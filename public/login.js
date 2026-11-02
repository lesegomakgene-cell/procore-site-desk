"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const tabs = { signin: $("tab-signin"), signup: $("tab-signup") };
  const panels = { signin: $("panel-signin"), signup: $("panel-signup") };

  function show(which) {
    for (const k of Object.keys(tabs)) {
      tabs[k].setAttribute("aria-selected", String(k === which));
      panels[k].hidden = k !== which;
    }
    try { history.replaceState(null, "", which === "signup" ? "/signup" : "/login"); } catch {}
  }
  tabs.signin.onclick = () => show("signin");
  tabs.signup.onclick = () => show("signup");
  if (location.pathname === "/signup") show("signup");

  // show / hide password
  document.querySelectorAll(".pw-toggle").forEach((b) => {
    b.onclick = () => {
      const input = $(b.dataset.for);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      b.textContent = reveal ? "Hide" : "Show";
    };
  });

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = !msg;
    if (msg) el.scrollIntoView({ block: "nearest" });
  }

  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = {};
    try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }

  // public info: agent name, whether a site code is needed, role list
  fetch("/api/public").then((r) => r.json()).then((d) => {
    document.querySelectorAll(".agent-name").forEach((e) => (e.textContent = d.agent));
    $("code-field").hidden = !d.signupCodeRequired;
    const sel = $("su-role");
    const none = document.createElement("option");
    none.value = ""; none.textContent = "Choose your role";
    sel.appendChild(none);
    (d.roles || []).forEach((r) => {
      const o = document.createElement("option");
      o.value = r; o.textContent = r;
      sel.appendChild(o);
    });
  }).catch(() => {});

  // ---- sign in ----
  panels.signin.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("signin-error", "");
    const login = $("si-login").value.trim();
    const password = $("si-password").value;
    if (!login || !password) return showError("signin-error", "Please enter your email or number and your password.");
    const btn = $("signin-btn");
    btn.disabled = true; btn.textContent = "Signing in...";
    try {
      const r = await post("/api/login", { login, password });
      if (r.ok) { location.href = "/"; return; }
      showError("signin-error", r.data.error || "Something went wrong. Please try again.");
    } catch {
      showError("signin-error", "Couldn't reach Site Desk. Check your connection and try again.");
    }
    btn.disabled = false; btn.textContent = "Sign in";
  });

  // ---- create account ----
  panels.signup.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("signup-error", "");
    const body = {
      name: $("su-name").value.trim(),
      login: $("su-login").value.trim(),
      password: $("su-password").value,
      role: $("su-role").value,
      company: $("su-company").value.trim(),
      code: $("su-code").value.trim(),
      website: $("su-website").value,
      consent: $("su-consent").checked,
    };
    if (!body.name) return showError("signup-error", "Please enter your full name.");
    if (!body.login) return showError("signup-error", "Please enter your email address or cell number.");
    if (body.password.length < 8) return showError("signup-error", "Your password needs at least 8 characters.");
    if (!$("code-field").hidden && !body.code) return showError("signup-error", "Please enter the site access code.");
    if (!body.consent) return showError("signup-error", "Please tick the box to agree before creating your account.");
    const btn = $("signup-btn");
    btn.disabled = true; btn.textContent = "Creating your account...";
    try {
      const r = await post("/api/signup", body);
      if (r.ok) { location.href = "/"; return; }
      showError("signup-error", r.data.error || "Something went wrong. Please try again.");
    } catch {
      showError("signup-error", "Couldn't reach Site Desk. Check your connection and try again.");
    }
    btn.disabled = false; btn.textContent = "Create my account";
  });
})();
