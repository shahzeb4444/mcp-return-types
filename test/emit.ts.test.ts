import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emitServerTs, runEmitTs } from "../src/emit/ts.js";
import { pascalCase, resultTypeNames, typeOf } from "../src/emit/tstype.js";
import { runInfer, type SchemasFile, type ToolEntry } from "../src/infer/run.js";
import { inferTool } from "../src/infer/tool.js";
import { tmpDir } from "./helpers.js";
import { infer, sample } from "./infer-helpers.js";
import { compileTs } from "./tsc-helper.js";
import { recordFixtureSchemas } from "./serve-helpers.js";

const NOW = new Date("2026-11-22T12:00:00Z");

function entry(tool: string, values: unknown[], over: { unwrap?: "json-text" | "structuredContent" | "text" } = {}): ToolEntry {
  const samples = values.map((v, i) => sample(v, { tool, args: `a${i}`, ...(over.unwrap ? { unwrap: over.unwrap } : {}) }));
  return { ...inferTool(tool, samples, { now: NOW }), version: 1, seen: samples.length, drift: [] };
}

const issue = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: n,
  title: `t${n}`,
  closed_at: n % 2 === 0 ? "2026-11-22T10:00:00Z" : null,
  labels: [{ name: "bug" }],
  ...extra,
});

function fileOf(...entries: ToolEntry[]): Pick<SchemasFile, "server" | "tools"> {
  return { server: "github", tools: Object.fromEntries(entries.map((e) => [e.tool, e])) };
}

const sampleFile = (): Pick<SchemasFile, "server" | "tools"> =>
  fileOf(
    entry("list_issues", [1, 2, 3, 4, 5, 6].map((n) => [issue(n, n < 4 ? { assignee: "ann" } : {})])),
    entry("get-repo", [1, 2, 3, 4].map((n) => ({ id: n, "full name": `o/r${n}`, topics: [], stats: { stars: n + 0.5 } }))),
    entry("rare_tool", [{ ok: true }]),
    entry("echo", ["a", "b", "c"].map((s) => s), { unwrap: "text" }),
  );

describe("TypeScript emit (snapshots)", () => {
  it("emits optional keys with ?, nullable with | null, and marks low-confidence tools", () => {
    const out = emitServerTs(sampleFile(), "0.1.0");
    expect(out).toMatchSnapshot();
    // Optional (missing in some results) and nullable (null in some results) stay separate.
    expect(out).toMatch(/assignee\?: string;/);
    expect(out).toMatch(/closed_at: string \| null;/);
    expect(out).toContain("// low confidence");
    expect(out).toContain("number: number;");
  });

  it("falls back to unknown for unknown shapes", () => {
    const out = emitServerTs(sampleFile(), "0.1.0");
    expect(out).toMatch(/topics: unknown\[\];/); // only empty arrays were ever seen
    expect(typeOf({}).text).toBe("unknown");
    expect(typeOf(undefined).text).toBe("unknown");
    expect(typeOf({ "x-capped": "depth" }).text).toBe("unknown");
    expect(typeOf({ "x-capped": "union" }).text).toBe("unknown");
    expect(typeOf({ type: "weird" }).text).toBe("unknown");
  });

  it("states how each result is unwrapped", () => {
    const out = emitServerTs(sampleFile(), "0.1.0");
    expect(out).toContain("// echo: result is the text content as a plain string");
    expect(out).toContain("export type EchoResult = string;");
    expect(out).toContain("// list_issues: result is the text content parsed as JSON");
  });

  it("is stable: tools in name order, same text on every run", () => {
    const a = emitServerTs(sampleFile(), "0.1.0");
    const reversed = sampleFile();
    reversed.tools = Object.fromEntries(Object.entries(reversed.tools).reverse());
    expect(emitServerTs(reversed, "0.1.0")).toBe(a);
  });
});

