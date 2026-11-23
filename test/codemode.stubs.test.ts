import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateStubs, type StubTool } from "../src/codemode/stubs.js";
import type { EmitTool } from "../src/emit/ts.js";
import { inferTool } from "../src/infer/tool.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";
import { compileTs } from "./tsc-helper.js";

const NOW = new Date("2026-11-22T12:00:00Z");
const infered = (tool: string, values: unknown[]): EmitTool =>
  inferTool(tool, values.map((v, i) => sample(v, { tool, args: `a${i}` })), { now: NOW });

const TOOLS: StubTool[] = [
  {
    name: "list_issues",
    description: "List issues of a repo.\nSupports paging.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed"] },
        page: { type: "integer" },
      },
      required: ["owner", "repo"],
    },
  },
  { name: "get-me", description: "Who am I", inputSchema: { type: "object", properties: {} } },
  { name: "search", inputSchema: { type: "object", properties: { q: { type: "string" }, labels: { type: "array", items: { type: "string" } } } } },
  { name: "no_schema" },
];

const OUTPUTS: Record<string, EmitTool> = {
  list_issues: infered("list_issues", [1, 2, 3, 4].map((n) => [{ number: n, title: "t", closed_at: n % 2 ? null : "2026-11-22T10:00:00Z" }])),
  "get-me": infered("get-me", [{ login: "a" }]),
  search: infered("search", [{ total: 1, items: [{ id: 1 }] }, { total: 2, items: [{ id: 2 }, { id: 3, extra: true }] }, { total: 0, items: [{ id: 9 }] }]),
};

describe("generateStubs (SPEC §6)", () => {
  it("arm C: every return is Promise<unknown>", () => {
    const out = generateStubs(TOOLS);
    expect(out).toMatchSnapshot();
    expect(out.match(/Promise<unknown>/g)).toHaveLength(TOOLS.length);
    expect(out).not.toContain("type ");
  });

  it("arm D: the same stubs with the inferred return types", () => {
    const out = generateStubs(TOOLS, { outputs: OUTPUTS });
    expect(out).toMatchSnapshot();
    expect(out).toContain("list_issues(args: {");
    expect(out).toContain("Promise<ListIssuesResult>");
    expect(out).toContain("Promise<unknown>"); // no_schema has no inferred type
  });

  it("C and D differ only in the return types (the benchmark's one variable)", () => {
    const c = generateStubs(TOOLS);
    const d = generateStubs(TOOLS, { outputs: OUTPUTS });
    const members = (s: string): string[] =>
      s
        .slice(s.indexOf("declare const"))
        .split("\n")
        .map((l) => l.replace(/Promise<\w+>/, "Promise<_>"));
    expect(members(d).filter((l) => !l.includes("// low confidence"))).toEqual(members(c));
  });

  it("marks low-confidence tools with // low confidence", () => {
    const d = generateStubs(TOOLS, { outputs: OUTPUTS });
    const lines = d.split("\n");
    const i = lines.findIndex((l) => l.startsWith(`  "get-me"(`));
    expect(lines[i - 1]?.trim()).toBe("// low confidence");
    expect(lines.filter((l) => l.trim() === "// low confidence").length).toBeGreaterThanOrEqual(1);
  });

  it("required args are required, optional ones are optional, no-arg tools take no argument", () => {
    const out = generateStubs(TOOLS);
    expect(out).toMatch(/list_issues\(args: \{/);
    expect(out).toContain("owner: string;");
    expect(out).toContain("state?: \"open\" | \"closed\";");
    expect(out).toContain("page?: number;");
    expect(out).toContain('"get-me"(): Promise<unknown>;');
    expect(out).toMatch(/search\(args\?: \{/);
    expect(out).toContain("no_schema(args?: Record<string, unknown>): Promise<unknown>;");
  });

  it("carries descriptions as comments and honours the namespace option", () => {
    const out = generateStubs(TOOLS, { namespace: "mcp" });
    expect(out).toContain("declare const mcp: {");
    expect(out).toContain("List issues of a repo.");
    expect(out).toContain("Repo owner");
  });

  it("is deterministic and independent of tool order", () => {
    expect(generateStubs([...TOOLS].reverse(), { outputs: OUTPUTS })).toBe(generateStubs(TOOLS, { outputs: OUTPUTS }));
  });

  it("both variants compile, and calls type-check against them", () => {
    const dir = tmpDir("typegen-stubs-");
    writeFileSync(path.join(dir, "c.d.ts"), generateStubs(TOOLS));
    expect(compileTs(dir, ["c.d.ts"]).output).toBe("");
    writeFileSync(path.join(dir, "d.d.ts"), generateStubs(TOOLS, { outputs: OUTPUTS }));
    expect(compileTs(dir, ["d.d.ts"]).output).toBe("");
    writeFileSync(
      path.join(dir, "use.ts"),
      [
        "const run = async () => {",
        "  const issues = await tools.list_issues({ owner: 'o', repo: 'r' });",
        "  const n: number = issues[0].number;",
        "  const me = await tools['get-me']();",
        "  const login: string = me.login;",
        "  // @ts-expect-error owner is required",
        "  await tools.list_issues({ repo: 'r' });",
        "  return [n, login];",
        "};",
        "export { run };",
      ].join("\n"),
    );
    expect(compileTs(dir, ["d.d.ts", "use.ts"]).output).toBe("");
  }, 60_000);
});
