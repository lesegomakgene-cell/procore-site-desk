// SiteInspect frontend - vanilla JS, no build step.
// Every value that came from a user or the server goes through esc() before it
// is put into HTML.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");

const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d = "") {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

const state = { config: {}, projects: [], templates: [], projectId: store.get("si.project") };

const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const isOverdue = (a) => a.status === "open" && a.dueDate && a.dueDate < today();
const scoreClass = (s) => (s >= 90 ? "good" : s >= 70 ? "mid" : "low");
const PRIORITIES = ["low", "medium", "high", "critical"];
const project = () => state.projects.find((p) => p.id === state.projectId);

// --- api -----------------------------------------------------------------
async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body instanceof Blob) {
    init.body = opts.body;
    init.headers["Content-Type"] = opts.body.type || "application/octet-stream";
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// --- ui helpers ------------------------------------------------------------
let toastTimer;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2500);
}
const fail = (e) => toast(e.message || String(e), true);

function openModal(html) {
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
  return $("#modalBody");
}
function closeModal() {
  $("#modal").hidden = true;
  $("#modalBody").innerHTML = "";
}
$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal();
});

const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;
const actionPill = (a) => (isOverdue(a) ? pill("overdue", "Overdue") : pill(a.status, a.status === "open" ? "Open" : "Closed"));
const photoUrl = (id) => `/api/photos/${encodeURIComponent(id)}`;
const thumbs = (ids, removable) =>
  ids.length
    ? `<div class="thumbs">${ids
        .map((id) => `<div class="thumb"><a href="${photoUrl(id)}" target="_blank" rel="noopener"><img src="${photoUrl(id)}" alt="Photo" loading="lazy"></a>${removable ? `<button type="button" data-rm-photo="${esc(id)}" aria-label="Remove photo">✕</button>` : ""}</div>`)
        .join("")}</div>`
    : "";

// Shrink camera photos before upload: phones produce 4-12 MB images.
async function uploadPhoto(file) {
  let blob = file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.8));
  } catch {
    // Fall back to the original file; the server checks it's an image.
  }
  const { id } = await api("/api/photos", { method: "POST", body: blob });
  return id;
}

function photoInput(attr) {
  return `<label class="btn">📷 Photo<input type="file" accept="image/*" capture="environment" ${attr} hidden multiple></label>`;
}

// --- data loading ------------------------------------------------------------
async function loadBase() {
  [state.config, state.projects, state.templates] = await Promise.all([api("/api/config"), api("/api/projects"), api("/api/templates")]);
  if (!project() && state.projects.length) state.projectId = state.projects[0].id;
  renderPicker();
}

function renderPicker() {
  const sel = $("#projectPicker");
  sel.innerHTML = state.projects.length
    ? state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === state.projectId ? "selected" : ""}>${esc(p.number ? `${p.number} · ${p.name}` : p.name)}</option>`).join("")
    : `<option value="">No project yet</option>`;
  if (state.projectId) store.set("si.project", state.projectId);
}
$("#projectPicker").addEventListener("change", (e) => {
  state.projectId = e.target.value;
  store.set("si.project", state.projectId);
  if (/^#\/(inspect|report)\//.test(location.hash)) location.hash = "#/";
  else render();
});

const projectData = async () => {
  const q = `?projectId=${encodeURIComponent(state.projectId)}`;
  const [inspections, actions] = await Promise.all([api("/api/inspections" + q), api("/api/actions" + q)]);
  return { inspections, actions };
};

const assigneeList = (actions) => [...new Set(actions.map((a) => a.assignee).filter(Boolean))].sort();
const datalist = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`;

