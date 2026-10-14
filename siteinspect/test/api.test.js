// Starts the real server in a child process with a throwaway data folder.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { csvCell, scoreOf } = require("../server");

const SERVER = path.join(__dirname, "..", "server.js");
const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "siteinspect-"));
  const port = 3700 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, APP_PASSWORD: "", ANTHROPIC_API_KEY: "", ...env },
  });
  t.after(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => /running/.test(d) && resolve());
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!Buffer.isBuffer(body)) init.headers["content-type"] = "application/json";
    }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { base, call, dataDir };
}

test("refuses to listen publicly without a password", () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, HOST: "0.0.0.0", APP_PASSWORD: "", PORT: "0" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /APP_PASSWORD must be set/);
});

test("password protection and lockout", async (t) => {
  const { call } = await startServer(t, { APP_PASSWORD: "s3cret:pass" });
  const basic = (p) => ({ authorization: "Basic " + Buffer.from("me:" + p).toString("base64") });
  assert.strictEqual((await call("GET", "/api/config")).status, 401);
  assert.strictEqual((await call("GET", "/healthz")).text, "ok");
  assert.strictEqual((await call("GET", "/api/config", undefined, basic("s3cret:pass"))).status, 200);
  for (let i = 0; i < 10; i++) assert.strictEqual((await call("GET", "/api/config", undefined, basic("wrong"))).status, 401);
  assert.strictEqual((await call("GET", "/api/config", undefined, basic("s3cret:pass"))).status, 429);
});

test("inspection flow: submit, score, actions, close-out, CSV", async (t) => {
  const { call, dataDir } = await startServer(t);

  assert.strictEqual((await call("POST", "/api/projects", { name: "" })).status, 400);
  const project = (await call("POST", "/api/projects", { name: "Riverside Park", number: "RP-1" })).json;

  const tpl = (await call("POST", "/api/templates", {
    name: "Mini check",
    sections: [{ title: "Access", items: ["Gate locked", "Signage up"] }, { title: "Edges", items: ["Guardrails fitted"] }],
  })).json;
  assert.strictEqual(tpl.builtIn, false);
  assert.ok((await call("GET", "/api/templates")).json.length > 5, "built-in templates are listed");

  const insp = (await call("POST", "/api/inspections", { projectId: project.id, templateId: tpl.id, area: "Block B", inspector: "Thabo" })).json;
  assert.strictEqual(insp.ref, "INS-0001");
  assert.strictEqual(insp.items.length, 3);

  // A photo for the failed item
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const photo = (await call("POST", "/api/photos", jpeg, { "content-type": "image/jpeg" })).json.id;
  assert.match(photo, /^[a-f0-9]{16}\.jpg$/);
  assert.strictEqual((await call("POST", "/api/photos", Buffer.from("<html>"))).status, 415);
  assert.strictEqual((await call("GET", "/api/photos/..%2fdb.json")).status, 404);
  assert.strictEqual((await call("GET", `/api/photos/${photo}`)).status, 200);

  // Partially answered: can't submit yet
  await call("PUT", `/api/inspections/${insp.id}`, { items: [{ id: "i1", result: "pass" }] });
  let r = await call("POST", `/api/inspections/${insp.id}/submit`, { signature: SIG });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /2 item/);

  await call("PUT", `/api/inspections/${insp.id}`, {
    items: [
      { id: "i2", result: "na" },
      { id: "i3", result: "fail", note: "Missing on east slab edge", priority: "high", assignee: "ABC Formwork", photos: [photo, "../../etc/passwd"] },
    ],
  });
  const saved = (await call("GET", `/api/inspections/${insp.id}`)).json;
  assert.deepStrictEqual(saved.items[2].photos, [photo], "bad photo ids are dropped");
  assert.strictEqual(saved.items[0].result, "pass", "earlier answers are kept");

  assert.strictEqual((await call("POST", `/api/inspections/${insp.id}/submit`, { signature: "nope" })).status, 400);
  r = await call("POST", `/api/inspections/${insp.id}/submit`, { signature: SIG });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, "submitted");
  assert.strictEqual(r.json.score, 50); // 1 pass, 1 fail, N/A ignored

  // Locked once submitted
  assert.strictEqual((await call("PUT", `/api/inspections/${insp.id}`, { notes: "x" })).status, 409);
  assert.strictEqual((await call("DELETE", `/api/inspections/${insp.id}`)).status, 409);
  assert.strictEqual((await call("DELETE", `/api/projects/${project.id}`)).status, 409);

  // One action raised for the failed item, due in 2 days for high priority
  const actions = (await call("GET", `/api/actions?projectId=${project.id}`)).json;
  assert.strictEqual(actions.length, 1);
  const a = actions[0];
  assert.strictEqual(a.ref, "ACT-0001");
  assert.strictEqual(a.title, "Guardrails fitted");
  assert.strictEqual(a.assignee, "ABC Formwork");
  assert.strictEqual(a.raisedBy, "Thabo");
  const due = new Date(insp.date + "T00:00:00Z");
  due.setUTCDate(due.getUTCDate() + 2);
  assert.strictEqual(a.dueDate, due.toISOString().slice(0, 10));

  // Closing needs evidence and a name
  assert.strictEqual((await call("PUT", `/api/actions/${a.id}`, { status: "closed", closedBy: "Thabo" })).status, 400);
  r = await call("PUT", `/api/actions/${a.id}`, { status: "closed", closedBy: "Thabo", closeoutNote: "Guardrails installed and checked" });
  assert.strictEqual(r.json.status, "closed");
  assert.ok(r.json.closedAt);

  // Manual action
  r = await call("POST", "/api/actions", { projectId: project.id, title: "=HYPERLINK(\"x\")", priority: "low" });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.ref, "ACT-0002");

  const csv = await call("GET", `/api/actions.csv?projectId=${project.id}`);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.text, /ACT-0001,closed,high,Guardrails fitted/);
  assert.match(csv.text, /"'=HYPERLINK\(""x""\)"/, "formulas are neutralised");

  // Data survives on disk
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8"));
  assert.strictEqual(db.inspections.length, 1);
  assert.strictEqual(db.actions.length, 2);

  // AI summary is off without a key
  assert.strictEqual((await call("POST", `/api/inspections/${insp.id}/summary`)).status, 400);
});

test("helpers", () => {
  assert.strictEqual(csvCell("+27 11 555"), "'+27 11 555");
  assert.strictEqual(csvCell('a "b", c'), '"a ""b"", c"');
  assert.strictEqual(scoreOf([{ result: "na" }]), 100);
  assert.strictEqual(scoreOf([{ result: "pass" }, { result: "pass" }, { result: "fail" }]), 67);
});
