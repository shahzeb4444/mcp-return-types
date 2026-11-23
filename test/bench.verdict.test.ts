import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRuns, pairedStats, renderReport, renderSummary, verdicts, type RunResult } from "../bench/analyze.js";
import { costOf, loadPrices, pricingFor } from "../bench/analysis/cost.js";
import type { BootstrapCI } from "../bench/analysis/stats.js";
import { amendedBackendVerdict, backendVerdict, EXCLUDE_REFUSAL_RATE_C, exclusionOf, isFull, modelChecks, originalChecks, whatMoved, type ModelEvidence } from "../bench/analysis/verdict.js";

const ci = (point: number, lo: number, hi: number): BootstrapCI => ({ point, lo, hi, resamples: 1000, undefinedResamples: 0, tasks: 20, pairs: 100 });

/** A full-run model where D is cheaper in output, turns flat, success equal, no code errors. */
const ev = (o: Partial<ModelEvidence> = {}): ModelEvidence => ({
  backend: "claude-cli",
  model: "m-strong",
  pairs: 100,
  tasks: 20,
  minRepsPerTask: 5,
  outputRatio: ci(0.6, 0.5, 0.8),
  turnsRatio: ci(0.95, 0.9, 1.0),
  successDiffPoints: ci(0, -3, 3),
  codeErrorsDiff: ci(0, 0, 0),
  codeErrorsRatio: ci(NaN, NaN, NaN),
  totalTokensRatio: ci(1.0, 0.9, 1.1),
  refusedC: 0,
  refusedD: 0,
  withoutRefusals: { pairs: 100, successDiffPoints: ci(0, -3, 3) },
  cost: { available: false, reason: "no prices for m-strong in bench/prices.json" },
  ...o,
});

describe("verdict: full-run gate", () => {
  it("needs 20 tasks and 5 paired reps per task", () => {
    expect(isFull({ tasks: 20, minRepsPerTask: 5 })).toBe(true);
    expect(isFull({ tasks: 19, minRepsPerTask: 5 })).toBe(false);
    expect(isFull({ tasks: 20, minRepsPerTask: 4 })).toBe(false);
  });
  it("pilot-sized data is NOT CHECKED (directional only), whatever the numbers", () => {
    const v = backendVerdict("claude-cli", [ev({ tasks: 12, minRepsPerTask: 2 })]);
    expect(v.verdict).toBe("NOT CHECKED");
    expect(v.full).toBe(false);
    expect(v.reasons[0]).toContain("directional only");
    expect(v.original).toBeNull();
  });
  it("one non-full model makes the whole backend NOT CHECKED", () => {
    expect(backendVerdict("b", [ev(), ev({ model: "m-weak", minRepsPerTask: 3 })]).verdict).toBe("NOT CHECKED");
  });
  it("no pairs is NOT CHECKED", () => {
    expect(backendVerdict("b", []).verdict).toBe("NOT CHECKED");
  });
});

