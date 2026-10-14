// InstantSiteMail - zero-dependency Node server
//
// Drop in an Outlook email (.msg / .eml) with its drawings and attachments;
// get back a contracts-manager analysis and a reply ready to send.
// Nothing is stored: files are parsed in memory and sent only to the
// Anthropic API. Your mailbox is never connected.
//
// Run:  node server.js     (Node 18+, 20+ recommended)

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseDropped } = require("./lib/files");
const { streamMessage, ClaudeError } = require("./lib/claude");
const { SYSTEM_PROMPT, ANALYSIS_SCHEMA, REFINE_SYSTEM } = require("./lib/prompt");

// --- tiny .env loader ----------------------------------------------------
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)(?:\s+#.*)?\s*$/);
    if (!m) continue;
    let val = m[2].startsWith("#") ? "" : m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

// --- config --------------------------------------------------------------
const PORT = Number(process.env.PORT || 3100);
// Local only by default - this is your work mail. On Render (which sets RENDER=true)
// the app must listen publicly or Render never sees it start; the password guard
// below still applies.
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MODEL || "claude-opus-5-5";
const EFFORT = process.env.EFFORT || "high";
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 32000);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_UPLOAD = 40 * 1024 * 1024; // one dropped file
const MAX_ANALYSE_BODY = 60 * 1024 * 1024; // JSON with base64 attachments
const MAX_API_PAYLOAD = 30 * 1024 * 1024; // the Messages API caps requests at 32 MB
const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// --- helpers -------------------------------------------------------------
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ClaudeError(`Upload too large (limit ${Math.round(limit / 1048576)} MB)`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  const raw = await readRaw(req, limit);
  try {
    return raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw new ClaudeError("Invalid JSON", 400);
  }
}

function passwordMatches(pass) {
  const a = crypto.createHash("sha256").update(String(pass)).digest();
  const b = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Online, the password is all that stands between the internet and your work
// mail, so repeated wrong guesses from one address get locked out for a while.
const failedLogins = new Map(); // ip -> { count, until }
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

// Behind Render's proxy the right-most X-Forwarded-For entry is the one the proxy
// added; earlier entries can be forged by the client.
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

// Returns "ok", "denied" or "locked".
function checkAuth(req) {
  if (!APP_PASSWORD) return "ok";
  const ip = clientIp(req);
  const rec = failedLogins.get(ip);
  if (rec && rec.until > Date.now()) return "locked";
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const [, pass] = Buffer.from(h.slice(6), "base64").toString("utf8").split(/:(.*)/s);
    if (pass !== undefined && passwordMatches(pass)) {
      failedLogins.delete(ip);
      return "ok";
    }
    const count = (rec && rec.until === 0 ? rec.count : 0) + 1; // an expired lockout starts afresh
    failedLogins.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    if (failedLogins.size > 10_000) failedLogins.clear();
  }
  return "denied";
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

// --- building the analysis request ---------------------------------------
function renderThread(thread) {
  return thread
    .map((m, i) => {
      const label = i === 0 ? "EMAIL TO ANALYSE" : `EARLIER / FORWARDED EMAIL ${i} (nested level ${m.level})`;
      return [
        `===== ${label} =====`,
        `From: ${clip(m.from, 500)}`,
        `To: ${clip(m.to, 2000)}`,
        m.cc ? `Cc: ${clip(m.cc, 2000)}` : "",
        `Date: ${clip(m.date, 100)}`,
        `Subject: ${clip(m.subject, 500)}`,
        "",
        clip(m.body, 200_000),
      ]
        .filter((l) => l !== "")
        .join("\n");
    })
    .join("\n\n");
}

function buildAnalyseRequest(input) {
  const thread = Array.isArray(input.thread) ? input.thread.slice(0, 30) : [];
  const docs = Array.isArray(input.documents) ? input.documents.slice(0, 60) : [];
  const profile = input.profile || {};
  const notes = clip(input.notes, 20_000);
  if (!thread.length && !docs.some((d) => d.include) && !notes.trim()) {
    throw new ClaudeError("Drop in an email (or paste one) first.", 400);
  }

  const content = [];
  const register = [];
  let n = 0;
  for (const d of docs) {
    const name = clip(d.name, 300) || "attachment";
    const origin = typeof d.fromEmail === "number" ? ` (attached to email ${d.fromEmail === 0 ? "being analysed" : d.fromEmail})` : " (provided separately by the user)";
    if (!d.include) {
      register.push(`- ${name}${origin}: NOT REVIEWED - ${d.note || "excluded by the user"}`);
      continue;
    }
    n++;
    if (d.kind === "pdf" && typeof d.data === "string") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data }, title: name });
    } else if (d.kind === "image" && typeof d.data === "string" && IMAGE_MEDIA.has(d.mime)) {
      content.push({ type: "text", text: `Attachment ${n}: ${name}` });
      content.push({ type: "image", source: { type: "base64", media_type: d.mime, data: d.data } });
    } else if (d.kind === "text" && typeof d.text === "string") {
      content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: d.text || "(empty)" }, title: name });
    } else {
      register.push(`- ${name}${origin}: NOT REVIEWED - unreadable format`);
      n--;
      continue;
    }
    register.push(`- ${name}${origin}: provided above (attachment ${n})`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const profileLines = [
    ["Name", profile.name],
    ["Position", profile.position],
    ["Company", profile.company],
    ["Project", profile.project],
    ["Our role on the contract", profile.role],
    ["Form of contract", profile.contract],
    ["Client / employer", profile.client],
    ["Sign-off", profile.signoff],
    ["House style / standing instructions", profile.style],
  ]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${clip(v, 2000)}`);

  content.push({
    type: "text",
    text: [
      `Today's date: ${today}`,
      "",
      "MY PROFILE",
      profileLines.length ? profileLines.join("\n") : "(not set - write the reply in neutral terms and leave [Name] for the sign-off)",
      "",
      "ATTACHMENT REGISTER",
      register.length ? register.join("\n") : "(no attachments)",
      "",
      thread.length ? renderThread(thread) : "(No email supplied - analyse the documents and notes below.)",
      "",
      notes.trim() ? `MY NOTES / BACKGROUND (not visible to the sender)\n${notes}` : "",
      "",
      "Analyse this as my contracts manager and prepare the reply.",
    ].join("\n"),
  });

  return { system: SYSTEM_PROMPT, messages: [{ role: "user", content }] };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new ClaudeError("The analysis came back in an unexpected format. Please try again.", 502);
  }
}

