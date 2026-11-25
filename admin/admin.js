"use strict";
(function () {
  // ---------- tiny DOM helpers (no innerHTML: everything is text, so it's safe) ----------
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const kid of kids) if (kid) e.append(kid);
    return e;
  }

  const TZ = "Africa/Johannesburg";
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleString("en-ZA", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "-";
  const fmtDay = (key) => { const [, m, d] = key.split("-"); return Number(d) + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]; };
  function ago(ms) {
    if (!ms) return "never";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 86400 * 30) { const d = Math.round(s / 86400); return d === 1 ? "yesterday" : d + " days ago"; }
    return fmtDate(ms).split(",")[0];
  }

  async function get(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" });
    let data = {};
    try { data = await r.json(); } catch {}
    return { ok: r.ok, data };
  }

  // ---------- charts ----------
  function barChart(rows, key, cls, labelOf, every) {
    const W = 600, H = 150, padL = 28, padB = 22, padT = 10;
    const max = Math.max(1, ...rows.map((d) => d[key]));
    const s = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img" });
    s.append(
      svg("line", { class: "axis", x1: padL, x2: W, y1: H - padB, y2: H - padB }),
      Object.assign(svg("text", { x: 0, y: padT + 4 }), { textContent: String(max) }),
      Object.assign(svg("text", { x: 0, y: H - padB }), { textContent: "0" })
    );
    const bw = (W - padL) / rows.length;
    rows.forEach((d, i) => {
      const h = (H - padB - padT) * (d[key] / max);
      const x = padL + i * bw;
      if (h > 0) {
        const title = svg("title"); title.textContent = labelOf(d) + ": " + d[key];
        s.append(svg("rect", { class: "bar " + cls, x: x + 1, y: H - padB - h, width: Math.max(1, bw - 2), height: h, rx: 2 }, title));
      }
      if (i % every === 0) s.append(Object.assign(svg("text", { x: x, y: H - 6 }), { textContent: labelOf(d, true) }));
    });
    return s;
  }

  function hbars(items, nameKey, cls) {
    if (!items.length) return el("p", { class: "muted small", text: "Nothing yet." });
    const max = Math.max(1, ...items.map((i) => i.count));
    return el("div", null, items.map((i) => {
      const fill = el("div", { class: "fill " + (cls || "") });
      fill.style.width = Math.max(2, (i.count / max) * 100) + "%";
      return el("div", { class: "hbar" }, el("div", { class: "name", text: i[nameKey], title: i[nameKey] }), el("div", { class: "track" }, fill), el("div", { class: "n", text: i.count }));
    }));
  }

  const kpi = (num, label, sub) => el("div", { class: "card kpi" }, el("div", { class: "num", text: num }), el("div", { class: "lbl", text: label }), sub ? el("div", { class: "sub", text: sub }) : null);
  const panel = (title, note, ...body) => el("div", { class: "card panel" }, el("h3", { text: title }), note ? el("p", { class: "panel-note", text: note }) : null, ...body);

  // ---------- modal ----------
  const modal = document.getElementById("modal");
  function openModal(title, bodyNodes, actions) {
    document.getElementById("modalTitle").textContent = title;
    const body = document.getElementById("modalBody"), act = document.getElementById("modalActions");
    body.textContent = ""; act.textContent = "";
    body.append(...bodyNodes);
    act.append(...actions);
    modal.classList.add("open");
  }
  const closeModal = () => modal.classList.remove("open");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeModal(); });

  // ---------- state ----------
  let S = { stats: null, status: null, users: [], requests: [], visits: null, messages: [] };
  let search = "";
  let vPeriod = "days", vMetric = "visitors", msgFilter = "new", showAllVisitors = false;

  // ---------- Visitors ----------
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const PAGE_NAMES = { "/login": "Sign-in page", "/signup": "Create account", "/": "Chat (signed in)", "/contact": "Contact page" };
  const pageName = (p) => PAGE_NAMES[p] || p;
  const DEVICE_NAMES = { mobile: "Phone", desktop: "Computer", tablet: "Tablet" };

  function segmented(options, current, onPick) {
    return el("div", { class: "seg", role: "group" }, options.map(([value, label]) =>
      el("button", { type: "button", "aria-pressed": String(value === current), text: label, onclick: () => onPick(value) })));
  }

  function renderVisitors() {
    const root = document.getElementById("view-visitors");
    root.textContent = "";
    const V = S.visits, st = S.status;
    if (!V) { root.append(el("div", { class: "card empty", text: "Couldn't load the visitor numbers. Press Refresh." })); return; }
    const t = V.totals;

    if (st && !st.storage.persistent) {
      root.append(el("div", { class: "alert alert-warn visit-note" },
        el("strong", { text: "Counting since " + fmtDate(st.storage.startedAt) + ". " }),
        "On Render's free plan the app forgets everything when it goes to sleep (after about 15 minutes with no visitors) or restarts, so these numbers start again from zero. Adding a disk keeps them (see the Health tab)."));
    }

    let trend = null, trendCls = "";
    if (t.change7 != null) {
      trend = (t.change7 > 0 ? "Up " : t.change7 < 0 ? "Down " : "Same as ") + (t.change7 === 0 ? "the 7 days before" : Math.abs(t.change7) + "% on the 7 days before");
      trendCls = t.change7 > 0 ? "up" : t.change7 < 0 ? "down" : "";
    }
    const k7 = kpi(t.d7, "Visitors, last 7 days", trend || `${t.views7} pages viewed`);
    if (trendCls) k7.querySelector(".sub").classList.add(trendCls);
    root.append(el("div", { class: "kpis" },
      kpi(t.today, "Visitors today", `${t.viewsToday} pages viewed. Yesterday: ${t.yesterday} visitors`),
      k7,
      kpi(t.d30, "Visitors, last 30 days", `${t.new30} new, ${t.returning30} came back on another day`),
      kpi(t.signedIn30, "Signed-in visitors (30 days)", `${t.guests30} visitors who weren't signed in`),
      kpi(t.all, "Visitors, all time", V.since ? `${t.viewsAll} pages viewed since ${fmtDate(V.since).split(",")[0]}` : "No visits yet")
    ));

    // visitors over time
    const rows = V[vPeriod];
    const labelOf = vPeriod === "months"
      ? (d) => { const [y, m] = d.key.split("-"); return MONTHS[Number(m) - 1] + " " + y.slice(2); }
      : vPeriod === "weeks" ? (d, short) => (short ? "" : "Week of ") + fmtDay(d.key) : (d) => fmtDay(d.key);
    const every = vPeriod === "days" ? 5 : vPeriod === "weeks" ? 2 : 1;
    const periodNote = { days: "Each day, last 30 days", weeks: "Each week (Monday to Sunday), last 12 weeks", months: "Each month, last 12 months" }[vPeriod];
    root.append(el("div", { class: "card panel" },
      el("div", { class: "panel-head" },
        el("h3", { text: vMetric === "visitors" ? "Visitors over time" : "Pages viewed over time" }),
        el("div", { class: "seg-group" },
          segmented([["days", "Days"], ["weeks", "Weeks"], ["months", "Months"]], vPeriod, (v) => { vPeriod = v; renderVisitors(); }),
          segmented([["visitors", "Visitors"], ["views", "Page views"]], vMetric, (v) => { vMetric = v; renderVisitors(); }))),
      el("p", { class: "panel-note", text: periodNote + ". Each visitor counts once per " + vPeriod.slice(0, -1) + ". Signed-in people count once even on several devices; anyone else counts once per phone or computer." }),
      barChart(rows, vMetric, vMetric === "visitors" ? "" : "brass", labelOf, every)));

    const pageItems = V.pages30.map((x) => ({ name: pageName(x.page), count: x.visitors }));
    const srcItems = V.sources30.map((x) => ({ name: x.source, count: x.count }));
    const base = (st && st.appUrl) || location.origin;
    root.append(el("div", { class: "grid-2" },
      panel("Pages they open", "Visitors per page, last 30 days", hbars(pageItems, "name")),
      panel("Where they came from", "Last 30 days. Direct means they typed the address, used a bookmark, or tapped a link in an app that doesn't say where it came from (WhatsApp usually doesn't).", hbars(srcItems, "name", "brass"),
        el("p", { class: "tip" }, "Tip: add ", el("code", { text: "?ref=whatsapp" }), " (or linkedin, email, qr) to links you share, for example ",
          el("code", { text: base + "/contact?ref=whatsapp" }), ", to see which ones bring people in."))
    ));

    root.append(el("div", { class: "grid-2" },
      panel("Phone or computer", "Visitors, last 30 days",
        el("div", { class: "devices" },
          el("div", { class: "pill" }, el("b", { text: V.devices.mobile || 0 }), "on a phone"),
          el("div", { class: "pill" }, el("b", { text: V.devices.desktop || 0 }), "on a computer"),
          el("div", { class: "pill" }, el("b", { text: V.devices.tablet || 0 }), "on a tablet"))),
      panel("Busiest hours", "Pages viewed by hour, South African time, last 30 days",
        barChart(V.hours.map((n, h) => ({ h, n })), "n", "soft", (d) => String(d.h).padStart(2, "0") + ":00", 3))
    ));

    const shown = showAllVisitors ? V.recent : V.recent.slice(0, 20);
    const more = V.recent.length > 20
      ? el("button", { class: "btn btn-ghost btn-small show-more", type: "button", text: showAllVisitors ? "Show fewer" : `Show all ${V.recent.length}`, onclick: () => { showAllVisitors = !showAllVisitors; renderVisitors(); } })
      : null;
    const deviceText = (r) => (r.devices && r.devices.length > 1 ? r.devices : [r.device]).map((d) => DEVICE_NAMES[d] || d || "-").join(" and ");
    root.append(panel("Who's been visiting", "Last 30 days, most recent first. Names show for people who were signed in; everyone else is a numbered guest.",
      V.recent.length ? [el("div", { class: "table-wrap" }, el("table", { class: "visit-table" },
        el("thead", null, el("tr", null, ["Visitor", "Last seen", "Days visited", "Pages viewed", "Last page", "Device", "Came from"].map((h) => el("th", { text: h })))),
        el("tbody", null, shown.map((r) => el("tr", null,
          el("td", { class: "cell-name" }, r.name ? [el("b", { text: r.name }), r.company ? el("span", { text: r.company }) : null] : el("span", { class: "guest", text: r.guest })),
          el("td", { text: ago(r.lastSeen) }),
          el("td", { text: r.days30 }),
          el("td", { text: r.views30 }),
          el("td", { text: pageName(r.lastPage) }),
          el("td", { text: deviceText(r) }),
          el("td", { text: r.source || "Direct" })))))), more]
        : el("p", { class: "muted small", text: "No visitors yet. Share your link and they'll show up here." })));

    root.append(el("div", { class: "foot-actions" },
      el("a", { class: "btn btn-ghost btn-small", href: "/api/admin/export/visits.csv", text: "Download visits (CSV)" }),
      el("span", { class: "muted small", text: "Your own visits are left out: this browser, any browser where you've opened this dashboard, and your own Site Desk account. Link previews and search-engine robots aren't counted." })));
  }

  // ---------- Messages ----------
  async function messageAction(m, action) {
    if (action === "delete" && !confirm(`Delete the message from ${m.name}? This can't be undone.`)) return;
    const r = await post("/api/admin/message-action", { id: m.id, action });
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    await loadAll(true);
  }

  function renderMessages() {
    const root = document.getElementById("view-messages");
    root.textContent = "";
    const all = S.messages || [];
    const fresh = all.filter((m) => m.status !== "answered");
    const tab = document.getElementById("tab-messages");
    tab.textContent = "Messages";
    if (fresh.length) tab.append(el("span", { class: "count", text: fresh.length }));

    const base = (S.status && S.status.appUrl) || location.origin;
    root.append(el("div", { class: "toolbar" },
      segmented([["new", `Waiting for a reply (${fresh.length})`], ["all", `All (${all.length})`]], msgFilter, (v) => { msgFilter = v; renderMessages(); }),
      el("div", { class: "grow" }),
      el("a", { class: "btn btn-ghost btn-small", href: "/contact", target: "_blank", rel: "noopener", text: "Open the contact page" }),
      el("a", { class: "btn btn-ghost btn-small", href: "/api/admin/export/messages.csv", text: "Download messages (CSV)" })));

    const list = msgFilter === "new" ? fresh : all;
    if (!list.length) {
      root.append(el("div", { class: "card empty" },
        el("p", { text: all.length ? "No messages waiting for a reply." : "No messages yet." }),
        el("p", { class: "small" }, "Anyone can write to you at ", el("code", { text: base + "/contact" }), ". It's also linked from the sign-in page and inside the app.")));
      return;
    }
    list.forEach((m) => {
      const d = m.delivery || {};
      root.append(el("div", { class: "card msg-card" + (m.status === "answered" ? " answered" : "") },
        el("header", null,
          el("b", { text: m.name }),
          el("span", { class: "badge", text: m.topic }),
          el("span", { class: "badge " + (m.status === "answered" ? "ok" : "warn"), text: m.status === "answered" ? "Answered" : "New" }),
          m.signedIn ? el("span", { class: "muted small", text: "Site Desk member" }) : null,
          el("span", { class: "grow" }),
          el("span", { class: "muted small", text: m.id + " - " + fmtDate(m.receivedAt) })),
        el("dl", null,
          m.email ? [el("dt", { text: "Email" }), el("dd", { text: m.email })] : null,
          m.phone ? [el("dt", { text: "WhatsApp / phone" }), el("dd", { text: m.phone })] : null),
        el("div", { class: "msg-text", text: m.message }),
        el("div", { class: "meta" },
          m.replyEmail ? el("a", { class: "btn btn-brass btn-small", href: m.replyEmail, text: "Reply by email" }) : null,
          m.replyWhatsapp ? el("a", { class: "btn " + (m.replyEmail ? "btn-ghost" : "btn-brass") + " btn-small", href: m.replyWhatsapp, target: "_blank", rel: "noopener noreferrer", text: "Reply on WhatsApp" }) : null,
          el("button", { class: "btn btn-ghost btn-small", type: "button", text: m.status === "answered" ? "Mark as not answered" : "Mark as answered", onclick: () => messageAction(m, m.status === "answered" ? "new" : "answered") }),
          el("button", { class: "btn btn-ghost btn-small", type: "button", text: "Delete", onclick: () => messageAction(m, "delete") }),
          el("span", { class: "grow" }),
          el("span", { class: "muted small", text: "Email alert:" }), badge(d.email ? d.email.state : "off"))));
    });
  }

  // ---------- Overview ----------
  function renderOverview() {
    const { stats, status } = S;
    const t = stats.totals;
    const root = document.getElementById("view-overview");
    root.textContent = "";

    const pct = (n) => (t.users ? Math.round((n / t.users) * 100) + "% of people" : "");
    root.append(el("div", { class: "kpis" },
      kpi(t.users, "People signed up", `+${t.signups7} this week, +${t.signups30} in 30 days`),
      kpi(t.activeToday, "Active today", `${t.active7} this week, ${t.active30} in 30 days`),
      kpi(t.questions7, "Questions this week", `${t.questionsToday} today, ${t.questions} all time`),
      kpi(t.avgQuestionsPerAsker30, "Questions per person", "Average over 30 days, for people who asked"),
      kpi(t.returning, "Came back on another day", pct(t.returning)),
      kpi(t.neverAsked, "Signed up, never asked", t.users ? "Worth a nudge on site" : ""),
      kpi(t.sessionRequests, "Live-session requests", `${t.requests7} this week, ${t.requestRate}% of people asked`),
      kpi(t.helpful.rate == null ? "-" : t.helpful.rate + "%", "Answers marked helpful", t.helpful.rate == null ? "No votes yet" : `${t.helpful.up} yes, ${t.helpful.down} no`),
      kpi(t.avgMs == null ? "-" : (t.avgMs / 1000).toFixed(1) + "s", "Average answer time", t.p95Ms == null ? "" : `Slowest 5%: ${(t.p95Ms / 1000).toFixed(1)}s`),
      kpi(t.errorRate30 + "%", "Answers that failed (30 days)", t.errorRate30 ? "Check the Health tab" : "All good")
    ));

    root.append(el("div", { class: "grid-2" },
      panel("Questions per day", "Last 30 days", barChart(stats.days, "questions", "", (d, short) => short ? fmtDay(d.day) : fmtDay(d.day), 5)),
      panel("People active per day", "Last 30 days", barChart(stats.days, "active", "brass", (d, short) => fmtDay(d.day), 5))
    ));
    root.append(el("div", { class: "grid-2" },
      panel("New sign-ups per day", "Last 30 days", barChart(stats.days, "signups", "soft", (d) => fmtDay(d.day), 5)),
      panel("Busiest hours", "When people ask, South African time, last 30 days",
        barChart(stats.hours.map((n, h) => ({ h, n })), "n", "", (d, short) => (short ? String(d.h).padStart(2, "0") + ":00" : String(d.h).padStart(2, "0") + ":00"), 3))
    ));

    const askedHow = stats.sources.topic + stats.sources.typed;
    root.append(el("div", { class: "grid-2" },
      panel("What people ask about", "Last 30 days", hbars(stats.topics30, "topic")),
      panel("Who's using it", null,
        el("p", { class: "label", text: "By role" }), hbars(stats.roles, "role", "brass"),
        stats.companies.length ? [el("p", { class: "label", text: "By company" }), hbars(stats.companies, "company")] : null)
    ));
    root.append(el("div", { class: "grid-2" },
      panel("How they use it", "Last 30 days",
        el("div", { class: "devices" },
          el("div", { class: "pill" }, el("b", { text: stats.devices.mobile || 0 }), "on a phone"),
          el("div", { class: "pill" }, el("b", { text: stats.devices.desktop || 0 }), "on a computer"),
          el("div", { class: "pill" }, el("b", { text: stats.devices.tablet || 0 }), "on a tablet")),
        el("p", { class: "muted small", text: askedHow ? `${Math.round((stats.sources.topic / askedHow) * 100)}% of questions came from tapping a topic; the rest were typed.` : "No questions yet." }),
        el("p", { class: "muted small", text: `Live-session button clicked ${t.offerClicks30} times in 30 days. Failed sign-ins this week: ${t.failedLogins7}.` })),
      panel("Most active people", "By total questions",
        stats.topUsers.length ? el("div", { class: "table-wrap" }, el("table", null,
          el("thead", null, el("tr", null, ["Person", "Questions", "Last active"].map((h) => el("th", { text: h })))),
          el("tbody", null, stats.topUsers.map((u) => el("tr", null,
            el("td", { class: "cell-name" }, el("b", { text: u.name }), el("span", { text: [u.company, u.role].filter(Boolean).join(" - ") })),
            el("td", { text: u.questions }), el("td", { text: ago(u.lastActive) })))))) : el("p", { class: "muted small", text: "Nobody has asked a question yet." }))
    ));
    root.append(panel("Newest sign-ups", null,
      stats.recentSignups.length ? el("div", { class: "table-wrap" }, el("table", null,
        el("thead", null, el("tr", null, ["Person", "Role", "Joined"].map((h) => el("th", { text: h })))),
        el("tbody", null, stats.recentSignups.map((u) => el("tr", null,
          el("td", { class: "cell-name" }, el("b", { text: u.name }), el("span", { text: u.company })),
          el("td", { text: u.role }), el("td", { text: ago(u.createdAt) + " (" + fmtDate(u.createdAt).split(",")[0] + ")" })))))) : el("p", { class: "muted small", text: "Nobody has signed up yet. Share the link and the site access code with the team." })));
    root.append(el("p", { class: "muted small", text: "Updated " + fmtDate(stats.generatedAt) + ". Days are counted in South African time." }));
  }

  // ---------- People ----------
  async function userAction(u, action) {
    if (action === "delete" && !confirm(`Delete ${u.name}'s account? Their details are removed and it can't be undone.`)) return;
    if (action === "reset" && !confirm(`Make a new temporary password for ${u.name}? They'll be signed out everywhere.`)) return;
    const r = await post("/api/admin/user-action", { id: u.id, action });
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    if (action === "reset") {
      const pw = el("div", { class: "temp-pw", text: r.data.tempPassword });
      openModal("Temporary password", [
        el("p", { class: "muted", text: `Give this to ${u.name} (WhatsApp or in person). They can change it from the menu once signed in.` }), pw,
      ], [
        el("button", { class: "btn btn-ghost", type: "button", text: "Copy", onclick: (e) => { navigator.clipboard && navigator.clipboard.writeText(r.data.tempPassword); e.target.textContent = "Copied"; } }),
        el("button", { class: "btn btn-primary", type: "button", text: "Done", onclick: closeModal }),
      ]);
    }
    await loadAll();
  }

  function renderPeople() {
    const root = document.getElementById("view-people");
    root.textContent = "";
    const q = search.trim().toLowerCase();
    const list = S.users.filter((u) => !q || [u.name, u.login, u.company, u.role].join(" ").toLowerCase().includes(q));
    const input = el("input", { class: "input", type: "search", placeholder: "Search people", value: search, "aria-label": "Search people" });
    input.addEventListener("input", () => { search = input.value; renderPeople(); const i = document.querySelector("#view-people input"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
    root.append(el("div", { class: "toolbar" }, input, el("div", { class: "grow" }),
      el("a", { class: "btn btn-ghost btn-small", href: "/api/admin/export/users.csv", text: "Download people (CSV)" }),
      el("a", { class: "btn btn-ghost btn-small", href: "/api/admin/export/activity.csv", text: "Download activity (CSV)" })));

    if (!list.length) { root.append(el("div", { class: "card empty", text: S.users.length ? "No one matches that search." : "Nobody has signed up yet." })); return; }

    root.append(el("div", { class: "card" }, el("div", { class: "table-wrap" }, el("table", null,
      el("thead", null, el("tr", null, ["Person", "Signs in with", "Joined", "Last active", "Questions", "Requests", "Status", ""].map((h) => el("th", { text: h })))),
      el("tbody", null, list.map((u) => el("tr", null,
        el("td", { class: "cell-name" }, el("b", { text: u.name }), el("span", { text: [u.company, u.role].filter(Boolean).join(" - ") })),
        el("td", { text: u.login }),
        el("td", { text: fmtDate(u.createdAt).split(",")[0] }),
        el("td", { text: ago(u.lastActive) }),
        el("td", { text: u.questions }),
        el("td", { text: u.requests }),
        el("td", null, el("span", { class: "badge " + (u.disabled ? "off" : "ok"), text: u.disabled ? "Switched off" : "Active" })),
        el("td", null, el("div", { class: "row-actions" },
          el("button", { class: "btn btn-ghost btn-small", type: "button", text: "Reset password", onclick: () => userAction(u, "reset") }),
          el("button", { class: "btn btn-ghost btn-small", type: "button", text: u.disabled ? "Switch on" : "Switch off", onclick: () => userAction(u, u.disabled ? "enable" : "disable") }),
          el("button", { class: "btn btn-ghost btn-small", type: "button", text: "Delete", onclick: () => userAction(u, "delete") })))
      )))))));
    root.append(el("p", { class: "muted small", text: "Resetting a password gives you a temporary one to pass on. Deleting removes the person's details but keeps the anonymous totals." }));
  }

  // ---------- Requests ----------
  function badge(state) {
    const map = { sent: ["ok", "sent"], failed: ["bad", "failed"], off: ["off", "not set up"] };
    const [cls, text] = map[state] || ["off", state];
    return el("span", { class: "badge " + cls, text });
  }
  function renderRequests() {
    const root = document.getElementById("view-requests");
    root.textContent = "";
    if (!S.requests.length) { root.append(el("div", { class: "card empty", text: "No live-session requests yet." })); return; }
    S.requests.forEach((r) => {
      const d = r.delivery || {};
      root.append(el("div", { class: "card req" },
        el("header", null, el("b", { text: r.name }), el("span", { class: "muted", text: r.company }), el("span", { class: "grow" }), el("span", { class: "muted small", text: r.id + " - " + fmtDate(r.receivedAt) })),
        el("dl", null,
          el("dt", { text: "Contact" }), el("dd", { text: r.contact || "-" }),
          el("dt", { text: "Topic" }), el("dd", { text: r.topic || "-" }),
          el("dt", { text: "When" }), el("dd", { text: (r.preferredTime || "-") + (r.urgency ? "  (" + r.urgency + ")" : "") }),
          el("dt", { text: "Details" }), el("dd", { text: r.details || "-" })),
        el("div", { class: "meta" },
          r.replyWhatsapp ? el("a", { class: "btn btn-brass btn-small", href: r.replyWhatsapp, target: "_blank", rel: "noopener noreferrer", text: "Reply on WhatsApp" }) : null,
          el("span", { class: "muted small", text: "Email:" }), badge(d.email ? d.email.state : "off"),
          el("span", { class: "muted small", text: "Webhook:" }), badge(d.webhook ? d.webhook.state : "off"))));
    });
  }

  // ---------- Health ----------
  function row(ok, title, text, extra) {
    return el("div", { class: "status-row" },
      el("span", { class: "badge " + (ok === true ? "ok" : ok === false ? "bad" : "warn"), text: ok === true ? "OK" : ok === false ? "Needs attention" : "Check" }),
      el("div", { class: "what" }, el("b", { text: title }), el("p", null, text), extra));
  }

  function renderHealth() {
    const { status: s } = S;
    const root = document.getElementById("view-health");
    root.textContent = "";
    const assistantOut = el("p", { class: "small" });
    const notifyOut = el("p", { class: "small" });

    const testAssistant = el("button", { class: "btn btn-ghost btn-small", type: "button", text: "Test the assistant", onclick: async (e) => {
      e.target.disabled = true; assistantOut.textContent = "Testing...";
      const r = await post("/api/admin/test-assistant");
      assistantOut.textContent = r.data.ok ? "Working. It answered in " + (r.data.ms / 1000).toFixed(1) + " seconds." : "Not working: " + (r.data.message || "unknown problem") + (r.data.status ? " (code " + r.data.status + ")" : "");
      e.target.disabled = false; loadAll(true);
    } });
    const testNotify = el("button", { class: "btn btn-ghost btn-small", type: "button", text: "Send a test request", onclick: async (e) => {
      e.target.disabled = true; notifyOut.textContent = "Sending...";
      const r = await post("/api/admin/test-notify");
      const d = r.data.delivery || {};
      const bit = (n, x) => n + ": " + (x ? (x.state === "failed" ? "failed (" + (x.detail || "") + ")" : x.state === "off" ? "not set up" : "sent") : "-");
      notifyOut.textContent = (r.data.notified ? "Sent. Check your inbox or chat now. " : "Nothing could be sent. ") + bit("Email", d.email) + "; " + bit("Webhook", d.webhook) + ".";
      e.target.disabled = false;
    } });

    const a = s.assistant, n = s.notifications, st = s.storage, sec = s.security;
    const anyNotify = n.email.configured || n.webhook.configured;

    root.append(el("div", { class: "card panel" },
      row(a.configured && !a.lastError, "The assistant", a.configured
        ? `Connected, using ${a.model}.` + (a.lastError ? ` The last answer failed: ${a.lastError.message}${a.lastError.status ? " (code " + a.lastError.status + ")" : ""}. This is usually a missing API key, an empty credit balance on console.anthropic.com, or a wrong model name.` : "")
        : "No API key yet. Add ANTHROPIC_API_KEY in your Render settings.", el("div", null, testAssistant, assistantOut)),
      row(anyNotify, "Live-session alerts to you", anyNotify
        ? [n.email.configured ? `Email goes to ${n.email.to}. ` : "", n.webhook.configured ? "A chat webhook is set. " : ""].join("")
        : "No automatic email yet, so people are asked to send their request to you on WhatsApp or email themselves. For an automatic email as well, add RESEND_API_KEY (free at resend.com) in Render. Sign up to Resend with the email you want alerts in, because Resend's free setup only sends to that address.", el("div", null, testNotify, notifyOut)),
      row(n.whatsapp.configured || !!s.contact.email ? true : null, "Where people can reach you directly",
        [s.contact.whatsapp ? `WhatsApp ${s.contact.whatsapp}` : "", s.contact.email ? `email ${s.contact.email}` : ""].filter(Boolean).join(" and ") +
        ". After every live-session request, people get one-tap buttons to send it to you here, with their message already written. To change these, set SITE_AGENT_WHATSAPP or SITE_AGENT_EMAIL in Render."),
      row(st.ok && st.persistent, "Saved accounts and statistics", !st.ok
        ? `Can't save to disk: ${st.error}`
        : st.persistent ? `Saved on disk. ${st.users} people and ${st.events} activity records so far.`
          : "Accounts are being saved to a temporary disk, and will be lost whenever Render restarts or the app goes to sleep. Add a persistent disk in Render (Starter plan, mount path /var/data) and the app will use it automatically."),
      row(true, "Contact form", `Anyone can send you a message at ${(s.appUrl || location.origin)}/contact, without an account. ` +
        (n.email.configured ? "Each one is emailed to you, and listed on the Messages tab." : "Messages are listed on the Messages tab, and people are asked to send them to you on WhatsApp or email too.") +
        ` ${st.messages} so far.`),
      row(true, "Visitor counting", `Every visit to the sign-in, contact and chat pages is counted, using one small anonymous cookie. ${st.visits} visits recorded. Robots, link previews and your own visits are left out.`),
      row(sec.signupCodeSet ? true : null, "Site access code", sec.signupCodeSet
        ? "Sign-up needs the site access code, so strangers can't use up your credit."
        : "Anyone with the link can sign up. Add SIGNUP_CODE (any word or number you choose) in your Render settings and give it to your team."),
      row(true, "Privacy and limits", `Each person can ask up to ${sec.dailyLimit || "unlimited"} questions a day. ${sec.storeQuestions ? "The first 200 characters of each question are kept (STORE_QUESTIONS is on)." : "Only the topic of each question is kept, not the question itself."}`)
    ));
  }

  // ---------- alerts at the top ----------
  function renderAlerts() {
    const { status: s } = S;
    const box = document.getElementById("alerts");
    box.textContent = "";
    const add = (cls, strong, text) => box.append(el("div", { class: "alert " + cls }, el("strong", { text: strong + " " }), text));
    if (!s.storage.ok) add("alert-error", "Can't save data.", s.storage.error);
    else if (!s.storage.persistent) add("alert-warn", "Accounts are not safe yet.", "They'll be lost when Render restarts the app. Open the Health tab to see the one-minute fix.");
    if (s.assistant.lastError) add("alert-error", "The assistant is failing.", s.assistant.lastError.message);
    if (!s.notifications.email.configured && !s.notifications.webhook.configured) add("alert-warn", "No automatic email alerts yet.", "Messages and live-session requests are saved here, and people are asked to send them to you on WhatsApp or email. See the Health tab to add automatic email.");
  }

  // ---------- load & tabs ----------
  async function loadAll(quiet) {
    try {
      // The new tabs load on their own, so a problem there can't hide the rest.
      const [stats, status, users, requests, visits, messages] = await Promise.all([
        get("/api/admin/stats"), get("/api/admin/status"), get("/api/admin/users"), get("/api/admin/requests"),
        get("/api/admin/visits").catch(() => null), get("/api/admin/messages").catch(() => null),
      ]);
      S = { stats, status, users: users.users, requests: requests.requests, visits, messages: messages ? messages.messages : [] };
      renderAlerts(); renderOverview(); renderPeople(); renderRequests(); renderHealth();
      try { renderVisitors(); } catch (e) { console.error(e); }
      try { renderMessages(); } catch (e) { console.error(e); }
    } catch (e) {
      if (!quiet) document.getElementById("alerts").append(el("div", { class: "alert alert-error", text: "Couldn't load the numbers. Refresh the page and sign in again." }));
    }
  }

  const TABS = ["visitors", "overview", "people", "messages", "requests", "health"];
  function showTab(name) {
    if (!TABS.includes(name)) name = "visitors";
    document.querySelectorAll("#tabs .tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    TABS.forEach((id) => (document.getElementById("view-" + id).hidden = id !== name));
  }
  document.querySelectorAll("#tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      showTab(tab.dataset.tab);
      try { history.replaceState(null, "", "#" + tab.dataset.tab); } catch {}
    });
  });
  showTab(location.hash.slice(1));
  document.getElementById("refresh").addEventListener("click", () => loadAll());
  loadAll();
  setInterval(() => loadAll(true), 60000);
})();