// --- router --------------------------------------------------------------
const routes = [
  [/^#?\/?$/, viewDashboard, "dash"],
  [/^#\/inspections$/, viewInspections, "insp"],
  [/^#\/new$/, viewNew, "new"],
  [/^#\/inspect\/([a-f0-9]+)$/, viewRunner, "insp"],
  [/^#\/report\/([a-f0-9]+)$/, viewReport, "insp"],
  [/^#\/actions(?:\?overdue)?$/, viewActions, "act"],
  [/^#\/setup$/, viewSetup, "setup"],
];

let leaveHook = null; // lets the runner flush unsaved changes before navigating
async function render() {
  if (leaveHook) {
    const h = leaveHook;
    leaveHook = null;
    await h();
  }
  closeModal();
  const hash = location.hash || "#/";
  const match = routes.find(([re]) => re.test(hash)) || routes[0];
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === match[2]));
  if (!state.projects.length && match[1] !== viewSetup) return viewWelcome();
  try {
    await match[1](...(hash.match(match[0]) || []).slice(1));
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back to dashboard</a></div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", render);

// --- welcome / projects ----------------------------------------------------------
function projectForm(p = {}) {
  return `
    <label>Project name *</label><input name="name" required value="${esc(p.name)}" placeholder="e.g. Riverside Office Park Phase 2">
    <div class="grid2">
      <div><label>Project / contract number</label><input name="number" value="${esc(p.number)}" placeholder="e.g. RP-2041"></div>
      <div><label>Client</label><input name="client" value="${esc(p.client)}"></div>
      <div><label>Site address</label><input name="address" value="${esc(p.address)}"></div>
      <div><label>Site / project manager</label><input name="manager" value="${esc(p.manager)}"></div>
    </div>`;
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

function viewWelcome() {
  view.innerHTML = `
    <div class="card">
      <h1>Welcome to SiteInspect</h1>
      <p class="muted">Run safety and quality inspections on your phone, raise actions against subcontractors and print signed reports. Start by adding your project.</p>
      <form id="pf">${projectForm()}<p><button class="btn-primary btn-block">Create project</button></p></form>
    </div>`;
  $("#pf").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const p = await api("/api/projects", { method: "POST", body: formData(e.target) });
      state.projectId = p.id;
      await loadBase();
      location.hash = "#/";
      render();
    } catch (err) { fail(err); }
  });
}

// --- dashboard ---------------------------------------------------------------
async function viewDashboard() {
  const { inspections, actions } = await projectData();
  const open = actions.filter((a) => a.status === "open");
  const overdue = open.filter(isOverdue);
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const recent = inspections.filter((i) => i.status === "submitted" && i.date >= since);
  const avg = recent.length ? Math.round(recent.reduce((s, i) => s + i.score, 0) / recent.length) : null;
  const drafts = inspections.filter((i) => i.status === "draft");
  const byAssignee = {};
  for (const a of open) byAssignee[a.assignee || "Unassigned"] = (byAssignee[a.assignee || "Unassigned"] || 0) + 1;
  const p = project();

  view.innerHTML = `
    <h1>${esc(p.name)}</h1>
    <p class="muted small">${esc([p.number, p.client, p.address].filter(Boolean).join(" · "))}</p>
    <div class="tiles">
      <a class="tile" href="#/actions"><span class="muted small">Open actions</span><b>${open.length}</b></a>
      <a class="tile ${overdue.length ? "bad" : ""}" href="#/actions?overdue"><span class="muted small">Overdue</span><b>${overdue.length}</b></a>
      <a class="tile" href="#/inspections"><span class="muted small">Inspections (30 days)</span><b>${recent.length}</b></a>
      <div class="tile"><span class="muted small">Avg score (30 days)</span><b class="score ${avg == null ? "" : scoreClass(avg)}" style="text-align:left">${avg == null ? "–" : avg + "%"}</b></div>
    </div>
    <a class="btn btn-primary btn-block" href="#/new">＋ Start a new inspection</a>
    <div style="height:12px"></div>
    ${drafts.length ? `<div class="card"><h2>In progress</h2><ul class="list">${drafts.map(inspRow).join("")}</ul></div>` : ""}
    <div class="card"><h2>Overdue actions</h2>${overdue.length ? `<ul class="list">${overdue.slice(0, 8).map(actionRow).join("")}</ul>` : `<p class="empty">Nothing overdue.</p>`}</div>
    <div class="card"><h2>Open actions by subcontractor</h2>${
      Object.keys(byAssignee).length
        ? `<ul class="list">${Object.entries(byAssignee).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li><div class="li"><span class="main">${esc(k)}</span><b>${n}</b></div></li>`).join("")}</ul>`
        : `<p class="empty">No open actions.</p>`
    }</div>
    <div class="card"><h2>Recent inspections</h2>${
      inspections.filter((i) => i.status === "submitted").length
        ? `<ul class="list">${inspections.filter((i) => i.status === "submitted").sort(byNewest).slice(0, 8).map(inspRow).join("")}</ul>`
        : `<p class="empty">No inspections submitted yet.</p>`
    }</div>`;
  bindActionRows(actions);
}

const byNewest = (a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt);

function inspRow(i) {
  const href = i.status === "draft" ? `#/inspect/${i.id}` : `#/report/${i.id}`;
  const answered = i.items.filter((x) => x.result).length;
  const fails = i.items.filter((x) => x.result === "fail").length;
  return `<li><a href="${href}">
    <div class="main"><div class="title">${esc(i.templateName)}</div>
      <div class="muted small">${esc(i.ref)} · ${esc(fmtDate(i.date))}${i.area ? " · " + esc(i.area) : ""}${i.inspector ? " · " + esc(i.inspector) : ""}</div></div>
    ${i.status === "draft" ? pill("draft", `${answered}/${i.items.length}`) : `${fails ? pill("fail", fails + " fail") : ""}<span class="score ${scoreClass(i.score)}">${i.score}%</span>`}
  </a></li>`;
}

function actionRow(a) {
  return `<li><a href="#" data-action="${esc(a.id)}">
    <div class="main"><div class="title">${esc(a.title)}</div>
      <div class="muted small">${esc(a.ref)} · ${esc(a.assignee || "Unassigned")}${a.location ? " · " + esc(a.location) : ""} · due ${esc(fmtDate(a.dueDate))}</div></div>
    ${a.priority === "critical" || a.priority === "high" ? pill(a.priority, a.priority) : ""}${actionPill(a)}
  </a></li>`;
}

function bindActionRows(actions, after) {
  $$("[data-action]", view).forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const a = actions.find((x) => x.id === el.dataset.action);
      if (a) actionModal(a, actions, after || render);
    })
  );
}

// --- inspections list ------------------------------------------------------
async function viewInspections() {
  const { inspections } = await projectData();
  let filter = store.get("si.inspFilter", "all");
  const draw = () => {
    const list = inspections.filter((i) => filter === "all" || i.status === filter).sort(byNewest);
    view.innerHTML = `
      <div class="row spread"><h1>Inspections</h1><a class="btn btn-primary" href="#/new">＋ New</a></div>
      <div class="chips">${[["all", "All"], ["draft", "In progress"], ["submitted", "Submitted"]]
        .map(([k, l]) => `<button data-f="${k}" class="${k === filter ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="card">${list.length ? `<ul class="list">${list.map(inspRow).join("")}</ul>` : `<p class="empty">No inspections here yet.</p>`}</div>`;
    $$("[data-f]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.f; store.set("si.inspFilter", filter); draw(); }));
  };
  draw();
}

// --- new inspection ----------------------------------------------------------
async function viewNew() {
  const cats = {};
  for (const t of state.templates) (cats[t.category] = cats[t.category] || []).push(t);
  const count = (t) => t.sections.reduce((n, s) => n + s.items.length, 0);
  view.innerHTML = `
    <h1>New inspection</h1>
    <form id="nf" class="card">
      <label>Checklist *</label>
      <select name="templateId" required>${Object.entries(cats)
        .map(([c, ts]) => `<optgroup label="${esc(c)}">${ts.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${count(t)} checks)</option>`).join("")}</optgroup>`)
        .join("")}</select>
      <p class="muted small" id="freq"></p>
      <label>Area / location on site</label><input name="area" placeholder="e.g. Block B, level 2" value="${esc(store.get("si.lastArea"))}">
      <div class="grid2">
        <div><label>Date</label><input type="date" name="date" value="${today()}"></div>
        <div><label>Inspector</label><input name="inspector" value="${esc(store.get("si.inspector"))}" placeholder="Your name"></div>
      </div>
      <label>Weather</label><input name="weather" placeholder="e.g. Fine, 24°C">
      <p><button class="btn-primary btn-block">Start inspection</button></p>
    </form>`;
  const sel = $("[name=templateId]");
  const showFreq = () => {
    const t = state.templates.find((x) => x.id === sel.value);
    $("#freq").textContent = t && t.frequency ? `Frequency: ${t.frequency}` : "";
  };
  sel.addEventListener("change", showFreq);
  showFreq();
  $("#nf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    body.projectId = state.projectId;
    store.set("si.inspector", body.inspector);
    store.set("si.lastArea", body.area);
    try {
      const insp = await api("/api/inspections", { method: "POST", body });
      location.hash = `#/inspect/${insp.id}`;
    } catch (err) { fail(err); }
  });
}

