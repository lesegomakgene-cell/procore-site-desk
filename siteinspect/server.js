// SiteInspect - zero-dependency Node server
//
// Site inspections for a main contractor: run checklists on a phone, take
// photos, raise actions against subcontractors, sign off, and print a report.
// Data is kept in a JSON file and a photos folder under DATA_DIR.
//
// Run:  node server.js     (Node 18+, 20+ recommended)

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Store } = require("./lib/store");
const { BUILT_IN_TEMPLATES } = require("./lib/templates");
const { streamMessage, ClaudeError } = require("./lib/claude");

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
const PORT = Number(process.env.PORT || 3200);
// Local only by default. On Render (which sets RENDER=true) the app must listen
// publicly; the password guard below still applies.
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MODEL || "claude-opus-5-5";
const EFFORT = process.env.EFFORT || "medium";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const COMPANY_NAME = process.env.COMPANY_NAME || "";
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || "data");
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_JSON = 2 * 1024 * 1024;
const MAX_PHOTO = 8 * 1024 * 1024;
const RESULTS = new Set(["pass", "fail", "na"]);
const PRIORITIES = ["low", "medium", "high", "critical"];
// Default days to close an action, by priority.
const DUE_DAYS = { low: 14, medium: 7, high: 2, critical: 1 };

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let store; // created on start so tests can point DATA_DIR elsewhere

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
        reject(new HttpError(`Upload too large (limit ${Math.round(limit / 1048576)} MB)`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req, MAX_JSON);
  try {
    const v = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError("Invalid JSON", 400);
  }
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n).trim();
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, n) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const photoList = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === "string" && store.photoPath(p)).slice(0, 20) : []);

