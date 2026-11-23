// Behaviour of the JSON fixture server (test/fixtures/json-server.ts). It is shared with the tests so that
// the traffic they record is exactly what the server really answers. The server returns JSON as text and
// never declares an outputSchema, like most real MCP servers.

export interface FixtureResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const json = (value: unknown): FixtureResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export const FIXTURE_TOOLS = [
  {
    name: "get_user",
    description: "Get one user. The ids 'extra', 'bad', 'plain', 'err' and 'array' make the server misbehave on purpose.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_items",
    description: "List items. The result is a JSON array, which cannot be declared as an outputSchema.",
    inputSchema: { type: "object", properties: { page: { type: "number" } } },
  },
  {
    name: "rare",
    description: "A tool that was called only once while recording.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function respond(tool: string, args: Record<string, unknown> | undefined): FixtureResult {
  if (tool === "list_items") return json([{ n: 1 }, { n: 2 }]);
  if (tool === "rare") return json({ v: 1 });
  if (tool !== "get_user") return { isError: true, content: [{ type: "text", text: `unknown tool ${tool}` }] };
  const id = String(args?.id ?? "");
  switch (id) {
    case "extra": // a new field that was never recorded: harmless
      return json({ id, name: "Ada", tags: ["a"], created: "2026-11-22T10:00:00Z", brandNew: { nested: true } });
    case "bad": // a field of the wrong type
      return json({ id, name: 123, tags: [], created: "2026-11-22T10:00:00Z" });
    case "plain":
      return { content: [{ type: "text", text: "this is not JSON" }] };
    case "err":
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ id, name: 123 }) }] };
    case "array":
      return json([id]);
    default: {
      const base = { id, name: "Ada", tags: ["a", "b"], created: "2026-11-22T10:00:00Z" };
      return json(id.endsWith("m") ? { ...base, email: "ada@example.com" } : base); // `email` is optional
    }
  }
}
