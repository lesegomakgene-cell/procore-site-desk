"use strict";
// Visitor analytics: which pages are opened, by whom, from where, and the
// day / week / month totals shown on the admin Visitors tab.
//
// A visit is one page opened in a browser: { t, v, p, u?, d, s?, n? }
//   t  time (ms)              v  anonymous visitor id (random, from the sd_v cookie)
//   p  page ("/login", ...)   u  user id, when the person is signed in
//   d  device                 s  where they came from ("" = direct, "=" = within the site)
//   n  1 when this was the visitor's first ever page
// Days, weeks (Monday to Sunday) and months are South African time.
const { dayKey } = require("./stats");
// A "visitor" is a signed-in person, or else one browser (phone or computer).

const OFFSET = 2 * 3600e3;
const DAY = 86400e3;

// Link previews, search engines, uptime monitors and scripts are not people.
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|skype|embedly|vkshare|pinterest|bitly|curl|wget|python|httpclient|okhttp|axios|node-fetch|undici|go-http|java\/|libwww|headless|phantom|lighthouse|pagespeed|pingdom|uptime|monitor|statuscake|render\/|scanner|checker/i;

function isBot(ua) {
  const s = String(ua || "");
  return !s || s.length < 20 || BOT_RE.test(s);
}

// Things like ?ref=whatsapp on a link you share.
const TAGS = {
  whatsapp: "WhatsApp", wa: "WhatsApp", linkedin: "LinkedIn", li: "LinkedIn",
  facebook: "Facebook", fb: "Facebook", instagram: "Instagram", ig: "Instagram",
  email: "Email", mail: "Email", outlook: "Email", gmail: "Email", newsletter: "Email",
  qr: "QR code", qrcode: "QR code", poster: "QR code", google: "Google",
  x: "X (Twitter)", twitter: "X (Twitter)", sms: "SMS", teams: "Teams", procore: "Procore",
};

