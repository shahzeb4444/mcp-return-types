import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRuns,
  codeOf,
  groupRows,
  loadResults,
  loadTurns,
  median,
  pairedStats,
  pairRuns,
  renderReport,
  renderSummary,
  type RunResult,
  type TurnLine,
} from "../bench/analyze.js";

const run = (o: Partial<RunResult>): RunResult => ({
  id: "x", status: "done", backend: "claude-cli", arm: "C", model: "m", task: "t1", rep: 1, pass: true, turns: 2, toolCalls: 1, codeErrors: 0,
  usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 }, modelLatencyMs: 1000, endedBy: "final", ...o,
});

const fence = (code: string): string => `\`\`\`ts\n${code}\n\`\`\``;
const turn = (n: number, o: Partial<TurnLine>): TurnLine => ({ type: "turn", turn: n, ...o });

/**
 * A small hand-made pilot: 3 tasks x 2 reps x arms C and D on one model.
 *  - C: page-01 rep 1 throws twice (a wrong field name, then .map on a non-array) and fails;
 *       nested-01 rep 2 refuses; everything else passes.
 *  - D: everything passes, fewer output tokens.
 */
function fixture(): { results: RunResult[]; turns: Map<string, TurnLine[]> } {
  const results: RunResult[] = [];
  const turns = new Map<string, TurnLine[]>();
  const tasks = [
    { task: "ctrl-01", category: "control" },
    { task: "nested-01", category: "nested" },
    { task: "page-01", category: "pagination" },
  ];
  for (const { task, category } of tasks) {
    for (const rep of [1, 2]) {
      for (const arm of ["C", "D"]) {
        const id = `${arm}-m-${task}-${rep}`;
        let r = run({ id, arm, task, category, rep, turns: 2, sandboxRuns: 1, usage: { output_tokens: arm === "C" ? 200 : 100 }, final: "42" });
        let lines: TurnLine[] = [turn(1, { reply_kind: "code", sandbox_status: "ok", reply: fence("return 1;") }), turn(2, { reply_kind: "final", reply: "FINAL: 42" })];
        if (arm === "C" && task === "page-01" && rep === 1) {
          r = { ...r, pass: false, turns: 4, sandboxRuns: 3, exceptions: 2, rewrites: 2, codeErrors: 4, final: "7", usage: { output_tokens: 600 } };
          lines = [
            turn(1, { reply_kind: "code", sandbox_status: "exception", sandbox_exception: "TypeError: Cannot read properties of undefined (reading 'length')", reply: fence("const r = await tools.list_issues({repo:'acme/api'}); return r.issues.length;") }),
            turn(2, { reply_kind: "code", sandbox_status: "exception", sandbox_exception: "TypeError: r.map is not a function", reply: fence("const r = await tools.list_issues({repo:'acme/api'}); return r.map(x => x);") }),
            turn(3, { reply_kind: "code", sandbox_status: "ok", reply: fence("const r = await tools.list_issues({repo:'acme/api'}); return r.items.length;") }),
            turn(4, { reply_kind: "final", reply: "FINAL: 7" }),
          ];
        }
        if (arm === "C" && task === "nested-01" && rep === 2) {
          r = { ...r, pass: false, turns: 1, sandboxRuns: 0, toolCalls: 0, final: "I can’t retrieve the issues because the issue tools aren’t available in this session." };
          lines = [turn(1, { reply_kind: "final", reply: `FINAL: ${r.final}` })];
        }
        results.push(r);
        turns.set(id, lines);
      }
    }
  }
  return { results, turns };
}

const knownFields = new Set(["items", "next_page", "title"]);

