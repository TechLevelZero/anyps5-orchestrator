#!/usr/bin/env node
import readline from "node:readline";

const base = (process.env.ORCHESTRATOR_URL || "http://127.0.0.1:8091").replace(/\/$/, "");
const token = process.env.ORCHESTRATOR_TOKEN || "";

const tools = [
  {
    name: "orchestrator_overview",
    description: "Read the user's AnyPS5 situation: open PRs and issues, the open-PR limit (guardrails), new comments from others, machines and their GPUs, verification jobs and the plan list. Call this before deciding what to work on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () => api("GET", "/api/agent/overview"),
  },
  {
    name: "report_status",
    description: "Tell the user's dashboard what you are doing now. Call it when you start a task, change task, get blocked or finish.",
    inputSchema: { type: "object", required: ["task"], additionalProperties: false, properties: {
      state: { type: "string", enum: ["working", "idle", "blocked", "waiting"] },
      task: { type: "string", description: "One line, e.g. 'Building fix/foo on gpu-box'" },
      detail: { type: "string" },
      machine: { type: "string", description: "Machine the work runs on, if any" },
    } },
    call: (input) => api("POST", "/api/agent/status", input),
  },
  {
    name: "request_verification",
    description: "Ask to build and test a fork branch (merged onto main) against main on every prepared GPU. The job waits until the user approves it in the dashboard; results come back through get_job.",
    inputSchema: { type: "object", required: ["owner", "branch"], additionalProperties: false, properties: {
      owner: { type: "string", description: "GitHub user that owns the fork" },
      branch: { type: "string" },
      issue: { type: "integer", description: "Issue or PR the branch fixes" },
      title: { type: "string" },
      reason: { type: "string", description: "Why this should be verified" },
    } },
    call: (input) => api("POST", "/api/agent/verify", input),
  },
  {
    name: "get_job",
    description: "Read a verification job: its status per machine and GPU, test results and the draft report.",
    inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
    call: (input) => api("GET", `/api/agent/jobs/${encodeURIComponent(input.id)}`),
  },
  {
    name: "add_plan",
    description: "Add an item to the user's plan board (lanes: now, next, later).",
    inputSchema: { type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string" }, detail: { type: "string" }, lane: { type: "string", enum: ["now", "next", "later"] } } },
    call: (input) => api("POST", "/api/agent/plans", input),
  },
  {
    name: "update_plan",
    description: "Move a plan to another lane or mark it done.",
    inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" }, lane: { type: "string", enum: ["now", "next", "later"] }, status: { type: "string", enum: ["open", "done"] }, detail: { type: "string" } } },
    call: (input) => api("PATCH", `/api/agent/plans/${encodeURIComponent(input.id)}`, input),
  },
  {
    name: "note",
    description: "Write a line to the dashboard's activity feed, for things the user should notice later.",
    inputSchema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } },
    call: (input) => api("POST", "/api/agent/note", input),
  },
];

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n");
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "initialize") {
    return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "anyps5-orchestrator", version: "0.1.0-beta" },
      instructions: "Report what you are doing with report_status as you work. Verification requests wait for the user's approval. The orchestrator never posts to GitHub." });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: tools.map(({ call, ...tool }) => tool) });
  if (method === "tools/call") {
    const tool = tools.find((entry) => entry.name === params?.name);
    if (!tool) return reply(id, null, { code: -32602, message: `unknown tool ${params?.name}` });
    try {
      const result = await tool.call(params.arguments || {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
    } catch (error) {
      return reply(id, { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true });
    }
  }
  reply(id, null, { code: -32601, message: `method not found: ${method}` });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return reply(null, null, { code: -32700, message: "parse error" }); }
  handle(message).catch((error) => reply(message.id ?? null, null, { code: -32603, message: String(error.message || error) }));
});
