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

// One alert to you: { subject, text, html, replyTo }.
async function sendEmail(mail) {
  if (!cfg.resendKey || !cfg.notifyEmail) return { state: "off" };
  const payload = { from: cfg.emailFrom, to: [cfg.notifyEmail], subject: mail.subject, text: mail.text, html: mail.html };
  if (EMAIL_RE.test(mail.replyTo || "")) payload.reply_to = mail.replyTo; // hit Reply to answer them
  try {
    const r = await postJson(cfg.resendUrl, { Authorization: "Bearer " + cfg.resendKey }, payload);
    return r.ok ? { state: "sent" } : { state: "failed", detail: shortError(r) };
  } catch (e) {
    return { state: "failed", detail: e.message };
  }
}

async function sendWebhook(text) {
  if (!cfg.webhookUrl) return { state: "off" };
  const body = cfg.webhookUrl.includes("discord") ? { content: text } : { text };
  try {
    const r = await postJson(cfg.webhookUrl, {}, body);
    return r.ok ? { state: "sent" } : { state: "failed", detail: shortError(r) };
  } catch (e) {
    return { state: "failed", detail: e.message };
  }
}

// Try every channel. `notified` is true only if at least one really went out.
async function deliver(mail) {
  const [email, webhook] = await Promise.all([sendEmail(mail), sendWebhook(mail.text)]);
  return { delivery: { email, webhook }, notified: email.state === "sent" || webhook.state === "sent" };
}

// A live-session request.
function notifyAll(rec) {
  const urgent = /urgent|today/i.test(rec.urgency || "");
  return deliver({
    subject: `${urgent ? "[" + rec.urgency + "] " : ""}Site Desk: ${rec.name} wants a live session${rec.topic ? " - " + rec.topic : ""}`,
    text: summaryText(rec),
    html: summaryHtml(rec),
    replyTo: rec.contact,
  });
}

// ---------------------------------------------------------------------------
// Contact-form messages
// ---------------------------------------------------------------------------
function firstName(name) { return String(name || "").trim().split(/\s+/)[0] || ""; }

function messageReplyEmail(msg) {
  if (!EMAIL_RE.test(msg.email || "")) return "";
  const body = `Hi ${firstName(msg.name)},\n\n\n\n---\nYour message (${msg.id}):\n${String(msg.message).slice(0, 1200)}`;
  return `mailto:${msg.email}?subject=${encodeURIComponent("Re: " + (msg.topic || "your message") + " (" + msg.id + ")")}&body=${encodeURIComponent(body)}`;
}

function messageReplyWhatsapp(msg) {
  const num = normalisePhone(msg.phone);
  if (!num) return "";
  return `https://wa.me/${num}?text=${encodeURIComponent(`Hi ${firstName(msg.name)}, thanks for your message on Site Desk (${msg.id}).`)}`;
}

function contactText(msg) {
  const wa = messageReplyWhatsapp(msg);
  const head = [
    `New message from the Site Desk contact form (${msg.id})`,
    `From: ${msg.name}`,
    msg.email ? `Email: ${msg.email}` : "",
    msg.phone ? `Phone / WhatsApp: ${msg.phone}` : "",
    wa ? `Reply on WhatsApp: ${wa}` : "",
    `About: ${msg.topic}`,
  ].filter(Boolean);
  return [...head, "", msg.message, "", `Received: ${formatSAST(msg.receivedAt)}`].join("\n");
}

