import { id, stamp } from "./store.js";
import { exec } from "./machines.js";
import { GitHub } from "./github.js";
import { createJob, cancel, gpuTargets } from "./runner.js";

export const serverInstructions = `This is the user's AnyPS5 Orchestrator, a self-hosted dashboard for their AnyPS5 contributions. AnyPS5 relinks PS5 executables into native Linux and Windows programs; the project takes contributions as GitHub pull requests.
Read get_overview first for context: the user's machines and GPUs, verification jobs, open PRs and issues, the open-PR limit, new comments and the plan board. Use report_status whenever you start, switch or finish a task so the user can follow your work in the dashboard.
Actions (queue_verification, cancel_job, prepare_machine, set_gpu_enabled, fix_machine, run_command) do not run immediately: they create a request the user approves or denies in the dashboard. Tell the user you've asked, then check the outcome with get_request. Never claim an action ran before its request is done.
To get a machine ready: run check_machine, then ask for fix_machine on each failing item that has an automatic fix, one at a time and in the listed order (the container engine before NVIDIA container support), re-checking after each; tell the user about items that need manual steps (GPU kernel drivers); once nothing fails, ask for prepare_machine. Use run_command (with sudo if needed) only for problems the built-in fixes don't cover, and explain why.
The orchestrator never posts to GitHub; verification reports are drafts the user copies. Before asking for a verification, look at the files the branch changes and mention build scripts, CMake or Python files, because they run during the build.`;