// --- inspection runner ---------------------------------------------------------
async function viewRunner(id) {
  const insp = await api(`/api/inspections/${id}`);
  if (insp.status !== "draft") return (location.hash = `#/report/${id}`);
  const { actions } = await projectData();
  const assignees = assigneeList(actions);

  // Autosave: changes are batched and sent one request at a time.
  let dirty = false, saving = null, timer = null;
  const setSaveState = (t) => { const el = $("#saveState"); if (el) el.textContent = t; };
  const save = async () => {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return;
    dirty = false;
    setSaveState("Saving…");
    saving = api(`/api/inspections/${id}`, {
      method: "PUT",
      body: { items: insp.items, notes: insp.notes, area: insp.area, weather: insp.weather },
    })
      .then(() => setSaveState("Saved"))
      .catch((e) => { dirty = true; setSaveState("Not saved - check connection"); fail(e); })
      .finally(() => (saving = null));
    await saving;
  };
  const queueSave = () => { dirty = true; setSaveState("Unsaved changes"); clearTimeout(timer); timer = setTimeout(save, 700); };
  leaveHook = save;

  const sections = [];
  for (const it of insp.items) {
    let s = sections.find((x) => x.title === it.section);
    if (!s) sections.push((s = { title: it.section, items: [] }));
    s.items.push(it);
  }

  const itemHtml = (it) => `
    <div class="item ${it.result === "fail" ? "is-fail" : ""}" data-item="${esc(it.id)}">
      <div class="item-text">${esc(it.text)}</div>
      <div class="seg">
        ${[["pass", "✓ Pass"], ["fail", "✕ Fail"], ["na", "N/A"]].map(([r, l]) => `<button type="button" class="${r} ${it.result === r ? "on" : ""}" data-result="${r}">${l}</button>`).join("")}
      </div>
      ${it.result === "fail" ? `<div class="fail-box grid2">
        <div><label>Priority</label><select data-f="priority">${PRIORITIES.map((p) => `<option ${it.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>
        <div><label>Assign to (subcontractor / person)</label><input data-f="assignee" list="assignees" value="${esc(it.assignee)}"></div>
        <div><label>Due date <span class="muted">(blank = by priority)</span></label><input type="date" data-f="dueDate" value="${esc(it.dueDate)}"></div>
      </div>` : ""}
      <textarea data-f="note" placeholder="${it.result === "fail" ? "What's wrong and what needs to be done?" : "Note (optional)"}" ${it.note || it.result === "fail" ? "" : "hidden"}>${esc(it.note)}</textarea>
      <div class="item-tools">
        ${it.note || it.result === "fail" ? "" : `<button type="button" data-addnote>✎ Note</button>`}
        ${photoInput("data-photo")}
      </div>
      ${thumbs(it.photos, true)}
    </div>`;

  const sectionStats = (s) => `${s.items.filter((i) => i.result).length}/${s.items.length}`;
  const drawProgress = () => {
    const done = insp.items.filter((i) => i.result).length;
    const fails = insp.items.filter((i) => i.result === "fail").length;
    $("#prog").style.width = `${(done / insp.items.length) * 100}%`;
    $("#progText").textContent = `${done} of ${insp.items.length} checked${fails ? ` · ${fails} failed` : ""}`;
    $("#signBtn").disabled = done < insp.items.length;
    sections.forEach((s, i) => ($(`#sec${i}`).textContent = sectionStats(s)));
  };

  view.innerHTML = `
    <div class="sticky-head">
      <div class="row spread"><div><b>${esc(insp.templateName)}</b><div class="muted small">${esc(insp.ref)} · ${esc(fmtDate(insp.date))}</div></div><span class="save-state" id="saveState">Saved</span></div>
      <div class="progress"><span id="prog"></span></div>
      <div class="row spread small" style="margin-top:4px"><span id="progText"></span><button class="small" type="button" id="markRest" style="padding:3px 8px">Mark rest Pass</button></div>
    </div>
    <div class="card grid2">
      <div><label>Area / location</label><input id="area" value="${esc(insp.area)}"></div>
      <div><label>Weather</label><input id="weather" value="${esc(insp.weather)}"></div>
    </div>
    ${sections.map((s, i) => `
      <details class="card section" open>
        <summary>${esc(s.title)} <span class="muted small" id="sec${i}">${sectionStats(s)}</span></summary>
        ${s.items.map(itemHtml).join("")}
      </details>`).join("")}
    <div class="card"><label style="margin-top:0">General notes / observations</label><textarea id="notes" placeholder="Anything else seen on the walk, good practice, toolbox talk topics…">${esc(insp.notes)}</textarea></div>
    <button class="btn-primary btn-block" id="signBtn">Review &amp; sign</button>
    <p class="row spread"><a href="#/inspections" class="btn">Save &amp; exit</a><button class="btn-danger" id="delBtn">Delete draft</button></p>
    ${datalist("assignees", assignees)}`;
  drawProgress();

  const redrawItem = (it) => {
    const el = $(`[data-item="${it.id}"]`);
    el.outerHTML = itemHtml(it);
    bindItem($(`[data-item="${it.id}"]`));
    drawProgress();
  };

  function bindItem(el) {
    const it = insp.items.find((x) => x.id === el.dataset.item);
    $$("[data-result]", el).forEach((b) => b.addEventListener("click", () => {
      it.result = it.result === b.dataset.result ? null : b.dataset.result;
      queueSave();
      redrawItem(it);
    }));
    $$("[data-f]", el).forEach((f) => f.addEventListener("input", () => { it[f.dataset.f] = f.value; queueSave(); }));
    const addNote = $("[data-addnote]", el);
    if (addNote) addNote.addEventListener("click", () => { const t = $("textarea", el); t.hidden = false; t.focus(); addNote.remove(); });
    $("[data-photo]", el).addEventListener("change", async (e) => {
      const files = [...e.target.files];
      setSaveState(`Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`);
      try {
        for (const f of files) it.photos.push(await uploadPhoto(f));
        queueSave();
        redrawItem(it);
      } catch (err) { fail(err); setSaveState("Photo upload failed"); }
    });
    $$("[data-rm-photo]", el).forEach((b) => b.addEventListener("click", () => {
      it.photos = it.photos.filter((p) => p !== b.dataset.rmPhoto);
      queueSave();
      redrawItem(it);
    }));
  }
  $$("[data-item]").forEach(bindItem);

  for (const f of ["area", "weather", "notes"]) $(`#${f}`).addEventListener("input", (e) => { insp[f] = e.target.value; queueSave(); });
  $("#markRest").addEventListener("click", () => {
    const rest = insp.items.filter((i) => !i.result);
    if (!rest.length) return;
    if (!confirm(`Mark the ${rest.length} unanswered item(s) as Pass?`)) return;
    rest.forEach((i) => { i.result = "pass"; redrawItem(i); });
    queueSave();
  });
  $("#delBtn").addEventListener("click", async () => {
    if (!confirm("Delete this draft inspection?")) return;
    leaveHook = null;
    try { await api(`/api/inspections/${id}`, { method: "DELETE" }); location.hash = "#/inspections"; } catch (e) { fail(e); }
  });
  $("#signBtn").addEventListener("click", async () => {
    await save();
    signModal(insp, () => (leaveHook = null));
  });
}

