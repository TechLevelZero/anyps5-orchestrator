#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, id, stamp } from "./lib/store.js";
import { Secrets, token, hash, equal } from "./lib/secrets.js";
import { setPassword, checkPassword, startSession, endSession, sessionValid, cookie, agentFor } from "./lib/auth.js";
import { GitHub, collect } from "./lib/github.js";
import { setDataDir, publicKey, detect, probe, validHost, validUser, localMachine, installKey, setPasswordResolver, exec, sections } from "./lib/machines.js";
import { createJob, tick, cancel, approve, prepare, activity, gpuTargets, install, work, checkMachine, applyFix, runAsRoot } from "./lib/runner.js";
import { Tools } from "./lib/tools.js";
import { serveMcp } from "./lib/mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".anyps5-orchestrator", "server");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8091);
setDataDir(dataDir);
const secrets = new Secrets(dataDir);
const store = new Store(path.join(dataDir, "state.json"), {
  config: { setup: { done: false, step: "password" }, mode: null, repo: "boykopovar/AnyPS5", github: null, machines: [], agents: [], tracked: [] },
  jobs: [], plans: [], activity: [], agentStatus: {}, seen: {},
});
store.secret = (sealed) => { try { return secrets.open(sealed); } catch { return ""; } };
setPasswordResolver((machine) => store.secret(machine.password));
const cache = { github: null, machines: {}, errors: {} };
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const config = () => store.data.config;
let tools;
const version = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version;
const inContainer = fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
const setupCodeFile = path.join(dataDir, "setup-code");
let setupCode = null;
if (!store.data.config.auth) {
  try { setupCode = fs.readFileSync(setupCodeFile, "utf8").trim(); } catch {}
  if (!setupCode) { setupCode = token(9); fs.writeFileSync(setupCodeFile, `${setupCode}\n`, { mode: 0o600 }); }
}
const failures = new Map();