describe("analyze: loading", () => {
  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
  it("loads only finished runs and their turn logs from files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "analyze-"));
    try {
      writeFileSync(path.join(dir, "a.json"), JSON.stringify(run({ id: "a", arm: "C" })));
      writeFileSync(path.join(dir, "b.json"), JSON.stringify(run({ id: "b", arm: "D", codeErrors: 1 })));
      writeFileSync(path.join(dir, "c.json"), JSON.stringify(run({ id: "c", arm: "D", status: "running" })));
      const t1 = JSON.stringify(turn(1, { sandbox_status: "exception", sandbox_exception: "TypeError: x is not iterable", reply: fence("for (const a of x) {}") }));
      writeFileSync(path.join(dir, "b.jsonl"), `${t1}\r\n${JSON.stringify({ type: "result", id: "b" })}\n{"torn`);
      const results = loadResults(dir);
      expect(results.map((r) => r.id)).toEqual(["a", "b"]);
      const turns = loadTurns(dir, results.map((r) => r.id));
      expect(turns.has("a")).toBe(false);
      expect(turns.get("b")).toHaveLength(1);
      const md = renderReport(results, "2026-01-01T00:00:00Z", { turns, rawLabel: "bench/results/pilot" });
      expect(md).toContain("in `bench/results/pilot`");
      expect(md).toContain("| claude-cli | m | t1 | 1 | PASS | PASS | 0 | 1 |");
      expect(md).toContain("Runs with 0 or missing output tokens: 0");
      expect(md).toContain("| method or iteration on the wrong type (e.g. .map on a non-array) | 0 | 0.00 | 1 | 1.00 |");
      expect(md).toContain("Runs without a turn log: 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reads code from fenced replies and from Codex JSON envelopes", () => {
    expect(codeOf(fence("return 1;"))).toBe("return 1;");
    expect(codeOf(JSON.stringify({ action: "run_code", code: "return 2;", answer: "" }))).toBe("return 2;");
    expect(codeOf("FINAL: 3")).toBeUndefined();
    expect(codeOf(undefined)).toBeUndefined();
  });
});

describe("analyze: per arm", () => {
  it("groups per backend, model and arm with per-task means and total tokens", () => {
    const rows = groupRows([
      run({ arm: "C", codeErrors: 2, turns: 4 }),
      run({ arm: "C", task: "t2", pass: false, codeErrors: 0, turns: 2, final: "the tools are not available here" }),
      run({ arm: "D", codeErrors: 0, turns: 2 }),
    ]);
    const c = rows.find((r) => r.arm === "C");
    expect(c).toMatchObject({ runs: 2, passes: 1, refused: 1, codeErrorsPerTask: 1, turnsPerTask: 3, outMedian: 50, totalMean: 155 });
    expect(rows.find((r) => r.arm === "D")).toMatchObject({ runs: 1, passes: 1, refused: 0 });
  });
  it("classifies each exception, marks refusals and never-paged pagination failures", () => {
    const { results, turns } = fixture();
    const runs = analyzeRuns(results, { turns, knownFields });
    const bad = runs.find((r) => r.id === "C-m-page-01-1");
    expect(bad?.exceptionList.map((e) => e.category)).toEqual(["wrong-field-name", "wrong-type-method"]);
    expect(bad?.neverPaged).toBe(true);
    expect(bad?.unclassified).toBe(0);
    expect(runs.filter((r) => r.refused).map((r) => r.id)).toEqual(["C-m-nested-01-2"]);
    expect(runs.find((r) => r.id === "C-m-nested-01-2")?.neverPaged).toBe(false);
  });
  it("counts exceptions it cannot see in a turn log as unclassified", () => {
    const [r] = analyzeRuns([run({ exceptions: 2, timeouts: 1, codeErrors: 3 })]);
    expect(r).toMatchObject({ unclassified: 3, hasTurnLog: false });
  });
});

describe("analyze: paired", () => {
  it("pairs by (backend, model, task, rep) and leaves unpaired runs out", () => {
    const pairs = pairRuns([run({ id: "c1", arm: "C" }), run({ id: "d1", arm: "D" }), run({ id: "c2", arm: "C", rep: 2 }), run({ id: "d3", arm: "D", model: "other" })]);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.C.id, pairs[0]?.D.id]).toEqual(["c1", "d1"]);
  });
  it("computes ratios, differences, McNemar and the refusal sensitivity check", () => {
    const { results, turns } = fixture();
    const [s] = pairedStats(analyzeRuns(results, { turns, knownFields }), { resamples: 2000, seed: 9 });
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.pairs).toBe(6);
    expect(s.tasks).toBe(3);
    // output: C = 200 x 4 + 600 + 200 = 1600 ... D = 100 x 6 = 600
    expect(s.outputRatio.point).toBeCloseTo(600 / 1600, 12);
    expect(s.outputRatio.hi).toBeLessThan(1);
    expect(s.turnsRatio.point).toBeCloseTo(12 / 13, 12);
    expect(s.codeErrorsDiff.point).toBeCloseTo(-4 / 6, 12);
    expect(s.codeErrorsRatio.point).toBe(0);
    expect(s.successDiffPoints.point).toBeCloseTo((100 * 2) / 6, 12);
    expect(s.mcnemar).toEqual({ b: 0, c: 2, p: 0.5 });
    expect(s.withoutRefusals.pairs).toBe(5);
    expect(s.withoutRefusals.mcnemar).toEqual({ b: 0, c: 1, p: 1 });
    expect(s.withoutRefusals.successDiffPoints.point).toBeCloseTo(100 / 5, 12);
  });
  it("is deterministic: the same data and seed give the same report", () => {
    const { results, turns } = fixture();
    const a = renderReport(results, "2026-01-01T00:00:00Z", { turns, knownFields, resamples: 1000, seed: 11 });
    const b = renderReport([...results].reverse(), "2026-01-01T00:00:00Z", { turns, knownFields, resamples: 1000, seed: 11 });
    expect(a).toBe(b);
  });
});