// --- routes --------------------------------------------------------------
async function handleParse(req, res) {
  const name = clip(new URL(req.url, "http://x").searchParams.get("name"), 300) || "file";
  const data = await readRaw(req, MAX_UPLOAD);
  if (!data.length) throw new ClaudeError("Empty file", 400);
  let result;
  try {
    result = parseDropped(name, data);
  } catch (e) {
    throw new ClaudeError(`Couldn't read ${name}: ${e.message}`, 422);
  }
  sendJson(res, 200, result);
}

async function handleAnalyse(req, res) {
  if (!API_KEY) throw new ClaudeError("ANTHROPIC_API_KEY is not set. Add it to .env and restart.", 500);
  const input = await readJson(req, MAX_ANALYSE_BODY);
  const { system, messages } = buildAnalyseRequest(input);
  const size = Buffer.byteLength(JSON.stringify(messages));
  if (size > MAX_API_PAYLOAD) {
    throw new ClaudeError(
      `Attachments total about ${Math.round(size / 1048576)} MB - the limit per analysis is about 30 MB. Untick some attachments and try again.`,
      413
    );
  }

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const write = (o) => res.write(JSON.stringify(o) + "\n");
  const started = Date.now();
  const ping = setInterval(() => write({ type: "ping", seconds: Math.round((Date.now() - started) / 1000) }), 5000);
  try {
    const out = await streamMessage({
      apiKey: API_KEY,
      model: MODEL,
      effort: EFFORT,
      system,
      messages,
      maxTokens: MAX_TOKENS,
      outputFormat: { type: "json_schema", schema: ANALYSIS_SCHEMA },
      onProgress: (p) => write({ type: "progress", ...p }),
    });
    write({ type: "result", analysis: parseJsonLoose(out.text), usage: out.usage, model: MODEL });
  } catch (e) {
    console.error("analyse failed:", e.message);
    write({ type: "error", error: e.message });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

async function handleRefine(req, res) {
  if (!API_KEY) throw new ClaudeError("ANTHROPIC_API_KEY is not set. Add it to .env and restart.", 500);
  const input = await readJson(req, 2 * 1024 * 1024);
  const draft = clip(input.draft, 60_000);
  const instruction = clip(input.instruction, 4000);
  if (!draft.trim() || !instruction.trim()) throw new ClaudeError("Need a draft and an instruction", 400);
  const text = [
    "CONTEXT (my analysis of the incoming email):",
    clip(input.context, 60_000),
    "",
    input.profile ? `MY PROFILE: ${clip(JSON.stringify(input.profile), 4000)}` : "",
    "",
    "CURRENT DRAFT:",
    draft,
    "",
    `REVISE IT: ${instruction}`,
  ].join("\n");
  const out = await streamMessage({
    apiKey: API_KEY,
    model: MODEL,
    effort: "medium",
    system: REFINE_SYSTEM,
    messages: [{ role: "user", content: text }],
    maxTokens: 16000,
  });
  sendJson(res, 200, { body: out.text.trim() });
}

const server = http.createServer(async (req, res) => {
  // Unauthenticated liveness check for Render; reveals nothing about the app.
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  const auth = checkAuth(req);
  if (auth === "locked") {
    res.writeHead(429, { "Content-Type": "text/plain" });
    return res.end("Too many wrong passwords. Try again in 15 minutes.");
  }
  if (auth !== "ok") {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="InstantSiteMail"', "Content-Type": "text/plain" });
    return res.end("Password required");
  }
  const { pathname } = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && pathname === "/api/config") {
      return sendJson(res, 200, { model: MODEL, ready: !!API_KEY });
    }
    if (req.method === "POST" && pathname === "/api/parse") return await handleParse(req, res);
    if (req.method === "POST" && pathname === "/api/analyse") return await handleAnalyse(req, res);
    if (req.method === "POST" && pathname === "/api/refine") return await handleRefine(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    const status = e instanceof ClaudeError && e.status ? e.status : 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: e.message });
    else res.end();
  }
});

// Analyses with large drawing sets can take a few minutes.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

if (require.main === module) {
  if (!LOCAL_HOSTS.has(HOST) && !APP_PASSWORD) {
    console.error(
      `Refusing to start: HOST=${HOST} makes the app reachable from other machines, so APP_PASSWORD must be set.`
    );
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`InstantSiteMail running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (listening on ${HOST})`);
    console.log(APP_PASSWORD ? "Password protection: on" : "Password protection: off (local use only)");
    console.log(`Model: ${MODEL} (effort: ${EFFORT})`);
    if (!API_KEY) console.warn("Warning: ANTHROPIC_API_KEY is not set - add it to .env");
  });
}

module.exports = { server, buildAnalyseRequest, checkAuth };
