"use strict";
// Reads settings from the environment (and a local .env file when present).
const fs = require("fs");
const path = require("path");
const { normalisePhone } = require("./util");

const ROOT = path.join(__dirname, "..");

(function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

const e = process.env;
const flag = (v, def = false) => (v == null || v === "" ? def : /^(1|true|yes|on)$/i.test(String(v)));
const onRender = !!e.RENDER;

// Where accounts and statistics are saved. On Render, a persistent disk
// mounted at /var/data is picked up automatically.
let dataDir;
if (e.DATA_DIR) dataDir = path.resolve(ROOT, e.DATA_DIR);
else if (onRender && fs.existsSync("/var/data")) dataDir = "/var/data";
else dataDir = path.join(ROOT, "data");

const persistent =
  !onRender || dataDir.startsWith("/var/data") || flag(e.PERSISTENT_STORAGE);

module.exports = {
  root: ROOT,
  port: Number(e.PORT) || 3000,
  onRender,

  // assistant
  apiKey: e.ANTHROPIC_API_KEY || "",
  model: e.MODEL || "claude-sonnet-5-5",
  anthropicUrl: e.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages",
  dailyLimit: e.DAILY_LIMIT === "" || e.DAILY_LIMIT == null ? 100 : Number(e.DAILY_LIMIT) || 0,

  // the person who runs the site desk
  agent: e.SITE_AGENT_NAME || "the site agent",
  agentEmail: e.SITE_AGENT_EMAIL || "",
  agentWhatsapp: normalisePhone(e.SITE_AGENT_WHATSAPP || ""),

  // how session requests reach the agent
  webhookUrl: e.REQUEST_WEBHOOK_URL || "",
  resendKey: e.RESEND_API_KEY || "",
  resendUrl: e.RESEND_API_URL || "https://api.resend.com/emails",
  notifyEmail: e.NOTIFY_EMAIL || e.SITE_AGENT_EMAIL || "",
  emailFrom: e.EMAIL_FROM || "Procore Site Desk <onboarding@resend.dev>",

  // security
  adminPassword: e.ADMIN_PASSWORD || "",
  signupCode: (e.SIGNUP_CODE || "").trim(),
  sessionDays: Number(e.SESSION_DAYS) || 30,
  // A whole crew may sign up on one site wifi, so this is generous.
  signupsPerHour: Number(e.SIGNUP_LIMIT) || 30,
  storeQuestions: flag(e.STORE_QUESTIONS, false),

  // storage
  dataDir,
  persistent,
  appUrl: e.RENDER_EXTERNAL_URL || e.APP_URL || "",
};
