"use strict";
// Contact form and visitor analytics, plus checks that they leave the live
// features (accounts, sessions, live sessions, old data files) alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMocks, startApp, client } = require("./helpers");

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const asPhone = (extra = {}) => ({ headers: { "User-Agent": PHONE_UA, ...extra } });
const asPC = (extra = {}) => ({ headers: { "User-Agent": PC_UA, ...extra } });
const ADMIN = { admin: "adminpw" };

let mocks, app;
const msg = (over = {}) => ({
  name: "Naledi Khumalo", email: "naledi@example.com", phone: "", topic: "Construction or contracts query",
  message: "Can you help me with a GCC 2015 extension of time claim?", elapsed: 9000, ...over,
});
const account = (over = {}) => ({
  name: "Sipho Dlamini", login: "sipho@example.com", password: "Correct-Horse-9", role: "Foreman / supervisor",
  company: "Acme Civils", code: "sitecode", consent: true, ...over,
});
const adminGet = (p) => client(app.base).get(p, ADMIN);
const visitStats = async () => (await adminGet("/api/admin/visits")).data;

test.before(async () => {
  mocks = await startMocks();
  app = await startApp({
    ANTHROPIC_API_URL: mocks.anthropicUrl,
    RESEND_API_URL: mocks.resendUrl,
    RESEND_API_KEY: "resend-key",
    NOTIFY_EMAIL: "lesego@example.com",
  });
});
test.after(async () => { await app.stop(); mocks.close(); });

