"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startMocks, startApp, client } = require("./helpers");

let mocks, app;
const good = (over = {}) => ({
  name: "Sipho Dlamini", login: "sipho@example.com", password: "Correct-Horse-9", role: "Foreman / supervisor",
  company: "Acme Civils", code: "sitecode", consent: true, ...over,
});

test.before(async () => {
  mocks = await startMocks();
  app = await startApp({
    ANTHROPIC_API_URL: mocks.anthropicUrl,
    RESEND_API_URL: mocks.resendUrl,
    RESEND_API_KEY: "resend-key",
    NOTIFY_EMAIL: "lesego@example.com",
    REQUEST_WEBHOOK_URL: mocks.webhookUrl,
  });
});
test.after(async () => { await app.stop(); mocks.close(); });

// ---------------------------------------------------------------- pages
test("signed-out visitors are sent to the sign-in page", async () => {
  const c = client(app.base);
  const home = await c.get("/");
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/login");
  const login = await c.get("/login");
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await c.get("/api/me")).status, 401);
});

test("old public request list and server files are not exposed", async () => {
  const c = client(app.base);
  assert.equal((await c.get("/api/session-requests")).status, 404);
  assert.equal((await c.get("/server.js")).status, 404);
  assert.equal((await c.get("/../server.js")).status, 404);
  assert.equal((await c.get("/data/users.json")).status, 404);
});

// ---------------------------------------------------------------- sign-up
test("sign-up checks code, password, consent and duplicates", async () => {
  const c = client(app.base);
  assert.equal((await c.post("/api/signup", good({ code: "nope" }))).status, 403);
  assert.equal((await c.post("/api/signup", good({ password: "short" }))).status, 400);
  assert.equal((await c.post("/api/signup", good({ password: "password1" }))).status, 400);
  assert.equal((await c.post("/api/signup", good({ consent: false }))).status, 400);
  assert.equal((await c.post("/api/signup", good({ login: "not an email" }))).status, 400);

  const ok = await c.post("/api/signup", good());
  assert.equal(ok.status, 200);
  assert.ok(c.cookie().startsWith("sd_session="));
  const me = await c.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.firstName, "Sipho");
  assert.equal(me.data.topics.length, 10);
  assert.equal(me.data.agent, "Lesego");
  assert.equal((await c.get("/")).status, 200); // app page now opens

  const dup = await client(app.base).post("/api/signup", good({ login: "SIPHO@example.com" }));
  assert.equal(dup.status, 409);
});

test("the hidden trap field stops bots without creating an account", async () => {
  const c = client(app.base);
  const r = await c.post("/api/signup", good({ login: "bot@example.com", website: "http://spam" }));
  assert.equal(r.status, 200);
  assert.equal(c.cookie(), "");
  assert.equal((await c.post("/api/login", { login: "bot@example.com", password: "Correct-Horse-9" })).status, 401);
});

test("cookies are HttpOnly and SameSite", async () => {
  const res = await fetch(app.base + "/api/signup", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
    body: JSON.stringify(good({ login: "cookie@example.com" })),
  });
  const set = res.headers.get("set-cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Secure/); // behind Render's https
});

// ---------------------------------------------------------------- sign-in
test("sign-in works by email or by cell number in any format", async () => {
  const a = client(app.base);
  assert.equal((await a.post("/api/signup", good({ name: "Thabo Mokoena", login: "082 111 2222" }))).status, 200);
  for (const form of ["+27821112222", "0821112222", "27 82 111 2222"]) {
    const c = client(app.base);
    assert.equal((await c.post("/api/login", { login: form, password: "Correct-Horse-9" })).status, 200, form);
  }
  const c = client(app.base);
  assert.equal((await c.post("/api/login", { login: "SIPHO@Example.com", password: "Correct-Horse-9" })).status, 200);
  const bad = await client(app.base).post("/api/login", { login: "sipho@example.com", password: "wrong-password" });
  assert.equal(bad.status, 401);
  assert.doesNotMatch(bad.text, /not found|no such|exists/i); // same answer for unknown people
});

test("repeated wrong passwords get blocked", async () => {
  const c = client(app.base);
  let last;
  for (let i = 0; i < 10; i++) last = await c.post("/api/login", { login: "nobody@example.com", password: "x-wrong-pass" });
  assert.equal(last.status, 429);
});

