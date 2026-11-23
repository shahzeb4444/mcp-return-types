// M10 quickstart: the safety rules (which tools may be called) and argument derivation. No processes.
import { describe, expect, it } from "vitest";
import { argSetsFor, candidates, planQuickstart, unsafeReason, type ListedTool, type PlanItem } from "../src/quickstart/plan.js";
import { describePlan, shellQuote } from "../src/quickstart/run.js";

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });
const ro = { readOnlyHint: true };
const item = (items: PlanItem[], tool: string): PlanItem | undefined => items.find((i) => i.tool === tool);

describe("quickstart safety: which tools are called", () => {
  const tools: ListedTool[] = [
    { name: "read", inputSchema: obj(), annotations: ro },
    { name: "no_annotations", inputSchema: obj() },
    { name: "empty_annotations", inputSchema: obj(), annotations: {} },
    { name: "not_read_only", inputSchema: obj(), annotations: { readOnlyHint: false } },
    { name: "destructive", inputSchema: obj(), annotations: { destructiveHint: true } },
    { name: "truthy_but_not_true", inputSchema: obj(), annotations: { readOnlyHint: "yes" } },
  ];

  it("by default calls only tools with annotations.readOnlyHint === true", () => {
    const plan = planQuickstart(tools, { calls: 3 });
    const called = plan.items.filter((i) => i.action === "call").map((i) => i.tool);
    expect(called).toEqual(["read"]);
    expect(item(plan.items, "read")).toMatchObject({ action: "call", because: "readOnlyHint" });
  });

  it("says why each other tool is skipped", () => {
    const plan = planQuickstart(tools, { calls: 3 });
    expect(item(plan.items, "no_annotations")).toEqual({
      tool: "no_annotations",
      action: "skip",
      reason: "not marked read-only (no annotations.readOnlyHint: true), so it may have side effects",
    });
    expect(item(plan.items, "empty_annotations")).toMatchObject({ action: "skip", reason: expect.stringContaining("not marked read-only") });
    expect(item(plan.items, "not_read_only")).toMatchObject({ action: "skip", reason: "may have side effects (annotations.readOnlyHint is false)" });
    expect(item(plan.items, "destructive")).toMatchObject({ action: "skip", reason: "marked destructive (annotations.destructiveHint is true)" });
    expect(item(plan.items, "truthy_but_not_true")).toMatchObject({ action: "skip" }); // only the boolean true counts
    expect(unsafeReason({ name: "x", annotations: { readOnlyHint: true, destructiveHint: true } })).toBeUndefined();
  });

  it("--tools calls exactly the listed tools, even without readOnlyHint, and skips the rest", () => {
    const plan = planQuickstart(tools, { calls: 2, only: ["no_annotations", "missing_tool"] });
    expect(plan.items.filter((i) => i.action === "call").map((i) => i.tool)).toEqual(["no_annotations"]);
    expect(item(plan.items, "no_annotations")).toMatchObject({ action: "call", because: "--tools" });
    expect(item(plan.items, "read")).toEqual({ tool: "read", action: "skip", reason: "not listed in --tools" });
    expect(plan.unknown).toEqual(["missing_tool"]);
  });

  it("--tools still needs derivable required arguments", () => {
    const plan = planQuickstart([{ name: "post", inputSchema: obj({ text: { type: "string" } }, ["text"]) }], { calls: 1, only: ["post"] });
    expect(item(plan.items, "post")).toMatchObject({ action: "skip", reason: expect.stringContaining('required argument "text"') });
  });

  it("skips a read-only tool whose required argument has no derivable value, and says which one", () => {
    const plan = planQuickstart([{ name: "echo", inputSchema: obj({ message: { type: "string" } }, ["message"]), annotations: ro }], { calls: 3 });
    expect(item(plan.items, "echo")).toEqual({
      tool: "echo",
      action: "skip",
      reason: 'required argument "message" (string) has no default, enum, const, example or minimum in its schema',
    });
  });
});

describe("quickstart arguments: derived from the schema only", () => {
  it("candidates: default first, then const, enum values, examples, minimum, booleans", () => {
    expect(candidates({ type: "string", enum: ["x", "y"], default: "y" })).toEqual(["y", "x"]);
    expect(candidates({ const: 5 })).toEqual([5]);
    expect(candidates({ type: "integer", minimum: 1 })).toEqual([1]);
    expect(candidates({ type: "integer", minimum: 1.5 })).toEqual([2]);
    expect(candidates({ type: "integer", exclusiveMinimum: 0 })).toEqual([1]);
    expect(candidates({ type: "number", minimum: 0.5 })).toEqual([0.5]);
    expect(candidates({ type: "boolean" })).toEqual([false, true]);
    expect(candidates({ type: "string", examples: ["e1"] })).toEqual(["e1"]);
    expect(candidates({ anyOf: [{ type: "string" }, { type: "integer", minimum: 3 }] })).toEqual([3]);
    expect(candidates({ type: "string" })).toEqual([]);
    expect(candidates({ type: "number" })).toEqual([]); // no minimum: nothing is invented
    expect(candidates({ type: "array", items: { type: "string" } })).toEqual([]);
    expect(candidates(undefined)).toEqual([]);
  });

  it("first call uses only required arguments; later calls vary one argument at a time", () => {
    const schema = obj({ location: { type: "string", enum: ["A", "B", "C"] }, verbose: { type: "boolean" } }, ["location"]);
    expect(argSetsFor(schema, 5)).toEqual([
      { location: "A" },
      { location: "B" },
      { location: "C" },
      { location: "A", verbose: false },
      { location: "A", verbose: true },
    ]);
  });

  it("--calls N gives N argument sets, repeating when there are fewer distinct ones", () => {
    expect(argSetsFor(obj(), 3)).toEqual([{}, {}, {}]);
    expect(argSetsFor(obj({ page: { type: "integer", minimum: 1 } }), 3)).toEqual([{}, { page: 1 }, {}]);
    expect(argSetsFor(undefined, 2)).toEqual([{}, {}]);
  });
});

describe("quickstart plan text and quoting", () => {
  it("describePlan lists the calls with their arguments and every skip with its reason", () => {
    const plan = planQuickstart(
      [
        { name: "get", inputSchema: obj({ kind: { enum: ["a", "b"] } }, ["kind"]), annotations: ro },
        { name: "rm", inputSchema: obj() },
      ],
      { calls: 2 },
    );
    expect(describePlan(plan, 2)).toEqual([
      "Plan: call 1 tool(s) 2 time(s) each, skip 1.",
      '  call  get (readOnlyHint) x2: {"kind":"a"} {"kind":"b"}',
      "  skip  rm: not marked read-only (no annotations.readOnlyHint: true), so it may have side effects",
    ]);
  });

  it("shellQuote keeps plain words and single-quotes the rest (valid in PowerShell and POSIX shells)", () => {
    expect(shellQuote("node")).toBe("node");
    expect(shellQuote("C:\\dev\\x.js")).toBe("C:\\dev\\x.js");
    expect(shellQuote("my dir/x")).toBe("'my dir/x'");
    expect(shellQuote("it's")).toBe("'it''s'");
  });
});
