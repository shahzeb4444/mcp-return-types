// The plain-MCP verdict rules, exactly as pre-registered in BENCHMARK.md Amendment 3 (per backend, S vs P).
// Pure functions; the thresholds are the constants below. Order: KILL, PASS, INCONCLUSIVE, PARTIAL.
import type { BootstrapCI } from "../analysis/stats.js";

export const PLAIN_TASKS = 6;
export const PLAIN_REPS = 2;
export const PLAIN_PAIRS = PLAIN_TASKS * PLAIN_REPS;
/** PASS needs the upper bound of the output-token ratio below this. */
export const OUTPUT_UPPER = 1.0;
/** PASS needs the upper bound of the turns ratio at or below this. */
export const TURNS_UPPER = 1.05;
/** Success non-inferiority: the lower bound of S-P (points) must be at least this. */
export const NI_MARGIN = -10;

export type PlainVerdict = "PASS" | "KILL" | "INCONCLUSIVE" | "PARTIAL" | "NOT CHECKED";

export interface PlainEvidence {
  pairs: number;
  tasks: number;
  minRepsPerTask: number;
  outputRatio: BootstrapCI;
  turnsRatio: BootstrapCI;
  successDiffPoints: BootstrapCI;
}

export interface PlainVerdictResult {
  verdict: PlainVerdict;
  /** One line per check, with the numbers. */
  checks: string[];
}

const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
const ci = (c: BootstrapCI, f = f2): string => `${f(c.point)} [${f(c.lo)}, ${f(c.hi)}]`;

/** Complete data = all 6 tasks with both reps paired (12 pairs). */
export const isComplete = (e: Pick<PlainEvidence, "tasks" | "minRepsPerTask">): boolean => e.tasks >= PLAIN_TASKS && e.minRepsPerTask >= PLAIN_REPS;

export function plainVerdict(e: PlainEvidence): PlainVerdictResult {
  const o = e.outputRatio;
  const t = e.turnsRatio;
  const s = e.successDiffPoints;
  // A CI that cannot be computed never counts for S: NaN comparisons are false, so it cannot pass a check.
  const niHolds = s.lo >= NI_MARGIN;
  const outputAbove = o.lo > OUTPUT_UPPER;
  const outputBelow = o.hi < OUTPUT_UPPER;
  const turnsOk = t.hi <= TURNS_UPPER;
  const containsOne = o.lo <= OUTPUT_UPPER && OUTPUT_UPPER <= o.hi;
  const checks = [
    `output tokens S/P ${ci(o)}: ${outputBelow ? "upper bound < 1.0" : outputAbove ? "entirely above 1.0" : containsOne ? "contains 1.0" : "not computable"}`,
    `turns S/P ${ci(t)}: upper bound ${turnsOk ? "<=" : "not <="} ${TURNS_UPPER}`,
    `success S-P ${ci(s, f1)} points: non-inferiority ${niHolds ? "holds" : "FAILS"} (lower bound ${niHolds ? ">=" : "<"} ${NI_MARGIN})`,
  ];
  if (!isComplete(e)) {
    return { verdict: "NOT CHECKED", checks: [`incomplete data: ${e.pairs} pair(s) over ${e.tasks} task(s), fewest reps per task ${e.minRepsPerTask}; the verdict needs ${PLAIN_TASKS} tasks x ${PLAIN_REPS} reps (directional only)`, ...checks] };
  }
  if (outputAbove || !niHolds) return { verdict: "KILL", checks };
  if (outputBelow && turnsOk && niHolds) return { verdict: "PASS", checks };
  if (containsOne) return { verdict: "INCONCLUSIVE", checks: [...checks, `with ${e.pairs} pairs per backend this outcome was expected to be likely (Amendment 3); it is not a failure of the tool`] };
  return { verdict: "PARTIAL", checks };
}