function contactHtml(msg) {
  const wa = messageReplyWhatsapp(msg);
  const row = (k, v) => v ? `<tr><td style="padding:6px 14px 6px 0;color:#6b6558;vertical-align:top">${k}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>` : "";
  return `<div style="font-family:Georgia,serif;color:#22303c;max-width:560px">
<h2 style="margin:0 0 4px">New message: ${escapeHtml(msg.topic)}</h2>
<p style="margin:0 0 14px;color:#6b6558">Reference ${escapeHtml(msg.id)} &middot; ${escapeHtml(formatSAST(msg.receivedAt))}</p>
<table style="border-collapse:collapse;font-size:15px">
${row("From", msg.name)}
${row("Email", msg.email)}
${row("Phone", msg.phone)}
</table>
<div style="margin:14px 0;padding:14px 16px;background:#f6f1e7;border-radius:8px;font-size:15px;line-height:1.55;white-space:pre-wrap">${escapeHtml(msg.message)}</div>
${msg.email ? `<p style="color:#6b6558;font-size:14px">Press Reply to answer ${escapeHtml(firstName(msg.name))} by email.</p>` : ""}
${wa ? `<p><a href="${escapeHtml(wa)}" style="background:#1b2f4b;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reply on WhatsApp</a></p>` : ""}
</div>`;
}

function notifyContact(msg) {
  const words = String(msg.message).replace(/\s+/g, " ").trim();
  return deliver({
    subject: `Site Desk message from ${msg.name}: ${msg.topic}${words ? " - " + (words.length > 50 ? words.slice(0, 50) + "..." : words) : ""}`,
    text: contactText(msg),
    html: contactHtml(msg),
    replyTo: msg.email,
  });
}

// The message written out ready to send from the person's own WhatsApp or email.
function contactPersonal(msg) {
  const greeting = cfg.agent === "the site agent" ? "Hi" : "Hi " + cfg.agent;
  return [
    `${greeting}, it's ${msg.name}. (Site Desk message ${msg.id})`,
    `About: ${msg.topic}`,
    "",
    String(msg.message).slice(0, 1200),
    "",
    `You can reply to me on: ${[msg.email, msg.phone].filter(Boolean).join(" or ")}`,
  ].join("\n");
}
function contactWhatsappLink(msg) {
  return cfg.agentWhatsapp ? `https://wa.me/${cfg.agentWhatsapp}?text=${encodeURIComponent(contactPersonal(msg))}` : "";
}
function contactMailtoLink(msg) {
  if (!cfg.agentEmail) return "";
  return `mailto:${cfg.agentEmail}?subject=${encodeURIComponent(msg.topic + " (" + msg.id + ")")}&body=${encodeURIComponent(contactPersonal(msg))}`;
}

// The request, written out ready to send, for the person's own WhatsApp or email.
function personalMessage(rec) {
  const greeting = cfg.agent === "the site agent" ? "Hi" : "Hi " + cfg.agent;
  return [
    `${greeting}, it's ${rec.name}${rec.company ? " from " + rec.company : ""}.`,
    `I've asked for a Procore live session on Site Desk (ref ${rec.id}).`,
    rec.topic ? `Topic: ${rec.topic}` : "",
    rec.preferredTime ? `When suits me: ${rec.preferredTime}` : "",
    rec.details ? `Details: ${rec.details.slice(0, 900)}` : "",
    rec.contact ? `You can reach me on: ${rec.contact}` : "",
  ].filter(Boolean).join("\n");
}

// A pre-filled WhatsApp link to you.
function fallbackWhatsapp(rec) {
  if (!cfg.agentWhatsapp) return "";
  return `https://wa.me/${cfg.agentWhatsapp}?text=${encodeURIComponent(personalMessage(rec))}`;
}

// A pre-filled email to you, opened in the person's own mail app.
function mailtoLink(rec) {
  if (!cfg.agentEmail) return "";
  const subject = `Procore live session request ${rec.id}${rec.topic ? " - " + rec.topic : ""}`;
  return `mailto:${cfg.agentEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(personalMessage(rec))}`;
}

module.exports = {
  notifyAll, fallbackWhatsapp, mailtoLink, replyWhatsapp, summaryText,
  notifyContact, contactWhatsappLink, contactMailtoLink, messageReplyEmail, messageReplyWhatsapp,
};
