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
    if (s < 86400 * 30) return Math.round(s / 86400) + " days ago";
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
  let S = { stats: null, status: null, users: [], requests: [] };
  let search = "";

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
        : "Nobody will be alerted automatically. Add RESEND_API_KEY and NOTIFY_EMAIL (free at resend.com) in your Render settings. Use the same email you signed up to Resend with.", el("div", null, testNotify, notifyOut)),
      row(n.whatsapp.configured ? true : null, "WhatsApp fallback", n.whatsapp.configured
        ? "If an alert can't be delivered, the person sees a button to message you on WhatsApp."
        : "Optional. Add SITE_AGENT_WHATSAPP (for example 0821234567) so people can message you if an alert fails."),
      row(st.ok && st.persistent, "Saved accounts and statistics", !st.ok
        ? `Can't save to disk: ${st.error}`
        : st.persistent ? `Saved on disk. ${st.users} people and ${st.events} activity records so far.`
          : "Accounts are being saved to a temporary disk, and will be lost whenever Render restarts or the app goes to sleep. Add a persistent disk in Render (Starter plan, mount path /var/data) and the app will use it automatically."),
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
    if (!s.notifications.email.configured && !s.notifications.webhook.configured) add("alert-warn", "No live-session alerts set up.", "Requests are saved here but you won't be told. See the Health tab.");
  }

  // ---------- load & tabs ----------
  async function loadAll(quiet) {
    try {
      const [stats, status, users, requests] = await Promise.all([get("/api/admin/stats"), get("/api/admin/status"), get("/api/admin/users"), get("/api/admin/requests")]);
      S = { stats, status, users: users.users, requests: requests.requests };
      renderAlerts(); renderOverview(); renderPeople(); renderRequests(); renderHealth();
    } catch (e) {
      if (!quiet) document.getElementById("alerts").append(el("div", { class: "alert alert-error", text: "Couldn't load the numbers. Refresh the page and sign in again." }));
    }
  }

  document.querySelectorAll("#tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#tabs .tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      ["overview", "people", "requests", "health"].forEach((id) => (document.getElementById("view-" + id).hidden = id !== tab.dataset.tab));
    });
  });
  document.getElementById("refresh").addEventListener("click", () => loadAll());
  loadAll();
  setInterval(() => loadAll(true), 60000);
})();