// ---------------------------------------------------------------- contact form
test("the contact page is open to everyone and lists the topics and your details", async () => {
  const c = client(app.base);
  const page = await c.get("/contact", asPhone());
  assert.equal(page.status, 200);
  assert.match(page.text, /Get in touch/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  const pub = await c.get("/api/public");
  assert.ok(pub.data.contactTopics.length >= 4);
  assert.equal(pub.data.agentEmail, "lesego@example.com");
  assert.equal(pub.data.agentWhatsappUrl, "https://wa.me/27821234567");
  assert.equal(pub.data.me, null);
  const login = await c.get("/login", asPhone());
  assert.match(login.text, /href="\/contact"/); // linked from the sign-in page
});

test("contact messages are checked before anything is sent", async () => {
  const c = client(app.base);
  const before = mocks.seen.email.length;
  assert.equal((await c.post("/api/contact", msg({ name: "" }))).status, 400);
  assert.equal((await c.post("/api/contact", msg({ email: "", phone: "" }))).status, 400);
  assert.equal((await c.post("/api/contact", msg({ email: "not-an-email" }))).status, 400);
  assert.equal((await c.post("/api/contact", msg({ phone: "12" , email: ""}))).status, 400);
  assert.equal((await c.post("/api/contact", msg({ message: "hi" }))).status, 400);
  assert.equal((await c.post("/api/contact", undefined, { body: "name=x", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await c.post("/api/contact", msg(), { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal(mocks.seen.email.length, before);
});

test("spam bots get a normal-looking answer but nothing is saved or sent", async () => {
  const c = client(app.base);
  const before = mocks.seen.email.length;
  const trap = await c.post("/api/contact", msg({ website: "http://spam.example" }));
  assert.equal(trap.status, 200);
  const fast = await c.post("/api/contact", msg({ elapsed: 300 }));
  assert.equal(fast.status, 200);
  assert.equal(mocks.seen.email.length, before);
  assert.equal((await adminGet("/api/admin/messages")).data.messages.length, 0);
});

test("a contact message is emailed to you with reply-to, and saved for the Messages tab", async () => {
  const c = client(app.base);
  const r = await c.post("/api/contact", msg({ phone: "072 555 1234" }));
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, true);
  assert.match(r.data.id, /^MSG-[0-9A-F]{6}$/);
  assert.match(r.data.whatsappUrl, /^https:\/\/wa\.me\/27821234567\?text=/);
  assert.match(decodeURIComponent(r.data.whatsappUrl), /extension of time/);
  assert.match(r.data.emailUrl, /^mailto:lesego@example\.com\?subject=/);

  const mail = mocks.seen.email.at(-1);
  assert.deepEqual(mail.body.to, ["lesego@example.com"]);
  assert.equal(mail.body.reply_to, "naledi@example.com");
  assert.match(mail.body.subject, /Naledi Khumalo: Construction or contracts query/);
  assert.match(mail.body.text, /extension of time/);
  assert.match(mail.body.text, /wa\.me\/27725551234/);
  assert.doesNotMatch(mail.body.html, /<script/);

  const list = (await adminGet("/api/admin/messages")).data.messages;
  assert.equal(list[0].id, r.data.id);
  assert.equal(list[0].status, "new");
  assert.match(list[0].replyEmail, /^mailto:naledi@example\.com\?subject=Re%3A/);
  assert.match(list[0].replyWhatsapp, /^https:\/\/wa\.me\/27725551234/);
  assert.equal(list[0].delivery.email.state, "sent");
  const status = (await adminGet("/api/admin/status")).data;
  assert.equal(status.newMessages, 1);
});

test("HTML in a message can't get into your email as code", async () => {
  const c = client(app.base);
  await c.post("/api/contact", msg({ name: "Eve <b>", message: "<script>alert(1)</script> hello there" }));
  const mail = mocks.seen.email.at(-1);
  assert.doesNotMatch(mail.body.html, /<script>/);
  assert.match(mail.body.html, /&lt;script&gt;/);
});

test("when the email alert fails, the person is asked to send it on WhatsApp or email", async () => {
  const c = client(app.base);
  const r = await c.post("/api/contact", msg({ message: "FAILALL this one please, it is urgent" }));
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, false);
  assert.match(r.data.whatsappUrl, /^https:\/\/wa\.me\/27821234567\?text=/);
  assert.match(r.data.emailUrl, /^mailto:lesego@example\.com/);
  const list = (await adminGet("/api/admin/messages")).data.messages;
  assert.equal(list[0].delivery.email.state, "failed"); // still saved for you
});

test("you can mark messages answered, reopen, export and delete them", async () => {
  const admin = client(app.base);
  const first = (await adminGet("/api/admin/messages")).data.messages.at(-1);
  const act = (action, id = first.id) => admin.post("/api/admin/message-action", { id, action }, ADMIN);
  assert.equal((await client(app.base).post("/api/admin/message-action", { id: first.id, action: "answered" })).status, 401);
  assert.equal((await act("answered")).status, 200);
  let m = (await adminGet("/api/admin/messages")).data.messages.find((x) => x.id === first.id);
  assert.equal(m.status, "answered");
  assert.ok(m.answeredAt);
  await act("new");
  m = (await adminGet("/api/admin/messages")).data.messages.find((x) => x.id === first.id);
  assert.equal(m.status, "new");
  const csv = await adminGet("/api/admin/export/messages.csv");
  assert.match(csv.text, /Received,Reference,Name/);
  assert.match(csv.text, /Naledi Khumalo/);
  const count = (await adminGet("/api/admin/messages")).data.messages.length;
  assert.equal((await act("delete")).status, 200);
  assert.equal((await adminGet("/api/admin/messages")).data.messages.length, count - 1);
  assert.equal((await act("delete")).status, 404);
});

test("signed-in members get their details filled in, and their message is linked to them", async () => {
  const c = client(app.base);
  await c.post("/api/signup", account({ name: "Thabo Mokoena", login: "thabo@example.com" }));
  const pub = await c.get("/api/public");
  assert.equal(pub.data.me.name, "Thabo Mokoena");
  assert.equal(pub.data.me.email, "thabo@example.com");
  await c.post("/api/contact", msg({ name: "Thabo Mokoena", email: "thabo@example.com" }));
  const m = (await adminGet("/api/admin/messages")).data.messages[0];
  assert.equal(m.signedIn, true);
});

// ---------------------------------------------------------------- visitors
test("a visit is counted once per browser, with an anonymous cookie", async () => {
  const before = await visitStats();
  const c = client(app.base);
  const first = await c.get("/login", asPhone());
  assert.equal(first.status, 200);
  const set = first.headers.get("set-cookie");
  assert.match(set, /sd_v=[a-f0-9]{24}/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  const again = await c.get("/contact", asPhone());
  assert.equal(again.headers.get("set-cookie"), null); // same browser, same id
  const after = await visitStats();
  assert.equal(after.totals.today, before.totals.today + 1);
  assert.equal(after.totals.viewsToday, before.totals.viewsToday + 2);
  assert.ok(after.pages30.some((p) => p.page === "/contact"));
  assert.ok(after.devices.mobile >= 1);
});

test("robots, link previews and scripts are not counted", async () => {
  const before = await visitStats();
  for (const ua of ["WhatsApp/2.23.20.0 A", "Googlebot/2.1 (+http://www.google.com/bot.html)", "curl/8.4.0", "", "facebookexternalhit/1.1"]) {
    const r = await client(app.base).get("/login", { headers: { "User-Agent": ua } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
  }
  const after = await visitStats();
  assert.equal(after.totals.viewsAll, before.totals.viewsAll);
});

test("shared links with ?ref= and outside websites show where visitors came from", async () => {
  await client(app.base).get("/contact?ref=whatsapp", asPhone());
  await client(app.base).get("/login", asPC({ Referer: "https://www.linkedin.com/feed/" }));
  await client(app.base).get("/login", asPC({ Referer: "https://www.google.co.za/" }));
  const home = await client(app.base).get("/?ref=qr", asPhone());
  assert.equal(home.headers.get("location"), "/login?ref=qr"); // the tag survives the redirect
  const s = await visitStats();
  const names = s.sources30.map((x) => x.source);
  for (const want of ["WhatsApp", "LinkedIn", "Google"]) assert.ok(names.includes(want), want);
});

test("signed-in visitors show by name; guests are numbered", async () => {
  const c = client(app.base);
  await c.post("/api/signup", account({ name: "Zanele Mthembu", login: "zanele@example.com", company: "BuildCo" }));
  assert.equal((await c.get("/", asPC())).status, 200);
  const s = await visitStats();
  const z = s.recent.find((r) => r.name === "Zanele Mthembu");
  assert.ok(z);
  assert.equal(z.company, "BuildCo");
  assert.equal(z.device, "desktop");
  assert.ok(s.recent.some((r) => /^Guest [0-9A-F]{4}$/.test(r.guest)));
  assert.ok(s.totals.signedIn30 >= 1);
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /zanele@example\.com|scrypt/); // no sign-in details or passwords
});

test("your own visits are left out once you've opened the dashboard in that browser", async () => {
  const mine = client(app.base);
  await mine.get("/login", asPC());
  await mine.get("/contact", asPC());
  const before = await visitStats();
  const dash = await mine.get("/admin", { ...ADMIN, ...asPC() });
  assert.equal(dash.status, 200);
  const after = await visitStats();
  assert.equal(after.totals.today, before.totals.today - 1);
  assert.equal(after.totals.viewsToday, before.totals.viewsToday - 2);
  await mine.get("/contact", asPC()); // and later visits too
  assert.equal((await visitStats()).totals.viewsToday, after.totals.viewsToday);
});

test("your own Site Desk account is recognised: dashboard link shown, visits left out", async () => {
  const me = client(app.base);
  await me.post("/api/signup", account({ name: "Lesego Makgene", login: "lesego@example.com" }));
  const info = await me.get("/api/me");
  assert.equal(info.data.isOwner, true);
  const other = client(app.base);
  await other.post("/api/signup", account({ name: "Other Person", login: "other@example.com" }));
  assert.equal((await other.get("/api/me")).data.isOwner, false);

  const before = await visitStats();
  await me.get("/", asPhone());
  const after = await visitStats();
  assert.equal(after.totals.viewsToday, before.totals.viewsToday);
  assert.ok(!after.recent.some((r) => r.name === "Lesego Makgene"));
});

test("the dashboard has visitor numbers by day, week and month, and a CSV", async () => {
  const s = await visitStats();
  assert.equal(s.days.length, 30);
  assert.equal(s.weeks.length, 12);
  assert.equal(s.months.length, 12);
  assert.equal(s.hours.length, 24);
  assert.ok(s.days.at(-1).visitors >= 1);
  assert.ok(s.weeks.at(-1).visitors >= s.days.at(-1).visitors);
  assert.ok(s.months.at(-1).visitors >= 1);
  assert.equal((await client(app.base).get("/api/admin/visits")).status, 401);
  const csv = await adminGet("/api/admin/export/visits.csv");
  assert.match(csv.text, /Time,Visitor,Person,Page,Device,Came from/);
  assert.match(csv.text, /Zanele Mthembu/);
  const page = await client(app.base).get("/admin", ADMIN);
  assert.match(page.text, /data-tab="visitors"/);
});

test("deleting an account removes their name from visits and messages", async () => {
  const c = client(app.base);
  await c.post("/api/signup", account({ name: "Gone Person", login: "gone@example.com" }));
  await c.get("/", asPhone());
  await c.post("/api/contact", msg({ name: "Gone Person", email: "gone@example.com" }));
  assert.equal((await c.post("/api/account/delete", { password: "Correct-Horse-9" })).status, 200);
  const s = await visitStats();
  assert.ok(!s.recent.some((r) => r.name === "Gone Person"));
  const m = (await adminGet("/api/admin/messages")).data.messages.find((x) => x.name === "Gone Person");
  assert.equal(m.signedIn, false);
});

// ---------------------------------------------------------------- keeping the live app safe
test("live sessions and chat still work exactly as before", async () => {
  const c = client(app.base);
  await c.post("/api/signup", account({ name: "Live User", login: "live@example.com" }));
  const chat = await c.post("/api/chat", { messages: [{ role: "user", content: "How do I create an RFI?" }] });
  assert.equal(chat.status, 200);
  const r = await c.post("/api/request-session", { contact: "0821112222", topic: "RFIs", details: "Stuck" });
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, true);
  assert.match(r.data.whatsappUrl, /^https:\/\/wa\.me\//);
  assert.match(mocks.seen.email.at(-1).body.subject, /Live User wants a live session/);
});

test("contact messages are limited per connection to stop floods", async () => {
  const a = await startApp({ ANTHROPIC_API_URL: mocks.anthropicUrl });
  const c = client(a.base);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await c.post("/api/contact", msg({ message: "Message number " + i }))).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429]);
  await a.stop();
});

test("data from the current live version loads untouched, and new data survives a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-upgrade-"));
  // Start the app once to make real accounts the way the live version does.
  let a = await startApp({ ANTHROPIC_API_URL: mocks.anthropicUrl, DATA_DIR: dir });
  const c = client(a.base);
  await c.post("/api/signup", account({ login: "existing@example.com" }));
  await c.post("/api/request-session", { contact: "0821112222", topic: "RFIs" });
  const cookie = c.cookie();
  await a.stop();
  // Pretend this folder came from the live version: no visit or message files yet.
  for (const f of ["visits.jsonl", "messages.jsonl", "owner.json"]) fs.rmSync(path.join(dir, f), { force: true });
  const keyFields = (raw) => JSON.parse(raw).map((u) => [u.id, u.name, u.loginKey, u.pw, u.createdAt, u.disabled].join("|"));
  const usersBefore = keyFields(fs.readFileSync(path.join(dir, "users.json"), "utf8"));
  const requestsBefore = fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8");
  // An old visit (over 13 months) that should be tidied away.
  fs.writeFileSync(path.join(dir, "visits.jsonl"), JSON.stringify({ t: Date.now() - 500 * 86400e3, v: "a".repeat(24), p: "/login", d: "mobile" }) + "\n");

  a = await startApp({ ANTHROPIC_API_URL: mocks.anthropicUrl, DATA_DIR: dir });
  try {
    const again = client(a.base); again.setCookie(cookie);
    assert.equal((await again.get("/api/me")).status, 200); // still signed in
    assert.deepEqual(keyFields(fs.readFileSync(path.join(dir, "users.json"), "utf8")), usersBefore);
    assert.equal(fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8"), requestsBefore);
    const reqs = await client(a.base).get("/api/admin/requests", ADMIN);
    assert.equal(reqs.data.requests.length, 1);
    const s = (await client(a.base).get("/api/admin/visits", ADMIN)).data;
    assert.equal(s.totals.viewsAll, 0); // the old visit was dropped
    await client(a.base).get("/login", asPhone());
    await client(a.base).post("/api/contact", msg());
  } finally { await a.stop(); }

  a = await startApp({ ANTHROPIC_API_URL: mocks.anthropicUrl, DATA_DIR: dir });
  try {
    const s = (await client(a.base).get("/api/admin/visits", ADMIN)).data;
    assert.equal(s.totals.viewsAll, 1);
    assert.equal((await client(a.base).get("/api/admin/messages", ADMIN)).data.messages.length, 1);
  } finally { await a.stop(); }
});
