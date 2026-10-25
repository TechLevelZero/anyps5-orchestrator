import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, sections } from "./machines.js";
import { id, stamp } from "./store.js";
import { recipeFor, rootCommand } from "./recipes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerFiles = ["verify.sh", "prepare.sh", "doctor.sh", "seccomp-uffd.json", "image/Dockerfile"];
export const work = (machine) => machine.workdir || "$HOME/.anyps5-orchestrator";
const valid = { owner: /^[A-Za-z0-9-]{1,39}$/, branch: /^[A-Za-z0-9._/-]{1,200}$/ };
const installed = new Map();

export async function install(machine) {
  const version = runnerFiles.map((file) => fs.statSync(path.join(here, "..", "runner", file)).mtimeMs).join(",");
  if (installed.get(machine.id) === version) return;
  const script = runnerFiles.map((file) => {
    const content = fs.readFileSync(path.join(here, "..", "runner", file)).toString("base64");
    return `mkdir -p "${work(machine)}/runner/${path.dirname(file)}" && echo '${content}' | base64 -d > "${work(machine)}/runner/${file}"`;
  }).join(" && ") + ` && chmod +x "${work(machine)}"/runner/*.sh && echo installed`;
  const result = await exec(machine, script, { timeout: 60000 });
  if (!result.stdout.includes("installed")) throw new Error(`could not install the runner on ${machine.name}: ${result.stderr.trim()}`);
  installed.set(machine.id, version);
}

export async function prepare(machine) {
  await install(machine);
  const result = await exec(machine, `ENGINE=${machine.engine} WORK="${work(machine)}" bash "${work(machine)}/runner/prepare.sh"`, { timeout: 3 * 3600 * 1000 });
  const s = sections(result.stdout);
  if (s.error !== undefined || !result.stdout.includes("@@done")) throw new Error(s.error || result.stderr.trim().split("\n").pop() || "prepare failed");
  const parse = (text) => {
    const devices = [];
    let current = null;
    for (const line of (text || "").split("\n")) {
      const [key, value] = line.split("=").map((part) => part?.trim());
      if (key === "vendorID") { current = { vendorId: value.toLowerCase() }; devices.push(current); }
      else if (!current) continue;
      else if (key === "deviceID") current.deviceId = value.toLowerCase();
      else if (key === "deviceType") current.type = value;
      else if (key === "deviceName") current.name = value;
      else if (key === "driverInfo") current.driver = value;
    }
    return devices.filter((device) => device.name);
  };
  return { dri: parse(s.dri), nvidia: parse(s.nvidia) };
}

export async function checkMachine(machine) {
  await install(machine);
  const result = await exec(machine, `${machine.engine ? `ENGINE=${machine.engine} ` : ""}WORK="${work(machine)}" bash "${work(machine)}/runner/doctor.sh"`, { timeout: 120000 });
  if (!result.stdout.includes("@@done")) throw new Error(result.stderr.trim().split("\n").pop() || "the health check did not finish");
  const health = { checked: stamp(), family: (result.stdout.match(/^@@family (\S+)/m) || [])[1] || "other", user: (result.stdout.match(/^@@user (\S+)/m) || [])[1] || machine.user, items: [] };
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("@@check ")) continue;
    const [checkId, status, title, detail, code] = line.slice(8).split("|");
    health.items.push({ id: checkId, status, title, detail, code: code || null });
  }
  for (const item of health.items) item.fix = recipeFor(item, health);
  health.ready = !health.items.some((item) => item.status === "fail");
  return health;
}

