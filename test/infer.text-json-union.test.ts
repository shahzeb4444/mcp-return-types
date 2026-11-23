// SPEC §3 rule 1, text | parsed union (M9 finding): a text tool whose result sometimes parses as JSON
// and sometimes does not widens to a union instead of failing validation.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emitToolType } from "../src/emit/ts.js";
import { runInfer, type SchemasFile } from "../src/infer/run.js";
import { acceptsText, sampleFits, type JsonSchema } from "../src/infer/schema.js";
import { inferTool } from "../src/infer/tool.js";
import { Recorder } from "../src/proxy/recorder.js";
import { ServeRewriter } from "../src/proxy/serve.js";
import { shapeOf } from "../src/proxy/shape.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");
const text = (s: string) => ({ content: [{ type: "text", text: s }] });

/** A read_file-like tool: plain text files, and one .json file whose text parses. */
function readFileStore() {
  const inDir = tmpDir();
  const rec = new Recorder({ outDir: inDir, name: "fs", fallbackName: "fs" });
  let id = 0;
  const call = (args: unknown, result: Record<string, unknown>): void => {
    id += 1;
    rec.fromClient({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: args } });
    rec.fromServer({ jsonrpc: "2.0", id, result });
  };
  const run = () => {
    runInfer({ inDir, now });
    return (JSON.parse(readFileSync(path.join(inDir, "schemas", "fs.json"), "utf8")) as SchemasFile).tools.read_file as SchemasFile["tools"][string];
  };
  return { inDir, call, run };
}

