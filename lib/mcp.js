import { allTools, serverInstructions } from "./tools.js";

const versions = ["2025-06-18", "2025-03-26", "2024-11-05"];

const readOnly = new Set(["check_machine", "get_overview", "get_machine", "list_fix_branches", "get_issue", "list_jobs", "get_job", "get_job_log", "list_plans", "list_requests", "get_request"]);
const destructive = new Set(["run_command", "cancel_job", "fix_machine"]);

function annotations(name) {
  return { readOnlyHint: readOnly.has(name), destructiveHint: destructive.has(name), idempotentHint: readOnly.has(name), openWorldHint: name === "get_issue" };
}

function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function failure(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

async function handle(message, agent, tools, version) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return message && "id" in message && !("method" in message) ? null : failure(message?.id, -32600, "invalid request");
  }
  const { id, method, params } = message;
  if (id === undefined) return null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "anyps5-orchestrator", title: "AnyPS5 Orchestrator", version },
        instructions: serverInstructions,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: allTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema, annotations: annotations(tool.name) })) });
    case "tools/call": {
      const name = params?.name;
      if (!allTools.some((tool) => tool.name === name)) return failure(id, -32602, `unknown tool ${name}`);
      try {
        const result = await tools.call(agent, name, params?.arguments || {});
        return reply(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 1) }] });
      } catch (error) {
        return reply(id, { content: [{ type: "text", text: `Error: ${error.message || error}` }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `method not found: ${method}`);
  }
}

export async function serveMcp(request, response, { agent, tools, version, readBody, touch }) {
  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== request.headers.host) {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify(failure(null, -32000, "cross-origin requests are not allowed")));
    return;
  }
  if (!agent) {
    response.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="anyps5-orchestrator"' });
    response.end(JSON.stringify(failure(null, -32001, "send the token from the dashboard as: Authorization: Bearer <token>")));
    return;
  }
  if (request.method === "GET") { response.writeHead(405, { Allow: "POST, DELETE" }); response.end(); return; }
  if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
  if (request.method !== "POST") { response.writeHead(405, { Allow: "POST, DELETE" }); response.end(); return; }
  let body;
  try { body = await readBody(request); } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify(failure(null, -32700, "parse error")));
    return;
  }
  touch(agent);
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((message) => handle(message, agent, tools, version)))).filter(Boolean);
  if (!replies.length) { response.writeHead(202); response.end(); return; }
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(batch ? replies : replies[0]));
}
