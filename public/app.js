"use strict";
(function () {
  const $ = (id) => document.getElementById(id);

  let me = null;            // the signed-in person
  let agent = "the site agent";
  let agentEmail = "";
  let whatsappUrl = "";
  let topics = [];
  let busy = false;
  let state = { history: [], view: [], lastTopic: "" };
  let storeKey = "sd_chat";

  // ---------- helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function api(url, body) {
    const opts = body === undefined
      ? { credentials: "same-origin" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" };
    const r = await fetch(url, opts);
    let data = {};
    try { data = await r.json(); } catch {}
    if (r.status === 401 && url !== "/api/account/password" && url !== "/api/account/delete") {
      location.href = "/login";
      throw new Error("signed out");
    }
    return { ok: r.ok, status: r.status, data };
  }

  function save() {
    try { sessionStorage.setItem(storeKey, JSON.stringify(state)); } catch {}
  }
  function load() {
    try {
      const s = JSON.parse(sessionStorage.getItem(storeKey) || "null");
      if (s && Array.isArray(s.history) && Array.isArray(s.view)) state = s;
    } catch {}
  }

  // ---------- safe formatting of the assistant's replies ----------
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    s = s.replace(/(https?:\/\/(?:(?!&quot;|&#39;)[^\s<])*[^\s<.,;:!?)&])/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[i] + "</code>");
  }

  function format(text) {
    const lines = escapeHtml(text).split("\n");
    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
    const flushList = () => {
      if (!list) return;
      const start = list.t === "ol" && list.start > 1 ? ' start="' + list.start + '"' : "";
      out.push("<" + list.t + start + ">" + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + "</" + list.t + ">");
      list = null;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.t !== "ol") { flushList(); list = { t: "ol", start: Number(m[1]), items: [] }; }
        list.items.push(m[2]); continue;
      }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        flushPara();
        if (!list || list.t !== "ul") { flushList(); list = { t: "ul", items: [] }; }
        list.items.push(m[1]); continue;
      }
      if ((m = line.match(/^\s*#{1,4}\s+(.*)$/))) { flushPara(); flushList(); out.push("<p><strong>" + inline(m[1]) + "</strong></p>"); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join("");
  }

  // ---------- greeting, topics, chips ----------
  function greeting() {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    return part + ", " + me.firstName + ".";
  }

  function buildTopics() {
    const grid = $("topics");
    const chips = $("chips");
    grid.textContent = "";
    chips.textContent = "";
    topics.forEach((t) => {
      const card = document.createElement("button");
      card.type = "button"; card.className = "topic";
      const b = document.createElement("b"); b.textContent = t.label;
      const s = document.createElement("span"); s.textContent = t.hint;
      card.append(b, s);
      card.onclick = () => ask(t.question, "topic");
      grid.appendChild(card);

      const chip = document.createElement("button");
      chip.type = "button"; chip.className = "chip"; chip.textContent = t.label;
      chip.onclick = () => ask(t.question, "topic");
      chips.appendChild(chip);
    });
    const fresh = document.createElement("button");
    fresh.type = "button"; fresh.className = "chip plain"; fresh.textContent = "New chat";
    fresh.onclick = newChat;
    chips.insertBefore(fresh, chips.firstChild);
  }

  function showChatView(on) {
    $("welcome").hidden = on;
    $("chat").hidden = !on;
    $("chips").hidden = !on;
  }

  function newChat() {
    state = { history: [], view: [], lastTopic: "" };
    save();
    $("chat").textContent = "";
    showChatView(false);
    window.scrollTo({ top: 0 });
  }

  // ---------- conversation ----------
  function scrollToBottom() { window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }

  function userRow(text) {
    const row = document.createElement("div");
    row.className = "msg-row user";
    const b = document.createElement("div");
    b.className = "bubble user"; b.textContent = text;
    row.appendChild(b);
    return row;
  }

  function botRow(item) {
    const row = document.createElement("div");
    row.className = "msg-row bot";
    const img = document.createElement("img");
    img.className = "avatar"; img.src = "/logo.svg"; img.alt = "";
    const col = document.createElement("div");
    col.className = "bot-col";
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (item.role === "error" ? "error" : "bot");
    if (item.role === "error") bubble.textContent = item.text;
    else bubble.innerHTML = format(item.text);
    col.appendChild(bubble);

    if (item.role === "bot") {
      const tools = document.createElement("div");
      tools.className = "msg-tools";
      if (item.offer) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn btn-brass";
        b.textContent = "Request a live session with " + agent;
        b.onclick = () => { api("/api/event", { type: "offer_click" }).catch(() => {}); openBooking(); };
        tools.appendChild(b);
      }
      if (item.mid) {
        const fb = document.createElement("span");
        fb.className = "fb";
        const thanks = () => { fb.textContent = "Thanks for the feedback."; };
        if (item.voted) {
          thanks();
        } else {
          const yes = document.createElement("button");
          const no = document.createElement("button");
          yes.type = no.type = "button";
          yes.className = no.className = "tool";
          yes.textContent = "Yes"; no.textContent = "No";
          const vote = (v) => {
            item.voted = v; save(); thanks();
            api("/api/feedback", { mid: item.mid, value: v }).catch(() => {});
          };
          yes.onclick = () => vote(1);
          no.onclick = () => vote(-1);
          fb.append("Was this helpful? ", yes, no);
        }
        tools.appendChild(fb);
      }
      if (tools.childNodes.length) col.appendChild(tools);
    }
    row.append(img, col);
    return row;
  }

  function addItem(item, opts = {}) {
    state.view.push(item);
    const row = item.role === "user" ? userRow(item.text) : botRow(item);
    $("chat").appendChild(row);
    save();
    if (!opts.silent) {
      if (item.role === "user") scrollToBottom();
      else row.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function showTyping() {
    const row = document.createElement("div");
    row.className = "msg-row bot"; row.id = "typing";
    const img = document.createElement("img");
    img.className = "avatar"; img.src = "/logo.svg"; img.alt = "";
    const b = document.createElement("div");
    b.className = "bubble bot";
    b.innerHTML = '<span class="typing" aria-label="Site Desk is typing"><i></i><i></i><i></i></span>';
    row.append(img, b);
    $("chat").appendChild(row);
    scrollToBottom();
  }
  function hideTyping() { const t = $("typing"); if (t) t.remove(); }

  async function ask(text, src) {
    text = String(text || "").trim();
    if (busy || !text) return;
    busy = true; $("send").disabled = true;
    showChatView(true);
    addItem({ role: "user", text });
    state.history.push({ role: "user", content: text });
    $("input").value = ""; autoGrow();
    showTyping();
    try {
      const r = await api("/api/chat", { messages: state.history, src: src || "typed" });
      hideTyping();
      if (r.ok) {
        state.history.push({ role: "assistant", content: r.data.reply });
        state.lastTopic = r.data.topic || state.lastTopic;
        addItem({ role: "bot", text: r.data.reply, offer: !!r.data.offerSession, mid: r.data.mid });
      } else {
        state.history.pop();
        addItem({ role: "error", text: r.data.error || "Something went wrong. Please try again." });
      }
    } catch (e) {
      hideTyping();
      if (String(e.message) !== "signed out") {
        state.history.pop();
        addItem({ role: "error", text: "Couldn't reach Site Desk. Check your connection and try again." });
      }
    } finally {
      busy = false; $("send").disabled = false;
      save();
    }
  }

  function autoGrow() {
    const i = $("input");
    i.style.height = "auto";
    i.style.height = Math.min(i.scrollHeight, 140) + "px";
  }

  // ---------- modals ----------
  let lastFocus = null;
  function openOverlay(overlay, focusEl) {
    lastFocus = document.activeElement;
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    if (focusEl) setTimeout(() => focusEl.focus(), 30);
  }
  function closeOverlay(overlay) {
    overlay.classList.remove("open");
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.addEventListener("keydown", (e) => {
    const open = document.querySelector(".overlay.open");
    if (!open) return;
    if (e.key === "Escape") { closeOverlay(open); return; }
    if (e.key === "Tab") { // keep Tab inside the dialog
      const f = [...open.querySelectorAll("button, input, select, textarea, summary, a[href]")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.querySelectorAll(".overlay").forEach((o) => o.addEventListener("mousedown", (e) => { if (e.target === o) closeOverlay(o); }));

  // ---- live session ----
  function openBooking() {
    $("bookForm").hidden = false;
    $("bookDone").hidden = true;
    $("bookError").hidden = true;
    $("b-contact").value = me.contact || "";
    const lastQ = [...state.history].reverse().find((m) => m.role === "user");
    $("b-details").value = lastQ ? "About my question: “" + lastQ.content.slice(0, 280) + "”" : "";
    if (state.lastTopic) {
      const match = [...$("b-topic").options].find((o) => o.value === state.lastTopic);
      if (match) $("b-topic").value = match.value;
    }
    openOverlay($("bookOverlay"), $("b-contact"));
  }

  function actionLink(text, href, cls) {
    const a = document.createElement("a");
    a.className = "btn " + cls; a.textContent = text; a.href = href;
    a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }

  $("bookForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("bookError");
    err.hidden = true;
    const contact = $("b-contact").value.trim();
    if (!contact) { err.textContent = "Please add a WhatsApp number or email so " + agent + " can reach you."; err.hidden = false; return; }
    const when = $("b-when").value, tod = $("b-tod").value;
    const btn = $("bookSubmit");
    btn.disabled = true; btn.textContent = "Sending...";
    try {
      const r = await api("/api/request-session", {
        contact,
        topic: $("b-topic").value,
        preferredTime: when + (tod !== "Any time" ? ", " + tod.toLowerCase() : ""),
        urgency: when === "As soon as possible" ? "Urgent" : when,
        details: $("b-details").value.trim(),
      });
      if (!r.ok) { err.textContent = r.data.error || "Couldn't send your request. Please try again."; err.hidden = false; }
      else showBookingResult(r.data, contact);
    } catch (ex) {
      if (String(ex.message) !== "signed out") { err.textContent = "Couldn't reach Site Desk. Check your connection and try again."; err.hidden = false; }
    }
    btn.disabled = false; btn.textContent = "Send request";
  });

  function showBookingResult(d, contact) {
    $("bookForm").hidden = true;
    $("bookDone").hidden = false;
    const note = $("doneNote"), actions = $("doneActions");
    actions.textContent = "";
    $("doneSub").textContent = "Reference " + d.id;
    if (d.notified) {
      $("doneTitle").textContent = "Request sent";
      note.className = "alert alert-ok";
      note.textContent = "Thank you, " + me.firstName + ". " + agent + " has been told and will contact you on " + contact + " to set up a time.";
    } else {
      $("doneTitle").textContent = "Request saved";
      note.className = "alert alert-warn";
      note.textContent = "Your request is saved, but " + agent + " couldn't be alerted automatically. To make sure it isn't missed, please message " + agent + " directly" + (d.whatsappUrl || d.agentEmail ? " using the button below." : " or tell the site office.") + " Quote reference " + d.id + ".";
      if (d.whatsappUrl) actions.appendChild(actionLink("Message on WhatsApp", d.whatsappUrl, "btn-brass"));
      if (d.agentEmail) actions.appendChild(actionLink("Send an email", "mailto:" + d.agentEmail + "?subject=" + encodeURIComponent("Procore live session request " + d.id), "btn-ghost"));
    }
    const close = document.createElement("button");
    close.type = "button"; close.className = "btn btn-primary"; close.textContent = "Done";
    close.onclick = () => closeOverlay($("bookOverlay"));
    actions.appendChild(close);
  }

  $("bookCancel").onclick = () => closeOverlay($("bookOverlay"));
  $("talkBtn").onclick = openBooking;
  $("welcomeBook").onclick = openBooking;

  // ---- account ----
  $("accountBtn").onclick = () => {
    $("accSub").textContent = me.name + (me.company ? " - " + me.company : "") + " - signed in as " + me.login;
    ["pwError", "pwOk", "delError"].forEach((id) => ($(id).hidden = true));
    $("pwForm").reset(); $("delForm").reset();
    document.querySelectorAll(".acc-section").forEach((d) => (d.open = false));
    openOverlay($("accOverlay"), $("accClose"));
  };
  $("accClose").onclick = () => closeOverlay($("accOverlay"));

  $("signOut").onclick = async () => {
    try { await api("/api/logout", {}); } catch {}
    try { sessionStorage.removeItem(storeKey); } catch {}
    location.href = "/login";
  };

  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("pwError").hidden = true; $("pwOk").hidden = true;
    const btn = $("pwBtn"); btn.disabled = true;
    try {
      const r = await api("/api/account/password", { current: $("pw-current").value, next: $("pw-new").value });
      if (r.ok) { $("pwOk").hidden = false; $("pwForm").reset(); }
      else { $("pwError").textContent = r.data.error || "Couldn't change your password."; $("pwError").hidden = false; }
    } catch {}
    btn.disabled = false;
  });

  $("delForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("delError").hidden = true;
    if (!confirm("Delete your Site Desk account? This can't be undone.")) return;
    const btn = $("delBtn"); btn.disabled = true;
    try {
      const r = await api("/api/account/delete", { password: $("del-password").value });
      if (r.ok) { try { sessionStorage.removeItem(storeKey); } catch {} location.href = "/login"; return; }
      $("delError").textContent = r.data.error || "Couldn't delete your account."; $("delError").hidden = false;
    } catch {}
    btn.disabled = false;
  });

  // ---------- composer ----------
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); ask($("input").value, "typed"); });
  $("input").addEventListener("input", autoGrow);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($("input").value, "typed"); }
  });

  // ---------- start ----------
  (async function init() {
    let r;
    try { r = await api("/api/me"); } catch { return; }
    if (!r.ok) { location.href = "/login"; return; }
    me = r.data.user;
    agent = r.data.agent; agentEmail = r.data.agentEmail; whatsappUrl = r.data.whatsappUrl;
    topics = r.data.topics || [];
    storeKey = "sd_chat_" + me.id;

    document.querySelectorAll(".agent-name").forEach((e) => (e.textContent = agent));
    $("initial").textContent = (me.firstName[0] || "?").toUpperCase();
    $("greeting").textContent = greeting();

    const sel = $("b-topic");
    topics.forEach((t) => { const o = document.createElement("option"); o.value = t.label; o.textContent = t.label; sel.appendChild(o); });
    ["Safety", "Timesheets", "Meetings", "Documents", "Forms", "Mobile app", "Access & permissions", "Something else"].forEach((l) => { const o = document.createElement("option"); o.value = l; o.textContent = l; sel.appendChild(o); });

    buildTopics();
    load();
    if (state.view.length) {
      showChatView(true);
      state.view.forEach((item) => {
        $("chat").appendChild(item.role === "user" ? userRow(item.text) : botRow(item));
      });
      window.scrollTo({ top: document.body.scrollHeight });
    }
  })();
})();