export async function applyFix(machine, checkId, password, fallbackPassword) {
  const health = machine.health;
  const item = health?.items.find((entry) => entry.id === checkId);
  if (!item) throw new Error(`no check ${checkId}; run the health check first`);
  const recipe = item.fix;
  if (!recipe) throw new Error(`there is no automatic fix for ${item.title}`);
  if (recipe.manual) throw new Error(`${recipe.title} has to be done by hand: ${recipe.steps.join(" ")}`);
  const { command, needsPassword } = rootCommand(recipe.commands.join("\n"), health);
  const secret = password || fallbackPassword || "";
  if (needsPassword && !secret) throw new Error("sudo on that machine needs a password");
  const result = await exec(machine, command, { timeout: 30 * 60 * 1000, input: needsPassword ? `${secret}\n` : "" });
  const output = `${result.stdout}${result.stderr}`.replace(/\[sudo\] password for [^:]*: ?/g, "").slice(-6000);
  if (result.code !== 0) {
    if (/incorrect password|Sorry, try again|no password was provided|a password is required/i.test(result.stderr)) throw new Error("sudo rejected the password");
    throw new Error(`the fix exited with ${result.code}: ${output.trim().split("\n").slice(-3).join(" / ")}`);
  }
  return { recipe: recipe.title, output };
}

export async function runAsRoot(machine, script, password, fallbackPassword) {
  const health = machine.health || { user: machine.user, items: [] };
  const { command, needsPassword } = rootCommand(script, health);
  const secret = password || fallbackPassword || "";
  if (needsPassword && !secret) throw new Error("sudo on that machine needs a password");
  return exec(machine, command, { timeout: 30 * 60 * 1000, input: needsPassword ? `${secret}\n` : "" });
}

export function gpuTargets(machine) {
  const targets = [];
  for (const gpu of machine.gpus || []) {
    if (!gpu.enabled) continue;
    if (gpu.vendor === "nvidia") targets.push({ id: `nv${gpu.index}`, spec: `nvidia:${gpu.index}`, name: "", label: gpu.vulkanName || gpu.name, vendor: "nvidia" });
    else if (gpu.vulkanName) targets.push({ id: `${gpu.vendor}${targets.length}`, spec: "dri:all", name: gpu.vulkanName, label: gpu.vulkanName, vendor: gpu.vendor });
  }
  return targets;
}

export function createJob(store, { issue, owner, branch, title, reason, requestedBy }) {
  if (!valid.owner.test(owner || "") || !valid.branch.test(branch || "") || branch.includes("..")) throw new Error("invalid owner or branch");
  const existing = store.data.jobs.find((job) => job.owner === owner && job.branch === branch && ["awaiting-approval", "queued", "running"].includes(job.status));
  if (existing) return existing;
  const machines = store.data.config.machines.filter((machine) => machine.enabled !== false && gpuTargets(machine).length);
  if (!machines.length) throw new Error("no machine has an enabled GPU yet: finish preparing a machine in Settings");
  const job = {
    id: id("job"), owner, branch, issue: Number(issue) || null, title: String(title || `${owner}/${branch}`).slice(0, 200), reason: String(reason || "").slice(0, 1000),
    requestedBy: requestedBy || "you", status: requestedBy && requestedBy !== "you" ? "awaiting-approval" : "queued", created: stamp(), started: null, finished: null,
    stages: machines.map((machine) => ({ machine: machine.id, machineName: machine.name, status: "pending", progress: [], gpus: gpuTargets(machine).map((target) => ({ ...target, result: null })), started: null, finished: null })),
    report: null,
  };
  store.data.jobs.unshift(job);
  store.data.jobs = store.data.jobs.slice(0, 200);
  activity(store, job.status === "queued" ? `Queued ${job.title}` : `${job.requestedBy} asked to verify ${job.title}; waiting for your approval`);
  return job;
}

export function activity(store, text, who = "orchestrator") {
  store.data.activity = [{ at: stamp(), text, who }, ...(store.data.activity || [])].slice(0, 400);
  store.save();
}