function passwordMatches(pass) {
  const a = crypto.createHash("sha256").update(String(pass)).digest();
  const b = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Repeated wrong guesses from one address get locked out for a while.
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

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

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

// --- domain --------------------------------------------------------------
function allTemplates() {
  return [...BUILT_IN_TEMPLATES, ...store.list("templates")];
}

function cleanTemplate(input) {
  const name = clip(input.name, 200);
  if (!name) throw new HttpError("Give the template a name", 400);
  const sections = (Array.isArray(input.sections) ? input.sections : [])
    .slice(0, 40)
    .map((s) => ({
      title: clip(s && s.title, 200) || "General",
      items: (Array.isArray(s && s.items) ? s.items : []).map((i) => clip(i, 500)).filter(Boolean).slice(0, 100),
    }))
    .filter((s) => s.items.length);
  if (!sections.length) throw new HttpError("Add at least one check item", 400);
  return { name, category: clip(input.category, 60) || "Custom", frequency: clip(input.frequency, 100), builtIn: false, sections };
}

function requireProject(id) {
  const p = store.get("projects", id);
  if (!p) throw new HttpError("Project not found", 404);
  return p;
}

function cleanProject(input) {
  const name = clip(input.name, 200);
  if (!name) throw new HttpError("Give the project a name", 400);
  return {
    name,
    number: clip(input.number, 60),
    client: clip(input.client, 200),
    address: clip(input.address, 300),
    manager: clip(input.manager, 120),
  };
}

function cleanItem(raw, existing) {
  const result = RESULTS.has(raw.result) ? raw.result : null;
  return {
    ...existing,
    result,
    note: clip(raw.note, 2000),
    photos: photoList(raw.photos),
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : "medium",
    assignee: clip(raw.assignee, 200),
    dueDate: isDate(raw.dueDate) ? raw.dueDate : "",
  };
}

function scoreOf(items) {
  const pass = items.filter((i) => i.result === "pass").length;
  const fail = items.filter((i) => i.result === "fail").length;
  return pass + fail ? Math.round((pass / (pass + fail)) * 100) : 100;
}

async function createInspection(input) {
  const project = requireProject(input.projectId);
  const tpl = allTemplates().find((t) => t.id === input.templateId);
  if (!tpl) throw new HttpError("Template not found", 404);
  let n = 0;
  const items = [];
  for (const s of tpl.sections) {
    for (const text of s.items) {
      items.push({ id: `i${++n}`, section: s.title, text, result: null, note: "", photos: [], priority: "medium", assignee: "", dueDate: "" });
    }
  }
  const count = store.list("inspections", (i) => i.projectId === project.id).length;
  return store.insert("inspections", {
    projectId: project.id,
    templateId: tpl.id,
    templateName: tpl.name,
    category: tpl.category,
    ref: `INS-${String(count + 1).padStart(4, "0")}`,
    area: clip(input.area, 200),
    inspector: clip(input.inspector, 120),
    date: isDate(input.date) ? input.date : today(),
    weather: clip(input.weather, 120),
    notes: "",
    items,
    status: "draft",
    score: null,
    signature: "",
    summary: "",
  });
}

async function updateInspection(id, input) {
  const insp = store.get("inspections", id);
  if (!insp) throw new HttpError("Inspection not found", 404);
  if (insp.status !== "draft") throw new HttpError("This inspection has been submitted and can't be changed", 409);
  const byId = new Map((Array.isArray(input.items) ? input.items : []).map((i) => [i && i.id, i]));
  const items = insp.items.map((it) => (byId.has(it.id) ? cleanItem(byId.get(it.id), it) : it));
  const changes = { items };
  for (const f of ["area", "inspector", "weather"]) if (f in input) changes[f] = clip(input[f], 200);
  if ("notes" in input) changes.notes = clip(input.notes, 5000);
  if (isDate(input.date)) changes.date = input.date;
  return store.update("inspections", id, changes);
}

// Submitting locks the inspection, scores it and raises an action for every failed item.
async function submitInspection(id, input) {
  const insp = store.get("inspections", id);
  if (!insp) throw new HttpError("Inspection not found", 404);
  if (insp.status !== "draft") throw new HttpError("Already submitted", 409);
  const open = insp.items.filter((i) => !i.result);
  if (open.length) throw new HttpError(`${open.length} item(s) still need a Pass, Fail or N/A`, 400);
  const signature = typeof input.signature === "string" ? input.signature : "";
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > 400_000) {
    throw new HttpError("Sign the inspection before submitting", 400);
  }
  const inspector = clip(input.inspector, 120) || insp.inspector;
  if (!inspector) throw new HttpError("Enter the inspector's name", 400);

  const actionCount = store.list("actions", (a) => a.projectId === insp.projectId).length;
  let n = 0;
  for (const item of insp.items.filter((i) => i.result === "fail")) {
    const action = await store.insert("actions", {
      projectId: insp.projectId,
      inspectionId: insp.id,
      inspectionRef: insp.ref,
      itemId: item.id,
      ref: `ACT-${String(actionCount + ++n).padStart(4, "0")}`,
      title: item.text,
      description: item.note,
      section: item.section,
      location: insp.area,
      assignee: item.assignee,
      priority: item.priority,
      dueDate: item.dueDate || addDays(insp.date, DUE_DAYS[item.priority] || 7),
      photos: item.photos,
      status: "open",
      raisedBy: inspector,
      closeoutNote: "",
      closeoutPhotos: [],
      closedBy: "",
      closedAt: "",
    });
    item.actionId = action.id;
  }
  return store.update("inspections", id, {
    items: insp.items,
    inspector,
    signature,
    score: scoreOf(insp.items),
    status: "submitted",
    submittedAt: new Date().toISOString(),
  });
}

function cleanAction(input, existing = {}) {
  const out = {};
  if (!existing.id || "title" in input) {
    out.title = clip(input.title, 500);
    if (!out.title) throw new HttpError("Describe the action", 400);
  }
  for (const [f, n] of [["description", 2000], ["location", 200], ["assignee", 200], ["section", 200]]) {
    if (f in input) out[f] = clip(input[f], n);
  }
  if ("priority" in input) out.priority = PRIORITIES.includes(input.priority) ? input.priority : "medium";
  if ("dueDate" in input) out.dueDate = isDate(input.dueDate) ? input.dueDate : "";
  if ("photos" in input) out.photos = photoList(input.photos);
  return out;
}

