// M11 plain-MCP test: the pre-registered verdict rules (BENCHMARK.md Amendment 3) and the paired S/P analysis.
import { describe, expect, it } from "vitest";
import type { BootstrapCI } from "../bench/analysis/stats.js";
import { harnessChecks, pairPlain, plainPairedStats, plainVerdicts, renderPlainReport } from "../bench/plain-mcp/analyze.js";
import type { PlainArm } from "../bench/plain-mcp/config.js";
import type { PlainResult } from "../bench/plain-mcp/runner.js";
import { plainVerdict, type PlainEvidence } from "../bench/plain-mcp/verdict.js";

const ci = (point: number, lo: number, hi: number): BootstrapCI => ({ point, lo, hi, resamples: 10_000, undefinedResamples: 0, tasks: 6, pairs: 12 });
const ev = (o: [number, number, number], t: [number, number, number], s: [number, number, number], more: Partial<PlainEvidence> = {}): PlainEvidence => ({
  pairs: 12,
  tasks: 6,
  minRepsPerTask: 2,
  outputRatio: ci(...o),
  turnsRatio: ci(...t),
  successDiffPoints: ci(...s),
  ...more,
});

describe("plainVerdict (Amendment 3)", () => {
  it("PASS: output upper < 1.0, turns upper <= 1.05, non-inferiority holds", () => {
    expect(plainVerdict(ev([0.8, 0.7, 0.95], [0.9, 0.8, 1.05], [0, -8.3, 8.3])).verdict).toBe("PASS");
  });
  it("KILL when the output CI lies entirely above 1.0", () => {
    expect(plainVerdict(ev([1.2, 1.01, 1.4], [1, 0.9, 1.1], [0, 0, 0])).verdict).toBe("KILL");
  });
  it("KILL when non-inferiority fails, even with fewer output tokens", () => {
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [0.9, 0.8, 1.0], [-8.3, -16.7, 0])).verdict).toBe("KILL");
  });
  it("exactly -10 points still holds non-inferiority", () => {
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [0.9, 0.8, 1.0], [0, -10, 0])).verdict).toBe("PASS");
  });
  it("INCONCLUSIVE when the output CI contains 1.0, with the pre-registered note", () => {
    const v = plainVerdict(ev([0.95, 0.8, 1.1], [1, 0.9, 1.1], [0, 0, 0]));
    expect(v.verdict).toBe("INCONCLUSIVE");
    expect(v.checks.join("\n")).toMatch(/expected to be likely/);
    expect(plainVerdict(ev([0.9, 0.8, 1.0], [1, 0.9, 1.0], [0, 0, 0])).verdict).toBe("INCONCLUSIVE"); // upper exactly 1.0
  });
  it("PARTIAL when output tokens drop but the turns upper bound is above 1.05", () => {
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [1.0, 0.9, 1.2], [0, 0, 0])).verdict).toBe("PARTIAL");
  });
  it("a CI that cannot be computed never counts for S", () => {
    expect(plainVerdict(ev([NaN, NaN, NaN], [1, 1, 1], [0, 0, 0])).verdict).toBe("PARTIAL");
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [NaN, NaN, NaN], [0, 0, 0])).verdict).toBe("PARTIAL");
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [1, 1, 1], [NaN, NaN, NaN])).verdict).toBe("KILL");
  });
  it("NOT CHECKED without all 6 tasks x 2 reps", () => {
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [0.9, 0.8, 1.0], [0, 0, 0], { pairs: 1, tasks: 1, minRepsPerTask: 1 })).verdict).toBe("NOT CHECKED");
    expect(plainVerdict(ev([0.8, 0.7, 0.9], [0.9, 0.8, 1.0], [0, 0, 0], { pairs: 11, tasks: 6, minRepsPerTask: 1 })).verdict).toBe("NOT CHECKED");
  });
});

const TASKS = ["ctrl-01", "nested-03", "nested-06", "page-02", "page-04", "write-01"];
function result(arm: PlainArm, task: string, rep: number, o: Partial<PlainResult> = {}): PlainResult {
  const out = o.usage?.output_tokens ?? 100;
  return {
    v: 1, id: `mock-${arm}-m-${task}-${rep}`, status: "done", workload: "mock", backend: "claude-cli", model: "m", arm, task, category: "nested", rep,
    pass: true, answerOk: true, stateOk: true, final: "x", refused: false, gradeReasons: [], turns: 4, toolCalls: 4, toolErrors: 0, toolsCalled: {}, shellCalls: 0,
    numTurns: 5, clientError: null, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 0 },
    totalTokens: 1 + out, wallMs: 1000, duplicateWrites: 0, unexpectedWrites: 0, missingWrites: 0, serverStarted: true, driftEvents: 0, mcpServers: [{ name: "github", status: "connected" }],
    offeredTools: ["mcp__github__get_issue"], usageCrossCheck: { modelUsageOutput: out, matches: true }, cwdWasEmpty: true, rateLimitWaits: 0, promptSha256: `p-${task}`, serverCommand: [], stderrTail: null,
    startedAt: "", finishedAt: "",
    ...o,
  };
}
const full = (sOut: (task: string) => number, sOpts: Partial<PlainResult> = {}): PlainResult[] =>
  TASKS.flatMap((t, i) => [1, 2].flatMap((rep) => [result("P", t, rep, { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 + 10 * i, reasoning_output_tokens: 0 } }), result("S", t, rep, { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: sOut(t), reasoning_output_tokens: 0 }, ...sOpts })]));

