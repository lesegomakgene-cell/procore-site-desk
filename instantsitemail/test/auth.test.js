// Starts the real server in a child process to check password protection.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");

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
  const port = 3300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), APP_PASSWORD: "s3cret:pass", ANTHROPIC_API_KEY: "" },
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.on("data", (d) => /running/.test(d) && resolve()));

  const url = `http://127.0.0.1:${port}/api/config`;
  const basic = (p) => ({ authorization: "Basic " + Buffer.from("me:" + p).toString("base64") });

  assert.strictEqual((await fetch(url)).status, 401);
  assert.strictEqual((await fetch(url, { headers: basic("s3cret:pass") })).status, 200);

  for (let i = 0; i < 10; i++) assert.strictEqual((await fetch(url, { headers: basic("wrong") })).status, 401);
  // Locked out now, even with the right password
  assert.strictEqual((await fetch(url, { headers: basic("s3cret:pass") })).status, 429);
});
