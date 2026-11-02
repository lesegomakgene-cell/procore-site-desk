// Procore Site Desk - zero-dependency Node server.
//
//   * People create an account, then chat with the Procore helper.
//   * They can request a live session; the site agent is notified for real.
//   * /admin shows usage statistics and lets the site agent manage accounts.
//
// Run:  node server.js        (Node 18 or newer)
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const cfg = require("./lib/config");
const U = require("./lib/util");
const { Store } = require("./lib/store");
const { Auth, hashPassword, verifyPassword, burnTime, checkPassword } = require("./lib/auth");
const notify = require("./lib/notify");
const stats = require("./lib/stats");
const { TOPICS, classify, ROLES } = require("./lib/topics");

const store = new Store(cfg.dataDir);
const auth = new Auth(store, cfg);

const VIEWS = path.join(cfg.root, "views");
const PUBLIC = path.join(cfg.root, "public");
const ADMIN_DIR = path.join(cfg.root, "admin");

let lastChatError = null; // shown on the admin page so problems are visible

// ---------------------------------------------------------------------------
// The assistant's brief
// ---------------------------------------------------------------------------
const SESSION_MARK = "[[SESSION]]";

const SYSTEM_PROMPT = `You are "Site Desk", a friendly help assistant for a building contractor's site team. You answer day-to-day questions about using Procore, the construction management platform. Your users are site personnel - foremen, engineers, safety officers, subcontractors and admin staff - often on their phones in the field.

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
- If a question is project-specific (this project's workflows, permissions, custom fields, naming conventions, contractual process), needs human judgement, involves a dispute, or the person is still stuck after your guidance, suggest a live session with ${cfg.agent}. Do this naturally, not on every message. When you do, end your reply with the exact marker ${SESSION_MARK} on its own final line. The app turns the marker into a "Request a live session" button, so never mention the marker itself.

Tone: warm, knowledgeable and plain-spoken, like a helpful colleague who has used Procore for years. Sentence case, no emoji, no jargon for its own sake. You are an unofficial helper set up by the site team - you are not Procore and not affiliated with Procore.`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  // Scripts and styles only from this site: a strong guard against injected code.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendFile(res, file, type, headers = {}, status = 200) {
  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, { error: "Not found" });
    res.writeHead(status, { "Content-Type": type, ...headers });
    res.end(content);
  });
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
  res.end();
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Only accept JSON posts from our own pages (blocks cross-site form posts).
function requirePost(req, res) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) {
    send(res, 415, { error: "Unsupported request." });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch {}
    if (!ok) { send(res, 403, { error: "Request blocked." }); return false; }
  }
  return true;
}

async function jsonBody(req, res) {
  try { return await readBody(req); }
  catch { send(res, 400, { error: "Could not read that request." }); return null; }
}

// --- rate limiting (in memory) ---
const hits = new Map();
function recent(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, arr);
  return arr;
}
function blocked(key, max, windowMs) { return recent(key, windowMs).length >= max; }
function hit(key, windowMs) { const a = recent(key, windowMs); a.push(Date.now()); }
function limited(key, max, windowMs) {
  if (blocked(key, max, windowMs)) return true;
  hit(key, windowMs);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k);
}, 600e3).unref();

function publicUser(u) {
  return {
    id: u.id, name: u.name, firstName: u.name.split(/\s+/)[0],
    login: u.loginDisplay, contact: u.contact, role: u.role, company: u.company || "",
  };
}