describe("paired S/P stats", () => {
  it("pairs by (workload, backend, model, task, rep) and computes ratios as sum over sum", () => {
    const rs = full(() => 50);
    const pairs = pairPlain(rs);
    expect(pairs).toHaveLength(12);
    const [s] = plainPairedStats(pairs, { resamples: 500 });
    const sumP = TASKS.reduce((a, _, i) => a + 2 * (100 + 10 * i), 0);
    expect(s?.outputRatio.point).toBeCloseTo((12 * 50) / sumP, 10);
    expect(s?.turnsRatio.point).toBe(1);
    expect(s?.successDiffPoints.point).toBe(0);
    expect(s).toMatchObject({ pairs: 12, tasks: 6, minRepsPerTask: 2 });
    expect(plainVerdicts(plainPairedStats(pairs, { resamples: 500 }))[0]?.verdict).toBe("PASS");
  });

  it("is deterministic for the fixed seed", () => {
    const rs = full((t) => (t === "page-02" ? 300 : 90));
    const a = plainPairedStats(pairPlain(rs), { resamples: 1000 })[0]?.outputRatio;
    const b = plainPairedStats(pairPlain(rs), { resamples: 1000 })[0]?.outputRatio;
    expect(a).toEqual(b);
  });

  it("S2 pairs are separate and never get a verdict", () => {
    const rs = [...full(() => 100), ...TASKS.flatMap((t) => [1, 2].map((rep) => result("S2", t, rep)))];
    const stats = [...plainPairedStats(pairPlain(rs, "P", "S")), ...plainPairedStats(pairPlain(rs, "P", "S2"))];
    expect(stats.map((s) => s.test).sort()).toEqual(["S", "S2"]);
    expect(plainVerdicts(stats)).toHaveLength(1);
  });

  it("a run without a partner is left out", () => {
    const rs = full(() => 100).filter((r) => !(r.arm === "S" && r.task === "ctrl-01" && r.rep === 2));
    expect(pairPlain(rs)).toHaveLength(11);
    expect(plainVerdicts(plainPairedStats(pairPlain(rs), { resamples: 200 }))[0]?.verdict).toBe("NOT CHECKED");
  });
});

describe("renderPlainReport", () => {
  it("has the verdict, the paired tables, the no-harm table and the harness checks", () => {
    const rs = [...full((t) => 100 + 10 * TASKS.indexOf(t), { driftEvents: 1 }), result("P", "ev-echo", 1, { workload: "everything", id: "everything-P-m-ev-echo-1" })];
    const md = renderPlainReport(rs, "2026-11-23T00:00:00Z", { resamples: 200 });
    expect(md).toMatch(/\*\*claude-cli \(m\): INCONCLUSIVE\*\*/);
    expect(md).toContain("## Paired S vs P (gating)");
    expect(md).toContain("## Paired S2 vs P (exploratory");
    expect(md).toContain("| claude-cli | ev-echo | P | PASS |");
    expect(md).toMatch(/serve drift events \(S\/S2\): 12/);
    expect(md).toMatch(/prompt differs between runs \(must be 0\): 0/);
  });
});

describe("harnessChecks: every tool call errored (the Codex approval-denied smoke run)", () => {
  const line = (rs: PlainResult[]): string => harnessChecks(rs).find((l) => l.includes("every tool call errored")) as string;
  it("flags a run whose tool calls all failed", () => {
    const bad = result("S", "ctrl-01", 1, { toolCalls: 3, toolErrors: 3, id: "denied-run" });
    expect(line([bad])).toMatch(/: 1 \(denied-run\)/);
  });
  it("does not flag runs with no tool errors, some tool errors, or no tool calls", () => {
    expect(line([result("S", "ctrl-01", 1, { toolCalls: 3, toolErrors: 0 }), result("P", "ctrl-01", 1, { toolCalls: 3, toolErrors: 1 }), result("P", "page-02", 1, { toolCalls: 0, toolErrors: 0 })])).toMatch(/: 0$/);
  });
});