const HOSTS = [
  [/(^|\.)google\./, "Google"], [/(^|\.)bing\.com$/, "Bing"], [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "LinkedIn"], [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"], [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "X (Twitter)"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "WhatsApp"],
  [/(^|\.)(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.google\.com|mail\.yahoo\.com)$/, "Email"],
  [/(^|\.)teams\.microsoft\.com$/, "Teams"], [/(^|\.)procore\.com$/, "Procore"], [/(^|\.)github\.com$/, "GitHub"],
];

function sourceOf(req, url) {
  const tag = String(url.searchParams.get("ref") || url.searchParams.get("utm_source") || "").trim().toLowerCase();
  if (tag) {
    if (TAGS[tag]) return TAGS[tag];
    const clean = tag.replace(/[^a-z0-9 ._-]/g, "").slice(0, 30);
    if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return "";
  let host;
  try { host = new URL(ref).host.toLowerCase(); } catch { return ""; }
  if (host === String(req.headers.host || "").toLowerCase()) return "=";
  const bare = host.replace(/^www\./, "").replace(/:\d+$/, "");
  for (const [re, label] of HOSTS) if (re.test(bare)) return label;
  return bare.slice(0, 60);
}

// Monday of the week, as "2026-11-23".
function weekKey(t) {
  const dow = new Date(t + OFFSET).getUTCDay(); // 0 = Sunday
  return dayKey(t - ((dow + 6) % 7) * DAY);
}
const monthKey = (t) => dayKey(t).slice(0, 7);

function lastMonths(now, n) {
  const d = new Date(now + OFFSET);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m + 1).padStart(2, "0")}`);
    if (--m < 0) { m = 11; y--; }
  }
  return out;
}

function inc(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

function bucketList(keys) {
  return new Map(keys.map((k) => [k, { key: k, visitors: new Set(), views: 0 }]));
}
function flatten(buckets) {
  return [...buckets.values()].map((b) => ({ key: b.key, visitors: b.visitors.size, views: b.views }));
}

function compute({ visits, users, ownerVids = [], ownerUids = [] }, now = Date.now()) {
  const hideV = new Set(ownerVids), hideU = new Set(ownerUids);
  const today = dayKey(now), yesterday = dayKey(now - DAY);
  const t7 = now - 7 * DAY, t14 = now - 14 * DAY, t30 = now - 30 * DAY;

  const dayKeys = []; for (let i = 29; i >= 0; i--) dayKeys.push(dayKey(now - i * DAY));
  const weekKeys = []; for (let i = 11; i >= 0; i--) weekKeys.push(weekKey(now - i * 7 * DAY));
  const days = bucketList(dayKeys), weeks = bucketList(weekKeys), months = bucketList(lastMonths(now, 12));

  const sets = { today: new Set(), yesterday: new Set(), d7: new Set(), prev7: new Set(), d30: new Set(), all: new Set() };
  const views = { today: 0, yesterday: 0, d7: 0, d30: 0, all: 0 };
  const signedIn30 = new Set();
  const pages = new Map(), pageVisitors = new Map();
  const sources = new Map();
  const hours = new Array(24).fill(0);
  const who = new Map(); // visitor -> details
  let since = null;

  // A signed-in person counts once, whichever phone or computer they use, and
  // their visits from before they signed in on that browser count as theirs.
  const uidOf = new Map();
  for (const v of visits) if (v && v.v && v.u) uidOf.set(v.v, v.u);
  const hidden = (v) => !v || !v.v || hideV.has(v.v) || hideU.has(v.u) || hideU.has(uidOf.get(v.v));
  const keyOf = (v) => (uidOf.has(v.v) ? "u:" + uidOf.get(v.v) : "v:" + v.v);

  for (const v of visits) {
    if (hidden(v)) continue;
    const t = v.t;
    const day = dayKey(t);
    const k = keyOf(v);
    if (since === null || t < since) since = t;

    sets.all.add(k); views.all++;
    if (day === today) { sets.today.add(k); views.today++; }
    if (day === yesterday) { sets.yesterday.add(k); views.yesterday++; }
    if (t >= t7) { sets.d7.add(k); views.d7++; }
    else if (t >= t14) sets.prev7.add(k);

    const db = days.get(day); if (db) { db.visitors.add(k); db.views++; }
    const wb = weeks.get(weekKey(t)); if (wb) { wb.visitors.add(k); wb.views++; }
    const mb = months.get(monthKey(t)); if (mb) { mb.visitors.add(k); mb.views++; }

    let w = who.get(k);
    if (!w) {
      w = { vid: v.v, first: t, last: t, days: new Set(), days30: new Set(), views30: 0, uid: uidOf.get(v.v) || null, device: v.d, devices: new Set(), source: null, lastPage: v.p };
      who.set(k, w);
    }
    if (v.d) w.devices.add(v.d);
    if (t < w.first) w.first = t;
    if (t >= w.last) { w.last = t; w.lastPage = v.p; w.device = v.d || w.device; }
    w.days.add(day);
    if (v.s !== undefined && v.s !== "=" && w.source === null) w.source = v.s;

    if (t >= t30) {
      sets.d30.add(k); views.d30++;
      w.views30++; w.days30.add(day);
      if (w.uid) signedIn30.add(k);
      const page = v.p || "?";
      inc(pages, page);
      if (!pageVisitors.has(page)) pageVisitors.set(page, new Set());
      pageVisitors.get(page).add(k);
      hours[new Date(t + OFFSET).getUTCHours()]++;
    }
  }

  // where people came from: each visitor once, by the first outside link they used in the last 30 days
  const firstSource30 = new Map();
  for (const v of visits) {
    if (hidden(v) || v.t < t30 || v.s === "=") continue;
    const k = keyOf(v);
    if (!firstSource30.has(k)) firstSource30.set(k, v.s || "");
  }
  for (const s of firstSource30.values()) inc(sources, s || "Direct");

  const devices = { mobile: 0, desktop: 0, tablet: 0 };
  let new30 = 0, returning30 = 0;
  for (const w of who.values()) {
    if (w.last < t30) continue;
    devices[w.device] = (devices[w.device] || 0) + 1;
    if (w.first >= t30) new30++;
    if (w.days.size >= 2) returning30++;
  }

  const byId = new Map(users.map((u) => [u.id, u]));
  const recent = [...who.values()]
    .filter((w) => w.last >= t30)
    .sort((a, b) => b.last - a.last)
    .slice(0, 100)
    .map((w) => {
      const u = w.uid ? byId.get(w.uid) : null;
      return {
        name: u ? u.name : "",
        company: u ? u.company || "" : "",
        guest: u ? "" : w.uid ? "Former member" : "Guest " + w.vid.slice(0, 4).toUpperCase(),
        firstSeen: w.first, lastSeen: w.last,
        days30: w.days30.size, views30: w.views30,
        device: w.device || "", devices: [...w.devices], source: w.source || "", lastPage: w.lastPage || "",
      };
    });

  const change7 = sets.prev7.size ? Math.round(((sets.d7.size - sets.prev7.size) / sets.prev7.size) * 100) : null;

  return {
    generatedAt: now,
    since,
    totals: {
      today: sets.today.size, viewsToday: views.today,
      yesterday: sets.yesterday.size, viewsYesterday: views.yesterday,
      d7: sets.d7.size, views7: views.d7, prev7: sets.prev7.size, change7,
      d30: sets.d30.size, views30: views.d30, new30, returning30,
      signedIn30: signedIn30.size, guests30: sets.d30.size - signedIn30.size,
      all: sets.all.size, viewsAll: views.all,
    },
    days: flatten(days), weeks: flatten(weeks), months: flatten(months),
    pages30: [...pages.entries()].sort((a, b) => b[1] - a[1]).map(([page, n]) => ({ page, views: n, visitors: pageVisitors.get(page).size })),
    sources30: [...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([source, count]) => ({ source, count })),
    devices,
    hours,
    recent,
  };
}

module.exports = { isBot, sourceOf, weekKey, compute };