function requireUser(req, res) {
  const user = auth.currentUser(req);
  if (!user) { send(res, 401, { error: "Please sign in again." }); return null; }
  return user;
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------
async function callAnthropic({ system, messages, maxTokens = 1024 }) {
  const started = Date.now();
  try {
    const r = await fetch(cfg.anthropicUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages }),
      signal: AbortSignal.timeout(45000),
    });
    const ms = Date.now() - started;
    if (!r.ok) {
      const raw = await r.text();
      let message = raw.slice(0, 200);
      try { message = JSON.parse(raw).error.message || message; } catch {}
      return { ok: false, status: r.status, message, ms };
    }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return { ok: true, text, ms };
  } catch (e) {
    return { ok: false, status: 0, message: e.message, ms: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
async function handleSignup(req, res) {
  if (!requirePost(req, res)) return;
  if (limited("signup:" + U.clientIp(req), cfg.signupsPerHour, 3600e3)) {
    return send(res, 429, { error: "Too many sign-up attempts from this connection. Please try again later." });
  }
  const b = await jsonBody(req, res); if (!b) return;
  if (b.website) return send(res, 200, { ok: true }); // hidden trap field: a bot filled it in

  const name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length < 2) return send(res, 400, { error: "Please enter your full name." });

  const login = U.parseLogin(b.login);
  if (!login) return send(res, 400, { error: "Please enter a valid email address or cell number." });

  if (cfg.signupCode && !U.safeEqual(String(b.code || "").trim().toLowerCase(), cfg.signupCode.toLowerCase())) {
    return send(res, 403, { error: "That site access code isn't right. Please ask the site office for the code." });
  }

  const pwError = checkPassword(b.password, login.key);
  if (pwError) return send(res, 400, { error: pwError });
  if (b.consent !== true) return send(res, 400, { error: "Please tick the box to agree before creating your account." });
  if (store.findUserByKey(login.key)) {
    return send(res, 409, { error: "There's already an account with that email or number. Try signing in instead." });
  }

  const now = Date.now();
  const user = {
    id: U.newId("u_"),
    name,
    loginKey: login.key,
    loginType: login.type,
    loginDisplay: login.display,
    contact: login.display,
    role: ROLES.includes(b.role) ? b.role : "Not given",
    company: String(b.company || "").trim().slice(0, 80),
    pw: await hashPassword(b.password),
    createdAt: now, lastLoginAt: now, lastSeenAt: now,
    consentAt: now,
    disabled: false,
  };
  store.users.push(user);
  store.saveUsers();
  store.addEvent({ type: "signup", uid: user.id, device: U.deviceFromUA(req.headers["user-agent"]) });
  auth.startSession(req, res, user.id);
  return send(res, 200, { ok: true });
}

async function handleLogin(req, res) {
  if (!requirePost(req, res)) return;
  const ip = U.clientIp(req);
  const b = await jsonBody(req, res); if (!b) return;
  const login = U.parseLogin(b.login);
  if (!login) { await burnTime(String(b.password || "")); return send(res, 400, { error: "Please enter a valid email address or cell number." }); }

  const k1 = "login:" + ip + ":" + login.key, k2 = "acct:" + login.key;
  if (blocked(k1, 8, 15 * 60e3) || blocked(k2, 20, 3600e3)) {
    return send(res, 429, { error: "Too many attempts. Please wait a few minutes and try again." });
  }

  const user = store.findUserByKey(login.key);
  let ok = false;
  if (user) ok = await verifyPassword(String(b.password || ""), user.pw);
  else await burnTime(String(b.password || ""));

  if (!ok) {
    hit(k1, 15 * 60e3); hit(k2, 3600e3);
    store.addEvent({ type: "login_fail" });
    return send(res, 401, { error: "That email or number and password don't match." });
  }
  if (user.disabled) {
    return send(res, 403, { error: `This account has been switched off. Please contact ${cfg.agent}.` });
  }
  user.lastLoginAt = Date.now();
  store.touchUser(user);
  store.saveUsers();
  store.addEvent({ type: "login", uid: user.id, device: U.deviceFromUA(req.headers["user-agent"]) });
  auth.startSession(req, res, user.id);
  return send(res, 200, { ok: true });
}

async function handleLogout(req, res) {
  if (!requirePost(req, res)) return;
  auth.endSession(req, res);
  return send(res, 200, { ok: true });
}

async function handleChangePassword(req, res) {
  if (!requirePost(req, res)) return;
  const user = requireUser(req, res); if (!user) return;
  const b = await jsonBody(req, res); if (!b) return;
  if (limited("pw:" + user.id, 6, 15 * 60e3)) return send(res, 429, { error: "Too many attempts. Please wait a few minutes." });
  if (!(await verifyPassword(String(b.current || ""), user.pw))) {
    return send(res, 401, { error: "Your current password isn't right." });
  }
  const err = checkPassword(b.next, user.loginKey);
  if (err) return send(res, 400, { error: err });
  user.pw = await hashPassword(b.next);
  store.saveUsers();
  auth.endAllSessions(user.id);   // sign out other devices
  auth.startSession(req, res, user.id); // keep this one
  store.addEvent({ type: "pw_change", uid: user.id });
  return send(res, 200, { ok: true });
}

async function handleDeleteAccount(req, res) {
  if (!requirePost(req, res)) return;
  const user = requireUser(req, res); if (!user) return;
  const b = await jsonBody(req, res); if (!b) return;
  if (!(await verifyPassword(String(b.password || ""), user.pw))) {
    return send(res, 401, { error: "That password isn't right." });
  }
  store.deleteUser(user.id);
  res.setHeader("Set-Cookie", "sd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return send(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Chat, feedback and live-session requests
// ---------------------------------------------------------------------------
async function handleChat(req, res) {
  if (!requirePost(req, res)) return;
  const user = requireUser(req, res); if (!user) return;
  if (limited("chat:" + user.id, 20, 60e3)) {
    return send(res, 429, { error: "You're sending messages quickly. Give it a few seconds and try again." });
  }
  const b = await jsonBody(req, res); if (!b) return;

  if (cfg.dailyLimit > 0) {
    const startOfDay = Date.now() - 24 * 3600e3;
    if (store.countSince(user.id, "chat", startOfDay) >= cfg.dailyLimit) {
      return send(res, 429, { error: `You've reached today's question limit. Please try again tomorrow, or request a live session with ${cfg.agent}.` });
    }
  }

  const messages = (Array.isArray(b.messages) ? b.messages : []).slice(-20)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 8000) }))
    .filter((m) => m.content.trim());
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return send(res, 400, { error: "Please type a question." });

  const question = messages[messages.length - 1].role === "user" ? messages[messages.length - 1].content : "";
  const topic = classify(question);
  const src = b.src === "topic" ? "topic" : "typed";
  const mid = U.newId("m_", 5);
  const log = (extra) => store.addEvent({
    type: "chat", uid: user.id, topic, src, len: question.length, mid,
    ...(cfg.storeQuestions ? { q: question.slice(0, 200) } : {}), ...extra,
  });

  if (!cfg.apiKey) {
    lastChatError = { at: Date.now(), status: 0, message: "ANTHROPIC_API_KEY is not set." };
    log({ ok: false, ms: 0 });
    return send(res, 503, { error: `Site Desk isn't fully set up yet. Please request a live session with ${cfg.agent} instead.` });
  }

  const system = `${SYSTEM_PROMPT}\n\nThe person you're helping is ${user.name.split(/\s+/)[0]}. Use their first name now and then, naturally, not in every reply.`;
  const r = await callAnthropic({ system, messages });
  if (!r.ok) {
    console.error("Anthropic API error:", r.status, r.message);
    lastChatError = { at: Date.now(), status: r.status, message: r.message };
    log({ ok: false, ms: r.ms });
    return send(res, 502, { error: "Site Desk is having trouble right now. Please try again in a moment, or request a live session." });
  }
  lastChatError = null;
  const offer = r.text.includes(SESSION_MARK);
  const reply = r.text.split(SESSION_MARK).join("").trim() || "Sorry, I didn't catch that. Could you rephrase it?";
  log({ ok: true, ms: r.ms });
  return send(res, 200, { reply, offerSession: offer, mid, topic });
}

