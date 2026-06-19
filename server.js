// Procore Site Desk - zero-dependency Node server
// Serves the chat UI, proxies the Anthropic API (key stays server-side),
// and records "request a live session" submissions to a local file.
//
// Run:  node server.js
// Needs: Node 18+ (uses built-in fetch). Node 20+ recommended.

const http = require("http");
const fs = require("fs");
const path = require("path");

// --- tiny .env loader (so you don't need any dependencies) ---------------
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// --- config --------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const SITE_AGENT_NAME = process.env.SITE_AGENT_NAME || "the site agent";
const SITE_AGENT_EMAIL = process.env.SITE_AGENT_EMAIL || "";
const REQUEST_WEBHOOK_URL = process.env.REQUEST_WEBHOOK_URL || "";
const REQUESTS_FILE = path.join(__dirname, "session-requests.jsonl");

// --- the assistant's brief ----------------------------------------------
const SYSTEM_PROMPT = `You are "Site Desk", a help assistant for a building contractor's site team. You answer day-to-day questions about using Procore, the construction management platform. Your users are site personnel - foremen, engineers, safety officers, subcontractors and admin staff - often on their phones in the field.

Scope of what you help with:
- Project Management tools: RFIs, Submittals, Transmittals, Drawings (and revisions/markups), Specifications, Documents, Meetings, Schedule, Photos, Emails, Correspondence, Forms, Action Plans, Coordination Issues, Models/BIM.
- Quality & Safety tools: Observations, Inspections, Incidents, Toolbox Talks, Forms, Action Plans.
- Everyday field tools: Daily Log (manpower, weather, deliveries, notes, quantities), Punch List, Photos, Tasks, Timesheets, the Procore mobile app (including offline use and syncing).
- General "how do I..." workflow questions across web and mobile.

How to answer:
- Be clear, practical and brief. Give numbered steps when explaining how to do something, written the way you'd talk a foreman through it on site.
- Lead with the answer. Keep it skimmable on a phone screen. Avoid long preambles.
- For safety questions, be careful and thorough - safety first, and never downplay a hazard or incident-reporting obligation.
- Procore's exact menus, button names and available tools depend on the company's account setup, the user's permission level, and the platform version. When the precise location of something may vary, say so plainly and tell them what to look for rather than guessing a single exact path. When something is genuinely beyond general guidance, point them to Procore's official Support site (support.procore.com) or their company's Procore admin.
- Never invent Procore features, tool names, or settings that you are not confident exist. If you don't know, say so.

When to suggest a live session:
- If a question is project-specific (this project's workflows, permissions, custom fields, naming conventions, contractual process), needs human judgement, involves a dispute, or the person is stuck after general guidance, suggest they book a live session with ${SITE_AGENT_NAME} using the "Request a live session" button. Do this naturally, not on every message.

Tone: knowledgeable, calm, no jargon for its own sake, sentence case, no emoji. You are an unofficial helper set up by the site team - you are not Procore and not affiliated with Procore.`;

// --- helpers -------------------------------------------------------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const STATIC = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  // prevent path traversal
  const safe = path
    .normalize(urlPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const filePath = path.join(__dirname, "public", safe);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    return send(res, 403, { error: "Forbidden" });
  }
  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, { error: "Not found" });
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": STATIC[ext] || "application/octet-stream" });
    res.end(content);
  });
}

// --- API: chat -----------------------------------------------------------
async function handleChat(req, res) {
  if (!API_KEY) {
    return send(res, 500, {
      error:
        "No API key set. Add ANTHROPIC_API_KEY to your .env file (see .env.example), then restart the server.",
    });
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: "Could not read your message." });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return send(res, 400, { error: "No message provided." });

  // keep the last ~20 turns to bound token use
  const trimmed = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 8000),
  }));

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: trimmed,
      }),
    });

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      console.error("Anthropic API error:", apiRes.status, detail);
      return send(res, 502, {
        error:
          "The assistant is unavailable right now. Check your API key and model name, then try again.",
      });
    }

    const data = await apiRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return send(res, 200, { reply: text || "Sorry, I didn't catch that. Try rephrasing?" });
  } catch (e) {
    console.error("Chat handler error:", e);
    return send(res, 502, {
      error: "Could not reach the assistant. Check the server's internet connection.",
    });
  }
}

// --- notify the site agent instantly (Slack/Discord/generic webhook) -----
// Free hosts wipe the local file on redeploy, so this is how requests
// actually reach you. Set REQUEST_WEBHOOK_URL to a Slack or Discord webhook.
async function notifyWebhook(rec) {
  if (!REQUEST_WEBHOOK_URL) return;
  const text =
    "New Procore live-session request\n" +
    `Name: ${rec.name}\n` +
    `Contact: ${rec.contact || "-"}\n` +
    `Topic: ${rec.topic || "-"}\n` +
    `Preferred: ${rec.preferredTime || "-"}\n` +
    `Urgency: ${rec.urgency || "-"}\n` +
    `Details: ${rec.details || "-"}`;
  const isDiscord = REQUEST_WEBHOOK_URL.includes("discord");
  const body = isDiscord ? { content: text } : { text };
  try {
    await fetch(REQUEST_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Webhook notify failed:", e.message);
  }
}

// --- API: live session requests -----------------------------------------
async function handleSessionRequest(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: "Could not read the form." });
  }
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) return send(res, 400, { error: "Please add your name." });

  const record = {
    receivedAt: new Date().toISOString(),
    name,
    contact: String(body.contact || "").trim().slice(0, 200),
    topic: String(body.topic || "").trim().slice(0, 200),
    preferredTime: String(body.preferredTime || "").trim().slice(0, 120),
    urgency: String(body.urgency || "").trim().slice(0, 40),
    details: String(body.details || "").trim().slice(0, 4000),
  };

  try {
    fs.appendFileSync(REQUESTS_FILE, JSON.stringify(record) + "\n");
  } catch (e) {
    console.error("Could not save request:", e);
    return send(res, 500, { error: "Could not save your request. Tell the site office directly." });
  }

  console.log(`\n>>> Live session request from ${record.name} (${record.urgency || "no urgency set"})`);
  console.log(`    Topic: ${record.topic || "-"}  |  Preferred: ${record.preferredTime || "-"}`);

  notifyWebhook(record).catch(() => {});

  return send(res, 200, {
    ok: true,
    agent: SITE_AGENT_NAME,
    agentEmail: SITE_AGENT_EMAIL,
  });
}

// --- API: list requests (for the site agent) -----------------------------
// NOTE: no authentication. Fine for local use. Add auth before deploying.
function handleListRequests(req, res) {
  if (!fs.existsSync(REQUESTS_FILE)) return send(res, 200, { requests: [] });
  const lines = fs.readFileSync(REQUESTS_FILE, "utf8").split("\n").filter(Boolean);
  const requests = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
  return send(res, 200, { requests });
}

// --- router --------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/request-session")
    return handleSessionRequest(req, res);
  if (req.method === "GET" && req.url === "/api/session-requests")
    return handleListRequests(req, res);
  if (req.method === "GET" && req.url === "/api/config")
    return send(res, 200, { agent: SITE_AGENT_NAME });
  if (req.method === "GET") return serveStatic(req, res);
  return send(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Procore Site Desk running:  http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL}   Site agent: ${SITE_AGENT_NAME}`);
  if (!API_KEY) {
    console.log("\n  ⚠  No ANTHROPIC_API_KEY found. Copy .env.example to .env and add your key.\n");
  } else {
    console.log("");
  }
});
