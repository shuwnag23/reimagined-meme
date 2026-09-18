const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

async function startServer() {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pickup-station-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_PASSWORD: "integration-test-password",
      ADMIN_SESSION_SECRET: "integration-test-session-secret",
      PICKUP_DATA_DIR: path.join(runtimeDir, "data"),
      PICKUP_UPLOAD_DIR: path.join(runtimeDir, "uploads"),
      PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", function (chunk) { stderr += chunk; });

  const port = await new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new Error("服务启动超时\n" + stderr));
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", function (chunk) {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once("exit", function (code) {
      clearTimeout(timer);
      reject(new Error("服务提前退出，退出码 " + code + "\n" + stderr));
    });
    child.once("error", reject);
  });

  return { child, port, runtimeDir };
}

test("public pages and authenticated admin API are available", async function (context) {
  const server = await startServer();
  context.after(async function () {
    server.child.kill();
    await new Promise(function (resolve) {
      if (server.child.exitCode !== null) return resolve();
      server.child.once("exit", resolve);
    });
    await rm(server.runtimeDir, { recursive: true, force: true });
  });

  const baseUrl = "http://127.0.0.1:" + server.port;
  const home = await fetch(baseUrl + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<!doctype html>/i);
  assert.equal(home.headers.get("x-content-type-options"), "nosniff");

  const state = await fetch(baseUrl + "/api/public/state");
  assert.equal(state.status, 200);
  const publicData = await state.json();
  assert.equal(publicData.products.length, 1);
  assert.equal(publicData.products[0].title, "示例商品文件");

  const rejectedLogin = await fetch(baseUrl + "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "admin", password: "wrong-password" })
  });
  assert.equal(rejectedLogin.status, 401);

  const login = await fetch(baseUrl + "/api/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https"
    },
    body: JSON.stringify({ user: "admin", password: "integration-test-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /pickup_admin=/);
  assert.match(cookie, /; Secure/);

  const adminState = await fetch(baseUrl + "/api/admin/state", {
    headers: { Cookie: cookie.split(";")[0] }
  });
  assert.equal(adminState.status, 200);
  const adminData = await adminState.json();
  assert.equal(adminData.products[0].codes[0], "DEMO-2026");
});