async function handleFeedback(req, res) {
  if (!requirePost(req, res)) return;
  const user = requireUser(req, res); if (!user) return;
  const b = await jsonBody(req, res); if (!b) return;
  const mid = String(b.mid || "").slice(0, 40);
  if (!mid) return send(res, 400, { error: "Missing message." });
  store.addEvent({ type: "feedback", uid: user.id, mid, v: b.value === 1 ? 1 : -1 });
  return send(res, 200, { ok: true });
}

async function handleEvent(req, res) {
  if (!requirePost(req, res)) return;
  const user = requireUser(req, res); if (!user) return;
  const b = await jsonBody(req, res); if (!b) return;
  if (b.type === "offer_click" && !limited("ev:" + user.id, 30, 60e3)) {
    store.addEvent({ type: "offer_click", uid: user.id });
  }
  return send(res, 200, { ok: true });
}

async function handleSessionRequest(req, res) {
  if (!requirePost(req, res)) return;
  const user = requireUser(req, res); if (!user) return;
  if (limited("req:" + user.id, 5, 10 * 60e3)) {
    return send(res, 429, { error: "You've sent several requests just now. Please wait a few minutes." });
  }
  const b = await jsonBody(req, res); if (!b) return;

  const contactRaw = String(b.contact || user.contact || "").trim();
  if (!U.parseLogin(contactRaw)) {
    return send(res, 400, { error: `Please give a WhatsApp number or email so ${cfg.agent} can reach you.` });
  }
  const record = {
    id: "SD-" + U.newId("", 3).toUpperCase(),
    receivedAt: Date.now(),
    userId: user.id,
    name: user.name,
    company: user.company || "",
    contact: contactRaw.slice(0, 160),
    topic: String(b.topic || "").trim().slice(0, 200),
    preferredTime: String(b.preferredTime || "").trim().slice(0, 120),
    urgency: String(b.urgency || "").trim().slice(0, 40),
    details: String(b.details || "").trim().slice(0, 4000),
  };

  const { delivery, notified } = await notify.notifyAll(record);
  record.delivery = delivery;
  store.addRequest(record);
  store.addEvent({ type: "session_request", uid: user.id, rid: record.id, notified });
  console.log(`>>> Live session request ${record.id} from ${record.name} (notified: ${notified})`);

  return send(res, 200, {
    ok: true,
    id: record.id,
    notified,
    agent: cfg.agent,
    agentEmail: cfg.agentEmail,
    whatsappUrl: notified ? "" : notify.fallbackWhatsapp(record),
  });
}

