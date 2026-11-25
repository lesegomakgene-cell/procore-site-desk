"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../lib/util");
const { compute } = require("../lib/stats");
const { classify } = require("../lib/topics");
const { checkPassword, hashPassword, verifyPassword } = require("../lib/auth");

test("phone numbers are normalised the South African way", () => {
  assert.equal(U.normalisePhone("082 111 2222"), "27821112222");
  assert.equal(U.normalisePhone("+27 82 111 2222"), "27821112222");
  assert.equal(U.normalisePhone("0027821112222"), "27821112222");
  assert.equal(U.normalisePhone("821112222"), "27821112222");
  assert.equal(U.normalisePhone("a@b.com"), "");
  assert.equal(U.normalisePhone("12"), "");
});

test("sign-in names are emails or phones, and stored in one canonical form", () => {
  assert.equal(U.parseLogin("Sipho@Example.COM").key, "e:sipho@example.com");
  assert.equal(U.parseLogin("082 111 2222").key, U.parseLogin("+27821112222").key);
  assert.equal(U.parseLogin("hello"), null);
});

test("CSV cells cannot run formulas in Excel", () => {
  assert.equal(U.csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(U.csvCell("+1"), "'+1");
  assert.equal(U.csvCell("a,b"), '"a,b"');
  assert.equal(U.csvCell(null), "");
});

test("passwords: weak ones are refused, hashes are salted and verify", async () => {
  assert.ok(checkPassword("short"));
  assert.ok(checkPassword("password1"));
  assert.ok(checkPassword("aaaaaaaaaa"));
  assert.ok(checkPassword("sipho@example.com", "e:sipho@example.com"));
  assert.equal(checkPassword("Correct-Horse-9"), "");
  const h1 = await hashPassword("Correct-Horse-9"), h2 = await hashPassword("Correct-Horse-9");
  assert.notEqual(h1, h2);
  assert.ok(await verifyPassword("Correct-Horse-9", h1));
  assert.ok(!(await verifyPassword("wrong", h1)));
  assert.ok(!(await verifyPassword("x", "garbage")));
});

test("questions are sorted into topics", () => {
  assert.equal(classify("How do I raise an RFI?"), "RFIs");
  assert.equal(classify("report a near miss"), "Incidents");
  assert.equal(classify("where is the weather in the daily log"), "Daily Log");
  assert.equal(classify("I forgot my password"), "Access & permissions");
  assert.equal(classify("blah"), "Other");
});

test("statistics count the right people on the right days (South African time)", () => {
  // 2 Nov 2026 12:00 SAST
  const now = Date.UTC(2026, 10, 2, 10, 0, 0);
  const H = 3600e3, D = 24 * H;
  const users = [
    { id: "a", name: "A", createdAt: now - 1 * H, role: "Foreman / supervisor", company: "X" },
    { id: "b", name: "B", createdAt: now - 3 * D, role: "Subcontractor", company: "X" },
    { id: "c", name: "C", createdAt: now - 40 * D, role: "Subcontractor" },
  ];
  const events = [
    { t: now - H, uid: "a", type: "chat", topic: "RFIs", src: "topic", ok: true, ms: 2000, mid: "m1", device: undefined },
    { t: now - H, uid: "a", type: "login", device: "mobile" },
    { t: now - 2 * D, uid: "b", type: "chat", topic: "RFIs", src: "typed", ok: true, ms: 4000, mid: "m2" },
    { t: now - 2 * D + H, uid: "b", type: "chat", topic: "Photos", src: "typed", ok: false, ms: 100, mid: "m3" },
    { t: now - 20 * D, uid: "b", type: "chat", topic: "Photos", src: "typed", ok: true, ms: 3000, mid: "m4" },
    { t: now - 100 * D, uid: "c", type: "login", device: "desktop" },
    { t: now - H, uid: "a", type: "feedback", mid: "m1", v: 1 },
    { t: now - H, uid: "b", type: "feedback", mid: "m2", v: -1 },
    { t: now - H, uid: "b", type: "feedback", mid: "m2", v: 1 }, // changed their mind: counts once
    { t: now - H, uid: "a", type: "session_request" },
    { t: now - H, type: "login_fail" },
    { t: now - H, uid: "deleted", type: "chat", topic: "RFIs", ok: true, ms: 1000 }, // removed person: still in totals
  ];
  const requests = [{ id: "SD-1", receivedAt: now - H }];
  const s = compute({ users, events, requests }, now);
  const t = s.totals;

  assert.equal(t.users, 3);
  assert.equal(t.signups7, 2);
  assert.equal(t.signupsToday, 1);
  assert.equal(t.activeToday, 2);         // A, and B (who gave feedback today)
  assert.equal(t.active7, 2);             // A and B
  assert.equal(t.active30, 2);            // C's activity is 100 days old
  assert.equal(t.questions, 5);
  assert.equal(t.questionsToday, 2);      // A's, plus the deleted person's
  assert.equal(t.questions7, 4);
  assert.equal(t.questions30, 5);
  assert.equal(t.returning, 1);           // B was active on two different days
  assert.equal(t.neverAsked, 1);          // C
  assert.equal(t.sessionRequests, 1);
  assert.equal(t.requestRate, 33);
  assert.deepEqual(t.helpful, { up: 2, down: 0, rate: 100 });
  assert.equal(t.errorRate30, 20);        // 1 of 5
  assert.equal(t.avgMs, 2500);            // failed answer excluded
  assert.equal(t.failedLogins7, 1);
  assert.deepEqual(s.topics30[0], { topic: "RFIs", count: 3 });
  assert.equal(s.sources.topic, 1);
  assert.equal(s.devices.mobile, 1);
  assert.equal(s.devices.desktop, 1);
  assert.equal(s.topUsers[0].name, "B");
  assert.equal(s.days.at(-1).questions, 2);
  assert.equal(s.hours[12], 2);           // 10:00 UTC is noon in South Africa
});

test("visitors are counted by South African day, Monday-to-Sunday week and month", () => {
  const V = require("../lib/visits");
  // Wed 25 Nov 2026, 12:00 SAST
  const now = Date.UTC(2026, 10, 25, 10, 0, 0);
  const H = 3600e3, D = 24 * H;
  const vid = (c) => c.repeat(24);
  const visits = [
    { t: now - H, v: vid("a"), p: "/login", d: "mobile", s: "WhatsApp", n: 1 },
    { t: now - H + 60e3, v: vid("a"), p: "/", d: "mobile", u: "u1", s: "=" },
    { t: now - 2 * H, v: vid("b"), p: "/contact", d: "desktop", s: "" },
    { t: now - 13 * H, v: vid("c"), p: "/login", d: "mobile" },            // 23:00 the night before: yesterday in SA
    { t: now - 3 * D, v: vid("a"), p: "/login", d: "mobile" },             // Sunday 22 Nov: last week
    { t: now - 9 * D, v: vid("d"), p: "/login", d: "tablet", s: "LinkedIn" }, // previous 7 days
    { t: now - 40 * D, v: vid("e"), p: "/login", d: "desktop" },           // October
    { t: now - H, v: vid("f"), p: "/login", d: "desktop" },                // the creator's browser
    { t: now - H, v: vid("g"), p: "/", d: "desktop", u: "owner" },         // the creator signed in
  ];
  const users = [{ id: "u1", name: "Sipho", company: "Acme" }, { id: "owner", name: "Lesego" }];
  const s = V.compute({ visits, users, ownerVids: [vid("f")], ownerUids: ["owner"] }, now);
  const t = s.totals;
  assert.equal(t.today, 2);          // a and b
  assert.equal(t.viewsToday, 3);
  assert.equal(t.yesterday, 1);      // c
  assert.equal(t.d7, 3);             // a, b, c
  assert.equal(t.prev7, 1);          // d
  assert.equal(t.change7, 200);
  assert.equal(t.d30, 4);
  assert.equal(t.all, 5);
  assert.equal(t.signedIn30, 1);
  assert.equal(t.returning30, 1);    // a came on two different days
  assert.equal(s.weeks.at(-1).key, "2026-11-23"); // Monday
  assert.equal(s.weeks.at(-1).visitors, 3);       // a, b, c (Mon 23 to today)
  assert.equal(s.weeks.at(-2).visitors, 2);       // a on Sunday 22nd, d on Monday 16th
  assert.equal(s.months.at(-1).key, "2026-11");
  assert.equal(s.months.at(-1).visitors, 4);
  assert.equal(s.months.at(-2).visitors, 1);      // e in October
  assert.equal(s.days.at(-1).views, 3);
  assert.equal(s.hours[11], 2);                   // 11:00 SAST
  const src = Object.fromEntries(s.sources30.map((x) => [x.source, x.count]));
  assert.equal(src.WhatsApp, 1);
  assert.equal(src.LinkedIn, 1);
  assert.equal(src.Direct, 2); // b and c
  assert.equal(s.recent[0].name, "Sipho");
  assert.equal(s.recent[0].company, "Acme");
  assert.ok(!JSON.stringify(s).includes("Lesego"));
  assert.ok(s.recent.some((r) => r.guest === "Guest BBBB"));
});

test("robots are recognised, and links say where people came from", () => {
  const V = require("../lib/visits");
  assert.equal(V.isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1"), false);
  for (const ua of ["WhatsApp/2.23", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.4", "", "python-requests/2.31"]) assert.equal(V.isBot(ua), true, ua);
  const req = (ref) => ({ headers: { host: "sd.example", referer: ref } });
  const u = (q = "") => new URL("http://sd.example/login" + q);
  assert.equal(V.sourceOf(req(), u("?ref=whatsapp")), "WhatsApp");
  assert.equal(V.sourceOf(req(), u("?utm_source=Site-Poster")), "Site-poster");
  assert.equal(V.sourceOf(req("https://www.google.co.za/"), u()), "Google");
  assert.equal(V.sourceOf(req("https://lnkd.in/abc"), u()), "LinkedIn");
  assert.equal(V.sourceOf(req("http://sd.example/contact"), u()), "=");
  assert.equal(V.sourceOf(req("https://www.someblog.co.za/post"), u()), "someblog.co.za");
  assert.equal(V.sourceOf(req(), u()), "");
});