test("sign-out ends the session on the server", async () => {
  const c = client(app.base);
  await c.post("/api/login", { login: "sipho@example.com", password: "Correct-Horse-9" });
  const saved = c.cookie();
  assert.equal((await c.get("/api/me")).status, 200);
  await c.post("/api/logout", {});
  const again = client(app.base); again.setCookie(saved);
  assert.equal((await again.get("/api/me")).status, 401); // old cookie is dead
});

test("cross-site and non-JSON posts are refused", async () => {
  const c = client(app.base);
  await c.post("/api/login", { login: "sipho@example.com", password: "Correct-Horse-9" });
  const form = await c.post("/api/chat", undefined, { body: "messages=1", headers: { "Content-Type": "text/plain" } });
  assert.equal(form.status, 415);
  const foreign = await c.post("/api/chat", { messages: [{ role: "user", content: "hi" }] }, { headers: { Origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
});

// ---------------------------------------------------------------- chat
test("chat answers, classifies the topic and turns the marker into a button flag", async () => {
  const c = client(app.base);
  await c.post("/api/login", { login: "sipho@example.com", password: "Correct-Horse-9" });
  assert.equal((await client(app.base).post("/api/chat", { messages: [{ role: "user", content: "hi" }] })).status, 401);

  const r = await c.post("/api/chat", { messages: [{ role: "user", content: "How do I create an RFI?" }], src: "topic" });
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /Open the RFIs tool/);
  assert.equal(r.data.topic, "RFIs");
  assert.equal(r.data.offerSession, false);
  assert.ok(r.data.mid);
  const sent = mocks.seen.anthropic.at(-1);
  assert.equal(sent.key, "test-key");
  assert.match(sent.body.system, /Sipho/); // greets by first name

  const o = await c.post("/api/chat", { messages: [{ role: "user", content: "Can you offer help with permissions?" }] });
  assert.equal(o.data.offerSession, true);
  assert.doesNotMatch(o.data.reply, /\[\[SESSION\]\]/);
});

test("a failing assistant shows a friendly error and is flagged to the admin", async () => {
  const c = client(app.base);
  await c.post("/api/login", { login: "sipho@example.com", password: "Correct-Horse-9" });
  const r = await c.post("/api/chat", { messages: [{ role: "user", content: "BREAK this" }] });
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /credit|balance|key/i); // details stay private
  const st = await client(app.base).get("/api/admin/status", { admin: "adminpw" });
  assert.match(st.data.assistant.lastError.message, /credit balance/);
  // next good answer clears the warning
  await c.post("/api/chat", { messages: [{ role: "user", content: "daily log?" }] });
  const st2 = await client(app.base).get("/api/admin/status", { admin: "adminpw" });
  assert.equal(st2.data.assistant.lastError, null);
});

test("the daily question limit protects your API credit", async () => {
  const c = client(app.base);
  await c.post("/api/signup", good({ name: "Limit Tester", login: "limit@example.com" }));
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await c.post("/api/chat", { messages: [{ role: "user", content: "photos?" }] })).status);
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses[5], 429);
});

// ---------------------------------------------------------------- live session
test("a live-session request reaches you by email and webhook", async () => {
  const c = client(app.base);
  await c.post("/api/login", { login: "sipho@example.com", password: "Correct-Horse-9" });
  assert.equal((await c.post("/api/request-session", { contact: "nonsense", topic: "RFIs" })).status, 400);

  const r = await c.post("/api/request-session", { contact: "0821112222", topic: "RFIs", preferredTime: "Tomorrow, morning", urgency: "Urgent", details: "Stuck on routing" });
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, true);
  assert.equal(r.data.whatsappUrl, ""); // no fallback needed
  assert.match(r.data.id, /^SD-[0-9A-F]{6}$/);

  const mail = mocks.seen.email.at(-1);
  assert.equal(mail.auth, "Bearer resend-key");
  assert.deepEqual(mail.body.to, ["lesego@example.com"]);
  assert.match(mail.body.subject, /\[Urgent\].*Sipho Dlamini/);
  assert.match(mail.body.text, /wa\.me\/27821112222/); // one-tap reply
  assert.match(mail.body.text, /Acme Civils/);
  assert.match(mocks.seen.webhook.at(-1).text, /Stuck on routing/);

  const list = await client(app.base).get("/api/admin/requests", { admin: "adminpw" });
  assert.equal(list.data.requests[0].id, r.data.id);
  assert.equal(list.data.requests[0].delivery.email.state, "sent");
});