describe("verdict: PRIMARY", () => {
  it("PASS: output upper bound < 1.0 on one model, all guardrails <= 1.05, non-inferior", () => {
    const v = backendVerdict("b", [ev(), ev({ model: "m-weak", outputRatio: ci(0.9, 0.8, 1.04), turnsRatio: ci(1.0, 0.95, 1.05) })]);
    expect(v.verdict).toBe("PASS");
    expect(v.reasons.join("\n")).toContain("on at least one model: yes");
  });
  it("an output upper bound of exactly 1.0 does not count as lower (strict <)", () => {
    expect(modelChecks(ev({ outputRatio: ci(0.8, 0.6, 1.0) })).outputLower).toBe(false);
    expect(backendVerdict("b", [ev({ outputRatio: ci(0.8, 0.6, 1.0) })]).verdict).toBe("KILL");
  });
  it("PARTIAL: output improves on one model but another model's turns upper bound is above 1.05", () => {
    const v = backendVerdict("b", [ev(), ev({ model: "m-weak", outputRatio: ci(1.0, 0.9, 1.05), turnsRatio: ci(1.02, 0.97, 1.06) })]);
    expect(v.verdict).toBe("PARTIAL");
    expect(v.reasons.join("\n")).toContain("> 1.05 on output tokens or turns: no");
  });
  it("PARTIAL: output upper bound above 1.05 on a model that does not improve", () => {
    expect(backendVerdict("b", [ev(), ev({ model: "m-weak", outputRatio: ci(1.0, 0.9, 1.2) })]).verdict).toBe("PARTIAL");
  });
  it("KILL: the output-token CI contains or exceeds 1.0 for every model", () => {
    const v = backendVerdict("b", [ev({ outputRatio: ci(0.9, 0.7, 1.1) }), ev({ model: "m-weak", outputRatio: ci(1.2, 1.05, 1.4) })]);
    expect(v.verdict).toBe("KILL");
    expect(v.reasons.at(-1)).toContain("contains or exceeds 1.0 for every model");
  });
  it("an undefined CI never counts in D's favour", () => {
    const c = modelChecks(ev({ outputRatio: ci(NaN, NaN, NaN), turnsRatio: ci(NaN, NaN, NaN), successDiffPoints: ci(NaN, NaN, NaN) }));
    expect(c).toMatchObject({ outputLower: false, outputGuard: false, turnsGuard: false, nonInferior: false });
  });
});

describe("verdict: NON-INFERIORITY and refusals", () => {
  it("KILL when the success D-C lower bound is below -10 points on any model, even if output improves", () => {
    const v = backendVerdict("b", [ev(), ev({ model: "m-weak", successDiffPoints: ci(-4, -12, 4) })]);
    expect(v.verdict).toBe("KILL");
    expect(v.reasons.at(-1)).toContain("success non-inferiority fails");
  });
  it("a lower bound of exactly -10 points is non-inferior", () => {
    expect(backendVerdict("b", [ev({ successDiffPoints: ci(0, -10, 8) })]).verdict).toBe("PASS");
  });
  it("gates on all pairs and reports the without-refusals result separately (not gating)", () => {
    const v = backendVerdict("b", [ev({ refusedC: 2, refusedD: 9, successDiffPoints: ci(-5, -15, 2), withoutRefusals: { pairs: 89, successDiffPoints: ci(0, -4, 4) } })]);
    expect(v.verdict).toBe("KILL");
    expect(v.models[0]?.nonInferiorWithoutRefusals).toBe(true);
    expect(v.notes.join("\n")).toContain("refused runs C 2, D 9");
    expect(v.notes.join("\n")).toContain("non-inferiority would hold without them (not gating)");
  });
});

describe("verdict: SECONDARY (cost, what moved, original criteria)", () => {
  it("says so when D's cache-weighted cost estimate is higher than C's, even on PASS", () => {
    const v = backendVerdict("b", [ev({ cost: { available: true, ratio: ci(1.3, 1.1, 1.5), meanC: 0.01, meanD: 0.013, cacheWriteKey: "cache_write_5m" } })]);
    expect(v.verdict).toBe("PASS");
    expect(v.notes.join("\n")).toContain("D's cache-weighted cost ESTIMATE is HIGHER than C's");
  });
  it("says so when there is no cost estimate", () => {
    expect(backendVerdict("b", [ev()]).notes.join("\n")).toContain("no cache-weighted cost estimate (no prices for m-strong");
  });
  it("lists every metric whose CI excludes no change, with direction", () => {
    const moved = whatMoved(ev({ totalTokensRatio: ci(1.3, 1.1, 1.5), codeErrorsDiff: ci(-0.2, -0.4, -0.05) }));
    expect(moved).toEqual([
      "m-strong: output tokens/task D/C 0.60 [0.50, 0.80], D lower",
      "m-strong: code errors/task D-C -0.20 [-0.40, -0.05], D lower",
      "m-strong: total tokens/task D/C 1.30 [1.10, 1.50], D higher",
    ]);
  });
  it("keeps the original criteria as a secondary result: zero code errors means the old KILL", () => {
    const o = originalChecks([ev(), ev({ model: "m-weak" })], "m-weak");
    expect(o.verdict).toBe("KILL");
    expect(o.reasons.at(-1)).toContain("no significant code-error change on any model");
    const v = backendVerdict("b", [ev()], "m-strong");
    expect(v.verdict).toBe("PASS");
    expect(v.original?.verdict).toBe("KILL");
  });
  it("original criteria PASS when code errors drop >= 30% significantly and the weak model gains >= 5 points", () => {
    const good = ev({ model: "m-weak", codeErrorsRatio: ci(0.5, 0.3, 0.8), codeErrorsDiff: ci(-0.3, -0.5, -0.1), successDiffPoints: ci(6, 1, 11) });
    expect(originalChecks([good], "m-weak").verdict).toBe("PASS");
    expect(originalChecks([good], "other").verdict).toBe("PARTIAL");
  });
});

