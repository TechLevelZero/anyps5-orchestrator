import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
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

test("adding a machine explains SSH failures", async () => {
  const refused = await user("POST", "/api/machines", { kind: "ssh", name: "nowhere", host: "127.0.0.1", user: "nobody", port: 1, auth: "key" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /refused the connection on port 1/);
  const state = (await api("GET", "/api/state")).body;
  assert.match(state.activity[0].text, /Couldn't add nobody@127\.0\.0\.1/);
});

function openLive(headers) {
  return new Promise((resolve) => {
    const request = http.request(`${base}/api/live`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), ...headers } });
    request.on("response", (response) => resolve({ status: response.statusCode }));
    request.on("upgrade", (response, socket) => {
      const messages = [];
      const waiters = [];
      let buffer = Buffer.alloc(0);
      let closed = null;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let length = buffer[1] & 0x7f;
          let start = 2;
          if (length === 126) { length = buffer.readUInt16BE(2); start = 4; } else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); start = 10; }
          if (buffer.length < start + length) break;
          const opcode = buffer[0] & 0x0f;
          const payload = buffer.subarray(start, start + length);
          buffer = buffer.subarray(start + length);
          if (opcode === 1) messages.push(JSON.parse(payload));
          if (opcode === 8) closed = payload.readUInt16BE(0);
          waiters.splice(0).forEach((wake) => wake());
        }
      });
      const until = async (test) => { for (let tries = 0; tries < 50 && !test(); tries++) await new Promise((wake) => { waiters.push(wake); setTimeout(wake, 100); }); return test(); };
      resolve({ status: response.statusCode, messages, until, closed: () => closed, socket });
    });
    request.end();
  });
}

test("live updates need a session from the same site, push changes and end at sign-out", async () => {
  const origin = { Origin: base };
  assert.equal((await openLive(origin)).status, 401);
  assert.equal((await openLive({ Cookie: cookie, Origin: "http://evil.example" })).status, 403);
  assert.equal((await openLive({ Cookie: cookie })).status, 403);
  const live = await openLive({ Cookie: cookie, ...origin });
  assert.equal(live.status, 101);
  assert.ok(await live.until(() => live.messages.length >= 1));
  assert.ok(Array.isArray(live.messages[0].state.machines));
  assert.equal(live.messages[0].state.now, undefined);
  await user("POST", "/api/plans", { title: "Pushed live" });
  assert.ok(await live.until(() => live.messages.some((message) => message.state.plans.some((entry) => entry.title === "Pushed live"))));
  await user("POST", "/api/logout");
  assert.ok(await live.until(() => live.closed() === 4401));
  live.socket.destroy();
});