test("reply-to is set when the person gave an email address", async () => {
  const c = client(app.base);
  await c.post("/api/login", { login: "sipho@example.com", password: "Correct-Horse-9" });
  await c.post("/api/request-session", { contact: "sipho@example.com", topic: "Forms" });
  assert.equal(mocks.seen.email.at(-1).body.reply_to, "sipho@example.com");
});

test("when no alert can be delivered the person is told, with a WhatsApp fallback", async () => {
  const c = client(app.base);
  await c.post("/api/signup", good({ name: "FAILALL Person", login: "fail@example.com" }));
  const r = await c.post("/api/request-session", { contact: "0829998888", topic: "RFIs" });
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, false);
  assert.match(r.data.whatsappUrl, /^https:\/\/wa\.me\/27821234567\?text=/);
  assert.equal(r.data.agentEmail, "lesego@example.com");
});

// ---------------------------------------------------------------- account
test("changing a password signs out other devices and keeps this one", async () => {
  const a = client(app.base), b = client(app.base);
  await a.post("/api/signup", good({ name: "Pw Person", login: "pw@example.com" }));
  await b.post("/api/login", { login: "pw@example.com", password: "Correct-Horse-9" });
  assert.equal((await a.post("/api/account/password", { current: "wrong", next: "Another-Pass-1" })).status, 401);
  assert.equal((await a.post("/api/account/password", { current: "Correct-Horse-9", next: "short" })).status, 400);
  assert.equal((await a.post("/api/account/password", { current: "Correct-Horse-9", next: "Another-Pass-1" })).status, 200);
  assert.equal((await a.get("/api/me")).status, 200);
  assert.equal((await b.get("/api/me")).status, 401);
  assert.equal((await client(app.base).post("/api/login", { login: "pw@example.com", password: "Correct-Horse-9" })).status, 401);
  assert.equal((await client(app.base).post("/api/login", { login: "pw@example.com", password: "Another-Pass-1" })).status, 200);
});

test("people can delete their own account", async () => {
  const c = client(app.base);
  await c.post("/api/signup", good({ name: "Leaving Person", login: "leave@example.com" }));
  await c.post("/api/chat", { messages: [{ role: "user", content: "inspection?" }] });
  assert.equal((await c.post("/api/account/delete", { password: "nope" })).status, 401);
  assert.equal((await c.post("/api/account/delete", { password: "Correct-Horse-9" })).status, 200);
  assert.equal((await client(app.base).post("/api/login", { login: "leave@example.com", password: "Correct-Horse-9" })).status, 401);
  const users = await client(app.base).get("/api/admin/users", { admin: "adminpw" });
  assert.ok(!users.data.users.some((u) => u.name === "Leaving Person"));
});

// ---------------------------------------------------------------- admin
test("the admin area needs the password", async () => {
  const c = client(app.base);
  assert.equal((await c.get("/admin")).status, 401);
  assert.equal((await c.get("/api/admin/users", { admin: "wrong" })).status, 401);
  assert.equal((await c.get("/api/admin/stats")).status, 401);
  const page = await c.get("/admin", { admin: "adminpw" });
  assert.equal(page.status, 200);
  assert.match(page.text, /Site Desk/);
  assert.equal((await c.get("/admin/admin.js", { admin: "adminpw" })).status, 200);
});

test("the dashboard reports real usage and never leaks password data", async () => {
  const admin = client(app.base);
  const stats = await admin.get("/api/admin/stats", { admin: "adminpw" });
  assert.equal(stats.status, 200);
  const t = stats.data.totals;
  assert.ok(t.users >= 5);
  assert.ok(t.questions >= 5);
  assert.equal(t.activeToday >= 3, true);
  assert.ok(stats.data.topics30.some((x) => x.topic === "RFIs"));
  assert.equal(stats.data.days.length, 30);
  assert.equal(stats.data.hours.length, 24);
  assert.ok(t.sessionRequests >= 3);
  assert.ok(t.failedLogins7 >= 1);

  const users = await admin.get("/api/admin/users", { admin: "adminpw" });
  assert.ok(!JSON.stringify(users.data).includes("scrypt"));
  const csv = await admin.get("/api/admin/export/users.csv", { admin: "adminpw" });
  assert.ok(csv.text.includes("sipho@example.com"));
  assert.ok(!csv.text.includes("scrypt"));
  const act = await admin.get("/api/admin/export/activity.csv", { admin: "adminpw" });
  assert.match(act.text, /Time,Person,Type/);
});