function signModal(insp, onDone) {
  const c = { pass: 0, fail: 0, na: 0 };
  insp.items.forEach((i) => c[i.result]++);
  const score = c.pass + c.fail ? Math.round((c.pass / (c.pass + c.fail)) * 100) : 100;
  const body = openModal(`
    <h2>Review &amp; sign</h2>
    <p><span class="score ${scoreClass(score)}" style="font-size:28px">${score}%</span></p>
    <p class="row">${pill("pass", c.pass + " pass")} ${pill("fail", c.fail + " fail")} ${pill("na", c.na + " N/A")}</p>
    ${c.fail ? `<p class="small">Submitting raises <b>${c.fail}</b> action${c.fail > 1 ? "s" : ""} on the actions register.</p>` : ""}
    <label>Inspector name *</label><input id="sigName" value="${esc(insp.inspector || store.get("si.inspector"))}">
    <label>Signature *</label><canvas class="sig" id="sig"></canvas>
    <div class="row spread" style="margin-top:6px"><span class="muted small">Sign with your finger or mouse</span><button type="button" id="sigClear" class="small">Clear</button></div>
    <p class="muted small">Once submitted the inspection is locked and becomes part of the site record.</p>
    <div class="row"><button data-close>Cancel</button><button class="btn-primary grow" id="submitBtn">Submit inspection</button></div>`);
  const pad = signaturePad($("#sig", body));
  $("#sigClear").addEventListener("click", pad.clear);
  $("#submitBtn").addEventListener("click", async (e) => {
    const name = $("#sigName").value.trim();
    if (!name) return toast("Enter your name", true);
    if (pad.isEmpty()) return toast("Please sign first", true);
    e.target.disabled = true;
    try {
      store.set("si.inspector", name);
      await api(`/api/inspections/${insp.id}/submit`, { method: "POST", body: { inspector: name, signature: pad.toDataURL() } });
      onDone();
      toast("Inspection submitted");
      location.hash = `#/report/${insp.id}`;
    } catch (err) { e.target.disabled = false; fail(err); }
  });
}