describe("analyze: report", () => {
  const { results, turns } = fixture();
  const md = renderReport(results, "2026-01-01T00:00:00Z", { turns, knownFields, resamples: 1000 });
  it("says the pilot is directional only", () => {
    expect(md).toContain("**PILOT / PARTIAL DATA: DIRECTIONAL ONLY.**");
    expect(md).toContain("NOT checked here");
    expect(md).toContain("- **claude-cli: NOT CHECKED** (directional only)");
    expect(md).not.toMatch(/: (PASS|KILL|PARTIAL)\*\*/);
  });
  it("has success with and without refusals", () => {
    expect(md).toContain("| claude-cli | m | C | 6 | 4/6 (67%) | 1 | 4/5 (80%) |");
    expect(md).toContain("| claude-cli | m | D | 6 | 6/6 (100%) | 0 | 6/6 (100%) |");
  });
  it("has the paired table with CIs and McNemar", () => {
    expect(md).toMatch(/\| claude-cli \| m \| 6 \(3\) \| 0\.38 \[[\d.]+, [\d.]+\] \|/);
    expect(md).toContain("| 0 / 2, p 0.500 | 5, ");
  });
  it("has the exception kinds per arm", () => {
    expect(md).toContain("| wrong field, argument or tool name | 1 | 0.17 | 0 | 0.00 |");
    expect(md).toContain("| method or iteration on the wrong type (e.g. .map on a non-array) | 1 | 0.17 | 0 | 0.00 |");
    expect(md).toContain("| **all exceptions and timeouts** | 2 | 0.33 | 0 | 0.00 |");
    expect(md).toContain("| rewrites | 2 | 0.33 | 0 | 0.00 |");
    expect(md).toContain("| failed pagination runs whose code never paged (refusals excluded) | 1 | 0.17 | 0 | 0.00 |");
    expect(md).toContain("<summary>Exception messages by kind");
    expect(md).toContain("- 1x (C 1, D 0): `TypeError: r.map is not a function`");
  });
  it("lists the refused runs", () => {
    expect(md).toContain("- `C-m-nested-01-2` (1 turn(s), without running any code):");
  });
  it("has the per-task table and the disagreeing pairs", () => {
    expect(md).toContain("| claude-cli | m | page-01 | pagination | 1/2 | 2/2 | 2.0 | 0.0 | 3.0 | 2.0 | 400 | 100 |");
    expect(md).toContain("- claude-cli / m / nested-01 rep 2: C FAIL (refused)");
    expect(md).toContain("- claude-cli / m / page-01 rep 1: C FAIL, 4 turn(s), 4 code error(s) [wrong-field-name, wrong-type-method]");
    expect(md).not.toContain("- claude-cli / m / ctrl-01");
  });
  it("prints a short console summary", () => {
    const s = renderSummary(results, { turns, knownFields, resamples: 500 });
    expect(s).toContain("Directional only");
    expect(s).toContain("claude-cli m C: 6 runs, success 4/6 (67%), refused 1");
    expect(s).toContain("McNemar 0/2 p 0.500");
  });
});