describe("schema -> TypeScript", () => {
  it("handles unions, nesting, maps, capped objects and quoted keys", () => {
    expect(typeOf({ type: ["string", "null"] }).text).toBe("string | null");
    expect(typeOf({ type: "integer" }).text).toBe("number");
    expect(typeOf({ type: "array", items: { type: ["string", "number"] } }).text).toBe("(string | number)[]");
    expect(typeOf({ type: "array" }).text).toBe("unknown[]");
    expect(typeOf({ anyOf: [{ type: "string" }, { type: "null" }] }).text).toBe("string | null");
    expect(typeOf({ type: "object", additionalProperties: { type: "number" } }).text).toBe("{ [key: string]: number }");
    expect(typeOf({ type: "object", properties: { a: { type: "string" } }, "x-capped": "keys" }).text).toContain("[key: string]: unknown;");
    expect(typeOf({ type: "object", properties: { "a b": { type: "string" }, ok: { type: "string" } } }).text).toContain('"a b"?: string;');
    expect(typeOf({ enum: ["a", "b"] }).text).toBe('"a" | "b"');
    expect(typeOf({ type: "object" }).text).toBe("Record<string, unknown>");
  });

  it("turns observed-value hints and formats into comments, never into a hard union", () => {
    const text = typeOf({
      type: "object",
      properties: { state: { type: "string", "x-observed-values": ["open", "closed"] }, at: { type: "string", format: "date-time" } },
    }).text;
    expect(text).toContain('/** observed values (a hint, not exhaustive): "open", "closed" */');
    expect(text).toContain("state?: string;");
    expect(text).toContain("/** format: date-time */");
  });

  it("a comment can not be ended early by a description", () => {
    const text = typeOf({ type: "object", properties: { a: { type: "string", description: "x */ evil()" } } }).text;
    expect(text).not.toContain("*/ evil");
  });

  it("names result types from tool names, without collisions", () => {
    expect(pascalCase("list_issues")).toBe("ListIssues");
    expect(pascalCase("get-sum")).toBe("GetSum");
    expect(pascalCase("3d")).toBe("_3d");
    expect(pascalCase("...")).toBe("Tool");
    const names = resultTypeNames(["get_sum", "get-sum", "getSum"]);
    expect([...names.values()]).toEqual(["GetSumResult", "GetSumResult2", "GetSumResult3"]);
  });
});

describe("emitted .d.ts files compile (tsc --noEmit)", () => {
  it("compiles, and the types accept real values and reject wrong ones", () => {
    const dir = tmpDir("typegen-emit-");
    writeFileSync(path.join(dir, "github.d.ts"), emitServerTs(sampleFile(), "0.1.0"));
    writeFileSync(
      path.join(dir, "use.ts"),
      [
        'import type { ListIssuesResult, GetRepoResult, EchoResult } from "./github";',
        "const ok: ListIssuesResult = [{ number: 1, title: 't', closed_at: null, labels: [{ name: 'x' }] }];",
        "const withAssignee: ListIssuesResult = [{ number: 1, title: 't', closed_at: '2026-11-22T10:00:00Z', labels: [], assignee: 'ann' }];",
        "// @ts-expect-error title is required",
        "const missing: ListIssuesResult = [{ number: 1, closed_at: null, labels: [] }];",
        "// @ts-expect-error closed_at may be null but not undefined",
        "const undef: ListIssuesResult = [{ number: 1, title: 't', labels: [] }];",
        "const repo: GetRepoResult = { id: 1, 'full name': 'o/r', topics: ['a', 2], stats: { stars: 1.5 } };",
        "const echo: EchoResult = 'hi';",
        "export { ok, withAssignee, missing, undef, repo, echo };",
      ].join("\n"),
    );
    const result = compileTs(dir, ["use.ts"]);
    expect(result.output).toBe("");
    expect(result.ok).toBe(true);
  }, 60_000);

  it("end to end: record -> infer -> `emit --ts` writes a file that compiles", async () => {
    const inDir = recordFixtureSchemas();
    const outDir = path.join(tmpDir("typegen-emit-out-"), "types");
    const result = runEmitTs({ inDir, outDir, version: "0.1.0" });
    expect(result.files).toHaveLength(1);
    const file = path.join(outDir, "json-fixture.d.ts");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("export type GetUserResult = {");
    expect(text).toMatch(/email\?: string;/);
    expect(text).toContain("// low confidence"); // the `rare` tool
    expect(compileTs(outDir, ["json-fixture.d.ts"]).output).toBe("");
  }, 60_000);

  it("`emit --ts` through the CLI", async () => {
    const { startProcess, CLI } = await import("./helpers.js");
    const inDir = recordFixtureSchemas();
    const outDir = path.join(tmpDir("typegen-emit-cli-"), "types");
    const run = startProcess(process.execPath, ["--import", "tsx", CLI, "emit", "--ts", "--in", inDir, "--out", outDir]);
    expect(await run.exited).toBe(0);
    expect(run.stdout().toString()).toContain("json-fixture: wrote");
    expect(existsSync(path.join(outDir, "json-fixture.d.ts"))).toBe(true);
    const missing = startProcess(process.execPath, ["--import", "tsx", CLI, "emit", "--ts", "--in", tmpDir()]);
    expect(await missing.exited).toBe(1);
    const noTarget = startProcess(process.execPath, ["--import", "tsx", CLI, "emit"]);
    expect(await noTarget.exited).toBe(2);
  }, 60_000);

  it("an inferred object that was never open stays usable: infer() output compiles for odd keys", () => {
    const dir = tmpDir("typegen-emit-odd-");
    mkdirSync(dir, { recursive: true });
    const schema = infer([{ "a-b": 1, "c d": [true], class: null, "": "x" }]);
    writeFileSync(path.join(dir, "odd.d.ts"), `export type Odd = ${typeOf(schema).text};\n`);
    expect(compileTs(dir, ["odd.d.ts"]).output).toBe("");
  }, 60_000);
});

// Silence unused-import lint for runInfer (kept to document that infer output feeds the emitter).
void runInfer;