function signaturePad(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.offsetWidth * ratio;
  canvas.height = canvas.offsetHeight * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.2;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = "#111";
  let drawing = false, empty = true;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  canvas.addEventListener("pointermove", (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); empty = false; });
  ["pointerup", "pointercancel"].forEach((ev) => canvas.addEventListener(ev, () => (drawing = false)));
  return {
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    isEmpty: () => empty,
    toDataURL: () => canvas.toDataURL("image/png"),
  };
}

// --- report --------------------------------------------------------------------
async function viewReport(id) {
  const insp = await api(`/api/inspections/${id}`);
  if (insp.status === "draft") return (location.hash = `#/inspect/${id}`);
  const actions = (await api(`/api/actions?projectId=${encodeURIComponent(insp.projectId)}`)).filter((a) => a.inspectionId === id);
  const p = state.projects.find((x) => x.id === insp.projectId) || {};
  const c = { pass: 0, fail: 0, na: 0 };
  insp.items.forEach((i) => c[i.result]++);
  const fails = insp.items.filter((i) => i.result === "fail");
  const sections = [...new Set(insp.items.map((i) => i.section))];
  const resultCell = (r) => pill(r, r === "na" ? "N/A" : r === "pass" ? "Pass" : "Fail");

  view.innerHTML = `
    <div class="row spread no-print" style="margin-bottom:12px">
      <a class="btn" href="#/inspections">← Back</a>
      <div class="row">${state.config.aiEnabled ? `<button id="aiBtn">${insp.summary ? "↻ Redo AI summary" : "✨ AI summary"}</button>` : ""}<button class="btn-dark" onclick="window.print()">Print / Save PDF</button></div>
    </div>
    <article class="report">
      <div class="report-head">
        <div>
          ${state.config.company ? `<div class="muted small">${esc(state.config.company)}</div>` : ""}
          <h1>${esc(insp.templateName)}</h1>
          <div>${esc(p.name)}${p.number ? ` (${esc(p.number)})` : ""}</div>
        </div>
        <div style="text-align:right"><div class="big-score score ${scoreClass(insp.score)}">${insp.score}%</div><div class="small muted">${esc(insp.ref)}</div></div>
      </div>
      <table class="meta">
        <tr><td>Date</td><td>${esc(fmtDate(insp.date))}</td><td>Inspector</td><td>${esc(insp.inspector)}</td></tr>
        <tr><td>Area</td><td>${esc(insp.area || "–")}</td><td>Weather</td><td>${esc(insp.weather || "–")}</td></tr>
        <tr><td>Client</td><td>${esc(p.client || "–")}</td><td>Site address</td><td>${esc(p.address || "–")}</td></tr>
        <tr><td>Results</td><td colspan="3">${c.pass} pass · ${c.fail} fail · ${c.na} N/A (${insp.items.length} checks)</td></tr>
      </table>
      <div id="summaryBox">${insp.summary ? `<h2>Summary</h2><div class="summary">${esc(insp.summary)}</div><p class="muted small">Summary drafted with AI from the checklist results and photos. Check it before relying on it.</p>` : ""}</div>
      <h2>Findings requiring action (${fails.length})</h2>
      ${fails.length ? `<table><tr><th>Ref</th><th>Finding</th><th>Priority</th><th>Assigned to</th><th>Due</th><th>Status</th></tr>
        ${fails.map((i) => {
          const a = actions.find((x) => x.id === i.actionId) || {};
          return `<tr><td>${esc(a.ref || "")}</td><td><b>${esc(i.text)}</b><div class="muted">${esc(i.section)}</div>${i.note ? `<div>${esc(i.note)}</div>` : ""}${i.photos.length ? `<div class="photos">${i.photos.map((ph) => `<img src="${photoUrl(ph)}" alt="Photo">`).join("")}</div>` : ""}</td>
            <td>${esc(i.priority)}</td><td>${esc(a.assignee || i.assignee || "–")}</td><td>${esc(fmtDate(a.dueDate))}</td><td>${a.id ? actionPill(a) : ""}</td></tr>`;
        }).join("")}</table>` : `<p>No defects found.</p>`}
      <h2>Full checklist</h2>
      <table><tr><th>Check</th><th style="width:70px">Result</th><th>Note</th></tr>
        ${sections.map((s) => `<tr><th colspan="3">${esc(s)}</th></tr>${insp.items.filter((i) => i.section === s).map((i) => `<tr><td>${esc(i.text)}</td><td>${resultCell(i.result)}</td><td>${esc(i.note)}${i.result !== "fail" && i.photos.length ? `<div class="photos">${i.photos.map((ph) => `<img src="${photoUrl(ph)}" alt="Photo">`).join("")}</div>` : ""}</td></tr>`).join("")}`).join("")}
      </table>
      ${insp.notes ? `<h2>General notes</h2><p style="white-space:pre-wrap">${esc(insp.notes)}</p>` : ""}
      <h2>Sign-off</h2>
      <p>${insp.signature ? `<img class="sig-img" src="${esc(insp.signature)}" alt="Signature"><br>` : ""}${esc(insp.inspector)} · submitted ${esc(fmtDate(insp.submittedAt))}</p>
    </article>`;

  const ai = $("#aiBtn");
  if (ai) ai.addEventListener("click", async () => {
    ai.disabled = true;
    ai.textContent = "Writing summary…";
    try {
      const updated = await api(`/api/inspections/${id}/summary`, { method: "POST" });
      insp.summary = updated.summary;
      render();
    } catch (e) { fail(e); ai.disabled = false; ai.textContent = "✨ AI summary"; }
  });
}

