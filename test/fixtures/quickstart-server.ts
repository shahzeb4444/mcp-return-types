// An MCP stdio server for the quickstart tests. Every tools/call it receives is appended (tool name and
// arguments) to the file named by QS_CALL_LOG, so a test can prove which tools were really called.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });

const QS_TOOLS = [
  { name: "list_things", description: "Read-only, no arguments.", inputSchema: obj(), annotations: { readOnlyHint: true } },
  {
    name: "get_thing",
    description: "Read-only, a required enum and an optional minimum.",
    inputSchema: obj({ kind: { type: "string", enum: ["a", "b"] }, page: { type: "integer", minimum: 1 } }, ["kind"]),
    annotations: { readOnlyHint: true },
  },
  { name: "find_thing", description: "Read-only, but needs a free-form string.", inputSchema: obj({ q: { type: "string" } }, ["q"]), annotations: { readOnlyHint: true } },
  { name: "delete_everything", description: "No annotations: may have side effects.", inputSchema: obj() },
  { name: "set_flag", description: "Explicitly not read-only.", inputSchema: obj({ on: { type: "boolean" } }), annotations: { readOnlyHint: false } },
  { name: "wipe", description: "Destructive.", inputSchema: obj(), annotations: { readOnlyHint: false, destructiveHint: true } },
];

const server = new Server({ name: "qs-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: QS_TOOLS }) as never);
server.setRequestHandler(CallToolRequestSchema, (req) => {
  const log = process.env.QS_CALL_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ tool: req.params.name, args: req.params.arguments ?? {} })}\n`);
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const value =
    req.params.name === "list_things"
      ? { items: [{ id: 1, name: "x" }], next: null }
      : req.params.name === "get_thing"
        ? { kind: args.kind, page: args.page ?? 1, ok: true }
        : { done: true };
  return { content: [{ type: "text", text: JSON.stringify(value) }] } as never;
});
await server.connect(new StdioServerTransport());