// ---------------------------------------------------------------------------
// Admin (password protected)
// ---------------------------------------------------------------------------
function adminOk(req, res) {
  if (!cfg.adminPassword) {
    res.writeHead(503, HTML_HEADERS);
    res.end("<h1>Admin is switched off</h1><p>Set an ADMIN_PASSWORD in your settings to turn on the admin page.</p>");
    return false;
  }
  const ip = U.clientIp(req);
  if (blocked("adminfail:" + ip, 10, 15 * 60e3)) {
    res.writeHead(429, { "Content-Type": "text/plain" });
    res.end("Too many wrong passwords. Try again in a few minutes.");
    return false;
  }
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const pw = Buffer.from(h.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
    if (U.safeEqual(pw, cfg.adminPassword)) return true;
    hit("adminfail:" + ip, 15 * 60e3);
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Site Desk admin", charset="UTF-8"', "Content-Type": "text/plain" });
  res.end("Password needed");
  return false;
}

function mask(email) {
  const [u, d] = String(email).split("@");
  return d ? u[0] + "***@" + d : "";
}

function adminStatus() {
  return {
    agent: cfg.agent,
    appUrl: cfg.appUrl,
    assistant: { configured: !!cfg.apiKey, model: cfg.model, lastError: lastChatError },
    notifications: {
      email: { configured: !!(cfg.resendKey && cfg.notifyEmail), to: cfg.notifyEmail ? mask(cfg.notifyEmail) : "" },
      webhook: { configured: !!cfg.webhookUrl },
      whatsapp: { configured: !!cfg.agentWhatsapp },
    },
    security: {
      signupCodeSet: !!cfg.signupCode,
      storeQuestions: cfg.storeQuestions,
      dailyLimit: cfg.dailyLimit,
    },
    storage: {
      ok: store.ok, error: store.error, persistent: cfg.persistent, onRender: cfg.onRender,
      users: store.users.length, events: store.events.length,
    },
  };
}

function adminUsers() {
  const q = new Map(), last = new Map(), reqs = new Map();
  for (const ev of store.events) {
    if (!ev.uid) continue;
    if (ev.type === "chat") q.set(ev.uid, (q.get(ev.uid) || 0) + 1);
    if (ev.type === "session_request") reqs.set(ev.uid, (reqs.get(ev.uid) || 0) + 1);
    if (!last.has(ev.uid) || ev.t > last.get(ev.uid)) last.set(ev.uid, ev.t);
  }
  return store.users.map((u) => ({
    id: u.id, name: u.name, login: u.loginDisplay, loginType: u.loginType, role: u.role, company: u.company || "",
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, lastActive: last.get(u.id) || u.lastSeenAt || null,
    questions: q.get(u.id) || 0, requests: reqs.get(u.id) || 0, disabled: !!u.disabled,
  })).sort((a, b) => b.createdAt - a.createdAt);
}

async function handleAdminAction(req, res) {
  if (!requirePost(req, res)) return;
  const b = await jsonBody(req, res); if (!b) return;
  const user = store.findUserById(String(b.id || ""));
  if (!user) return send(res, 404, { error: "That account no longer exists." });
  switch (b.action) {
    case "disable":
      user.disabled = true; store.saveUsers(); auth.endAllSessions(user.id);
      return send(res, 200, { ok: true });
    case "enable":
      user.disabled = false; store.saveUsers();
      return send(res, 200, { ok: true });
    case "reset": {
      const temp = U.tempPassword();
      user.pw = await hashPassword(temp);
      store.saveUsers(); auth.endAllSessions(user.id);
      return send(res, 200, { ok: true, tempPassword: temp });
    }
    case "delete":
      store.deleteUser(user.id);
      return send(res, 200, { ok: true });
    default:
      return send(res, 400, { error: "Unknown action." });
  }
}

function csv(res, filename, rows) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  res.end("﻿" + rows.map((r) => r.map(U.csvCell).join(",")).join("\r\n") + "\r\n");
}

