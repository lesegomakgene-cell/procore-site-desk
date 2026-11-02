"use strict";
// Small shared helpers (no dependencies).
const crypto = require("crypto");

// South African numbers: 082 123 4567 / +27 82 123 4567 -> 27821234567.
// Returns "" when the text doesn't look like a phone number.
function normalisePhone(raw) {
  const s = String(raw || "").trim();
  if (!s || s.includes("@")) return "";
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "27" + d.slice(1);
  else if (d.length === 9) d = "27" + d;
  d = d.replace(/\D/g, "");
  return d.length >= 9 && d.length <= 15 ? d : "";
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

// A sign-in name is either an email or a cell number. Returns the key used to
// look the account up, plus how to show it.
function parseLogin(raw) {
  const s = String(raw || "").trim();
  if (EMAIL_RE.test(s) && s.length <= 160) {
    return { type: "email", key: "e:" + s.toLowerCase(), display: s };
  }
  const p = normalisePhone(s);
  if (p) return { type: "phone", key: "p:" + p, display: s.slice(0, 40) };
  return null;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// CSV cell, protected against spreadsheet formula injection.
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function newId(prefix, bytes = 6) {
  return prefix + crypto.randomBytes(bytes).toString("hex");
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// Constant-time string comparison.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function deviceFromUA(ua) {
  const s = String(ua || "");
  if (/ipad|tablet/i.test(s)) return "tablet";
  if (/mobi|android|iphone/i.test(s)) return "mobile";
  return "desktop";
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return (xf ? String(xf).split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}

// "2 Nov 2026, 16:40" in South African time.
function formatSAST(ms) {
  try {
    return new Intl.DateTimeFormat("en-ZA", {
      timeZone: "Africa/Johannesburg",
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

// Easy-to-read temporary passwords (no 0/O, 1/l/I).
function tempPassword(len = 10) {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = {
  normalisePhone, parseLogin, EMAIL_RE, escapeHtml, csvCell, newId, sha256,
  safeEqual, deviceFromUA, clientIp, formatSAST, tempPassword,
};
