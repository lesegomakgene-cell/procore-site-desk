"use strict";
// Tells the site agent when someone asks for a live session.
// Email (via Resend) and/or a Slack/Discord webhook. Each attempt is
// checked, so the app knows whether anyone was actually told.
const cfg = require("./config");
const { escapeHtml, normalisePhone, EMAIL_RE, formatSAST } = require("./util");

async function postJson(url, headers, body, ms = 8000) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, text };
}

function shortError(r) {
  try {
    const j = JSON.parse(r.text);
    return `${r.status}: ${j.message || (j.error && j.error.message) || r.text.slice(0, 160)}`;
  } catch {
    return `${r.status}: ${String(r.text).slice(0, 160)}`;
  }
}

function replyWhatsapp(rec, text) {
  const num = normalisePhone(rec.contact);
  return num ? `https://wa.me/${num}${text ? "?text=" + encodeURIComponent(text) : ""}` : "";
}

function summaryText(rec) {
  const wa = replyWhatsapp(rec);
  return [
    `New live-session request (${rec.id})`,
    `Name: ${rec.name}${rec.company ? " (" + rec.company + ")" : ""}`,
    `Contact: ${rec.contact || "-"}`,
    wa ? `Reply on WhatsApp: ${wa}` : "",
    `Topic: ${rec.topic || "-"}`,
    `When: ${rec.preferredTime || "-"}  |  Urgency: ${rec.urgency || "-"}`,
    `Details: ${rec.details || "-"}`,
    `Received: ${formatSAST(rec.receivedAt)}`,
  ].filter(Boolean).join("\n");
}

function summaryHtml(rec) {
  const wa = replyWhatsapp(rec);
  const row = (k, v) => `<tr><td style="padding:6px 14px 6px 0;color:#6b6558;vertical-align:top">${k}</td><td style="padding:6px 0">${escapeHtml(v || "-")}</td></tr>`;
  return `<div style="font-family:Georgia,serif;color:#22303c;max-width:560px">
<h2 style="margin:0 0 4px">New live-session request</h2>
<p style="margin:0 0 14px;color:#6b6558">Reference ${escapeHtml(rec.id)} &middot; ${escapeHtml(formatSAST(rec.receivedAt))}</p>
<table style="border-collapse:collapse;font-size:15px">
${row("Name", rec.name + (rec.company ? " (" + rec.company + ")" : ""))}
${row("Contact", rec.contact)}
${row("Topic", rec.topic)}
${row("When", rec.preferredTime)}
${row("Urgency", rec.urgency)}
${row("Details", rec.details)}
</table>
${wa ? `<p><a href="${escapeHtml(wa)}" style="background:#1b2f4b;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reply on WhatsApp</a></p>` : ""}
</div>`;
}

async function sendEmail(rec) {
  if (!cfg.resendKey || !cfg.notifyEmail) return { state: "off" };
  const urgent = /urgent|today/i.test(rec.urgency || "");
  const payload = {
    from: cfg.emailFrom,
    to: [cfg.notifyEmail],
    subject: `${urgent ? "[" + rec.urgency + "] " : ""}Site Desk: ${rec.name} wants a live session${rec.topic ? " - " + rec.topic : ""}`,
    text: summaryText(rec),
    html: summaryHtml(rec),
  };
  if (EMAIL_RE.test(rec.contact || "")) payload.reply_to = rec.contact; // hit Reply to answer them
  try {
    const r = await postJson(cfg.resendUrl, { Authorization: "Bearer " + cfg.resendKey }, payload);
    return r.ok ? { state: "sent" } : { state: "failed", detail: shortError(r) };
  } catch (e) {
    return { state: "failed", detail: e.message };
  }
}

async function sendWebhook(rec) {
  if (!cfg.webhookUrl) return { state: "off" };
  const text = summaryText(rec);
  const body = cfg.webhookUrl.includes("discord") ? { content: text } : { text };
  try {
    const r = await postJson(cfg.webhookUrl, {}, body);
    return r.ok ? { state: "sent" } : { state: "failed", detail: shortError(r) };
  } catch (e) {
    return { state: "failed", detail: e.message };
  }
}

// Try every channel. `notified` is true only if at least one really went out.
async function notifyAll(rec) {
  const [email, webhook] = await Promise.all([sendEmail(rec), sendWebhook(rec)]);
  return { delivery: { email, webhook }, notified: email.state === "sent" || webhook.state === "sent" };
}

// A pre-filled WhatsApp link the person can tap if nothing could be sent.
function fallbackWhatsapp(rec) {
  if (!cfg.agentWhatsapp) return "";
  const greeting = cfg.agent === "the site agent" ? "Hi" : "Hi " + cfg.agent;
  const text = `${greeting}, it's ${rec.name}. I asked for a Procore live session (ref ${rec.id})${rec.topic ? " about " + rec.topic : ""}.`;
  return `https://wa.me/${cfg.agentWhatsapp}?text=${encodeURIComponent(text)}`;
}

module.exports = { notifyAll, fallbackWhatsapp, replyWhatsapp, summaryText };
