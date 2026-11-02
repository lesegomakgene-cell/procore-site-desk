"use strict";
// Turns the usage log into the numbers shown on the admin dashboard.
// Days are counted in South African time (UTC+2, no daylight saving).
const OFFSET = 2 * 3600e3;
const DAY = 86400e3;

const dayKey = (t) => new Date(t + OFFSET).toISOString().slice(0, 10);
const hourOf = (t) => new Date(t + OFFSET).getUTCHours();

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
function inc(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

function compute({ users, events, requests }, now = Date.now()) {
  const today = dayKey(now);
  const t7 = now - 7 * DAY;
  const t30 = now - 30 * DAY;

  // last 30 days as buckets
  const dayList = [];
  for (let i = 29; i >= 0; i--) dayList.push(dayKey(now - i * DAY));
  const perDay = new Map(dayList.map((d) => [d, { day: d, signups: 0, questions: 0, active: new Set() }]));

  const activeDaysByUser = new Map(); // uid -> Set(days)
  const activeToday = new Set(), active7 = new Set(), active30 = new Set();
  const askers30 = new Set();
  const questionsByUser = new Map();
  const lastActive = new Map();
  const requestsByUser = new Set();
  const topics30 = new Map(), topicsAll = new Map();
  const hours = new Array(24).fill(0);
  const sources = { topic: 0, typed: 0 };
  const deviceByUser = new Map();
  const feedback = new Map(); // message id -> 1 | -1
  const latencies = [];
  let questions = 0, questions7 = 0, questions30 = 0, questionsToday = 0;
  let errors30 = 0, chats30 = 0, failedLogins7 = 0, offerClicks30 = 0;

  for (const ev of events) {
    const uid = ev.uid && ev.uid !== "deleted" ? ev.uid : null;
    const day = dayKey(ev.t);

    if (uid && ev.type !== "login_fail") {
      if (!activeDaysByUser.has(uid)) activeDaysByUser.set(uid, new Set());
      activeDaysByUser.get(uid).add(day);
      if (!lastActive.has(uid) || ev.t > lastActive.get(uid)) lastActive.set(uid, ev.t);
      if (day === today) activeToday.add(uid);
      if (ev.t >= t7) active7.add(uid);
      if (ev.t >= t30) active30.add(uid);
      const b = perDay.get(day);
      if (b) b.active.add(uid);
    }
    if (ev.device && uid) deviceByUser.set(uid, ev.device);

    switch (ev.type) {
      case "chat": {
        questions++;
        if (uid) inc(questionsByUser, uid);
        inc(topicsAll, ev.topic || "Other");
        if (day === today) questionsToday++;
        if (ev.t >= t7) questions7++;
        if (ev.t >= t30) {
          questions30++; chats30++;
          if (uid) askers30.add(uid);
          inc(topics30, ev.topic || "Other");
          hours[hourOf(ev.t)]++;
          if (ev.ok === false) errors30++;
          else if (typeof ev.ms === "number") latencies.push(ev.ms);
          if (ev.src === "topic") sources.topic++; else sources.typed++;
        }
        const b = perDay.get(day);
        if (b) b.questions++;
        break;
      }
      case "feedback":
        if (ev.mid) feedback.set(ev.mid, ev.v === 1 ? 1 : -1);
        break;
      case "session_request":
        if (uid) requestsByUser.add(uid);
        break;
      case "login_fail":
        if (ev.t >= t7) failedLogins7++;
        break;
      case "offer_click":
        if (ev.t >= t30) offerClicks30++;
        break;
    }
  }

  // sign-ups come from the user list (the source of truth)
  let signupsToday = 0, signups7 = 0, signups30 = 0;
  const roles = new Map(), companies = new Map();
  for (const u of users) {
    if (dayKey(u.createdAt) === today) signupsToday++;
    if (u.createdAt >= t7) signups7++;
    if (u.createdAt >= t30) signups30++;
    const b = perDay.get(dayKey(u.createdAt));
    if (b) b.signups++;
    inc(roles, u.role || "Not given");
    if (u.company) inc(companies, u.company.trim());
  }

  let returning = 0;
  for (const days of activeDaysByUser.values()) if (days.size >= 2) returning++;

  let up = 0, down = 0;
  for (const v of feedback.values()) v === 1 ? up++ : down++;

  const devices = { mobile: 0, desktop: 0, tablet: 0 };
  for (const uid of deviceByUser.keys()) {
    if (users.some((u) => u.id === uid)) devices[deviceByUser.get(uid)] = (devices[deviceByUser.get(uid)] || 0) + 1;
  }

  latencies.sort((a, b) => a - b);
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const p95Ms = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;

  const usersWithChats = new Set(questionsByUser.keys());
  const neverAsked = users.filter((u) => !usersWithChats.has(u.id)).length;

  const requests7 = requests.filter((r) => r.receivedAt >= t7).length;
  const requestsToday = requests.filter((r) => dayKey(r.receivedAt) === today).length;

  const nameOf = new Map(users.map((u) => [u.id, u]));
  const topUsers = top(questionsByUser, 10)
    .filter(([uid]) => nameOf.has(uid))
    .map(([uid, n]) => {
      const u = nameOf.get(uid);
      return { id: uid, name: u.name, company: u.company || "", role: u.role || "", questions: n, lastActive: lastActive.get(uid) || null };
    });

  const recentSignups = [...users]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8)
    .map((u) => ({ id: u.id, name: u.name, company: u.company || "", role: u.role || "", createdAt: u.createdAt }));

  return {
    generatedAt: now,
    totals: {
      users: users.length,
      disabled: users.filter((u) => u.disabled).length,
      signupsToday, signups7, signups30,
      activeToday: activeToday.size, active7: active7.size, active30: active30.size,
      returning,
      neverAsked,
      questions, questions7, questions30, questionsToday,
      avgQuestionsPerAsker30: askers30.size ? +(questions30 / askers30.size).toFixed(1) : 0,
      sessionRequests: requests.length, requests7, requestsToday,
      requestRate: users.length ? Math.round((requestsByUser.size / users.length) * 100) : 0,
      helpful: { up, down, rate: up + down ? Math.round((up / (up + down)) * 100) : null },
      errorRate30: chats30 ? Math.round((errors30 / chats30) * 100) : 0,
      avgMs, p95Ms,
      offerClicks30,
      failedLogins7,
    },
    days: dayList.map((d) => {
      const b = perDay.get(d);
      return { day: d, signups: b.signups, questions: b.questions, active: b.active.size };
    }),
    topics30: top(topics30, 12).map(([topic, count]) => ({ topic, count })),
    topicsAll: top(topicsAll, 12).map(([topic, count]) => ({ topic, count })),
    hours,
    sources,
    devices,
    roles: top(roles, 10).map(([role, count]) => ({ role, count })),
    companies: top(companies, 8).map(([company, count]) => ({ company, count })),
    topUsers,
    recentSignups,
  };
}

module.exports = { compute, dayKey };