function throttle(request) {
  const key = request.socket.remoteAddress || "?";
  const entry = failures.get(key);
  if (entry && entry.until > Date.now()) throw new Error(`too many attempts; try again in ${Math.ceil((entry.until - Date.now()) / 1000)} s`);
  return {
    failed() {
      const fails = (failures.get(key)?.fails || 0) + 1;
      failures.set(key, { fails, until: fails >= 5 ? Date.now() + Math.min(15 * 60, 30 * 2 ** (fails - 5)) * 1000 : 0 });
    },
    passed() { failures.delete(key); },
  };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1 << 20) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function serveStatic(request, response) {
  const pathname = new URL(request.url, "http://local").pathname;
  const file = path.normalize(path.join(here, "public", pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(path.join(here, "public") + path.sep)) return send(response, 403, { error: "forbidden" });
  fs.readFile(file, (error, content) => {
    if (error) return send(response, 404, { error: "not found" });
    response.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com https://github.com https://opengraph.githubassets.com https://cdn.jsdelivr.net data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  });
}

function publicMachine(machine) {
  const live = cache.machines[machine.id] || {};
  const { password, ...rest } = machine;
  const health = machine.health ? { ...machine.health, needsPassword: machine.health.items?.find((item) => item.id === "sudo")?.status !== "ok" && machine.auth !== "password" } : null;
  return { ...rest, health, live, targets: gpuTargets(machine) };
}

function state() {
  const c = config();
  const agents = c.agents.filter((agent) => !agent.revoked).map((agent) => ({ id: agent.id, name: agent.name, client: agent.client || null, created: agent.created, lastSeen: agent.lastSeen || null, allowed: agent.allowed || [], status: store.data.agentStatus[agent.id] || null }));
  return {
    now: stamp(), setup: c.setup, mode: c.mode, repo: c.repo, me: c.github?.login || null, avatar: c.github?.avatar || null,
    machines: c.machines.map(publicMachine), agents, github: cache.github, errors: cache.errors,
    jobs: store.data.jobs.slice(0, 80), plans: store.data.plans, activity: store.data.activity.slice(0, 100), tracked: c.tracked,
    requests: (store.data.requests || []).slice(0, 60),
    install: { version, container: inContainer },
  };
}

function machine(idValue) {
  const found = config().machines.find((entry) => entry.id === idValue);
  if (!found) throw new Error("no such machine");
  return found;
}

function explainSsh(error, entry) {
  const text = String(error.message || error);
  const where = `${entry.user}@${entry.host}`;
  if (/Permission denied|wrong password|Authentication failed/i.test(text)) {
    return entry.auth === "key" && !entry.password && !entry.triedPassword
      ? `${where} turned down the orchestrator's key. With "Key only", add the key shown above to ~/.ssh/authorized_keys of ${entry.user} on that machine first, or choose "Password, then a key".`
      : `${where} turned down the sign-in. Check that "${entry.user}" is the user name on that machine (not the one on this computer) and that the password is right.`;
  }
  if (/Connection refused/i.test(text)) return `${entry.host} refused the connection on port ${entry.port}: is SSH running there, and is that the right port?`;
  if (/timed out|No route to host|Network is unreachable/i.test(text)) return `${entry.host} didn't answer on port ${entry.port}: check the address, and that a firewall isn't blocking SSH.`;
  if (/Could not resolve|Name or service not known/i.test(text)) return `"${entry.host}" isn't a name this computer can find: use the machine's IP address or full host name.`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) return `${entry.host}'s SSH host key is different from the one saved for it. If the machine was reinstalled, remove its line from ssh/known_hosts in the orchestrator's data folder and try again.`;
  return text;
}

async function addMachine(input) {
  try {
    return await addMachineChecked(input);
  } catch (error) {
    const label = input.kind === "local" ? "this computer" : `${input.user || "?"}@${input.host || "?"}`;
    activity(store, `Couldn't add ${label}: ${error.message}`);
    throw error;
  }
}

async function addMachineChecked(input) {
  const c = config();
  let entry;
  if (input.kind === "local") {
    if (c.machines.some((existing) => existing.kind === "local")) throw new Error("this machine is already added");
    entry = { ...localMachine(), id: "local" };
  } else {
    if (!validHost.test(input.host || "") || !validUser.test(input.user || "")) throw new Error("enter a valid host and user name");
    const portNumber = Number(input.port || 22);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error("invalid port");
    const auth = ["key", "password-key", "password"].includes(input.auth) ? input.auth : "key";
    entry = { id: id("m"), kind: "ssh", host: input.host, user: input.user, port: portNumber, name: String(input.name || input.host).slice(0, 60), auth: auth === "password" ? "password" : "key" };
    if (c.machines.some((existing) => existing.kind === "ssh" && existing.host === entry.host && existing.user === entry.user && existing.port === entry.port)) throw new Error("that machine is already added");
    if (auth !== "key") {
      if (typeof input.password !== "string" || !input.password) throw new Error("enter the password for that user");
      entry.triedPassword = true;
      if (auth === "password-key") { try { await installKey(entry, input.password); } catch (error) { throw new Error(explainSsh(error, entry)); } }
      else entry.password = secrets.seal(input.password);
    }
  }
  let found;
  try { found = await detect(entry); } catch (error) { throw new Error(explainSsh(error, entry)); }
  delete entry.triedPassword;
  if (!found.engine && entry.kind === "local" && inContainer) throw new Error("the orchestrator runs inside a container, which has no Docker or Podman of its own: choose Advanced and add the machines (this host too, if it should build) over SSH");
  Object.assign(entry, { engine: found.engine, engines: found.engines, os: found.os, cpu: found.cpu, memMb: found.memMb, diskFreeGb: found.diskFreeGb, nvidiaToolkit: found.nvidiaToolkit, gpus: found.gpus.map((gpu) => ({ ...gpu, enabled: true })), detected: found.detected, prepare: { status: "needed" }, enabled: true });
  c.machines.push(entry);
  activity(store, `Added machine ${entry.name} (${entry.gpus.map((gpu) => gpu.name).join(", ") || "no GPU"})${entry.engine ? "" : "; it has no working container engine yet, see its health check"}`);
  runCheck(entry).catch(() => {});
  return entry;
}

async function runCheck(entry) {
  entry.healthRunning = true;
  try {
    if (!entry.engine || !(entry.engines || []).includes(entry.engine)) {
      const found = await detect(entry);
      Object.assign(entry, { engine: found.engine, engines: found.engines });
    }
    entry.health = await checkMachine(entry);
    const failing = entry.health.items.filter((item) => item.status === "fail");
    activity(store, `${entry.name} health check: ${failing.length ? `${failing.length} to fix (${failing.map((item) => item.title).join(", ")})` : "everything needed is there"}`);
    return entry.health;
  } finally {
    delete entry.healthRunning;
    store.save();
  }
}

async function fixMachine(entry, checkId, password) {
  const title = entry.health?.items.find((item) => item.id === checkId)?.fix?.title || checkId;
  activity(store, `Fixing on ${entry.name}: ${title}`);
  try {
    const result = await applyFix(entry, checkId, password, entry.auth === "password" ? store.secret(entry.password) : "");
    const health = await runCheck(entry);
    const item = health.items.find((candidate) => candidate.id === checkId);
    activity(store, `${entry.name}: ${title} ${item && item.status !== "fail" ? "worked" : "ran, but the check still fails"}`);
    return { ...result, health, fixed: Boolean(item && item.status !== "fail") };
  } catch (error) {
    activity(store, `${entry.name}: ${title} failed: ${error.message}`);
    throw error;
  }
}

function startPrepare(entry) {
  if (!entry.engine) throw new Error(`${entry.name} has no working Docker or Podman yet: fix it from its health check first`);
  entry.prepare = { status: "running", started: stamp() };
  store.save();
  prepare(entry).then((devices) => {
    const dri = devices.dri.filter((device) => !/CPU/.test(device.type || ""));
    const others = entry.gpus.filter((gpu) => gpu.vendor !== "nvidia");
    others.forEach((gpu, index) => {
      const [vendorId, deviceId] = (gpu.pci || "").toLowerCase().split(":");
      const taken = (device) => others.some((other, otherIndex) => otherIndex < index && other.vulkanName === device.name);
      const match = dri.find((device) => device.deviceId === deviceId && (!device.vendorId || device.vendorId === vendorId) && !taken(device))
        || dri.find((device) => (gpu.vendor === "amd" ? /AMD|RADV/i : /Intel/i).test(device.name) && !taken(device));
      if (match) { gpu.vulkanName = match.name; gpu.driver = match.driver; }
    });
    const nvidia = devices.nvidia.filter((device) => !/CPU/.test(device.type || "") && (!device.vendorId || device.vendorId === "0x10de"));
    entry.gpus.filter((gpu) => gpu.vendor === "nvidia").forEach((gpu, index) => { const match = nvidia.find((device) => device.name === gpu.name) || nvidia[index]; if (match) { gpu.vulkanName = match.name; gpu.driver = match.driver; } else delete gpu.vulkanName; });
    entry.prepare = { status: "ready", finished: stamp(), devices };
    const unseen = entry.gpus.filter((gpu) => !gpu.vulkanName).map((gpu) => gpu.name);
    activity(store, `${entry.name} is ready: ${gpuTargets(entry).map((target) => target.label).join(", ") || "no Vulkan GPU found"}${unseen.length ? `; Vulkan can't see ${unseen.join(", ")} inside containers, so ${unseen.length > 1 ? "they are" : "it is"} left out of tests (see the health check)` : ""}`);
  }).catch((error) => {
    entry.prepare = { status: "failed", finished: stamp(), error: String(error.message || error) };
    activity(store, `Preparing ${entry.name} failed: ${entry.prepare.error}`);
  });
}

function plan(input, who) {
  const entry = { id: id("plan"), title: String(input.title || "").slice(0, 200), detail: String(input.detail || "").slice(0, 2000), lane: ["now", "next", "later"].includes(input.lane) ? input.lane : "next", status: "open", created: stamp(), by: who };
  if (!entry.title) throw new Error("a plan needs a title");
  store.data.plans.push(entry);
  activity(store, `${who} planned: ${entry.title}`, who);
  return entry;
}

function updatePlan(idValue, input, who) {
  const entry = store.data.plans.find((item) => item.id === idValue);
  if (!entry) throw new Error("no such plan");
  for (const key of ["title", "detail"]) if (typeof input[key] === "string") entry[key] = input[key].slice(0, key === "title" ? 200 : 2000);
  if (["now", "next", "later"].includes(input.lane)) entry.lane = input.lane;
  if (["open", "done"].includes(input.status) && input.status !== entry.status) { entry.status = input.status; if (input.status === "done") activity(store, `${who} finished: ${entry.title}`, who); }
  store.save();
  return entry;
}

const routes = [
  ["GET", "/healthz", "none", () => ({ ok: true, version })],
  ["GET", "/api/session", "none", (request) => ({ setup: config().setup, hasPassword: Boolean(config().auth), authed: sessionValid(config(), cookie(request, "orch_session")), container: inContainer, version })],
  ["POST", "/api/setup/password", "none", (request, input, response) => {
    if (config().auth) throw new Error("a password is already set");
    const gate = throttle(request);
    if (!setupCode || !equal(String(input.code || "").trim(), setupCode)) { gate.failed(); throw new Error("wrong setup code: it's printed in the orchestrator's log and saved in its data folder as setup-code"); }
    gate.passed();
    setPassword(config(), input.password);
    setupCode = null;
    fs.rmSync(setupCodeFile, { force: true });
    config().setup.step = "github";
    login(response);
    return { ok: true };
  }],
  ["POST", "/api/login", "none", (request, input, response) => {
    const gate = throttle(request);
    if (!checkPassword(config(), input.password)) { gate.failed(); throw new Error("wrong password"); }
    gate.passed();
    login(response);
    return { ok: true };
  }],
  ["POST", "/api/logout", "user", (request, input, response) => { endSession(config(), cookie(request, "orch_session")); response.setHeader?.("Set-Cookie", "orch_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"); store.save(); return { ok: true }; }],
  ["GET", "/api/state", "user", () => state()],
  ["POST", "/api/setup/github", "user", async (request, input) => {
    const value = String(input.token || "").trim();
    if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(value)) throw new Error("that does not look like a GitHub token");
    const user = await new GitHub(value, config().repo).user();
    config().github = { login: user.login, avatar: user.avatar_url, token: secrets.seal(value), linked: stamp() };
    if (typeof input.repo === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.repo)) config().repo = input.repo;
    config().setup.step = "mode";
    cache.github = null;
    activity(store, `Linked GitHub account ${user.login}`);
    return { login: user.login, avatar: user.avatar_url };
  }],
  ["POST", "/api/setup/mode", "user", async (request, input) => {
    if (!["simple", "advanced"].includes(input.mode)) throw new Error("choose simple or advanced");
    config().mode = input.mode;
    config().setup.step = "machines";
    if (input.mode === "simple" && !config().machines.some((entry) => entry.kind === "local")) await addMachine({ kind: "local" });
    store.save();
    return { ok: true };
  }],
  ["POST", "/api/setup/step", "user", (request, input) => {
    if (!["password", "github", "mode", "machines", "agents", "done"].includes(input.step)) throw new Error("unknown step");
    config().setup.step = input.step;
    if (input.step === "done") { config().setup.done = true; activity(store, "Setup finished"); }
    store.save();
    return config().setup;
  }],
  ["GET", "/api/ssh-key", "user", () => ({ publicKey: publicKey() })],
  ["POST", "/api/machines", "user", async (request, input) => { publicKey(); const entry = await addMachine(input); store.save(); return publicMachine(entry); }],
  ["POST", /^\/api\/machines\/([\w-]+)\/detect$/, "user", async (request, input, response, match) => {
    const entry = machine(match[1]);
    const found = await detect(entry);
    const old = new Map((entry.gpus || []).map((gpu) => [`${gpu.vendor}:${gpu.index ?? gpu.slot}`, gpu]));
    Object.assign(entry, { engines: found.engines, os: found.os, cpu: found.cpu, memMb: found.memMb, diskFreeGb: found.diskFreeGb, gpus: found.gpus.map((gpu) => ({ ...gpu, enabled: old.get(`${gpu.vendor}:${gpu.index ?? gpu.slot}`)?.enabled ?? true, vulkanName: old.get(`${gpu.vendor}:${gpu.index ?? gpu.slot}`)?.vulkanName })), detected: found.detected });
    store.save();
    return publicMachine(entry);
  }],
  ["POST", /^\/api\/machines\/([\w-]+)\/check$/, "user", (request, input, response, match) => runCheck(machine(match[1]))],
  ["POST", /^\/api\/machines\/([\w-]+)\/fix$/, "user", (request, input, response, match) => fixMachine(machine(match[1]), String(input.check || ""), typeof input.password === "string" ? input.password : "")],
  ["POST", /^\/api\/machines\/([\w-]+)\/prepare$/, "user", (request, input, response, match) => { const entry = machine(match[1]); if (entry.prepare?.status !== "running") startPrepare(entry); return entry.prepare; }],
  ["PATCH", /^\/api\/machines\/([\w-]+)$/, "user", async (request, input, response, match) => {
    const entry = machine(match[1]);
    if (typeof input.name === "string") entry.name = input.name.slice(0, 60);
    if (typeof input.enabled === "boolean") entry.enabled = input.enabled;
    if (typeof input.engine === "string" && (entry.engines || []).includes(input.engine)) entry.engine = input.engine;
    if (input.gpu !== undefined && entry.gpus[input.gpu]) entry.gpus[input.gpu].enabled = Boolean(input.gpuEnabled);
    if (input.switchToKey && entry.auth === "password") { await installKey(entry, store.secret(entry.password)); entry.auth = "key"; delete entry.password; activity(store, `${entry.name} now signs in with the orchestrator's key; the password was deleted`); }
    store.save();
    return publicMachine(entry);
  }],
  ["DELETE", /^\/api\/machines\/([\w-]+)$/, "user", (request, input, response, match) => { config().machines = config().machines.filter((entry) => entry.id !== match[1]); store.save(); return { ok: true }; }],
  ["POST", "/api/agents", "user", (request, input) => {
    const value = token(32);
    const entry = { id: id("agent"), name: String(input.name || "AI agent").slice(0, 60), client: ["claude-code", "codex", "cursor", "other"].includes(input.client) ? input.client : "other", tokenHash: hash(value), created: stamp(), allowed: [] };
    config().agents.push(entry);
    activity(store, `Connected agent ${entry.name}`);
    return { id: entry.id, name: entry.name, token: value };
  }],
  ["DELETE", /^\/api\/agents\/([\w-]+)$/, "user", (request, input, response, match) => { const entry = config().agents.find((agent) => agent.id === match[1]); if (entry) entry.revoked = stamp(); store.save(); return { ok: true }; }],
  ["POST", "/api/jobs", "user", (request, input) => createJob(store, { ...input, requestedBy: "you" })],
  ["POST", /^\/api\/jobs\/([\w-]+)\/approve$/, "user", (request, input, response, match) => approve(store, match[1])],
  ["POST", /^\/api\/jobs\/([\w-]+)\/cancel$/, "user", (request, input, response, match) => cancel(store, match[1])],
  ["POST", /^\/api\/jobs\/([\w-]+)\/retry$/, "user", (request, input, response, match) => {
    const job = store.data.jobs.find((entry) => entry.id === match[1]);
    if (!job) throw new Error("no such job");
    return createJob(store, { issue: job.issue, owner: job.owner, branch: job.branch, title: job.title, reason: job.reason, requestedBy: "you" });
  }],
  ["DELETE", /^\/api\/jobs\/([\w-]+)$/, "user", (request, input, response, match) => {
    const job = store.data.jobs.find((entry) => entry.id === match[1]);
    if (job && ["queued", "running", "awaiting-approval"].includes(job.status)) throw new Error("cancel the job first");
    store.data.jobs = store.data.jobs.filter((entry) => entry.id !== match[1]);
    for (const stage of job?.stages || []) {
      const entry = config().machines.find((item) => item.id === stage.machine);
      if (entry && /^job-[a-z0-9]+$/.test(job.id)) exec(entry, `rm -rf "${work(entry)}/jobs/${job.id}"`, { timeout: 120000 });
    }
    return { ok: true };
  }],
  ["POST", "/api/plans", "user", (request, input) => plan(input, "you")],
  ["PATCH", /^\/api\/plans\/([\w-]+)$/, "user", (request, input, response, match) => updatePlan(match[1], input, "you")],
  ["DELETE", /^\/api\/plans\/([\w-]+)$/, "user", (request, input, response, match) => { store.data.plans = store.data.plans.filter((entry) => entry.id !== match[1]); store.save(); return { ok: true }; }],
  ["POST", "/api/tracked", "user", (request, input) => { const number = Number(input.number); if (!Number.isInteger(number) || number < 1) throw new Error("issue number"); config().tracked = [...new Set([...config().tracked, number])].slice(-50); store.save(); return config().tracked; }],

  ["POST", /^\/api\/requests\/([\w-]+)\/decide$/, "user", async (request, input, response, match) => tools.decide(match[1], input.decision, Boolean(input.always), typeof input.password === "string" ? input.password : "")],
  ["PATCH", /^\/api\/agents\/([\w-]+)$/, "user", (request, input, response, match) => {
    const entry = config().agents.find((agent) => agent.id === match[1] && !agent.revoked);
    if (!entry) throw new Error("no such agent");
    if (Array.isArray(input.allowed)) entry.allowed = input.allowed.filter((name) => typeof name === "string" && name !== "run_command");
    if (typeof input.name === "string" && input.name.trim()) entry.name = input.name.trim().slice(0, 60);
    store.save();
    return { ok: true };
  }],
  ["POST", "/api/agent/status", "agent", (request, input, response, match, agent) => setStatus(agent, input)],
  ["GET", "/api/agent/overview", "agent", () => {
    const s = state();
    return {
      repo: s.repo, you: s.me, guardrails: s.github?.guardrails || null,
      rules: ["Verification jobs you request wait for the user's approval.", "Nothing is posted to GitHub by the orchestrator; reports are drafts for the user.", "Respect the open-PR limit in guardrails before suggesting a new PR."],
      machines: s.machines.map((entry) => ({ id: entry.id, name: entry.name, online: entry.live?.online, gpus: entry.targets.map((target) => target.label), ready: entry.prepare?.status === "ready" })),
      jobs: s.jobs.slice(0, 20).map((job) => ({ id: job.id, title: job.title, status: job.status, requestedBy: job.requestedBy })),
      plans: s.plans.filter((entry) => entry.status === "open"),
      ours: { prs: (s.github?.mine?.prs || []).filter((pr) => pr.state === "open").map((pr) => ({ number: pr.number, title: pr.title })), issues: (s.github?.mine?.issues || []).filter((issue) => issue.state === "open").map((issue) => ({ number: issue.number, title: issue.title })) },
      newComments: (s.github?.comments || []).slice(0, 10).map((comment) => ({ number: comment.number, author: comment.author?.login, at: comment.at, body: comment.body.slice(0, 300) })),
    };
  }],
  ["POST", "/api/agent/verify", "agent", (request, input, response, match, agent) => createJob(store, { ...input, requestedBy: agent.name })],
  ["GET", /^\/api\/agent\/jobs\/([\w-]+)$/, "agent", (request, input, response, match) => {
    const job = store.data.jobs.find((entry) => entry.id === match[1]);
    if (!job) throw new Error("no such job");
    return { id: job.id, title: job.title, status: job.status, stages: job.stages.map((stage) => ({ machine: stage.machineName, status: stage.status, reason: stage.reason, progress: stage.progress.slice(-5), gpus: stage.gpus.map((gpu) => ({ gpu: gpu.label, result: gpu.result })) })), report: job.report };
  }],
  ["POST", "/api/agent/plans", "agent", (request, input, response, match, agent) => plan(input, agent.name)],
  ["PATCH", /^\/api\/agent\/plans\/([\w-]+)$/, "agent", (request, input, response, match, agent) => updatePlan(match[1], input, agent.name)],
  ["POST", "/api/agent/note", "agent", (request, input, response, match, agent) => { activity(store, `${agent.name}: ${String(input.text || "").slice(0, 300)}`, agent.name); return { ok: true }; }],
];

function setStatus(agent, input) {
  const entry = { state: ["working", "idle", "blocked", "waiting"].includes(input.state) ? input.state : "working", task: String(input.task || "").slice(0, 300), detail: String(input.detail || "").slice(0, 2000), machine: String(input.machine || "").slice(0, 60), at: stamp() };
  const previous = store.data.agentStatus[agent.id];
  store.data.agentStatus[agent.id] = { ...entry, history: [entry, ...(previous?.history || [])].slice(0, 30) };
  if (previous?.task !== entry.task && entry.task) activity(store, `${agent.name}: ${entry.task}`, agent.name);
  store.save();
  return { ok: true };
}

tools = new Tools(store, cache, {
  activity: (text, who) => activity(store, text, who || "orchestrator"),
  plan: (input, who) => plan(input, who),
  updatePlan: (planId, input, who) => updatePlan(planId, input, who),
  prepare: (entry) => { if (entry.prepare?.status !== "running") startPrepare(entry); return entry.prepare; },
  status: setStatus,
  check: (entry) => runCheck(entry),
  fix: (entry, checkId, password) => fixMachine(entry, checkId, password),
  root: (entry, script, password) => runAsRoot(entry, script, password, entry.auth === "password" ? store.secret(entry.password) : ""),
});

function login(response) {
  const value = startSession(config());
  store.save();
  response.setHeader("Set-Cookie", `orch_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${14 * 86400}`);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://local");
    if (url.pathname === "/mcp") {
      return serveMcp(request, response, { agent: agentFor(config(), request), tools, version, readBody, touch: (agent) => { agent.lastSeen = stamp(); store.save(); } });
    }
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/healthz") return serveStatic(request, response);
    let match = null;
    const route = routes.find(([method, pattern]) => method === request.method && (typeof pattern === "string" ? pattern === url.pathname : (match = url.pathname.match(pattern))));
    if (!route) return send(response, 404, { error: "not found" });
    if (typeof route[1] === "string") match = null;
    const [, , auth, handler] = route;
    let agent = null;
    if (auth === "user") {
      if (!sessionValid(config(), cookie(request, "orch_session"))) return send(response, 401, { error: "log in first" });
      if (request.method !== "GET" && request.headers["x-requested-with"] !== "orchestrator") return send(response, 403, { error: "missing request header" });
    } else if (auth === "agent") {
      agent = agentFor(config(), request);
      if (!agent) return send(response, 401, { error: "agent token required" });
    } else if (request.method !== "GET" && request.headers["x-requested-with"] !== "orchestrator") {
      return send(response, 403, { error: "missing request header" });
    }
    const input = request.method === "GET" ? {} : await readBody(request);
    const result = await handler(request, input, response, match, agent);
    store.save();
    send(response, 200, result);
  } catch (error) {
    send(response, 400, { error: String(error.message || error) });
  }
});

function loop(name, task, every) {
  const run = async () => {
    try { await task(); delete cache.errors[name]; } catch (error) { cache.errors[name] = `${stamp()} ${error.message || error}`; }
    setTimeout(run, every);
  };
  setTimeout(run, 1000);
}

loop("machines", async () => {
  await Promise.all(config().machines.map(async (entry) => { cache.machines[entry.id] = { ...(await probe(entry)), checked: stamp() }; }));
}, 30000);
loop("github", () => collect(store, cache), 5 * 60000);
loop("jobs", () => tick(store), 20000);
for (const entry of config().machines) if (entry.prepare?.status === "running") entry.prepare = { status: "needed", note: "interrupted by a restart" };

server.listen(port, host, () => {
  console.log(`anyps5-orchestrator ${version} listening on http://${host}:${port}`);
  if (setupCode) console.log(`Open it in a browser to run the setup wizard. Setup code: ${setupCode} (also in ${setupCodeFile})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    try { store.flush(); } catch (error) { console.error(`could not save state: ${error.message}`); }
    server.close();
    process.exit(0);
  });
}