async function handleAdmin(req, res, url) {
  if (!adminOk(req, res)) return;
  const p = url.pathname;

  if (req.method === "GET" && (p === "/admin" || p === "/admin/")) return sendFile(res, path.join(ADMIN_DIR, "index.html"), HTML_HEADERS["Content-Type"], HTML_HEADERS);
  if (req.method === "GET" && p === "/admin/admin.js") return sendFile(res, path.join(ADMIN_DIR, "admin.js"), "text/javascript; charset=utf-8", { "Cache-Control": "no-store" });

  if (req.method === "GET" && p === "/api/admin/status") return send(res, 200, adminStatus());
  if (req.method === "GET" && p === "/api/admin/stats") return send(res, 200, stats.compute({ users: store.users, events: store.events, requests: store.requests }));
  if (req.method === "GET" && p === "/api/admin/users") return send(res, 200, { users: adminUsers() });
  if (req.method === "GET" && p === "/api/admin/requests") {
    return send(res, 200, {
      requests: [...store.requests].reverse().slice(0, 200).map((r) => ({ ...r, replyWhatsapp: notify.replyWhatsapp(r) })),
    });
  }

  if (req.method === "POST" && p === "/api/admin/user-action") return handleAdminAction(req, res);

  if (req.method === "POST" && p === "/api/admin/test-notify") {
    if (!requirePost(req, res)) return;
    const rec = {
      id: "SD-TEST", receivedAt: Date.now(), name: "Test message", company: "", contact: cfg.agentWhatsapp ? "+" + cfg.agentWhatsapp : "",
      topic: "Checking that notifications work", preferredTime: "-", urgency: "Whenever",
      details: "This is a test from the Site Desk admin page. If you can read this, requests will reach you.",
    };
    const { delivery, notified } = await notify.notifyAll(rec);
    return send(res, 200, { notified, delivery });
  }

  if (req.method === "POST" && p === "/api/admin/test-assistant") {
    if (!requirePost(req, res)) return;
    if (!cfg.apiKey) return send(res, 200, { ok: false, message: "ANTHROPIC_API_KEY is not set." });
    const r = await callAnthropic({ system: "Reply with the single word OK.", messages: [{ role: "user", content: "Ping" }], maxTokens: 16 });
    if (r.ok) lastChatError = null; else lastChatError = { at: Date.now(), status: r.status, message: r.message };
    return send(res, 200, r.ok ? { ok: true, ms: r.ms } : { ok: false, status: r.status, message: r.message });
  }

  if (req.method === "GET" && p === "/api/admin/export/users.csv") {
    const byId = new Map(adminUsers().map((u) => [u.id, u]));
    const rows = [["Name", "Sign-in", "Role", "Company", "Joined", "Last active", "Questions", "Session requests", "Status"]];
    for (const u of store.users) {
      const x = byId.get(u.id);
      rows.push([u.name, u.loginDisplay, u.role, u.company || "", U.formatSAST(u.createdAt), x.lastActive ? U.formatSAST(x.lastActive) : "", x.questions, x.requests, u.disabled ? "Switched off" : "Active"]);
    }
    return csv(res, "site-desk-users.csv", rows);
  }
  if (req.method === "GET" && p === "/api/admin/export/activity.csv") {
    const names = new Map(store.users.map((u) => [u.id, u.name]));
    const rows = [["Time", "Person", "Type", "Topic", "Source", "Worked", "Response ms", "Question"]];
    for (const ev of store.events) {
      if (ev.type === "login_fail") continue;
      rows.push([U.formatSAST(ev.t), names.get(ev.uid) || (ev.uid === "deleted" ? "(deleted)" : ""), ev.type, ev.topic || "", ev.src || "", ev.ok === undefined ? "" : ev.ok ? "yes" : "no", ev.ms == null ? "" : ev.ms, ev.q || ""]);
    }
    return csv(res, "site-desk-activity.csv", rows);
  }
  return send(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// Static files and pages
// ---------------------------------------------------------------------------
const STATIC = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function servePublic(req, res, url) {
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "Forbidden" });
  const type = STATIC[path.extname(file)];
  if (!type) return send(res, 404, { error: "Not found" });
  return sendFile(res, file, type, { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  if (p === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

  if (p === "/admin" || p.startsWith("/admin/") || p.startsWith("/api/admin/")) return handleAdmin(req, res, url);

  // pages
  if (m === "GET" && p === "/") {
    if (!auth.currentUser(req)) return redirect(res, "/login");
    return sendFile(res, path.join(VIEWS, "app.html"), HTML_HEADERS["Content-Type"], HTML_HEADERS);
  }
  if (m === "GET" && (p === "/login" || p === "/signup")) {
    if (auth.currentUser(req)) return redirect(res, "/");
    return sendFile(res, path.join(VIEWS, "login.html"), HTML_HEADERS["Content-Type"], HTML_HEADERS);
  }

  // public info for the sign-in page
  if (m === "GET" && p === "/api/public") {
    return send(res, 200, { agent: cfg.agent, signupCodeRequired: !!cfg.signupCode, roles: ROLES });
  }

  // account
  if (m === "POST" && p === "/api/signup") return handleSignup(req, res);
  if (m === "POST" && p === "/api/login") return handleLogin(req, res);
  if (m === "POST" && p === "/api/logout") return handleLogout(req, res);
  if (m === "POST" && p === "/api/account/password") return handleChangePassword(req, res);
  if (m === "POST" && p === "/api/account/delete") return handleDeleteAccount(req, res);
  if (m === "GET" && p === "/api/me") {
    const user = requireUser(req, res); if (!user) return;
    return send(res, 200, {
      user: publicUser(user),
      agent: cfg.agent,
      agentEmail: cfg.agentEmail,
      whatsappUrl: cfg.agentWhatsapp ? "https://wa.me/" + cfg.agentWhatsapp : "",
      topics: TOPICS,
    });
  }

  // the app
  if (m === "POST" && p === "/api/chat") return handleChat(req, res);
  if (m === "POST" && p === "/api/feedback") return handleFeedback(req, res);
  if (m === "POST" && p === "/api/event") return handleEvent(req, res);
  if (m === "POST" && p === "/api/request-session") return handleSessionRequest(req, res);

  if (m === "GET") return servePublic(req, res, url);
  return send(res, 405, { error: "Method not allowed" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error("Unhandled error:", e);
    if (!res.headersSent) send(res, 500, { error: "Something went wrong. Please try again." });
    else res.end();
  });
});

// Save everything when Render restarts the app.
function shutdown() {
  try { store.saveUsers(); store.saveSessions(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(cfg.port, "0.0.0.0", () => {
  const on = (b) => (b ? "on" : "OFF");
  console.log(`\n  Procore Site Desk running:  http://localhost:${cfg.port}`);
  console.log(`  Assistant: ${on(cfg.apiKey)} (${cfg.model})   Agent: ${cfg.agent}`);
  console.log(`  Notify email: ${on(cfg.resendKey && cfg.notifyEmail)}   webhook: ${on(cfg.webhookUrl)}   WhatsApp fallback: ${on(cfg.agentWhatsapp)}`);
  console.log(`  Sign-up code: ${cfg.signupCode ? "required" : "NOT SET (anyone with the link can sign up)"}   Admin page: ${on(cfg.adminPassword)}`);
  console.log(`  Data folder: ${cfg.dataDir}${cfg.persistent ? "" : "   (WARNING: not persistent - accounts are lost on restart)"}\n`);
});
