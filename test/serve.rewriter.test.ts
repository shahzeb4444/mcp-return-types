import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasClosedObject } from "../src/emit/open.js";
import type { SchemasFile } from "../src/infer/run.js";
import { ServeRewriter } from "../src/proxy/serve.js";
import { respond } from "./fixtures/json-logic.js";
import { tmpDir } from "./helpers.js";
import { recordFixtureSchemas } from "./serve-helpers.js";

interface Harness {
  inDir: string;
  warnings: string[];
  rewriter: ServeRewriter;
  list: (tools: Record<string, unknown>[]) => Record<string, unknown> | undefined;
  call: (tool: string, args: Record<string, unknown>, result?: Record<string, unknown>) => Record<string, unknown> | undefined;
}

function harness(opts: { declareSchemas?: boolean; inDir?: string } = {}): Harness {
  const inDir = opts.inDir ?? recordFixtureSchemas();
  const warnings: string[] = [];
  const rewriter = new ServeRewriter({ inDir, fallbackName: "json-fixture", declareSchemas: opts.declareSchemas, onWarn: (m) => warnings.push(m) });
  let id = 100;
  rewriter.fromClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  rewriter.rewrite({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "json-fixture" } } });
  const list: Harness["list"] = (tools) => {
    id += 1;
    rewriter.fromClient({ jsonrpc: "2.0", id, method: "tools/list" });
    return rewriter.rewrite({ jsonrpc: "2.0", id, result: { tools } }) as Record<string, unknown> | undefined;
  };
  const call: Harness["call"] = (tool, args, result) => {
    id += 1;
    rewriter.fromClient({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
    return rewriter.rewrite({ jsonrpc: "2.0", id, result: result ?? respond(tool, args) }) as Record<string, unknown> | undefined;
  };
  return { inDir, warnings, rewriter, list, call };
}

const toolList = (r: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> => {
  const tools = (r?.result as { tools: Record<string, unknown>[] }).tools;
  return Object.fromEntries(tools.map((t) => [t.name as string, t]));
};
const structured = (r: Record<string, unknown> | undefined): unknown => (r?.result as Record<string, unknown> | undefined)?.structuredContent;
const driftLines = (inDir: string): Record<string, unknown>[] => {
  const file = path.join(inDir, "drift.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
};
const declared = [
  { name: "get_user", inputSchema: { type: "object" } },
  { name: "list_items", inputSchema: { type: "object" } },
  { name: "rare", inputSchema: { type: "object" } },
  { name: "unknown_tool", inputSchema: { type: "object" } },
];

describe("serve: tools/list injection (SPEC §3 rule 12)", () => {
  it("by default (also what --no-output-schema asks for) leaves tools/list alone", () => {
    const h = harness();
    expect(h.list(declared)).toBeUndefined();
    expect(harness({ declareSchemas: false }).list(declared)).toBeUndefined();
  });

  it("--declare-schemas injects outputSchema only for medium/high tools with an object root", () => {
    const h = harness({ declareSchemas: true });
    const tools = toolList(h.list(declared));
    expect(tools.get_user?.outputSchema).toMatchObject({ type: "object" });
    expect((tools.get_user?.outputSchema as { required: string[] }).required.slice().sort()).toEqual(["created", "id", "name", "tags"]);
    expect(tools.rare?.outputSchema).toBeUndefined(); // low confidence
    expect(tools.list_items?.outputSchema).toBeUndefined(); // array root cannot be an outputSchema
    expect(tools.unknown_tool?.outputSchema).toBeUndefined(); // never recorded
  });

  it("injected schemas are OPEN at every level, while the stored schema is closed", () => {
    const h = harness({ declareSchemas: true });
    const stored = JSON.parse(readFileSync(path.join(h.inDir, "schemas", "json-fixture.json"), "utf8")) as SchemasFile;
    expect(hasClosedObject(stored.tools.get_user?.schema)).toBe(true); // closed internally, for drift detection
    const sent = toolList(h.list(declared)).get_user?.outputSchema;
    expect(hasClosedObject(sent)).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('"additionalProperties":false');
    expect(JSON.stringify(sent)).not.toContain("x-");
    expect(JSON.stringify(sent)).not.toContain("$schema");
    expect((sent as { properties: Record<string, unknown> }).properties).toHaveProperty("email");
    expect((sent as { required: string[] }).required).not.toContain("email");
  });

  it("never overrides a schema the server declared itself", () => {
    const h = harness({ declareSchemas: true });
    const own = { type: "object", properties: { mine: { type: "string" } } };
    expect(h.list([{ name: "get_user", inputSchema: { type: "object" }, outputSchema: own }])).toBeUndefined(); // unchanged
  });

  it("keeps every other field of each tool and of the result", () => {
    const h = harness({ declareSchemas: true });
    const msg = h.list([{ name: "get_user", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    expect(toolList(msg).get_user).toMatchObject({ description: "d", annotations: { readOnlyHint: true } });
  });
});

describe("serve: tools/call fail-open rules (SPEC §3 rule 12)", () => {
  it("adds structuredContent, equal to the parsed text, when the result matches", () => {
    const h = harness();
    const out = h.call("get_user", { id: "ok1" });
    expect(structured(out)).toEqual({ id: "ok1", name: "Ada", tags: ["a", "b"], created: "2026-11-22T10:00:00Z" });
    expect((out?.result as { content: unknown }).content).toEqual(respond("get_user", { id: "ok1" }).content); // text untouched
  });

  it("accepts a harmless new field, because the schema is open", () => {
    const h = harness();
    const out = h.call("get_user", { id: "extra" });
    expect(structured(out)).toMatchObject({ id: "extra", brandNew: { nested: true } });
    expect(driftLines(h.inDir)).toEqual([]);
  });

  it("accepts the optional key both present and absent", () => {
    const h = harness();
    expect(structured(h.call("get_user", { id: "xm" }))).toHaveProperty("email");
    expect(structured(h.call("get_user", { id: "x" }))).not.toHaveProperty("email");
  });

  it("on a mismatch passes the result through unchanged and logs one drift event", () => {
    const h = harness();
    expect(h.call("get_user", { id: "bad" })).toBeUndefined(); // undefined = forward the original bytes
    expect(h.call("get_user", { id: "bad" })).toBeUndefined();
    const lines = driftLines(h.inDir);
    expect(lines).toHaveLength(1); // the same problem is logged once per process
    expect(lines[0]).toMatchObject({ source: "serve", server: "json-fixture", tool: "get_user" });
    expect(String(lines[0]?.reason)).toContain("does not match the inferred schema");
    expect(h.warnings.join("\n")).toContain("drift in \"get_user\"");
    expect(JSON.stringify(lines)).not.toContain("Ada"); // no values in the drift log
  });

  it("never adds structuredContent to isError results, even if the body would match", () => {
    const h = harness();
    expect(h.call("get_user", { id: "err" })).toBeUndefined();
    expect(driftLines(h.inDir)).toEqual([]);
  });

  it("leaves results that already have structuredContent alone", () => {
    const h = harness();
    expect(h.call("get_user", { id: "u" }, { content: [], structuredContent: { id: "u" } })).toBeUndefined();
  });

  it("passes plain text and non-object JSON through, as drift", () => {
    const h = harness();
    expect(h.call("get_user", { id: "plain" })).toBeUndefined();
    expect(h.call("get_user", { id: "array" })).toBeUndefined();
    const reasons = driftLines(h.inDir).map((l) => String(l.reason));
    expect(reasons).toEqual(["result is no longer JSON", "result is JSON but not an object"]);
  });

  it("does nothing for low-confidence, array-root and unknown tools", () => {
    const h = harness();
    expect(h.call("rare", {})).toBeUndefined();
    expect(h.call("list_items", { page: 1 })).toBeUndefined();
    expect(h.call("unknown_tool", {}, { content: [{ type: "text", text: "{}" }] })).toBeUndefined();
    expect(driftLines(h.inDir)).toEqual([]);
  });

  it("adds the same structuredContent with --declare-schemas, and fails open the same way", () => {
    const h = harness({ declareSchemas: true });
    expect(structured(h.call("get_user", { id: "ok1" }))).toMatchObject({ id: "ok1" });
    expect(h.call("get_user", { id: "bad" })).toBeUndefined();
  });

  it("ignores JSON-RPC errors, notifications and responses it did not ask for", () => {
    const h = harness();
    h.rewriter.fromClient({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_user", arguments: { id: "z" } } });
    expect(h.rewriter.rewrite({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "bad" } })).toBeUndefined();
    expect(h.rewriter.rewrite({ jsonrpc: "2.0", method: "notifications/progress", params: {} })).toBeUndefined();
    expect(h.rewriter.rewrite({ jsonrpc: "2.0", id: 999, result: { content: [] } })).toBeUndefined();
  });

  it("a cancelled call is forgotten", () => {
    const h = harness();
    h.rewriter.fromClient({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_user", arguments: { id: "z" } } });
    h.rewriter.fromClient({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } });
    expect(h.rewriter.rewrite({ jsonrpc: "2.0", id: 8, result: respond("get_user", { id: "z" }) })).toBeUndefined();
  });

  it("serves nothing, and says so once, when no schemas exist", () => {
    const h = harness({ inDir: tmpDir("typegen-empty-"), declareSchemas: true });
    expect(h.list(declared)).toBeUndefined();
    expect(h.call("get_user", { id: "ok1" })).toBeUndefined();
    expect(h.warnings.filter((w) => w.includes("no inferred schemas"))).toHaveLength(1);
  });

  it("serves nothing when the schemas file is corrupt", () => {
    const inDir = tmpDir("typegen-corrupt-");
    mkdirSync(path.join(inDir, "schemas"), { recursive: true });
    writeFileSync(path.join(inDir, "schemas", "json-fixture.json"), "{ not json");
    const h = harness({ inDir });
    expect(h.call("get_user", { id: "ok1" })).toBeUndefined();
  });

  it("serves a tool without a schema when its schema does not compile", () => {
    const inDir = recordFixtureSchemas();
    const file = path.join(inDir, "schemas", "json-fixture.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SchemasFile;
    (parsed.tools.get_user as { schema: unknown }).schema = { type: "object", properties: { a: { type: "no-such-type" } } };
    writeFileSync(file, JSON.stringify(parsed));
    const h = harness({ inDir });
    expect(h.call("get_user", { id: "ok1" })).toBeUndefined();
    expect(h.warnings.join("\n")).toContain("does not compile");
  });

  it("checks the full value, not only the first 50 array items that were recorded", () => {
    const h = harness();
    // tags was recorded as string[]; a number far beyond item 50 must be caught.
    const tags = Array.from({ length: 200 }, () => "t");
    tags[150] = 5 as unknown as string;
    const out = h.call("get_user", { id: "long" }, { content: [{ type: "text", text: JSON.stringify({ id: "long", name: "A", tags, created: "2026-11-22T10:00:00Z" }) }] });
    expect(out).toBeUndefined();
  });

  it("does not claim a date-time that clients would reject", () => {
    const h = harness();
    const out = h.call("get_user", { id: "dt" }, { content: [{ type: "text", text: JSON.stringify({ id: "dt", name: "A", tags: [], created: "2026-11-22 10:00" }) }] });
    expect(out).toBeUndefined();
    expect(driftLines(h.inDir)).toHaveLength(1);
  });
});