describe("cost estimate", () => {
  it("uses the cost formula with cache_write_1h when given, else cache_write_5m", () => {
    const table = { _note: "x", a: { input: 1, cache_write_5m: 2, cache_read: 0.5, output: 10 }, b: { input: 1, cache_write_1h: 4, cache_write_5m: 2, cache_read: 0.5, output: 10 } };
    const a = pricingFor(table, "a");
    const b = pricingFor(table, "b");
    expect(a).toMatchObject({ ok: true, write: 2, cacheWriteKey: "cache_write_5m" });
    expect(b).toMatchObject({ ok: true, write: 4, cacheWriteKey: "cache_write_1h" });
    if (!a.ok) return;
    const u = { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, output_tokens: 100_000 };
    expect(costOf(u, a)).toBeCloseTo(1 + 2 + 1 + 1, 12);
  });
  it("gives no estimate when a price is null or the model is missing (never a guess)", () => {
    const table = { m: { input: 1, cache_write_5m: 2, cache_read: 0.5, output: null }, s: "not an object" };
    expect(pricingFor(table, "m")).toEqual({ ok: false, reason: "price(s) output missing or null for m in bench/prices.json" });
    expect(pricingFor(table, "s").ok).toBe(false);
    expect(pricingFor(table, "x").ok).toBe(false);
    expect(pricingFor(null, "m")).toEqual({ ok: false, reason: "no bench/prices.json" });
  });
  it("loads the price table and returns null for a missing or broken file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prices-"));
    try {
      writeFileSync(path.join(dir, "p.json"), JSON.stringify({ m: { input: 1 } }));
      writeFileSync(path.join(dir, "bad.json"), "{");
      expect(loadPrices(path.join(dir, "p.json"))).toEqual({ m: { input: 1 } });
      expect(loadPrices(path.join(dir, "bad.json"))).toBeNull();
      expect(loadPrices(path.join(dir, "none.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A synthetic full run on one backend: 20 tasks x 5 reps x arms C, D for one model. */
function fullRun(model: string, d: (task: number, rep: number) => Partial<RunResult>, backend = "claude-cli"): RunResult[] {
  const rs: RunResult[] = [];
  for (let t = 1; t <= 20; t++) {
    for (let rep = 1; rep <= 5; rep++) {
      const base = { status: "done", backend, model, task: `t${String(t).padStart(2, "0")}`, category: "nested", rep, toolCalls: 2, codeErrors: 0, endedBy: "final", final: "1", modelLatencyMs: 1000 };
      rs.push({ ...base, id: `C-${model}-${t}-${rep}`, arm: "C", pass: true, turns: 3, usage: { input_tokens: 10, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 0, output_tokens: 1000 + 10 * t } });
      rs.push({ ...base, id: `D-${model}-${t}-${rep}`, arm: "D", pass: true, turns: 3, usage: { input_tokens: 10, cache_creation_input_tokens: 16_000, cache_read_input_tokens: 0, output_tokens: 600 + 10 * t }, ...d(t, rep) });
    }
  }
  return rs;
}

describe("analyze: full-run verdict in the report", () => {
  const prices = { "m-a": { input: 1, cache_write_5m: 1.25, cache_read: 0.1, output: 5 } };
  const results = fullRun("m-a", () => ({}));
  const opts = { resamples: 500, seed: 3, prices };

  it("computes PASS and says D's cost estimate is higher (D writes more cache)", () => {
    const stats = pairedStats(analyzeRuns(results), opts);
    expect(stats[0]).toMatchObject({ tasks: 20, minRepsPerTask: 5, refusedC: 0, refusedD: 0 });
    expect(stats[0]?.cost.available).toBe(true);
    const [v] = verdicts(stats);
    expect(v?.verdict).toBe("PASS");
    expect(v?.original?.verdict).toBe("KILL");
    const md = renderReport(results, "2026-01-01T00:00:00Z", opts);
    expect(md).toContain("**FULL-RUN DATA.**");
    expect(md).not.toContain("DIRECTIONAL ONLY");
    expect(md).toContain("- **claude-cli: PASS**");
    expect(md).toContain("D's cache-weighted cost ESTIMATE is HIGHER than C's");
    expect(md).toContain("Original H1 criteria (before Amendment 1; SECONDARY, not gating): KILL");
    expect(md).toContain("changed AFTER the pilot data was seen");
    expect(md).toMatch(/\| claude-cli \| m-a \| 1\.50 \[[\d.]+, [\d.]+\] \| [\d.]+ \[[\d.]+, [\d.]+\] \(cache write at cache_write_5m\) \|/);
    const s = renderSummary(results, opts);
    expect(s).toContain("VERDICT claude-cli: PASS (D's cost ESTIMATE is higher than C's on some model)");
  });

  it("computes KILL when D fails 4 of 20 tasks in every rep (success lower bound below -10 points)", () => {
    const rs = fullRun("m-a", (t) => (t <= 4 ? { pass: false, final: "I can't retrieve the issues because the tool isn't available" } : {}));
    const [v] = verdicts(pairedStats(analyzeRuns(rs), opts));
    expect(v?.verdict).toBe("KILL");
    expect(v?.notes.join("\n")).toContain("refused runs C 0, D 20");
  });

  it("marks only the full backends in a mixed report", () => {
    const pilotish = fullRun("g", () => ({}), "codex-cli").filter((r) => r.rep <= 2);
    const md = renderReport([...results, ...pilotish], "2026-01-01T00:00:00Z", opts);
    expect(md).toContain("**FULL-RUN DATA FOR claude-cli ONLY.**");
    expect(md).toContain("- **codex-cli: NOT CHECKED** (directional only)");
  });
});

describe("verdict: Amendment 2 exclusion (arm-C refusal rate > 25%)", () => {
  /** A Luna-like model: many refusals in C, more in D, non-inferiority fails. */
  const luna = (o: Partial<ModelEvidence> = {}): ModelEvidence =>
    ev({ backend: "codex-cli", model: "m-luna", refusedC: 31, refusedD: 50, successDiffPoints: ci(-25, -33, -17), outputRatio: ci(0.91, 0.77, 1.06), ...o });
  const sol = ev({ backend: "codex-cli", model: "m-sol" });
  const full = { tasks: 20, minRepsPerTask: 5 };

  it("the threshold is 25%", () => {
    expect(EXCLUDE_REFUSAL_RATE_C).toBe(0.25);
  });
  it("boundary: exactly 25% is kept, anything above is excluded (strict >)", () => {
    expect(exclusionOf({ ...full, pairs: 100, refusedC: 24 }).excluded).toBe(false);
    expect(exclusionOf({ ...full, pairs: 100, refusedC: 25 }).excluded).toBe(false);
    expect(exclusionOf({ ...full, pairs: 100, refusedC: 26 }).excluded).toBe(true);
    expect(exclusionOf({ tasks: 20, minRepsPerTask: 6, pairs: 120, refusedC: 30 }).excluded).toBe(false); // 25.0%
    expect(exclusionOf({ tasks: 20, minRepsPerTask: 6, pairs: 120, refusedC: 31 }).excluded).toBe(true); // 25.8%
  });
  it("the rate is refused arm-C runs over paired runs, and the reason says the rule came after the full run", () => {
    const x = exclusionOf({ ...full, pairs: 100, refusedC: 31 });
    expect(x.refusalRateC).toBeCloseTo(0.31);
    expect(x.reason).toContain("31% (31/100) > 25%");
    expect(x.reason).toContain("written after the full run");
    expect(exclusionOf({ ...full, pairs: 100, refusedC: 25 }).reason).toBeNull();
  });
  it("arm-D refusals alone never exclude a model (the rule reads the baseline only)", () => {
    expect(amendedBackendVerdict("b", [ev({ refusedC: 0, refusedD: 90 })]).excluded).toHaveLength(0);
  });
  it("no pairs: rate n/a, not excluded", () => {
    const x = exclusionOf({ pairs: 0, refusedC: 0, tasks: 0, minRepsPerTask: 0 });
    expect(Number.isNaN(x.refusalRateC)).toBe(true);
    expect(x.excluded).toBe(false);
  });
  it("pilot-sized data is never excluded and stays NOT CHECKED (directional only)", () => {
    const pilot = { tasks: 12, minRepsPerTask: 2, pairs: 24 };
    const v = amendedBackendVerdict("codex-cli", [luna({ ...pilot, refusedC: 20 }), ev({ ...pilot, model: "m-sol" })]);
    expect(v.excluded).toHaveLength(0);
    expect(v.verdict).toBe("NOT CHECKED");
    expect(v.unexcluded.verdict).toBe("NOT CHECKED");
    expect(v.reasons[0]).toContain("directional only");
    expect(v.perModel.every((m) => m.verdict === "NOT CHECKED" && !m.excluded)).toBe(true);
  });
  it("without an exclusion the amended verdict equals the Amendment 1 verdict", () => {
    const ms = [ev(), ev({ model: "m-weak", refusedC: 25 })];
    const { unexcluded, perModel, excluded, ...rest } = amendedBackendVerdict("b", ms);
    expect(excluded).toHaveLength(0);
    expect(rest).toEqual(backendVerdict("b", ms));
    expect(unexcluded).toEqual(backendVerdict("b", ms));
    expect(perModel.map((m) => m.verdict)).toEqual(["PASS", "PASS"]);
  });
  it("judges the backend on the non-excluded models only, and keeps the unexcluded KILL on record", () => {
    const v = amendedBackendVerdict("codex-cli", [luna(), sol], "m-luna");
    expect(v.verdict).toBe("PASS");
    expect(v.unexcluded.verdict).toBe("KILL");
    expect(v.models.map((m) => m.model)).toEqual(["m-sol"]);
    expect(v.reasons[0]).toContain("excluded from this verdict (Amendment 2): m-luna");
    expect(v.excluded.map((m) => m.model)).toEqual(["m-luna"]);
  });
  it("gives every model its own verdict from its own numbers, excluded ones included", () => {
    const v = amendedBackendVerdict("codex-cli", [luna(), sol]);
    const byModel = new Map(v.perModel.map((m) => [m.model, m]));
    expect(byModel.get("m-luna")?.verdict).toBe("KILL");
    expect(byModel.get("m-luna")?.excluded).toBe(true);
    expect(byModel.get("m-luna")?.detail.notes.join("\n")).toContain("refused runs C 31, D 50");
    expect(byModel.get("m-sol")?.verdict).toBe("PASS");
    expect(byModel.get("m-sol")?.excluded).toBe(false);
  });
  it("excluding a model does not help when the remaining models fail on their own", () => {
    const badSol = ev({ backend: "codex-cli", model: "m-sol", outputRatio: ci(1.0, 0.9, 1.1) });
    const v = amendedBackendVerdict("codex-cli", [luna(), badSol]);
    expect(v.verdict).toBe("KILL");
    expect(v.unexcluded.verdict).toBe("KILL");
  });
  it("every model excluded: NOT CHECKED, with the unexcluded verdict still given", () => {
    const v = amendedBackendVerdict("codex-cli", [luna()]);
    expect(v.verdict).toBe("NOT CHECKED");
    expect(v.unexcluded.verdict).toBe("KILL");
    expect(v.reasons.join("\n")).toContain("every model of the backend is excluded");
    expect(v.original).toBeNull();
  });
});

describe("analyze: Amendment 2 in the report and the console summary", () => {
  const refusal = "I can't retrieve the issues because the tool isn't available";
  // m-luna: arm C refuses tasks 1-6 (30/100 runs, 30%), arm D refuses tasks 1-10 (50/100): KILL on its own.
  const taskNo = (r: RunResult): number => Number(r.task.slice(1));
  const lunaRuns = fullRun("m-luna", (t) => (t <= 10 ? { pass: false, final: refusal } : {}), "codex-cli").map((r) =>
    r.arm === "C" && taskNo(r) <= 6 ? { ...r, pass: false, final: refusal } : r,
  );
  const results = [...fullRun("m-sol", () => ({}), "codex-cli"), ...lunaRuns];
  const opts = { resamples: 500, seed: 3 };

  it("computes the exclusion from the run files", () => {
    const stats = pairedStats(analyzeRuns(results), opts);
    expect(stats.find((s) => s.model === "m-luna")).toMatchObject({ refusedC: 30, refusedD: 50, pairs: 100 });
    const [v] = verdicts(stats);
    expect(v?.verdict).toBe("PASS");
    expect(v?.unexcluded.verdict).toBe("KILL");
    expect(v?.excluded.map((m) => m.model)).toEqual(["m-luna"]);
  });
  it("prints both verdicts on one line, per-model verdicts, and the excluded model's own numbers", () => {
    const s = renderSummary(results, opts);
    expect(s).toContain("VERDICT codex-cli: PASS (excluded: m-luna, arm-C refusal rate 30% > 25%) | without exclusions: KILL");
    expect(s).toContain("model m-luna: KILL (EXCLUDED: harness-incompatible");
    expect(s).toContain("model m-sol: PASS");
    const md = renderReport(results, "2026-01-01T00:00:00Z", opts);
    expect(md).toContain("## Verdict (amended H1, BENCHMARK.md Amendments 1 and 2)");
    expect(md).toContain("- **codex-cli: PASS** (excluded: m-luna); without exclusions: KILL");
    expect(md).toContain("- codex-cli / m-luna: **KILL**, EXCLUDED from the backend verdict");
    expect(md).toContain("#### Excluded: m-luna (own verdict KILL, on record)");
    expect(md).toContain("m-luna: refused runs C 30, D 50");
    expect(md).toContain("#### codex-cli without the exclusion (Amendment 1 only, on record): KILL");
  });
  it("prints 'without exclusions' even when nothing is excluded", () => {
    expect(renderSummary(fullRun("m-a", () => ({})), opts)).toContain("VERDICT claude-cli: PASS | without exclusions: PASS");
  });
  it("the pilot stays directional only: no verdict line, no exclusion", () => {
    const pilot = results.filter((r) => r.rep <= 2);
    const s = renderSummary(pilot, opts);
    expect(s).toContain("Directional only");
    expect(s).not.toContain("VERDICT");
    expect(renderReport(pilot, "2026-01-01T00:00:00Z", opts)).toContain("- **codex-cli: NOT CHECKED** (directional only); without exclusions: NOT CHECKED");
  });
});