describe("text | parsed union", () => {
  it("acceptsText / sampleFits: a JSON-text sample fits a text schema through its plain-text reading", () => {
    const textSchema: JsonSchema = { type: "string" };
    expect(acceptsText(textSchema)).toBe(true);
    expect(acceptsText({ type: "object", properties: {}, additionalProperties: false })).toBe(false);
    expect(acceptsText({ type: ["object", "string"] })).toBe(true);
    const json = sample({ name: "x" }, { unwrap: "json-text" });
    expect(sampleFits(json, textSchema)).toBe(true);
    // A structuredContent value has no text reading.
    expect(sampleFits(sample({ name: "x" }, { unwrap: "structuredContent" }), textSchema)).toBe(false);
    // Plain text never fits an object-only schema.
    expect(sampleFits(sample("hello", { unwrap: "text" }), { type: "object", properties: {}, additionalProperties: false })).toBe(false);
  });

  it("text and JSON-text samples of one tool infer a union string | object, unwrap mixed", () => {
    const t = inferTool(
      "read_file",
      [
        sample("hello world", { unwrap: "text" }),
        sample("line one\nline two", { unwrap: "text" }),
        sample({ name: "demo", version: 2 }, { unwrap: "json-text" }),
      ],
      { now },
    );
    expect(t.unwrap).toBe("mixed");
    expect(t.unwrapCounts).toEqual({ "json-text": 1, text: 2 });
    expect(t.schema.type).toEqual(["object", "string"]);
    expect(t.schema.properties).toEqual({ name: { type: "string" }, version: { type: "integer" } });
    const ts = emitToolType(t, "ReadFileResult", { exported: true });
    expect(ts).toContain("// read_file: result is the text content parsed as JSON when it parses, else the text as a plain string");
    expect(ts).toMatch(/export type ReadFileResult = \{\n {2}name: string;\n {2}version: number;\n\} \| string;/);
  });

  it("drift: a JSON-text result of a tool trained on plain text widens the schema without a drift event", () => {
    const s = readFileStore();
    s.call({ path: "a.txt" }, text("hello"));
    s.call({ path: "b.txt" }, text("plain words"));
    s.call({ path: "c.txt" }, text("more words"));
    const before = s.run();
    expect(before).toMatchObject({ unwrap: "text", version: 1, schema: { type: "string" } });
    s.call({ path: "data.json" }, text('{"name":"demo","version":2}'));
    const after = s.run();
    expect(after.unwrap).toBe("mixed");
    expect(after.schema.type).toEqual(["object", "string"]);
    expect(after.version).toBe(2); // the schema changed
    expect(after.drift).toEqual([]); // but nothing broke: the text is still a string
    expect(existsSync(path.join(s.inDir, "drift.jsonl"))).toBe(false);
  });

  it("drift: plain text from a tool trained on JSON text is a break (logged) and widens to the same union", () => {
    const s = readFileStore();
    for (const n of [1, 2, 3]) s.call({ n }, text(JSON.stringify({ name: `f${n}`, version: n })));
    expect(s.run()).toMatchObject({ unwrap: "json-text", version: 1 });
    s.call({ n: 4 }, text("not json at all"));
    const after = s.run();
    expect(after.drift).toHaveLength(1);
    expect(after.schema.type).toEqual(["object", "string"]);
    expect(after.unwrap).toBe("mixed");
  });

  it("serve: a text | object tool gets structuredContent for its JSON results and passes plain text without drift", () => {
    const inDir = tmpDir();
    const samplesDir = path.join(inDir, "samples", "fs");
    mkdirSync(samplesDir, { recursive: true });
    const lines = [
      ...[1, 2, 3].map((n) => sample({ name: `f${n}`, version: n }, { tool: "read_file", unwrap: "json-text" })),
      ...[1, 2].map(() => sample("some text", { tool: "read_file", unwrap: "text" })),
    ];
    appendFileSync(path.join(samplesDir, "read_file.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    runInfer({ inDir, now });
    const warnings: string[] = [];
    const rw = new ServeRewriter({ inDir, name: "fs", fallbackName: "fs", declareSchemas: true, onWarn: (m) => warnings.push(m) });
    let id = 0;
    const call = (result: Record<string, unknown>) => {
      id += 1;
      rw.fromClient({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: {} } });
      return rw.rewrite({ jsonrpc: "2.0", id, result }) as { result: Record<string, unknown> } | undefined;
    };
    expect(call(text('{"name":"x","version":9}'))?.result.structuredContent).toEqual({ name: "x", version: 9 });
    expect(call(text("plain text"))).toBeUndefined();
    expect(call(text('"a JSON string"'))).toBeUndefined(); // fits as text
    expect(warnings).toEqual([]);
    expect(existsSync(path.join(inDir, "drift.jsonl"))).toBe(false);
    // A union root is never declared as outputSchema (MCP needs an object root).
    id += 1;
    rw.fromClient({ jsonrpc: "2.0", id, method: "tools/list" });
    expect(rw.rewrite({ jsonrpc: "2.0", id, result: { tools: [{ name: "read_file", inputSchema: { type: "object" } }] } })).toBeUndefined();
  });

  it("serve: an object-only tool still reports plain text as drift (no silent widening at serve time)", () => {
    const inDir = tmpDir();
    const samplesDir = path.join(inDir, "samples", "fs");
    mkdirSync(samplesDir, { recursive: true });
    const lines = [1, 2, 3].map((n) => sample({ name: `f${n}` }, { tool: "get", unwrap: "json-text" }));
    appendFileSync(path.join(samplesDir, "get.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    runInfer({ inDir, now });
    const warnings: string[] = [];
    const rw = new ServeRewriter({ inDir, name: "fs", fallbackName: "fs", onWarn: (m) => warnings.push(m) });
    rw.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get", arguments: {} } });
    expect(rw.rewrite({ jsonrpc: "2.0", id: 1, result: text("oops") })).toBeUndefined();
    expect(warnings.join("\n")).toContain("result is no longer JSON");
  });

  it("the recorded shape of a JSON-text result is the parsed value, never the raw text", () => {
    expect(shapeOf(JSON.parse('{"name":"demo"}'))).toEqual({ t: "object", keys: { name: { t: "string", len: "short" } } });
  });
});
