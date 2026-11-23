// A tiny MCP stdio server that answers with JSON text and declares no outputSchema.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FIXTURE_TOOLS, respond } from "./json-logic.js";

const server = new Server({ name: "json-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: FIXTURE_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, (req) => respond(req.params.name, req.params.arguments) as never);
await server.connect(new StdioServerTransport());
