"use strict";
// Simple file-based storage: users, sessions, session requests and a usage
// event log. Everything lives in one folder (DATA_DIR). Fine for a site team
// of hundreds; no database needed.
const fs = require("fs");
const path = require("path");

const VISIT_KEEP_DAYS = 400;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.ok = true;
    this.error = "";
    this.users = [];
    this.sessions = {}; // tokenHash -> { uid, exp, created }
    this.requests = [];
    this.events = [];
    this.messages = [];   // contact-form messages
    this.visits = [];     // page visits: { t, v: visitor id, p: page, u?: user id, d: device, s?: source, n?: 1 if new }
    this.ownerVids = [];  // browsers that opened /admin: the creator's own visits, left out of the counts
    this.startedAt = Date.now();
    this._lastUserSave = 0;
    this._init();
  }

  _p(name) { return path.join(this.dir, name); }

  _fail(e) {
    this.ok = false;
    this.error = String((e && e.message) || e);
    console.error("Storage problem:", this.error);
  }

  _init() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.accessSync(this.dir, fs.constants.W_OK);
    } catch (e) {
      this._fail(e);
    }
    this.users = this._readJson("users.json", []);
    this.sessions = this._readJson("sessions.json", {});
    this.requests = this._readLines("requests.jsonl");
    this.events = this._readLines("events.jsonl");
    this.messages = this._readLines("messages.jsonl");
    this.ownerVids = this._readJson("owner.json", { vids: [] }).vids || [];
    // Visits older than about 13 months are dropped so the file stays small.
    const all = this._readLines("visits.jsonl");
    const keepFrom = Date.now() - VISIT_KEEP_DAYS * 86400e3;
    this.visits = all.filter((v) => v.t >= keepFrom);
    if (this.visits.length !== all.length) this._rewriteLines("visits.jsonl", this.visits);
  }

  _readJson(name, fallback) {
    const file = this._p(name);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") {
        // Never overwrite a damaged file: keep a copy first.
        console.error(`Could not read ${name}:`, e.message);
        try { fs.copyFileSync(file, file + ".damaged-" + Date.now()); } catch {}
      }
      return fallback;
    }
  }

  _readLines(name) {
    try {
      return fs.readFileSync(this._p(name), "utf8")
        .split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code !== "ENOENT") console.error(`Could not read ${name}:`, e.message);
      return [];
    }
  }

  _writeJson(name, data) {
    try {
      const file = this._p(name);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file); // atomic: a crash can't leave half a file
    } catch (e) { this._fail(e); }
  }

  _append(name, obj) {
    try { fs.appendFileSync(this._p(name), JSON.stringify(obj) + "\n"); }
    catch (e) { this._fail(e); }
  }

  _rewriteLines(name, arr) {
    try {
      const file = this._p(name);
      fs.writeFileSync(file + ".tmp", arr.map((o) => JSON.stringify(o)).join("\n") + (arr.length ? "\n" : ""));
      fs.renameSync(file + ".tmp", file);
    } catch (e) { this._fail(e); }
  }

  // ---- users ----
  saveUsers() { this._lastUserSave = Date.now(); this._writeJson("users.json", this.users); }
  saveSessions() { this._writeJson("sessions.json", this.sessions); }
  findUserById(id) { return this.users.find((u) => u.id === id) || null; }
  findUserByKey(key) { return this.users.find((u) => u.loginKey === key) || null; }

  // "Last seen" changes constantly; write it out at most every 5 minutes.
  touchUser(user) {
    user.lastSeenAt = Date.now();
    if (Date.now() - this._lastUserSave > 5 * 60 * 1000) this.saveUsers();
  }

  // ---- usage log ----
  addEvent(ev) {
    ev.t = ev.t || Date.now();
    this.events.push(ev);
    this._append("events.jsonl", ev);
  }

  countSince(uid, type, sinceMs) {
    let n = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.t < sinceMs) break;
      if (ev.uid === uid && ev.type === type) n++;
    }
    return n;
  }

  // ---- session requests ----
  addRequest(rec) {
    this.requests.push(rec);
    this._append("requests.jsonl", rec);
  }

  // ---- contact-form messages ----
  addMessage(msg) {
    this.messages.push(msg);
    this._append("messages.jsonl", msg);
  }
  findMessage(id) { return this.messages.find((m) => m.id === id) || null; }
  saveMessages() { this._rewriteLines("messages.jsonl", this.messages); }
  deleteMessage(id) {
    this.messages = this.messages.filter((m) => m.id !== id);
    this.saveMessages();
  }

  // ---- visits ----
  addVisit(v) {
    this.visits.push(v);
    this._append("visits.jsonl", v);
  }
  addOwnerVid(vid) {
    if (!vid || this.ownerVids.includes(vid)) return;
    this.ownerVids = [...this.ownerVids, vid].slice(-50);
    this._writeJson("owner.json", { vids: this.ownerVids });
  }

  // Remove a person and what identifies them. Anonymous totals stay so the
  // statistics don't change.
  deleteUser(uid) {
    this.users = this.users.filter((u) => u.id !== uid);
    for (const [h, s] of Object.entries(this.sessions)) if (s.uid === uid) delete this.sessions[h];
    for (const ev of this.events) {
      if (ev.uid === uid) { ev.uid = "deleted"; delete ev.q; }
    }
    for (const r of this.requests) {
      if (r.userId === uid) {
        r.userId = "deleted"; r.name = "(deleted)"; r.contact = ""; r.details = ""; r.topic = r.topic || "";
        r.delivery = r.delivery || {};
      }
    }
    let visitsChanged = false;
    for (const v of this.visits) if (v.u === uid) { delete v.u; visitsChanged = true; }
    let messagesChanged = false;
    for (const m of this.messages) if (m.uid === uid) { delete m.uid; messagesChanged = true; }
    this.saveUsers();
    this.saveSessions();
    this._rewriteLines("events.jsonl", this.events);
    this._rewriteLines("requests.jsonl", this.requests);
    if (visitsChanged) this._rewriteLines("visits.jsonl", this.visits);
    if (messagesChanged) this.saveMessages();
  }
}

module.exports = { Store };