test("the admin can reset, switch off, switch on and delete accounts", async () => {
  const admin = client(app.base);
  const person = client(app.base);
  await person.post("/api/signup", good({ name: "Managed Person", login: "managed@example.com" }));
  const find = async () => (await admin.get("/api/admin/users", { admin: "adminpw" })).data.users.find((u) => u.login === "managed@example.com");
  const id = (await find()).id;
  const act = (action) => admin.post("/api/admin/user-action", { id, action }, { admin: "adminpw" });

  const reset = await act("reset");
  assert.equal(reset.status, 200);
  assert.ok(reset.data.tempPassword.length >= 10);
  assert.equal((await person.get("/api/me")).status, 401); // signed out everywhere
  assert.equal((await client(app.base).post("/api/login", { login: "managed@example.com", password: "Correct-Horse-9" })).status, 401);
  const back = client(app.base);
  assert.equal((await back.post("/api/login", { login: "managed@example.com", password: reset.data.tempPassword })).status, 200);

  await act("disable");
  assert.equal((await back.get("/api/me")).status, 401);
  const blocked = await client(app.base).post("/api/login", { login: "managed@example.com", password: reset.data.tempPassword });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Lesego/);

  await act("enable");
  assert.equal((await client(app.base).post("/api/login", { login: "managed@example.com", password: reset.data.tempPassword })).status, 200);

  await act("delete");
  assert.equal(await find(), undefined);
});

test("admin test buttons report what happened", async () => {
  const admin = client(app.base);
  const a = await admin.post("/api/admin/test-assistant", {}, { admin: "adminpw" });
  assert.equal(a.data.ok, true);
  const n = await admin.post("/api/admin/test-notify", {}, { admin: "adminpw" });
  assert.equal(n.data.notified, true);
  assert.equal(n.data.delivery.email.state, "sent");
  assert.equal(n.data.delivery.webhook.state, "sent");
  const status = await admin.get("/api/admin/status", { admin: "adminpw" });
  assert.equal(status.data.notifications.email.to, "l***@example.com");
  assert.equal(status.data.security.signupCodeSet, true);
});

// ---------------------------------------------------------------- persistence
test("accounts, sessions and statistics survive a restart", async () => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "sd-persist-"));
  const env = { ANTHROPIC_API_URL: mocks.anthropicUrl, DATA_DIR: dir };
  let a = await startApp(env);
  const c = client(a.base);
  await c.post("/api/signup", good({ login: "keep@example.com" }));
  await c.post("/api/chat", { messages: [{ role: "user", content: "punch list?" }] });
  const cookie = c.cookie();
  await a.stop();

  a = await startApp(env);
  const again = client(a.base);
  again.setCookie(cookie);
  assert.equal((await again.get("/api/me")).status, 200); // still signed in
  assert.equal((await client(a.base).post("/api/login", { login: "keep@example.com", password: "Correct-Horse-9" })).status, 200);
  const stats = await client(a.base).get("/api/admin/stats", { admin: "adminpw" });
  assert.equal(stats.data.totals.users, 1);
  assert.equal(stats.data.totals.questions, 1);
  await a.stop();
});

test("with no site code set, sign-up is open (and the admin page is told)", async () => {
  const a = await startApp({ SIGNUP_CODE: "", ANTHROPIC_API_URL: mocks.anthropicUrl });
  const pub = await client(a.base).get("/api/public");
  assert.equal(pub.data.signupCodeRequired, false);
  assert.equal((await client(a.base).post("/api/signup", good({ code: "" }))).status, 200);
  const st = await client(a.base).get("/api/admin/status", { admin: "adminpw" });
  assert.equal(st.data.security.signupCodeSet, false);
  await a.stop();
});

test("the admin page is switched off until a password is set", async () => {
  const a = await startApp({ ADMIN_PASSWORD: "" });
  assert.equal((await client(a.base).get("/admin")).status, 503);
  assert.equal((await client(a.base).get("/api/admin/stats", { admin: "" })).status, 503);
  await a.stop();
});