// --- actions -------------------------------------------------------------------
async function viewActions() {
  const { actions } = await projectData();
  let filter = location.hash.includes("overdue") ? "overdue" : store.get("si.actFilter", "open");
  let who = "", q = "";
  const assignees = assigneeList(actions);
  const draw = () => {
    const list = actions
      .filter((a) => filter === "all" || (filter === "overdue" ? isOverdue(a) : a.status === filter))
      .filter((a) => !who || (a.assignee || "") === who)
      .filter((a) => !q || `${a.ref} ${a.title} ${a.description} ${a.location} ${a.assignee}`.toLowerCase().includes(q))
      .sort((a, b) => (a.status === b.status ? (a.dueDate || "9").localeCompare(b.dueDate || "9") : a.status === "open" ? -1 : 1));
    $("#alist").innerHTML = list.length ? `<ul class="list">${list.map(actionRow).join("")}</ul>` : `<p class="empty">No actions match.</p>`;
    $$(".chips button").forEach((b) => b.classList.toggle("on", b.dataset.f === filter));
    bindActionRows(actions, viewActions);
  };
  view.innerHTML = `
    <div class="row spread"><h1>Actions</h1><div class="row"><a class="btn" href="/api/actions.csv?projectId=${encodeURIComponent(state.projectId)}">⬇ CSV</a><button class="btn-primary" id="newAct">＋ New</button></div></div>
    <div class="chips">${[["open", "Open"], ["overdue", "Overdue"], ["closed", "Closed"], ["all", "All"]].map(([k, l]) => `<button data-f="${k}">${l}</button>`).join("")}</div>
    <div class="row" style="margin-bottom:10px">
      <select id="who" class="grow" style="width:auto"><option value="">All subcontractors</option>${assignees.map((a) => `<option>${esc(a)}</option>`).join("")}</select>
      <input id="q" class="grow" style="width:auto" placeholder="Search…">
    </div>
    <div class="card" id="alist"></div>`;
  $$(".chips button").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.f; store.set("si.actFilter", filter); draw(); }));
  $("#who").addEventListener("change", (e) => { who = e.target.value; draw(); });
  $("#q").addEventListener("input", (e) => { q = e.target.value.toLowerCase(); draw(); });
  $("#newAct").addEventListener("click", () => actionModal(null, actions, viewActions));
  draw();
}

