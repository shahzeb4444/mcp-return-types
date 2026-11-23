// The H1 verdict for the FULL run (BENCHMARK.md "Thresholds", as changed by Amendment 1, 2026-11-23).
// Pure functions over the paired statistics of each (backend, model); bench/analyze.ts renders the result.
//
// Amended criteria, per backend (D/C ratios and D-C differences, paired bootstrap 95% CI):
//   PRIMARY          some model has output-token ratio upper bound < 1.0, and no model has an upper bound
//                    > 1.05 on the output-token ratio or the turns ratio.
//   NON-INFERIORITY  every model: lower bound of success D-C >= -10 points (all pairs; the same without
//                    refused pairs is reported next to it, not gating).
//   PASS = PRIMARY and NON-INFERIORITY.
//   KILL = no model has output-token ratio upper bound < 1.0, or NON-INFERIORITY fails on any model.
//   PARTIAL = anything else.
// A CI that could not be computed (NaN) never counts in D's favour.
// The ORIGINAL criteria (before Amendment 1) are still evaluated, as a secondary, non-gating result.
import type { BootstrapCI } from "./stats.js";

export const FULL_TASKS = 20;
export const FULL_REPS = 5;
/** PRIMARY: D's output tokens must be lower: the upper CI bound of D/C strictly below this. */
export const PRIMARY_UPPER = 1.0;
/** PRIMARY guardrail: no model may have an upper CI bound above this on output tokens or turns. */
export const GUARDRAIL_UPPER = 1.05;
/** NON-INFERIORITY: lower CI bound of success D-C, in percentage points, at least this. */
export const NI_MARGIN_POINTS = -10;

export type Verdict = "PASS" | "KILL" | "PARTIAL" | "NOT CHECKED";

/** What the verdict reads for one (backend, model). `PairedStats` in bench/analyze.ts has this shape. */
export interface ModelEvidence {
  backend: string;
  model: string;
  pairs: number;
  tasks: number;
  /** Fewest complete C/D pairs any task has (full run: >= FULL_REPS). */
  minRepsPerTask: number;
  outputRatio: BootstrapCI;
  turnsRatio: BootstrapCI;
  successDiffPoints: BootstrapCI;
  codeErrorsDiff: BootstrapCI;
  codeErrorsRatio: BootstrapCI;
  totalTokensRatio: BootstrapCI;
  refusedC: number;
  refusedD: number;
  withoutRefusals: { pairs: number; successDiffPoints: BootstrapCI };
  cost: CostEvidence;
}

export type CostEvidence =
  | { available: true; ratio: BootstrapCI; meanC: number; meanD: number; cacheWriteKey: string }
  | { available: false; reason: string };

export interface ModelChecks {
  model: string;
  full: boolean;
  /** Output-token ratio upper bound < 1.0. */
  outputLower: boolean;
  /** Output-token ratio upper bound <= 1.05. */
  outputGuard: boolean;
  /** Turns ratio upper bound <= 1.05. */
  turnsGuard: boolean;
  /** Success D-C lower bound >= -10 points, all pairs (gating). */
  nonInferior: boolean;
  /** The same without refused pairs (reported, not gating). */
  nonInferiorWithoutRefusals: boolean;
  /** D's mean cache-weighted cost estimate above C's (point estimate); null when no estimate exists. */
  costHigher: boolean | null;
}

export interface OriginalChecks {
  verdict: Exclude<Verdict, "NOT CHECKED">;
  reasons: string[];
}

export interface BackendVerdict {
  backend: string;
  verdict: Verdict;
  full: boolean;
  models: ModelChecks[];
  /** Why this verdict, one line per criterion. */
  reasons: string[];
  /** What moved: every metric whose CI excludes "no change", per model. */
  moved: string[];
  /** Things the verdict must say regardless of PASS/KILL/PARTIAL (cost, refusals, missing estimates). */
  notes: string[];
  /** The pre-amendment criteria, secondary only; null when the data is not full. */
  original: OriginalChecks | null;
}

