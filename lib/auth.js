"use strict";
// Passwords, sessions and cookies. Uses only Node's built-in crypto.
const crypto = require("crypto");
const { promisify } = require("util");
const { sha256 } = require("./util");

const scrypt = promisify(crypto.scrypt);
const COOKIE = "sd_session";
const N = 16384;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, n, saltHex, keyHex] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(keyHex, "hex");
    const key = await scrypt(String(password), Buffer.from(saltHex, "hex"), expected.length, { N: Number(n), r: 8, p: 1 });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Used when the account doesn't exist, so a wrong email takes as long as a
// wrong password and can't be told apart by timing.
let dummy;
async function burnTime(password) {
  if (!dummy) dummy = await hashPassword("not-a-real-password");
  await verifyPassword(password, dummy);
}

const WEAK = new Set([
  "password", "password1", "12345678", "123456789", "1234567890", "qwerty123",
  "iloveyou", "11111111", "00000000", "abcd1234", "welcome1", "letmein123",
]);

// Returns an error message, or "" when the password is fine.
function checkPassword(pw, loginKey = "") {
  const s = String(pw || "");
  if (s.length < 8) return "Your password needs at least 8 characters.";
  if (s.length > 200) return "That password is too long.";
  if (WEAK.has(s.toLowerCase())) return "That password is too easy to guess. Try something less common.";
  if (/^(.)\1+$/.test(s)) return "That password is too easy to guess. Try something less common.";
  const bare = String(loginKey).replace(/^[ep]:/, "").toLowerCase();
  if (bare && s.toLowerCase() === bare) return "Your password can't be the same as your email or number.";
  return "";
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || !!req.socket.encrypted;
}

function cookieHeader(req, value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    isHttps(req) ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

class Auth {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
  }

  // Create a session, set the cookie on the response.
  startSession(req, res, uid) {
    const token = crypto.randomBytes(32).toString("base64url");
    const maxAge = this.cfg.sessionDays * 86400;
    this.store.sessions[sha256(token)] = { uid, created: Date.now(), exp: Date.now() + maxAge * 1000 };
    this._prune();
    this.store.saveSessions();
    res.setHeader("Set-Cookie", cookieHeader(req, token, maxAge));
  }

  endSession(req, res) {
    const token = parseCookies(req)[COOKIE];
    if (token) {
      delete this.store.sessions[sha256(token)];
      this.store.saveSessions();
    }
    res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
  }

  endAllSessions(uid) {
    for (const [h, s] of Object.entries(this.store.sessions)) if (s.uid === uid) delete this.store.sessions[h];
    this.store.saveSessions();
  }

  // Returns the signed-in user, or null.
  currentUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const s = this.store.sessions[sha256(token)];
    if (!s || s.exp < Date.now()) return null;
    const user = this.store.findUserById(s.uid);
    if (!user || user.disabled) return null;
    this.store.touchUser(user);
    return user;
  }

  _prune() {
    const now = Date.now();
    for (const [h, s] of Object.entries(this.store.sessions)) if (s.exp < now) delete this.store.sessions[h];
  }
}

module.exports = { Auth, hashPassword, verifyPassword, burnTime, checkPassword, parseCookies };