function actionModal(a, actions, after) {
  const isNew = !a;
  a = a || { title: "", description: "", location: "", assignee: "", priority: "medium", dueDate: "", photos: [], status: "open" };
  const photos = [...(a.photos || [])];
  const closePhotos = [];
  const closed = a.status === "closed";
  const body = openModal(`
    <div class="row spread"><h2>${isNew ? "New action" : esc(a.ref)}</h2>${isNew ? "" : actionPill(a)}</div>
    ${a.inspectionRef ? `<p class="muted small">Raised from inspection <a href="#/report/${esc(a.inspectionId)}">${esc(a.inspectionRef)}</a> by ${esc(a.raisedBy)}</p>` : a.raisedBy ? `<p class="muted small">Raised by ${esc(a.raisedBy)}</p>` : ""}
    <form id="af">
      <fieldset style="border:0;padding:0;margin:0" ${closed ? "disabled" : ""}>
        <label>What needs doing? *</label><input name="title" required value="${esc(a.title)}">
        <label>Details</label><textarea name="description">${esc(a.description)}</textarea>
        <div class="grid2">
          <div><label>Location</label><input name="location" value="${esc(a.location)}"></div>
          <div><label>Assign to</label><input name="assignee" list="assigneesM" value="${esc(a.assignee)}"></div>
          <div><label>Priority</label><select name="priority">${PRIORITIES.map((p) => `<option ${a.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>
          <div><label>Due date</label><input type="date" name="dueDate" value="${esc(a.dueDate)}"></div>
        </div>
        <div id="aPhotos">${thumbs(photos, !closed)}</div>
        ${closed ? "" : `<div class="item-tools">${photoInput('id="aPhotoIn"')}</div>`}
      </fieldset>
      ${datalist("assigneesM", assigneeList(actions))}
      ${closed ? `<div class="card" style="margin-top:12px;background:var(--pass-bg)"><b>Closed</b> by ${esc(a.closedBy)} on ${esc(fmtDate(a.closedAt))}<p style="white-space:pre-wrap">${esc(a.closeoutNote)}</p>${thumbs(a.closeoutPhotos, false)}</div>` : ""}
      <div class="row" style="margin-top:14px">
        <button type="button" data-close>Cancel</button>
        ${closed ? `<button type="button" id="reopen" class="grow">Reopen</button>` : `<button class="btn-dark grow">${isNew ? "Raise action" : "Save"}</button>`}
      </div>
    </form>
    ${!isNew && !closed ? `
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <h3>Close out</h3>
      <label>Close-out note (what was done)</label><textarea id="coNote"></textarea>
      <div id="coPhotos"></div>
      <div class="item-tools">${photoInput('id="coPhotoIn"')}</div>
      <label>Closed by *</label><input id="coBy" value="${esc(store.get("si.inspector"))}">
      <p><button class="btn-primary btn-block" id="closeBtn">Close action</button></p>` : ""}`);

  const bindPhotos = (inputSel, list, boxSel) => {
    const box = $(boxSel, body);
    const redraw = () => {
      box.innerHTML = thumbs(list, true);
      $$("[data-rm-photo]", box).forEach((b) => b.addEventListener("click", () => { list.splice(list.indexOf(b.dataset.rmPhoto), 1); redraw(); }));
    };
    redraw();
    const input = $(inputSel, body);
    if (input) input.addEventListener("change", async (e) => {
      try { for (const f of e.target.files) list.push(await uploadPhoto(f)); redraw(); } catch (err) { fail(err); }
    });
  };
  if (!closed) bindPhotos("#aPhotoIn", photos, "#aPhotos");
  if (!isNew && !closed) bindPhotos("#coPhotoIn", closePhotos, "#coPhotos");

  $("#af", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { ...formData(e.target), photos };
    try {
      if (isNew) await api("/api/actions", { method: "POST", body: { ...data, projectId: state.projectId, raisedBy: store.get("si.inspector") } });
      else await api(`/api/actions/${a.id}`, { method: "PUT", body: data });
      closeModal();
      toast(isNew ? "Action raised" : "Saved");
      after();
    } catch (err) { fail(err); }
  });
  const reopen = $("#reopen", body);
  if (reopen) reopen.addEventListener("click", async () => {
    try { await api(`/api/actions/${a.id}`, { method: "PUT", body: { status: "open" } }); closeModal(); toast("Action reopened"); after(); } catch (err) { fail(err); }
  });
  const closeBtn = $("#closeBtn", body);
  if (closeBtn) closeBtn.addEventListener("click", async () => {
    const closedBy = $("#coBy", body).value.trim();
    try {
      await api(`/api/actions/${a.id}`, { method: "PUT", body: { status: "closed", closeoutNote: $("#coNote", body).value, closeoutPhotos: closePhotos, closedBy } });
      store.set("si.inspector", closedBy);
      closeModal();
      toast("Action closed");
      after();
    } catch (err) { fail(err); }
  });
}

// --- setup -----------------------------------------------------------------------
async function viewSetup() {
  const custom = state.templates.filter((t) => !t.builtIn);
  view.innerHTML = `
    <h1>Setup</h1>
    <div class="card">
      <h2>You</h2>
      <label>Your name (used as inspector and on close-outs)</label>
      <input id="me" value="${esc(store.get("si.inspector"))}">
    </div>
    <div class="card">
      <div class="row spread"><h2>Projects</h2><button id="addProj" class="btn-primary">＋ Add</button></div>
      <ul class="list">${state.projects.map((p) => `<li><div class="li"><div class="main"><div class="title">${esc(p.name)}</div><div class="muted small">${esc([p.number, p.client].filter(Boolean).join(" · "))}</div></div><button data-edit="${esc(p.id)}">Edit</button></div></li>`).join("") || `<li class="empty">No projects yet.</li>`}</ul>
    </div>
    <div class="card">
      <div class="row spread"><h2>Checklists</h2><button id="addTpl" class="btn-primary">＋ Custom</button></div>
      <ul class="list">${state.templates.map((t) => `<li><div class="li"><div class="main"><div class="title">${esc(t.name)}</div><div class="muted small">${esc(t.category)}${t.frequency ? " · " + esc(t.frequency) : ""} · ${t.sections.reduce((n, s) => n + s.items.length, 0)} checks${t.builtIn ? " · built in" : ""}</div></div>${t.builtIn ? "" : `<button class="btn-danger" data-deltpl="${esc(t.id)}">Delete</button>`}</div></li>`).join("")}</ul>
      ${custom.length ? "" : `<p class="muted small">Add your own checklists for company-specific inspections, e.g. a tower crane pre-use check or a fire door inspection.</p>`}
    </div>`;
  $("#me").addEventListener("change", (e) => { store.set("si.inspector", e.target.value.trim()); toast("Saved"); });
  $("#addProj").addEventListener("click", () => projectModal());
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => projectModal(state.projects.find((p) => p.id === b.dataset.edit))));
  $("#addTpl").addEventListener("click", templateModal);
  $$("[data-deltpl]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this checklist? Inspections already done with it are kept.")) return;
    try { await api(`/api/templates/${b.dataset.deltpl}`, { method: "DELETE" }); await loadBase(); render(); } catch (e) { fail(e); }
  }));
}

function projectModal(p) {
  const body = openModal(`
    <h2>${p ? "Edit project" : "New project"}</h2>
    <form id="pf">${projectForm(p)}
      <div class="row" style="margin-top:14px"><button type="button" data-close>Cancel</button><button class="btn-dark grow">Save</button></div>
    </form>
    ${p ? `<p><button class="btn-danger" id="delProj">Delete project</button></p>` : ""}`);
  $("#pf", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const saved = await api(p ? `/api/projects/${p.id}` : "/api/projects", { method: p ? "PUT" : "POST", body: formData(e.target) });
      if (!p) state.projectId = saved.id;
      await loadBase();
      render();
    } catch (err) { fail(err); }
  });
  const del = $("#delProj", body);
  if (del) del.addEventListener("click", async () => {
    if (!confirm(`Delete ${p.name} and its open actions?`)) return;
    try {
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      if (state.projectId === p.id) state.projectId = "";
      await loadBase();
      render();
    } catch (err) { fail(err); }
  });
}

// Lines like "Access: Gates secured" put the item in the "Access" section;
// lines without a section go in the last section used.
function parseChecklist(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    if (!line) continue;
    const m = line.match(/^([^:]{1,80}):\s*(.*)$/);
    const title = m ? m[1].trim() : current ? current.title : "General";
    const item = m ? m[2].trim() : line;
    if (!current || current.title !== title) {
      current = sections.find((s) => s.title === title) || null;
      if (!current) sections.push((current = { title, items: [] }));
    }
    if (item) current.items.push(item);
  }
  return sections.filter((s) => s.items.length);
}

function templateModal() {
  const body = openModal(`
    <h2>New checklist</h2>
    <form id="tf">
      <label>Name *</label><input name="name" required placeholder="e.g. Tower crane pre-use check">
      <div class="grid2">
        <div><label>Category</label><select name="category"><option>Safety</option><option>Quality</option><option>Environmental</option><option>Compliance</option><option>Custom</option></select></div>
        <div><label>Frequency</label><input name="frequency" placeholder="e.g. Daily"></div>
      </div>
      <label>Checks * <span class="muted">(one per line, "Section: check")</span></label>
      <textarea name="items" rows="10" placeholder="Pre-start: Operator's licence on site&#10;Pre-start: Daily log book completed&#10;Pre-start: Limit switches tested&#10;Lifting: Lifting plan available&#10;Lifting: Slings and shackles tagged"></textarea>
      <div class="row" style="margin-top:14px"><button type="button" data-close>Cancel</button><button class="btn-dark grow">Save checklist</button></div>
    </form>`);
  $("#tf", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      await api("/api/templates", { method: "POST", body: { name: d.name, category: d.category, frequency: d.frequency, sections: parseChecklist(d.items) } });
      await loadBase();
      toast("Checklist saved");
      render();
    } catch (err) { fail(err); }
  });
}

// --- start ---------------------------------------------------------------------
loadBase()
  .then(render)
  .catch((e) => { view.innerHTML = `<div class="card"><h2>Can't reach the server</h2><p>${esc(e.message)}</p></div>`; });