const fin = Number.isFinite;
const below = (x: number, limit: number): boolean => fin(x) && x < limit;
const atMost = (x: number, limit: number): boolean => fin(x) && x <= limit;
const atLeast = (x: number, limit: number): boolean => fin(x) && x >= limit;
const f2 = (n: number): string => (fin(n) ? n.toFixed(2) : "n/a");
const f1 = (n: number): string => (fin(n) ? n.toFixed(1) : "n/a");
export const ciText = (c: BootstrapCI, fmt: (n: number) => string = f2): string => `${fmt(c.point)} [${fmt(c.lo)}, ${fmt(c.hi)}]`;

export function isFull(e: Pick<ModelEvidence, "tasks" | "minRepsPerTask">): boolean {
  return e.tasks >= FULL_TASKS && e.minRepsPerTask >= FULL_REPS;
}

export function modelChecks(e: ModelEvidence): ModelChecks {
  return {
    model: e.model,
    full: isFull(e),
    outputLower: below(e.outputRatio.hi, PRIMARY_UPPER),
    outputGuard: atMost(e.outputRatio.hi, GUARDRAIL_UPPER),
    turnsGuard: atMost(e.turnsRatio.hi, GUARDRAIL_UPPER),
    nonInferior: atLeast(e.successDiffPoints.lo, NI_MARGIN_POINTS),
    nonInferiorWithoutRefusals: atLeast(e.withoutRefusals.successDiffPoints.lo, NI_MARGIN_POINTS),
    costHigher: e.cost.available ? (fin(e.cost.meanC) && fin(e.cost.meanD) ? e.cost.meanD > e.cost.meanC : null) : null,
  };
}

/** Metrics whose CI excludes "no change" (1 for ratios, 0 for differences), with direction. */
export function whatMoved(e: ModelEvidence): string[] {
  const out: string[] = [];
  const ratio = (name: string, c: BootstrapCI): void => {
    if (below(c.hi, 1)) out.push(`${e.model}: ${name} D/C ${ciText(c)}, D lower`);
    else if (fin(c.lo) && c.lo > 1) out.push(`${e.model}: ${name} D/C ${ciText(c)}, D higher`);
  };
  const diff = (name: string, c: BootstrapCI, fmt = f2): void => {
    if (below(c.hi, 0)) out.push(`${e.model}: ${name} D-C ${ciText(c, fmt)}, D lower`);
    else if (fin(c.lo) && c.lo > 0) out.push(`${e.model}: ${name} D-C ${ciText(c, fmt)}, D higher`);
  };
  ratio("output tokens/task", e.outputRatio);
  ratio("turns/task", e.turnsRatio);
  diff("success (points)", e.successDiffPoints, f1);
  diff("code errors/task", e.codeErrorsDiff);
  ratio("total tokens/task", e.totalTokensRatio);
  if (e.cost.available) ratio("cache-weighted cost ESTIMATE/task", e.cost.ratio);
  return out;
}

/**
 * The original H1 thresholds (BENCHMARK.md before Amendment 1), kept as a secondary result. Read as:
 * PASS = some model has >= 30% fewer code errors (D/C point <= 0.70) with the D-C CI below 0, AND the weak
 * model's success D-C point >= +5, AND every model's output and turns D/C upper bound <= 1.05.
 * KILL = no model has a significant code-error change (D-C CI excluding 0), OR some model's output or turns
 * D/C point > 1.10. PARTIAL otherwise.
 */