async function start(store, job, stage, machine) {
  await install(machine);
  const gpus = stage.gpus.map((gpu) => `${gpu.id}|${gpu.spec}|${gpu.name}`).join("\n");
  const repoUrl = `https://github.com/${store.data.config.repo}`;
  const dir = `${work(machine)}/jobs/${job.id}`;
  const command = `mkdir -p "${dir}/out" && printf '%s\\n' '${gpus.replace(/'/g, "")}' > "${dir}/out/gpus.txt" && { ENGINE=${machine.engine} REPO_URL=${repoUrl} WORK="${work(machine)}" setsid nohup bash "${work(machine)}/runner/verify.sh" ${job.id} ${job.owner} '${job.branch}' > "${dir}/run.log" 2>&1 < /dev/null & } && echo started`;
  const result = await exec(machine, command, { timeout: 30000 });
  if (!result.stdout.includes("started")) throw new Error(result.stderr.trim() || "could not start");
  stage.status = "running";
  stage.started = stamp();
  job.status = "running";
  job.started ||= stamp();
  activity(store, `Started ${job.title} on ${machine.name}`);
}

async function poll(store, job, stage, machine) {
  const dir = `${work(machine)}/jobs/${job.id}/out`;
  const reads = stage.gpus.map((gpu) => `echo; echo @@gpu_${gpu.id}; cat "${dir}/gpu-${gpu.id}/result.json" 2>/dev/null`).join("; ");
  const result = await exec(machine, `echo @@progress; tail -n 40 "${dir}/progress.log" 2>/dev/null; echo; echo @@result; cat "${dir}/result.json" 2>/dev/null; ${reads}; echo; echo @@alive; pgrep -f "[v]erify.sh ${job.id}" >/dev/null && echo yes`, { timeout: 30000 });
  if (result.code !== 0 && !result.stdout) return;
  const s = sections(result.stdout);
  stage.progress = (s.progress || "").split("\n").filter(Boolean).map((line) => line.replace(/^\S+\s/, ""));
  for (const gpu of stage.gpus) {
    const text = s[`gpu_${gpu.id}`];
    if (text) { try { gpu.result = JSON.parse(text); } catch {} }
  }
  if (s.result) {
    try {
      const overall = JSON.parse(s.result);
      const missing = stage.gpus.filter((gpu) => !gpu.result);
      stage.status = overall.status === "done" && !missing.length ? "done" : "failed";
      stage.reason = overall.reason || (missing.length ? `no result for ${missing.map((gpu) => gpu.label).join(", ")}` : null);
      stage.finished = stamp();
      activity(store, `${machine.name} finished ${job.title}: ${stage.status === "done" ? stage.gpus.map((gpu) => `${gpu.label} ${gpu.result?.verdict || "?"}`).join(", ") : stage.reason}`);
    } catch {}
  } else if (!(s.alive || "").includes("yes") && Date.now() - Date.parse(stage.started) > 120000) {
    stage.status = "failed";
    stage.reason = "the runner stopped without a result";
    stage.finished = stamp();
  }
}

function detail(result) {
  if (!result) return "not run";
  const parts = [`${result.selected} selected tests`];
  parts.push(result.onlyDev.length ? `failing only on the branch: ${result.onlyDev.map((entry) => `\`${entry.test}\` (${entry.recheckFailures.dev}/${entry.recheckRuns} serial reruns failed on the branch, ${entry.recheckFailures.main}/${entry.recheckRuns} on main)`).join(", ")}` : "no test fails only on the branch");
  if (result.newTests.length) parts.push(`new tests: ${result.newTests.map((test) => `\`${test.test}\` ${test.passed ? "passes" : "fails"}`).join(", ")}`);
  parts.push(result.newVuids.length ? `new validation errors: ${result.newVuids.map((vuid) => `\`${vuid}\``).join(", ")}` : "no new `VUID-` errors");
  if (result.layerMissing?.main || result.layerMissing?.dev) parts.push("**the validation layer did not load**");
  return parts.join("; ");
}

export function report(store, job) {
  const results = job.stages.flatMap((stage) => stage.gpus.map((gpu) => ({ stage, gpu })));
  const first = results.find(({ gpu }) => gpu.result)?.gpu.result;
  const vendors = new Set(results.map(({ gpu }) => gpu.vendor));
  const missing = ["nvidia", "amd", "intel"].filter((vendor) => !vendors.has(vendor)).map((vendor) => ({ nvidia: "NVIDIA", amd: "AMD", intel: "Intel" })[vendor]);
  return [
    `I built [\`${job.owner}/${job.branch}\`](https://github.com/${job.owner}/${store.data.config.repo.split("/")[1]}/tree/${job.branch})${first?.head ? ` (\`${first.head.slice(0, 10)}\`)` : ""} merged onto \`main\`${first?.main ? ` \`${first.main.slice(0, 10)}\`` : ""} and ran it against unchanged \`main\` on the same machine and GPU, with \`ANYPS5_REQUIRE_VULKAN=1\`, \`ANYPS5_NO_SHADER_CACHE=1\` and \`VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation\`. The tests are the ones \`tools/select_tests.py\` selects for the change plus any the branch adds; a test that failed only on the branch was rerun three times one at a time on both sides.`,
    "",
    "| GPU | Result | Details |",
    "| --- | --- | --- |",
    ...results.map(({ stage, gpu }) => `| ${gpu.result?.gpu || gpu.label} | ${stage.status === "failed" && !gpu.result ? `not run: ${stage.reason}` : gpu.result?.verdict || stage.status} | ${detail(gpu.result)} |`),
    "",
    missing.length ? `Not covered: ${missing.join(" and ")} GPUs.` : "",
    "",
    "Verified with [anyps5-orchestrator](https://github.com/TechLevelZero/anyps5-orchestrator).",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