const readTools = [
  { name: "get_overview", description: "Current state: the repository, the user's GitHub login, guardrails (open PRs vs the limit), machines with GPUs and readiness, recent jobs, open plans, the user's open PRs and issues, and the newest comments from others.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_machine", description: "Full details of one machine: OS, CPU, memory, disk, container engine, each GPU (vendor, PCI ID, Vulkan name, enabled), preparation state and live load.", input_schema: { type: "object", properties: { machine: { type: "string", description: "Machine id or name" } }, required: ["machine"], additionalProperties: false } },
  { name: "list_fix_branches", description: "Open issues that link a fix branch on a fork, with the branch, how far it is ahead of and behind main, the files it changes, and any PR already open for it.", input_schema: { type: "object", properties: { include_with_open_pr: { type: "boolean" } }, additionalProperties: false } },
  { name: "get_issue", description: "Read an issue or pull request with its body and its most recent comments.", input_schema: { type: "object", properties: { number: { type: "integer" }, comments: { type: "integer", description: "How many recent comments (default 10, at most 30)" } }, required: ["number"], additionalProperties: false } },
  { name: "list_jobs", description: "Verification jobs, newest first, with status and per-GPU verdicts.", input_schema: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false } },
  { name: "get_job", description: "One verification job: each machine stage, its progress lines, per-GPU results (tests failing only on the branch with serial recheck counts, new tests, new VUIDs) and the draft report.", input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false } },
  { name: "get_job_log", description: "The end of one log file of a job on its machine: progress, run (the runner's own output), dev-build (the sandboxed branch build), or a GPU's main/dev ctest log.", input_schema: { type: "object", properties: { job: { type: "string" }, machine: { type: "string" }, log: { type: "string", enum: ["progress", "run", "dev-build", "main", "dev"] }, gpu: { type: "string", description: "GPU target id for main/dev logs, e.g. nv0 or amd1" }, lines: { type: "integer", description: "Lines from the end (default 80, at most 400)" } }, required: ["job", "log"], additionalProperties: false } },
  { name: "list_plans", description: "The user's plan board.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "add_plan", description: "Add a plan to the board.", input_schema: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, lane: { type: "string", enum: ["now", "next", "later"] } }, required: ["title"], additionalProperties: false } },
  { name: "update_plan", description: "Change a plan's lane, details or mark it done.", input_schema: { type: "object", properties: { id: { type: "string" }, lane: { type: "string", enum: ["now", "next", "later"] }, status: { type: "string", enum: ["open", "done"] }, detail: { type: "string" } }, required: ["id"], additionalProperties: false } },
];
const setupTools = [
  { name: "check_machine", description: "Run the health check on a machine: container engine and access, GPU drivers, NVIDIA container support, GPU device access, python3/flock/curl, disk space, reflink copies and GitHub access. Each failing item comes with the exact fix commands (or manual steps) and their risk. Run it after adding a machine and after each fix.", input_schema: { type: "object", properties: { machine: { type: "string" } }, required: ["machine"], additionalProperties: false } },
];
const actionTools = [
  { name: "fix_machine", description: "Ask to apply the orchestrator's built-in fix for one failing health-check item (by its id from check_machine). The fix runs as root; the user approves it in the dashboard and types the sudo password there if one is needed. The machine is re-checked afterwards; the request's result says whether the item now passes.", input_schema: { type: "object", properties: { machine: { type: "string" }, check: { type: "string", description: "Health-check item id, e.g. nvidia-toolkit" }, why: { type: "string" } }, required: ["machine", "check"], additionalProperties: false } },
  { name: "queue_verification", description: "Ask to queue a verification of a fork branch: merged onto main, built and tested against unchanged main on every prepared, enabled GPU, with the branch sandboxed without network. Creates a request the user approves in the dashboard; check it with get_request.", input_schema: { type: "object", properties: { owner: { type: "string" }, branch: { type: "string" }, issue: { type: "integer" }, title: { type: "string" }, reason: { type: "string" } }, required: ["owner", "branch"], additionalProperties: false } },
  { name: "cancel_job", description: "Ask to stop a queued or running job. Creates a request the user approves in the dashboard.", input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false } },
  { name: "prepare_machine", description: "Ask to build the build image on a machine and detect its GPUs' Vulkan names. Creates a request the user approves in the dashboard.", input_schema: { type: "object", properties: { machine: { type: "string" } }, required: ["machine"], additionalProperties: false } },
  { name: "set_gpu_enabled", description: "Ask to include or exclude one GPU of a machine from verification runs. Creates a request the user approves in the dashboard.", input_schema: { type: "object", properties: { machine: { type: "string" }, gpu: { type: "integer", description: "GPU index in get_machine's list" }, enabled: { type: "boolean" } }, required: ["machine", "gpu", "enabled"], additionalProperties: false } },
  { name: "run_command", description: "Ask to run a shell command on one of the user's machines, as the orchestrator's user or, with sudo: true, as root (use fix_machine for problems check_machine knows). The user sees the exact command and approves it in the dashboard; the output (first 20 KB) is in the request's result.", input_schema: { type: "object", properties: { machine: { type: "string" }, command: { type: "string" }, sudo: { type: "boolean", description: "Run as root through sudo" }, why: { type: "string", description: "One line shown to the user" } }, required: ["machine", "command", "why"], additionalProperties: false } },
];
const agentTools = [
  { name: "report_status", description: "Show the user's dashboard what you are doing now. Call it when you start a task, switch tasks, get blocked, wait for the user or finish.", input_schema: { type: "object", properties: { state: { type: "string", enum: ["working", "idle", "blocked", "waiting"] }, task: { type: "string", description: "One line, e.g. 'Rebasing fix/foo onto main'" }, detail: { type: "string" }, machine: { type: "string", description: "Machine the work runs on, if any" } }, required: ["task"], additionalProperties: false } },
  { name: "note", description: "Add a line to the dashboard's activity feed for something the user should notice later.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { name: "list_requests", description: "Your action requests and whether the user approved, denied or is still deciding.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_request", description: "One action request: its status and, once approved and run, its result.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];
export const toolNames = { read: [...readTools, ...setupTools, ...agentTools].map((tool) => tool.name), action: actionTools.map((tool) => tool.name) };
export const allTools = [...readTools, ...setupTools, ...agentTools, ...actionTools];
const asRoot = (name, input) => name === "fix_machine" || (name === "run_command" && input?.sudo === true);



export function validate(name, input) {
  const tool = allTools.find((entry) => entry.name === name);
  if (!tool) return `unknown tool ${name}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const { properties, required = [] } = tool.input_schema;
  for (const key of required) if (input[key] === undefined) return `missing ${key}`;
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key];
    if (!spec) return `unexpected field ${key}`;
    if (spec.type === "integer" && !Number.isInteger(value)) return `${key} must be an integer`;
    if (spec.type === "string" && typeof value !== "string") return `${key} must be a string`;
    if (spec.type === "boolean" && typeof value !== "boolean") return `${key} must be true or false`;
    if (spec.enum && !spec.enum.includes(value)) return `${key} must be one of ${spec.enum.join(", ")}`;
  }
  return null;
}

export class Tools {
  constructor(store, cache, hooks) {
    this.store = store;
    this.cache = cache;
    this.hooks = hooks;
    store.data.requests ||= [];
  }

  async call(agent, name, input = {}) {
    const problem = validate(name, input);
    if (problem) throw new Error(problem);
    if (!toolNames.action.includes(name)) return this.tool(name, input, agent);
    if ((agent.allowed || []).includes(name) && !asRoot(name, input)) {
      const result = await this.tool(name, input, agent);
      this.hooks.activity(`${agent.name}: ${name.replace(/_/g, " ")} ${summarizeInput(input)} (always allowed)`, agent.name);
      return { status: "done", result };
    }
    const request = { id: id("req"), agent: agent.id, agentName: agent.name, tool: name, input, status: "pending", created: stamp(), decided: null, result: null };
    this.store.data.requests.unshift(request);
    this.store.data.requests = this.store.data.requests.slice(0, 200);
    this.hooks.activity(`${agent.name} asks to ${name.replace(/_/g, " ")} ${summarizeInput(input)}; waiting for your approval`, agent.name);
    this.store.save();
    return { status: "pending", request: request.id, note: "The user approves or denies this in the dashboard. Check it with get_request." };
  }

  async decide(requestId, decision, always, password = "") {
    const request = this.store.data.requests.find((entry) => entry.id === requestId);
    if (!request || request.status !== "pending") throw new Error("nothing pending with that id");
    request.decided = stamp();
    const agent = (this.store.data.config.agents || []).find((entry) => entry.id === request.agent);
    if (decision !== "approve") {
      request.status = "denied";
      this.hooks.activity(`Denied ${request.agentName}'s request to ${request.tool.replace(/_/g, " ")}`);
      return request;
    }
    if (always && agent && request.tool !== "run_command" && !asRoot(request.tool, request.input)) agent.allowed = [...new Set([...(agent.allowed || []), request.tool])];
    request.status = "running";
    this.store.save();
    try {
      request.result = await this.tool(request.tool, request.input, agent || { id: request.agent, name: request.agentName }, { password });
      request.status = "done";
      this.hooks.activity(`Approved and ran ${request.agentName}'s ${request.tool.replace(/_/g, " ")} ${summarizeInput(request.input)}`);
    } catch (error) {
      request.status = "failed";
      request.result = { error: String(error.message || error) };
    }
    this.store.save();
    return request;
  }

  machine(ref) {
    const machines = this.store.data.config.machines;
    const found = machines.find((entry) => entry.id === ref) || machines.find((entry) => entry.name.toLowerCase() === String(ref).toLowerCase());
    if (!found) throw new Error(`no machine ${ref}; machines: ${machines.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`);
    return found;
  }

  async tool(name, input, agent, context = {}) {
    const data = this.store.data;
    const config = data.config;
    const github = this.cache.github;
    switch (name) {
      case "get_overview": return {
        repo: config.repo, user: config.github?.login, guardrails: github?.guardrails, githubUpdated: github?.updated || null, collectorErrors: Object.keys(this.cache.errors || {}).length ? this.cache.errors : undefined,
        machines: config.machines.map((entry) => ({ id: entry.id, name: entry.name, online: this.cache.machines[entry.id]?.online ?? null, ready: entry.prepare?.status, gpus: gpuTargets(entry).map((target) => `${target.id}: ${target.label}`), disabledGpus: (entry.gpus || []).filter((gpu) => !gpu.enabled).map((gpu) => gpu.vulkanName || gpu.name) })),
        jobs: data.jobs.slice(0, 10).map((job) => ({ id: job.id, title: job.title, status: job.status, created: job.created })),
        plans: data.plans.filter((entry) => entry.status === "open").map((entry) => ({ id: entry.id, lane: entry.lane, title: entry.title })),
        openPrs: (github?.mine?.prs || []).filter((pr) => pr.state === "open").map((pr) => ({ number: pr.number, title: pr.title, comments: pr.comments, updated: pr.updated })),
        openIssues: (github?.mine?.issues || []).filter((issue) => issue.state === "open").map((issue) => ({ number: issue.number, title: issue.title, comments: issue.comments })),
        newComments: (github?.comments || []).slice(0, 8).map((comment) => ({ number: comment.number, author: comment.author?.login, at: comment.at, text: comment.body.slice(0, 400) })),
      };
      case "get_machine": {
        const entry = this.machine(input.machine);
        const { password, ...rest } = entry;
        return { ...rest, live: this.cache.machines[entry.id] || null, targets: gpuTargets(entry) };
      }
      case "list_fix_branches": return (github?.candidates || []).filter((candidate) => candidate.branches.length && (input.include_with_open_pr || !(candidate.check?.pulls || []).some((pull) => pull.state === "open"))).slice(0, 40)
        .map((candidate) => ({ issue: candidate.number, title: candidate.title, author: candidate.author?.login, branch: candidate.branches[0], check: candidate.check, labels: candidate.labels.map((label) => label.name), updated: candidate.updated }));
      case "get_issue": {
        const gh = new GitHub(this.store.secret(config.github?.token), config.repo);
        const issue = await gh.get(`repos/${config.repo}/issues/${input.number}`);
        const count = Math.min(30, Math.max(0, input.comments ?? 10));
        const comments = count ? await gh.get(`repos/${config.repo}/issues/${input.number}/comments?per_page=100`) : [];
        return { number: issue.number, title: issue.title, state: issue.state, pr: Boolean(issue.pull_request), author: issue.user?.login, labels: issue.labels.map((label) => label.name), body: (issue.body || "").slice(0, 12000),
          comments: comments.slice(-count).map((comment) => ({ author: comment.user.login, at: comment.created_at, body: comment.body.slice(0, 4000) })) };
      }
      case "list_jobs": return data.jobs.slice(0, Math.min(50, input.limit || 15)).map((job) => ({ id: job.id, title: job.title, owner: job.owner, branch: job.branch, status: job.status, requestedBy: job.requestedBy, created: job.created, gpus: job.stages.flatMap((stage) => stage.gpus.map((gpu) => `${gpu.label}: ${gpu.result?.verdict || stage.status}`)) }));
      case "get_job": {
        const job = data.jobs.find((entry) => entry.id === input.job);
        if (!job) throw new Error("no such job");
        return { ...job, stages: job.stages.map((stage) => ({ ...stage, progress: stage.progress.slice(-15) })) };
      }
      case "get_job_log": {
        const job = data.jobs.find((entry) => entry.id === input.job);
        if (!job) throw new Error("no such job");
        const stage = input.machine ? job.stages.find((entry) => entry.machine === input.machine || entry.machineName === input.machine) : job.stages[0];
        if (!stage) throw new Error("that machine has no stage in this job");
        const machine = this.machine(stage.machine);
        const lines = Math.min(400, Math.max(1, input.lines || 80));
        const dir = `${machine.workdir || "$HOME/.anyps5-orchestrator"}/jobs/${job.id}`;
        let file;
        if (input.log === "progress") file = `${dir}/out/progress.log`;
        else if (input.log === "run") file = `${dir}/run.log`;
        else if (input.log === "dev-build") file = `${dir}/out/dev-build.log`;
        else {
          if (!/^[a-z]+[0-9]+$/.test(input.gpu || "") || !stage.gpus.some((gpu) => gpu.id === input.gpu)) throw new Error(`pick a gpu: ${stage.gpus.map((gpu) => gpu.id).join(", ")}`);
          file = `${dir}/out/gpu-${input.gpu}/${input.log}.log`;
        }
        const result = await exec(machine, `tail -n ${lines} "${file}" 2>&1 | cut -c1-400`, { timeout: 30000 });
        return result.stdout.slice(-30000) || result.stderr || "(empty)";
      }
      case "list_plans": return data.plans;
      case "add_plan": return this.hooks.plan(input, agent.name);
      case "update_plan": return this.hooks.updatePlan(input.id, input, agent.name);
      case "report_status": return this.hooks.status(agent, input);
      case "note": this.hooks.activity(`${agent.name}: ${input.text.slice(0, 300)}`, agent.name); return { ok: true };
      case "list_requests": return (data.requests || []).filter((entry) => entry.agent === agent.id).slice(0, 30).map(({ id, tool, status, created, decided }) => ({ id, tool, status, created, decided }));
      case "get_request": {
        const request = (data.requests || []).find((entry) => entry.id === input.id && entry.agent === agent.id);
        if (!request) throw new Error("no such request");
        return request;
      }
      case "queue_verification": {
        const job = createJob(this.store, { ...input, requestedBy: "you" });
        return { id: job.id, status: job.status, gpus: job.stages.flatMap((stage) => stage.gpus.map((gpu) => `${stage.machineName}: ${gpu.label}`)) };
      }
      case "cancel_job": { const job = await cancel(this.store, input.job); return { id: job.id, status: job.status }; }
      case "prepare_machine": return this.hooks.prepare(this.machine(input.machine));
      case "set_gpu_enabled": {
        const entry = this.machine(input.machine);
        const gpu = entry.gpus?.[input.gpu];
        if (!gpu) throw new Error(`no GPU ${input.gpu} on ${entry.name}`);
        gpu.enabled = input.enabled;
        this.store.save();
        return { machine: entry.name, gpu: gpu.vulkanName || gpu.name, enabled: gpu.enabled };
      }
      case "check_machine": {
        const health = await this.hooks.check(this.machine(input.machine));
        return { machine: input.machine, ready: health.ready, family: health.family, items: health.items.map(({ id: itemId, status, title, detail, fix }) => ({ id: itemId, status, title, detail, fix: fix ? { title: fix.title, risk: fix.risk, manual: Boolean(fix.manual), commands: fix.commands, steps: fix.steps, note: fix.note } : undefined })) };
      }
      case "fix_machine": {
        const result = await this.hooks.fix(this.machine(input.machine), input.check, context.password);
        return { fix: result.recipe, fixed: result.fixed, output: result.output.slice(-4000), stillFailing: result.health.items.filter((item) => item.status === "fail").map((item) => item.id) };
      }
      case "run_command": {
        const target = this.machine(input.machine);
        const result = input.sudo ? await this.hooks.root(target, input.command, context.password) : await exec(target, input.command, { timeout: 120000 });
        return { exitCode: result.code, stdout: result.stdout.slice(0, 20000), stderr: result.stderr.slice(0, 4000) };
      }
      default: throw new Error(`unknown tool ${name}`);
    }
  }
}


function summarizeInput(input) {
  return Object.entries(input || {}).filter(([key]) => key !== "reason" && key !== "why").map(([key, value]) => `${key}=${String(value).slice(0, 60)}`).join(" ");
}