export function originalChecks(models: readonly ModelEvidence[], weakModel: string | undefined): OriginalChecks {
  const reasons: string[] = [];
  const significant = (e: ModelEvidence): boolean => below(e.codeErrorsDiff.hi, 0) || (fin(e.codeErrorsDiff.lo) && e.codeErrorsDiff.lo > 0);
  const fewerErrors = models.some((e) => atMost(e.codeErrorsRatio.point, 0.7) && below(e.codeErrorsDiff.hi, 0));
  reasons.push(`code errors >= 30% fewer and significant on some model: ${fewerErrors ? "yes" : "no"} (${models.map((e) => `${e.model} D/C ${ciText(e.codeErrorsRatio)}, D-C ${ciText(e.codeErrorsDiff)}`).join("; ")})`);
  const weak = models.find((e) => e.model === weakModel);
  const weakUp = weak !== undefined && atLeast(weak.successDiffPoints.point, 5);
  reasons.push(`weak model success D-C >= +5 points: ${weakUp ? "yes" : "no"} (${weak ? `${weak.model} ${ciText(weak.successDiffPoints, f1)}` : `weak model ${weakModel ?? "unknown"} not in the data`})`);
  const guard = models.every((e) => atMost(e.outputRatio.hi, GUARDRAIL_UPPER) && atMost(e.turnsRatio.hi, GUARDRAIL_UPPER));
  reasons.push(`output and turns D/C upper bound <= 1.05 on every model: ${guard ? "yes" : "no"}`);
  const noErrorSignal = !models.some(significant);
  const costly = models.some((e) => (fin(e.outputRatio.point) && e.outputRatio.point > 1.1) || (fin(e.turnsRatio.point) && e.turnsRatio.point > 1.1));
  const verdict = fewerErrors && weakUp && guard ? "PASS" : noErrorSignal || costly ? "KILL" : "PARTIAL";
  if (verdict === "KILL") reasons.push(`KILL because: ${[noErrorSignal ? "no significant code-error change on any model" : "", costly ? "a D/C point estimate of output or turns > 1.10" : ""].filter(Boolean).join(" and ")}`);
  return { verdict, reasons };
}

/** The amended verdict for one backend. Only full data is judged; anything less is NOT CHECKED. */
export function backendVerdict(backend: string, models: readonly ModelEvidence[], weakModel?: string): BackendVerdict {
  const checks = models.map(modelChecks);
  const base = { backend, models: checks, moved: models.flatMap(whatMoved) };
  if (models.length === 0) {
    return { ...base, verdict: "NOT CHECKED", full: false, reasons: ["no complete C/D pairs"], notes: [], original: null };
  }
  const notFull = models.filter((e) => !isFull(e));
  if (notFull.length > 0) {
    return {
      ...base,
      verdict: "NOT CHECKED",
      full: false,
      reasons: [
        `not a full run, so directional only: ${notFull.map((e) => `${e.model} has ${e.tasks} task(s), at least ${e.minRepsPerTask} paired rep(s) per task`).join("; ")} (full = ${FULL_TASKS} tasks x ${FULL_REPS} reps)`,
      ],
      notes: [],
      original: null,
    };
  }

  const reasons: string[] = [];
  const anyLower = checks.some((c) => c.outputLower);
  const guards = checks.every((c) => c.outputGuard && c.turnsGuard);
  const ni = checks.every((c) => c.nonInferior);
  const list = (f: (e: ModelEvidence) => string): string => models.map(f).join("; ");
  reasons.push(`PRIMARY output tokens/task D/C upper bound < ${PRIMARY_UPPER.toFixed(2)} on at least one model: ${anyLower ? "yes" : "no"} (${list((e) => `${e.model} ${ciText(e.outputRatio)}`)})`);
  reasons.push(`PRIMARY no model with an upper bound > ${GUARDRAIL_UPPER.toFixed(2)} on output tokens or turns: ${guards ? "yes" : "no"} (turns D/C: ${list((e) => `${e.model} ${ciText(e.turnsRatio)}`)})`);
  reasons.push(`NON-INFERIORITY success D-C lower bound >= ${NI_MARGIN_POINTS} points on every model (all pairs): ${ni ? "yes" : "no"} (${list((e) => `${e.model} ${ciText(e.successDiffPoints, f1)}`)})`);

  let verdict: Verdict;
  if (!anyLower || !ni) {
    verdict = "KILL";
    reasons.push(`KILL because: ${[!anyLower ? "the output-token D/C CI contains or exceeds 1.0 for every model" : "", !ni ? "success non-inferiority fails" : ""].filter(Boolean).join(" and ")}`);
  } else verdict = guards ? "PASS" : "PARTIAL";

  const notes: string[] = [];
  for (const e of models) {
    const c = checks.find((x) => x.model === e.model) as ModelChecks;
    notes.push(
      `${e.model}: refused runs C ${e.refusedC}, D ${e.refusedD}; success D-C without refused pairs (${e.withoutRefusals.pairs} pairs) ${ciText(e.withoutRefusals.successDiffPoints, f1)}${c.nonInferiorWithoutRefusals === c.nonInferior ? "" : `, so non-inferiority ${c.nonInferiorWithoutRefusals ? "would hold" : "would fail"} without them (not gating)`}`,
    );
    if (e.cost.available) {
      if (c.costHigher) notes.push(`${e.model}: D's cache-weighted cost ESTIMATE is HIGHER than C's (${e.cost.meanD.toFixed(5)} vs ${e.cost.meanC.toFixed(5)} USD/task, D/C ${ciText(e.cost.ratio)}; estimate from bench/prices.json)`);
    } else notes.push(`${e.model}: no cache-weighted cost estimate (${e.cost.reason}), so it is unknown whether D costs more than C`);
  }
  return { ...base, verdict, full: true, reasons, notes, original: originalChecks(models, weakModel) };
}

