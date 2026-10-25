import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-server-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let server;
let cookie = "";

async function api(method, route, body, headers = {}) {
  const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = response.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const user = (method, route, body) => api(method, route, body, { "X-Requested-With": "orchestrator" });

async function rpc(token, message, headers = {}) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(message) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const call = async (token, name, args = {}) => {
  const { body } = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { error: body.result.isError, value: body.result.isError ? body.result.content[0].text : JSON.parse(body.result.content[0].text) };
};

test.before(async () => {
  server = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => { if (String(chunk).includes("listening")) resolve(); });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});

test.after(() => server?.kill("SIGTERM"));

test("health and session", async () => {
  assert.deepEqual((await api("GET", "/healthz")).body.ok, true);
  const session = (await api("GET", "/api/session")).body;
  assert.equal(session.hasPassword, false);
  assert.equal(session.authed, false);
});

test("claiming the instance needs the setup code", async () => {
  const code = fs.readFileSync(path.join(dir, "setup-code"), "utf8").trim();
  assert.equal((await user("POST", "/api/setup/password", { password: "a long enough password", code: "wrong" })).status, 400);
  assert.equal((await api("POST", "/api/setup/password", { password: "a long enough password", code })).status, 403);
  const ok = await user("POST", "/api/setup/password", { password: "a long enough password", code });
  assert.equal(ok.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, "setup-code")));
  assert.equal((await user("POST", "/api/setup/password", { password: "another long password", code })).status, 400);
  assert.equal((await api("GET", "/api/session")).body.authed, true);
});

test("dashboard writes need the request header and a session", async () => {
  assert.equal((await api("POST", "/api/plans", { title: "x" })).status, 403);
  assert.equal((await user("POST", "/api/plans", { title: "Write tests" })).status, 200);
  const saved = cookie;
  cookie = "";
  assert.equal((await user("POST", "/api/plans", { title: "x" })).status, 401);
  cookie = saved;
});

test("MCP: tools, status, and requests that wait for approval", async () => {
  const created = (await user("POST", "/api/agents", { name: "Test agent", client: "claude-code" })).body;
  assert.ok(created.token);
  const init = await rpc(created.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.body.result.serverInfo.name, "anyps5-orchestrator");
  assert.equal((await rpc(created.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await rpc(created.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools;
  assert.ok(list.find((tool) => tool.name === "get_overview").annotations.readOnlyHint);
  assert.ok(list.find((tool) => tool.name === "run_command").annotations.destructiveHint);
  assert.deepEqual((await call(created.token, "report_status", { task: "Testing" })).value, { ok: true });
  assert.ok((await call(created.token, "get_overview")).value.repo);
  assert.equal((await call(created.token, "get_overview", { stray: 1 })).error, true);
  const pending = (await call(created.token, "set_gpu_enabled", { machine: "none", gpu: 0, enabled: false })).value;
  assert.equal(pending.status, "pending");
  assert.equal((await call(created.token, "get_request", { id: pending.request })).value.status, "pending");
  const decided = (await user("POST", `/api/requests/${pending.request}/decide`, { decision: "deny" })).body;
  assert.equal(decided.status, "denied");
  assert.equal((await call(created.token, "get_request", { id: pending.request })).value.status, "denied");
  const state = (await api("GET", "/api/state")).body;
  assert.equal(state.agents[0].status.task, "Testing");
  assert.ok(state.agents[0].lastSeen);
});

test("MCP refuses missing tokens, wrong tokens and other sites", async () => {
  assert.equal((await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  assert.equal((await rpc("nope", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  const created = (await user("POST", "/api/agents", { name: "Second", client: "other" })).body;
  assert.equal((await rpc(created.token, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://evil.example" })).status, 403);
  await user("DELETE", `/api/agents/${created.id}`);
  assert.equal((await rpc(created.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
});

test("repeated wrong passwords are slowed down", async () => {
  const saved = cookie;
  cookie = "";
  for (let attempt = 0; attempt < 5; attempt++) await user("POST", "/api/login", { password: "not the password" });
  const blocked = await user("POST", "/api/login", { password: "a long enough password" });
  assert.match(blocked.body.error, /too many attempts/);
  cookie = saved;
});