export async function tick(store) {
  const machines = new Map(store.data.config.machines.map((machine) => [machine.id, machine]));
  const busy = new Set(store.data.jobs.filter((job) => job.status === "running").flatMap((job) => job.stages.filter((stage) => stage.status === "running").map((stage) => stage.machine)));
  for (const job of [...store.data.jobs].reverse()) {
    if (!["queued", "running"].includes(job.status)) continue;
    for (const stage of job.stages) {
      const machine = machines.get(stage.machine);
      if (!machine) { stage.status = "failed"; stage.reason = "machine removed"; continue; }
      try {
        if (stage.status === "pending" && !busy.has(machine.id)) { await start(store, job, stage, machine); busy.add(machine.id); }
        else if (stage.status === "running") await poll(store, job, stage, machine);
      } catch (error) {
        stage.status = "failed";
        stage.reason = String(error.message || error);
        stage.finished = stamp();
      }
    }
    if (job.stages.every((stage) => !["pending", "running"].includes(stage.status))) {
      const verdicts = job.stages.flatMap((stage) => stage.gpus.map((gpu) => gpu.result?.verdict));
      job.status = verdicts.includes("regression") ? "regression" : job.stages.some((stage) => stage.status === "failed") ? "failed" : verdicts.length && verdicts.every((verdict) => verdict === "clean") ? "clean" : "incomplete";
      job.finished = stamp();
      job.report = report(store, job);
      activity(store, `Finished ${job.title}: ${job.status}`);
    }
  }
  store.save();
}

export async function cancel(store, jobId) {
  const job = store.data.jobs.find((entry) => entry.id === jobId);
  if (!job) throw new Error("no such job");
  const wasRunning = job.status === "running";
  job.status = job.status === "awaiting-approval" ? "rejected" : "cancelled";
  job.finished = stamp();
  for (const stage of job.stages) {
    if (!["pending", "running"].includes(stage.status)) continue;
    const machine = store.data.config.machines.find((entry) => entry.id === stage.machine);
    if (wasRunning && stage.status === "running" && machine) {
      await exec(machine, `pkill -f "[v]erify.sh ${job.id}"; for e in docker podman; do command -v $e >/dev/null && $e ps --format '{{.Names}}' 2>/dev/null | grep '^orch-${job.id}-' | xargs -r $e kill >/dev/null 2>&1; done; true`, { timeout: 30000 });
    }
    stage.status = "cancelled";
  }
  activity(store, `${job.status === "rejected" ? "Rejected" : "Cancelled"} ${job.title}`);
  return job;
}

export function approve(store, jobId) {
  const job = store.data.jobs.find((entry) => entry.id === jobId);
  if (!job || job.status !== "awaiting-approval") throw new Error("nothing to approve");
  job.status = "queued";
  activity(store, `Approved ${job.title}`);
  return job;
}