// ---------------------------------------------------------------------------------------------------------
// Amendment 2 (BENCHMARK.md, 2026-11-23), written AFTER the full-run results were seen:
// a model whose arm-C (baseline) refusal rate is above 25% is excluded from the backend verdict as
// harness-incompatible. Its own numbers and its own verdict are still computed and reported, and the
// backend verdict without the exclusion is reported next to the amended one. The rule applies to full-run
// data only, so pilot or partial data stays "directional only" exactly as before.

/** A model whose arm-C refusal rate is strictly above this fraction is excluded (25% itself is kept). */
export const EXCLUDE_REFUSAL_RATE_C = 0.25;

export interface Exclusion {
  excluded: boolean;
  /** Refused arm-C runs / paired arm-C runs (NaN without pairs). */
  refusalRateC: number;
  reason: string | null;
}

const pctText = (x: number): string => (fin(x) ? `${(100 * x).toFixed(0)}%` : "n/a");

export function exclusionOf(e: Pick<ModelEvidence, "pairs" | "refusedC" | "tasks" | "minRepsPerTask">): Exclusion {
  const rate = e.pairs > 0 ? e.refusedC / e.pairs : NaN;
  const excluded = isFull(e) && fin(rate) && rate > EXCLUDE_REFUSAL_RATE_C;
  return {
    excluded,
    refusalRateC: rate,
    reason: excluded
      ? `harness-incompatible (Amendment 2, rule written after the full run): arm-C refusal rate ${pctText(rate)} (${e.refusedC}/${e.pairs}) > ${pctText(EXCLUDE_REFUSAL_RATE_C)}`
      : null,
  };
}

/** One model judged on its own (the same thresholds, applied to a one-model backend). */
export interface ModelVerdict extends Exclusion {
  backend: string;
  model: string;
  verdict: Verdict;
  detail: BackendVerdict;
}

/** The backend verdict after Amendment 2. Its BackendVerdict fields judge the non-excluded models only. */
export interface AmendedBackendVerdict extends BackendVerdict {
  /** The same backend judged on every model, without the exclusion (kept on record). */
  unexcluded: BackendVerdict;
  perModel: ModelVerdict[];
  excluded: ModelVerdict[];
}

export function amendedBackendVerdict(backend: string, models: readonly ModelEvidence[], weakModel?: string): AmendedBackendVerdict {
  const unexcluded = backendVerdict(backend, models, weakModel);
  const perModel: ModelVerdict[] = models.map((e) => {
    const detail = backendVerdict(backend, [e], weakModel);
    return { backend, model: e.model, verdict: detail.verdict, detail, ...exclusionOf(e) };
  });
  const excluded = perModel.filter((m) => m.excluded);
  const extra = { unexcluded, perModel, excluded };
  if (excluded.length === 0) return { ...unexcluded, ...extra };
  const why = `excluded from this verdict (Amendment 2): ${excluded.map((m) => `${m.model}, ${m.reason ?? ""}`).join("; ")}`;
  const kept = models.filter((e) => !excluded.some((m) => m.model === e.model));
  if (kept.length === 0) {
    return { ...unexcluded, ...extra, verdict: "NOT CHECKED", models: [], moved: [], notes: [], original: null, reasons: [why, "every model of the backend is excluded, so no backend verdict is computed"] };
  }
  const v = backendVerdict(backend, kept, weakModel);
  return { ...v, ...extra, reasons: [why, ...v.reasons] };
}