async function updateAction(id, input) {
  const action = store.get("actions", id);
  if (!action) throw new HttpError("Action not found", 404);
  const changes = cleanAction(input, action);
  if (input.status === "closed" && action.status !== "closed") {
    changes.closeoutNote = clip(input.closeoutNote, 2000);
    changes.closeoutPhotos = photoList(input.closeoutPhotos);
    changes.closedBy = clip(input.closedBy, 120);
    if (!changes.closeoutNote && !changes.closeoutPhotos.length) {
      throw new HttpError("Add a close-out note or photo as evidence", 400);
    }
    if (!changes.closedBy) throw new HttpError("Enter who is closing the action", 400);
    changes.status = "closed";
    changes.closedAt = new Date().toISOString();
  } else if (input.status === "open" && action.status === "closed") {
    Object.assign(changes, { status: "open", closedAt: "", closedBy: "" });
  }
  return store.update("actions", id, changes);
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  // Leading =,+,-,@ would run as a formula in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function actionsCsv(projectId) {
  const project = requireProject(projectId);
  const rows = [["Ref", "Status", "Priority", "Title", "Description", "Location", "Section", "Assigned to", "Raised", "Raised by", "From inspection", "Due", "Overdue", "Closed", "Closed by", "Close-out note"]];
  const t = today();
  for (const a of store.list("actions", (x) => x.projectId === project.id)) {
    rows.push([
      a.ref, a.status, a.priority, a.title, a.description, a.location, a.section, a.assignee,
      a.createdAt.slice(0, 10), a.raisedBy, a.inspectionRef || "", a.dueDate,
      a.status === "open" && a.dueDate && a.dueDate < t ? "yes" : "", (a.closedAt || "").slice(0, 10), a.closedBy, a.closeoutNote,
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// --- AI summary ----------------------------------------------------------
const SUMMARY_SYSTEM = `You are an experienced construction health & safety and quality manager working for a main contractor. You write the summary section of a site inspection report that goes to the project manager, the client's representative and subcontractors.

Write in plain, direct site English. Base everything strictly on the checklist results, notes and photos provided; do not invent findings. Where a photo shows something the inspector did not note, you may mention it, clearly saying it is observed from the photo.

Structure (plain text, no markdown headings, no tables):
1. One short paragraph: overall condition of the area and the score in context.
2. "Key risks:" followed by up to five bullet points ("- "), most serious first, each naming the hazard and why it matters.
3. "Priority actions:" followed by bullet points with who should act (use the assignee if given, otherwise the responsible trade) and by when.
4. One line on anything done well, if there is something worth recognising.

Keep it under 250 words.`;

async function summariseInspection(id) {
  if (!API_KEY) throw new HttpError("ANTHROPIC_API_KEY is not set, so AI summaries are off. Add it to .env and restart.", 400);
  const insp = store.get("inspections", id);
  if (!insp) throw new HttpError("Inspection not found", 404);
  const project = store.get("projects", insp.projectId) || {};
  const lines = insp.items.map((i) => {
    let l = `[${(i.result || "unanswered").toUpperCase()}] ${i.section} - ${i.text}`;
    if (i.note) l += ` | Note: ${i.note}`;
    if (i.result === "fail") l += ` | Priority: ${i.priority}${i.assignee ? ` | Assigned to: ${i.assignee}` : ""}`;
    return l;
  });

  const content = [];
  let photos = 0;
  for (const item of insp.items.filter((i) => i.result === "fail")) {
    for (const p of item.photos) {
      if (photos >= 12) break;
      const file = store.photoPath(p);
      if (!file || !fs.existsSync(file)) continue;
      const media = p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg";
      content.push({ type: "text", text: `Photo for failed item: ${item.text}` });
      content.push({ type: "image", source: { type: "base64", media_type: media, data: fs.readFileSync(file).toString("base64") } });
      photos++;
    }
  }
  content.push({
    type: "text",
    text: [
      `Project: ${project.name || ""}${project.number ? ` (${project.number})` : ""}`,
      `Inspection: ${insp.templateName} ${insp.ref}`,
      `Area: ${insp.area || "not stated"} | Date: ${insp.date} | Inspector: ${insp.inspector || "not stated"}${insp.weather ? ` | Weather: ${insp.weather}` : ""}`,
      `Score: ${insp.score != null ? insp.score : scoreOf(insp.items)}%`,
      "",
      "CHECKLIST RESULTS",
      ...lines,
      insp.notes ? `\nGENERAL NOTES\n${insp.notes}` : "",
      "",
      "Write the inspection summary.",
    ].join("\n"),
  });

  let out;
  try {
    out = await streamMessage({
      apiKey: API_KEY,
      model: MODEL,
      effort: EFFORT,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content }],
      maxTokens: 16000,
    });
  } catch (e) {
    throw new HttpError(e.message, 502);
  }
  const summary = out.text.trim();
  // Saving the summary is allowed on a submitted inspection - it's report text only.
  insp.summary = summary;
  insp.updatedAt = new Date().toISOString();
  await store.save();
  return insp;
}

// --- routes --------------------------------------------------------------
async function route(req, res, pathname, query) {
  const m = (re) => pathname.match(re);
  const GET = req.method === "GET";
  const POST = req.method === "POST";
  const PUT = req.method === "PUT";
  const DEL = req.method === "DELETE";
  let r;

  if (GET && pathname === "/api/config") {
    return sendJson(res, 200, { aiEnabled: !!API_KEY, model: MODEL, company: COMPANY_NAME });
  }

  // projects
  if (pathname === "/api/projects") {
    if (GET) return sendJson(res, 200, store.list("projects"));
    if (POST) return sendJson(res, 201, await store.insert("projects", cleanProject(await readJson(req))));
  }
  if ((r = m(/^\/api\/projects\/([a-f0-9]+)$/))) {
    if (PUT) {
      requireProject(r[1]);
      return sendJson(res, 200, await store.update("projects", r[1], cleanProject(await readJson(req))));
    }
    if (DEL) {
      requireProject(r[1]);
      if (store.list("inspections", (i) => i.projectId === r[1]).length) {
        throw new HttpError("This project has inspections. Delete those first.", 409);
      }
      await store.removeWhere("actions", (a) => a.projectId === r[1]);
      await store.remove("projects", r[1]);
      return sendJson(res, 200, { ok: true });
    }
  }

  // templates
  if (pathname === "/api/templates") {
    if (GET) return sendJson(res, 200, allTemplates());
    if (POST) return sendJson(res, 201, await store.insert("templates", cleanTemplate(await readJson(req))));
  }
  if ((r = m(/^\/api\/templates\/([a-f0-9]+)$/)) && DEL) {
    if (!(await store.remove("templates", r[1]))) throw new HttpError("Template not found", 404);
    return sendJson(res, 200, { ok: true });
  }

  // inspections
  if (pathname === "/api/inspections") {
    if (GET) {
      const pid = query.get("projectId");
      // The list leaves out signatures to keep it light.
      const list = store.list("inspections", (i) => !pid || i.projectId === pid).map(({ signature, ...rest }) => rest);
      return sendJson(res, 200, list);
    }
    if (POST) return sendJson(res, 201, await createInspection(await readJson(req)));
  }
  if ((r = m(/^\/api\/inspections\/([a-f0-9]+)$/))) {
    if (GET) {
      const insp = store.get("inspections", r[1]);
      if (!insp) throw new HttpError("Inspection not found", 404);
      return sendJson(res, 200, insp);
    }
    if (PUT) return sendJson(res, 200, await updateInspection(r[1], await readJson(req)));
    if (DEL) {
      const insp = store.get("inspections", r[1]);
      if (!insp) throw new HttpError("Inspection not found", 404);
      if (insp.status !== "draft") throw new HttpError("Submitted inspections are part of the site record and can't be deleted", 409);
      await store.remove("inspections", r[1]);
      return sendJson(res, 200, { ok: true });
    }
  }
  if ((r = m(/^\/api\/inspections\/([a-f0-9]+)\/submit$/)) && POST) {
    return sendJson(res, 200, await submitInspection(r[1], await readJson(req)));
  }
  if ((r = m(/^\/api\/inspections\/([a-f0-9]+)\/summary$/)) && POST) {
    return sendJson(res, 200, await summariseInspection(r[1]));
  }

  // actions
  if (pathname === "/api/actions") {
    if (GET) {
      const pid = query.get("projectId");
      return sendJson(res, 200, store.list("actions", (a) => !pid || a.projectId === pid));
    }
    if (POST) {
      const input = await readJson(req);
      const project = requireProject(input.projectId);
      const count = store.list("actions", (a) => a.projectId === project.id).length;
      const action = await store.insert("actions", {
        projectId: project.id,
        ref: `ACT-${String(count + 1).padStart(4, "0")}`,
        inspectionId: "",
        inspectionRef: "",
        description: "", location: "", assignee: "", section: "", photos: [],
        priority: "medium",
        ...cleanAction(input),
        dueDate: isDate(input.dueDate) ? input.dueDate : addDays(today(), DUE_DAYS[input.priority] || 7),
        status: "open",
        raisedBy: clip(input.raisedBy, 120),
        closeoutNote: "", closeoutPhotos: [], closedBy: "", closedAt: "",
      });
      return sendJson(res, 201, action);
    }
  }
  if ((r = m(/^\/api\/actions\/([a-f0-9]+)$/)) && PUT) {
    return sendJson(res, 200, await updateAction(r[1], await readJson(req)));
  }
  if (GET && pathname === "/api/actions.csv") {
    const project = requireProject(query.get("projectId"));
    const name = (project.number || project.name).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="actions-${name}-${today()}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.end("﻿" + actionsCsv(project.id)); // BOM so Excel reads UTF-8
  }

  // photos
  if (pathname === "/api/photos" && POST) {
    const buf = await readRaw(req, MAX_PHOTO);
    let ext = null;
    if (buf[0] === 0xff && buf[1] === 0xd8) ext = ".jpg";
    else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = ".png";
    else if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") ext = ".webp";
    if (!ext) throw new HttpError("Photos must be JPEG, PNG or WebP", 415);
    return sendJson(res, 201, { id: await store.savePhoto(buf, ext) });
  }
  if ((r = m(/^\/api\/photos\/([a-z0-9.]+)$/)) && GET) {
    const file = store.photoPath(r[1]);
    if (!file) throw new HttpError("Not found", 404);
    return fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: "Not found" });
      const type = file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable" });
      res.end(data);
    });
  }

  if (pathname.startsWith("/api/")) throw new HttpError("Not found", 404);
  if (GET) return serveStatic(req, res);
  sendJson(res, 405, { error: "Method not allowed" });
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
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="SiteInspect"', "Content-Type": "text/plain" });
    return res.end("Password required");
  }
  const url = new URL(req.url, "http://x");
  try {
    await route(req, res, url.pathname, url.searchParams);
  } catch (e) {
    const status = (e instanceof HttpError || e instanceof ClaudeError) && e.status ? e.status : 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !(e instanceof HttpError) ? "Server error" : e.message });
    else res.end();
  }
});

server.headersTimeout = 60_000;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

if (require.main === module) {
  if (!LOCAL_HOSTS.has(HOST) && !APP_PASSWORD) {
    console.error(`Refusing to start: HOST=${HOST} makes the app reachable from other machines, so APP_PASSWORD must be set.`);
    process.exit(1);
  }
  store = new Store(DATA_DIR);
  server.listen(PORT, HOST, () => {
    console.log(`SiteInspect running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (listening on ${HOST})`);
    console.log(APP_PASSWORD ? "Password protection: on" : "Password protection: off (local use only)");
    console.log(`Data folder: ${DATA_DIR}`);
    console.log(API_KEY ? `AI summaries: on (${MODEL})` : "AI summaries: off (no ANTHROPIC_API_KEY)");
  });
}

module.exports = { server, scoreOf, csvCell };
