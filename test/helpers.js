"use strict";
// Test helpers: start the real server against fake Anthropic / Resend / webhook
// services, and talk to it like a browser would.
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function readAll(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
}

// Fake outside services. `seen` records what the app sent them.
async function startMocks() {
  const seen = { anthropic: [], email: [], webhook: [] };
  const anthropic = await listen(async (req, res) => {
    const body = JSON.parse((await readAll(req)) || "{}");
    seen.anthropic.push({ key: req.headers["x-api-key"], body });
    const last = body.messages[body.messages.length - 1].content;
    res.setHeader("Content-Type", "application/json");
    if (last.includes("BREAK")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "Your credit balance is too low" } }));
    }
    const text = last.includes("offer") ? "That depends on your project setup.\n[[SESSION]]" : "1. Open the RFIs tool.\n2. Tap **Create**.";
    res.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
  const resend = await listen(async (req, res) => {
    const body = JSON.parse((await readAll(req)) || "{}");
    seen.email.push({ auth: req.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    if (String(body.text).includes("FAILALL")) { res.statusCode = 500; return res.end(JSON.stringify({ message: "boom" })); }
    res.end(JSON.stringify({ id: "e1" }));
  });
  const webhook = await listen(async (req, res) => {
    const body = JSON.parse((await readAll(req)) || "{}");
    seen.webhook.push(body);
    if (String(body.text).includes("FAILALL")) { res.statusCode = 500; return res.end("no"); }
    res.end("ok");
  });
  const url = (s, p = "") => `http://127.0.0.1:${s.address().port}${p}`;
  return {
    seen,
    anthropicUrl: url(anthropic, "/v1/messages"),
    resendUrl: url(resend, "/emails"),
    webhookUrl: url(webhook, "/hook"),
    close: () => [anthropic, resend, webhook].forEach((s) => s.close()),
  };
}

async function startApp(extraEnv = {}) {
  const port = await freePort();
  const dataDir = extraEnv.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "sitedesk-"));
  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    DATA_DIR: dataDir,
    ANTHROPIC_API_KEY: "test-key",
    ADMIN_PASSWORD: "adminpw",
    SIGNUP_CODE: "SiteCode",
    SITE_AGENT_NAME: "Lesego",
    SITE_AGENT_WHATSAPP: "0821234567",
    SITE_AGENT_EMAIL: "lesego@example.com",
    DAILY_LIMIT: "5",
    SIGNUP_LIMIT: "500",
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/healthz"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base, dataDir, log: () => log,
    stop: () => new Promise((resolve) => { proc.once("exit", resolve); proc.kill("SIGTERM"); }),
  };
}

// A tiny browser: remembers cookies, sends JSON.
function client(base) {
  let cookie = "";
  async function call(method, p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    if (cookie && !opts.noCookie) headers.Cookie = cookie;
    if (opts.admin) headers.Authorization = "Basic " + Buffer.from("admin:" + opts.admin).toString("base64");
    const res = await fetch(base + p, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set && !opts.noCookie) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, headers: res.headers };
  }
  return {
    get: (p, o) => call("GET", p, o),
    post: (p, json, o) => call("POST", p, { ...o, json }),
    cookie: () => cookie,
    setCookie: (c) => { cookie = c; },
  };
}

module.exports = { startMocks, startApp, client };
