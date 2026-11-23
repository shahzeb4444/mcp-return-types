// Reads the finished per-run result files (<raw>/*.json, plus their <id>.jsonl turn logs) and writes a report.
//
//   npm run bench:analyze [-- --raw <dir> --out <file>]
//   node --import tsx bench/analyze.ts --raw bench/results/pilot --out bench/results/REPORT.md   (PowerShell-safe)
//
// Per backend, model and arm: success (with and without refusals), code errors, turns, output and total
// tokens per task, the sandbox exceptions by kind, refusals, and failed pagination runs that never paged.
// Paired by (task, rep) between arms C and D: bootstrap 95% CIs (10,000 resamples over tasks, fixed seed)
// for the D/C ratios of output tokens and turns per task and the D-C difference in code errors per task,
// and the exact McNemar test on paired pass/fail (BENCHMARK.md "Analysis").
// Verdict (BENCHMARK.md thresholds as changed by Amendment 1): computed per backend ONLY when every model of
// that backend has full-run data (20 tasks x 5 paired reps); pilot or partial data stays "directional only".
// Amendment 2 (written AFTER the full run): a model whose arm-C refusal rate is above 25% is excluded from
// its backend's verdict; every model also gets its own verdict, and the unexcluded backend verdict is printed
// next to the amended one, so nothing is hidden. Rules: bench/analysis/verdict.ts. Cost is a labelled estimate from bench/prices.json (bench/analysis/cost.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { classifyException, codePaginates, ERROR_CATEGORIES, isRefusal, knownFieldsFromSchemas, type ErrorCategory } from "./analysis/classify.js";
import { costOf, loadPrices, pricingFor, type PriceTable } from "./analysis/cost.js";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, clusterBootstrap, mcnemarExact, type BootstrapCI, type McNemar } from "./analysis/stats.js";
import { amendedBackendVerdict, EXCLUDE_REFUSAL_RATE_C, FULL_REPS, FULL_TASKS, GUARDRAIL_UPPER, NI_MARGIN_POINTS, PRIMARY_UPPER, type AmendedBackendVerdict, type BackendVerdict, type CostEvidence } from "./analysis/verdict.js";
import { WEAK_MODEL } from "./harness/config.js";
import { parseEnvelope, parseReply } from "./harness/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARM_D_SCHEMAS = path.join(HERE, "arm-d", "mock-github.json");
const PRICES = path.join(HERE, "prices.json");

export interface RunResult {
  id: string;
  status: string;
  backend: string;
  arm: string;
  model: string;
  task: string;
  category?: string;
  rep: number;
  pass: boolean;
  turns: number;
  toolCalls: number;
  codeErrors: number;
  sandboxRuns?: number;
  exceptions?: number;
  timeouts?: number;
  rewrites?: number;
  duplicateWrites?: number;
  endedBy?: string;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
  modelLatencyMs?: number;
  final?: string | null;
}

/** The parts of a `.jsonl` turn line the analysis reads. */
export interface TurnLine {
  type: "turn";
  turn: number;
  reply_kind?: string;
  sandbox_status?: "ok" | "exception" | "timeout";
  sandbox_exception?: string;
  reply?: string;
}

export function loadResults(dir: string): RunResult[] {
  const out: RunResult[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const r = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RunResult;
    if (r.status === "done") out.push(r);
  }
  return out;
}

/** Turn lines per run id, from `<dir>/<id>.jsonl` (missing files are left out). */
export function loadTurns(dir: string, ids: readonly string[]): Map<string, TurnLine[]> {
  const out = new Map<string, TurnLine[]>();
  for (const id of ids) {
    const file = path.join(dir, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    const lines: TurnLine[] = [];
    for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (l.trim() === "") continue;
      try {
        const v = JSON.parse(l) as { type?: string };
        if (v.type === "turn") lines.push(v as TurnLine);
      } catch {
        // a torn last line of an unfinished run; finished runs only reach here with whole lines
      }
    }
    out.set(id, lines);
  }
  return out;
}

/** Field names in the arm D result types (used to spot wrong field names); empty if the file is missing. */
export function loadKnownFields(file = ARM_D_SCHEMAS): Set<string> {
  try {
    return knownFieldsFromSchemas(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return new Set();
  }
}

/** The code of a logged reply: a fenced block (Claude) or a JSON envelope (Codex). */
export function codeOf(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  for (const r of [parseReply(reply), parseEnvelope(reply)]) if (r.kind === "code") return r.code;
  return undefined;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
const f0 = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a");
const pct = (a: number, b: number): string => (b > 0 ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "n/a");
const out = (r: RunResult): number => r.usage?.output_tokens ?? 0;
const totalTokens = (r: RunResult): number =>
  (r.usage?.input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.output_tokens ?? 0);

export interface ClassifiedException {
  turn: number;
  status: "exception" | "timeout";
  message: string;
  category: ErrorCategory;
}

export interface AnalyzedRun extends RunResult {
  refused: boolean;
  exceptionList: ClassifiedException[];
  /** Exceptions + timeouts counted in the result but not found in a turn log. */
  unclassified: number;
  /** Pagination-category run that failed (not refused), ran code, and whose code never read next_page or asked for another page. */
  neverPaged: boolean;
  hasTurnLog: boolean;
}

export function analyzeRuns(results: readonly RunResult[], opts: { turns?: Map<string, TurnLine[]>; knownFields?: ReadonlySet<string> } = {}): AnalyzedRun[] {
  const known = opts.knownFields ?? new Set<string>();
  return results.map((r) => {
    const lines = opts.turns?.get(r.id);
    const exceptionList: ClassifiedException[] = [];
    const codes: string[] = [];
    for (const l of lines ?? []) {
      const code = codeOf(l.reply);
      if (code !== undefined) codes.push(code);
      if (l.sandbox_status === "exception" || l.sandbox_status === "timeout") {
        const message = l.sandbox_exception ?? "";
        exceptionList.push({ turn: l.turn, status: l.sandbox_status, message, category: classifyException({ status: l.sandbox_status, message, code }, known) });
      }
    }
    const counted = (r.exceptions ?? 0) + (r.timeouts ?? 0);
    const refused = isRefusal(r.final, r.pass);
    return {
      ...r,
      refused,
      exceptionList,
      unclassified: Math.max(0, counted - exceptionList.length),
      neverPaged: r.category === "pagination" && !r.pass && !refused && codes.length > 0 && !codePaginates(codes),
      hasTurnLog: lines !== undefined,
    };
  });
}

export interface GroupRow {
  backend: string;
  model: string;
  arm: string;
  runs: number;
  passes: number;
  refused: number;
  codeErrorsPerTask: number;
  turnsPerTask: number;
  outMedian: number;
  outMean: number;
  totalMean: number;
  uncachedIn: number;
  cacheWrite: number;
  cacheRead: number;
  reasoning: number;
  latencyMedianMs: number;
}

const key = (...parts: (string | number)[]): string => parts.join("\u0000");

function groupBy<T>(xs: readonly T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return m;
}

export function groupRows(results: readonly RunResult[]): GroupRow[] {
  const rows: GroupRow[] = [];
  for (const rs of groupBy(results, (r) => key(r.backend, r.model, r.arm)).values()) {
    const first = rs[0] as RunResult;
    const avg = (pick: (r: RunResult) => number | undefined): number => mean(rs.map((r) => pick(r) ?? 0));
    rows.push({
      backend: first.backend,
      model: first.model,
      arm: first.arm,
      runs: rs.length,
      passes: rs.filter((r) => r.pass).length,
      refused: rs.filter((r) => isRefusal(r.final, r.pass)).length,
      codeErrorsPerTask: mean(rs.map((r) => r.codeErrors)),
      turnsPerTask: mean(rs.map((r) => r.turns)),
      outMedian: median(rs.map(out)),
      outMean: avg(out),
      totalMean: avg(totalTokens),
      uncachedIn: avg((r) => r.usage?.input_tokens),
      cacheWrite: avg((r) => r.usage?.cache_creation_input_tokens),
      cacheRead: avg((r) => r.usage?.cache_read_input_tokens),
      reasoning: avg((r) => r.usage?.reasoning_output_tokens),
      latencyMedianMs: median(rs.map((r) => r.modelLatencyMs ?? NaN).filter(Number.isFinite)),
    });
  }
  return rows.sort((a, b) => `${a.backend}|${a.model}|${a.arm}`.localeCompare(`${b.backend}|${b.model}|${b.arm}`));
}

export interface Pair<R extends RunResult = RunResult> {
  backend: string;
  model: string;
  task: string;
  rep: number;
  C: R;
  D: R;
}

/** Complete C/D pairs by (backend, model, task, rep); runs without a partner are left out. */
export function pairRuns<R extends RunResult>(results: readonly R[]): Pair<R>[] {
  const cells = new Map<string, { C?: R; D?: R }>();
  for (const r of results) {
    if (r.arm !== "C" && r.arm !== "D") continue;
    const k = key(r.backend, r.model, r.task, r.rep);
    const cell = cells.get(k) ?? {};
    cell[r.arm] = r;
    cells.set(k, cell);
  }
  const pairs: Pair<R>[] = [];
  for (const cell of cells.values()) {
    if (cell.C && cell.D) pairs.push({ backend: cell.C.backend, model: cell.C.model, task: cell.C.task, rep: cell.C.rep, C: cell.C, D: cell.D });
  }
  return pairs.sort((a, b) => key(a.backend, a.model, a.task, String(a.rep).padStart(4, "0")).localeCompare(key(b.backend, b.model, b.task, String(b.rep).padStart(4, "0"))));
}

const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

export interface PairedStats {
  backend: string;
  model: string;
  pairs: number;
  tasks: number;
  /** Fewest complete C/D pairs of any task (the full run needs >= 5). */
  minRepsPerTask: number;
  outputRatio: BootstrapCI;
  turnsRatio: BootstrapCI;
  codeErrorsDiff: BootstrapCI;
  codeErrorsRatio: BootstrapCI;
  successDiffPoints: BootstrapCI;
  /** Secondary: D/C of total tokens per task (uncached in + cache write + cache read + output). */
  totalTokensRatio: BootstrapCI;
  mcnemar: McNemar;
  /** Refused runs per arm among the paired runs. */
  refusedC: number;
  refusedD: number;
  /** Sensitivity check: the same with every pair that has a refusal on either side left out. */
  withoutRefusals: { pairs: number; successDiffPoints: BootstrapCI; mcnemar: McNemar };
  /** Secondary: cache-weighted cost ESTIMATE from bench/prices.json, or why there is none. */
  cost: CostEvidence;
}

type PairedCore = Pick<PairedStats, "pairs" | "tasks" | "outputRatio" | "turnsRatio" | "codeErrorsDiff" | "codeErrorsRatio" | "successDiffPoints" | "totalTokensRatio" | "mcnemar">;

export interface PairedOptions {
  resamples?: number;
  seed?: number;
  /** The bench/prices.json table; without it there is no cost estimate. */
  prices?: PriceTable | null;
}

function pairedFor(pairs: readonly Pair<AnalyzedRun>[], opts: PairedOptions): PairedCore {
  const byTask = (p: Pair): string => p.task;
  const boot = (stat: (xs: readonly Pair<AnalyzedRun>[]) => number): BootstrapCI => clusterBootstrap(pairs, byTask, stat, opts);
  return {
    pairs: pairs.length,
    tasks: new Set(pairs.map(byTask)).size,
    outputRatio: boot((xs) => sum(xs, (p) => out(p.D)) / sum(xs, (p) => out(p.C))),
    turnsRatio: boot((xs) => sum(xs, (p) => p.D.turns) / sum(xs, (p) => p.C.turns)),
    codeErrorsDiff: boot((xs) => sum(xs, (p) => p.D.codeErrors - p.C.codeErrors) / xs.length),
    codeErrorsRatio: boot((xs) => sum(xs, (p) => p.D.codeErrors) / sum(xs, (p) => p.C.codeErrors)),
    successDiffPoints: boot((xs) => (100 * sum(xs, (p) => Number(p.D.pass) - Number(p.C.pass))) / xs.length),
    totalTokensRatio: boot((xs) => sum(xs, (p) => totalTokens(p.D)) / sum(xs, (p) => totalTokens(p.C))),
    mcnemar: mcnemarExact(pairs.filter((p) => p.C.pass && !p.D.pass).length, pairs.filter((p) => !p.C.pass && p.D.pass).length),
  };
}

function costFor(pairs: readonly Pair<AnalyzedRun>[], model: string, opts: PairedOptions): CostEvidence {
  const pricing = pricingFor(opts.prices, model);
  if (!pricing.ok) return { available: false, reason: pricing.reason };
  const cost = (r: RunResult): number => costOf(r.usage, pricing);
  return {
    available: true,
    ratio: clusterBootstrap(pairs, (p) => p.task, (xs) => sum(xs, (p) => cost(p.D)) / sum(xs, (p) => cost(p.C)), opts),
    meanC: mean(pairs.map((p) => cost(p.C))),
    meanD: mean(pairs.map((p) => cost(p.D))),
    cacheWriteKey: pricing.cacheWriteKey,
  };
}

export function pairedStats(runs: readonly AnalyzedRun[], opts: PairedOptions = {}): PairedStats[] {
  const outStats: PairedStats[] = [];
  for (const ps of groupBy(pairRuns(runs), (p) => key(p.backend, p.model)).values()) {
    const first = ps[0] as Pair<AnalyzedRun>;
    const clean = ps.filter((p) => !p.C.refused && !p.D.refused);
    const c = pairedFor(clean, opts);
    outStats.push({
      backend: first.backend,
      model: first.model,
      ...pairedFor(ps, opts),
      minRepsPerTask: Math.min(...[...groupBy(ps, (p) => p.task).values()].map((xs) => xs.length)),
      refusedC: ps.filter((p) => p.C.refused).length,
      refusedD: ps.filter((p) => p.D.refused).length,
      withoutRefusals: { pairs: clean.length, successDiffPoints: c.successDiffPoints, mcnemar: c.mcnemar },
      cost: costFor(ps, first.model, opts),
    });
  }
  return outStats.sort((a, b) => key(a.backend, a.model).localeCompare(key(b.backend, b.model)));
}

/**
 * The amended H1 verdict per backend (Amendments 1 and 2): NOT CHECKED unless every model of the backend has
 * full-run data; models excluded under Amendment 2 are left out, and each result carries the unexcluded verdict
 * and a verdict per model.
 */
export function verdicts(stats: readonly PairedStats[], weak: Record<string, string | undefined> = WEAK_MODEL): AmendedBackendVerdict[] {
  return [...groupBy(stats, (s) => s.backend).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([backend, ms]) => amendedBackendVerdict(backend, ms, weak[backend]));
}

const ci = (c: BootstrapCI, fmt: (n: number) => string = f2): string =>
  `${fmt(c.point)} [${fmt(c.lo)}, ${fmt(c.hi)}]${c.undefinedResamples ? ` (${c.undefinedResamples} resamples undefined)` : ""}`;
const pval = (p: number): string => (p >= 0.001 ? p.toFixed(3) : "<0.001");

function excerpt(s: string | null | undefined, n = 140): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(t.length > n ? `${t.slice(0, n)}...` : t);
}

const CATEGORY_LABEL = new Map<string, string>(ERROR_CATEGORIES.map((c) => [c.id, c.label]));

export interface ReportOptions {
  turns?: Map<string, TurnLine[]>;
  knownFields?: ReadonlySet<string>;
  /** Shown in the header, e.g. bench/results/pilot. */
  rawLabel?: string;
  resamples?: number;
  seed?: number;
  /** bench/prices.json, for the labelled cost estimate (secondary). */
  prices?: PriceTable | null;
}

function renderVerdictDetail(L: string[], v: BackendVerdict, indent = ""): void {
  for (const r of v.reasons) L.push(`${indent}- ${r}`);
  if (!v.full) return;
  for (const n of v.notes) L.push(`${indent}- ${n}`);
  L.push(`${indent}- What moved (CI excludes no change): ${v.moved.length ? "" : "nothing"}`);
  for (const m of v.moved) L.push(`${indent}  - ${m}`);
  if (v.original) {
    L.push(`${indent}- Original H1 criteria (before Amendment 1; SECONDARY, not gating): ${v.original.verdict}`);
    for (const r of v.original.reasons) L.push(`${indent}  - ${r}`);
  }
}

function renderVerdictSection(vs: readonly AmendedBackendVerdict[]): string[] {
  const L: string[] = [];
  L.push("## Verdict (amended H1, BENCHMARK.md Amendments 1 and 2)", "");
  L.push(
    `Per backend, full-run data only. PRIMARY: output tokens/task D/C upper 95% bound < ${PRIMARY_UPPER.toFixed(2)} on at least one model, and no model with an upper bound > ${GUARDRAIL_UPPER.toFixed(2)} on output tokens or turns. NON-INFERIORITY: success D-C lower bound >= ${NI_MARGIN_POINTS} points on every model (all pairs gate; without refused pairs is reported). KILL: the output-token CI contains or exceeds 1.0 for every model, or non-inferiority fails. PARTIAL: anything else. These criteria were changed AFTER the pilot data was seen (see BENCHMARK.md).`,
    "",
    `Amendment 2 (written AFTER the full-run results were seen): a model whose arm-C (baseline) refusal rate is above ${Math.round(100 * EXCLUDE_REFUSAL_RATE_C)}% is excluded from its backend's verdict as harness-incompatible. Excluded models keep their own numbers and verdict below, and every backend line also gives the verdict without the exclusion.`,
    "",
  );
  for (const v of vs) L.push(`- **${v.backend}: ${v.verdict}**${v.full ? "" : " (directional only)"}${v.excluded.length ? ` (excluded: ${v.excluded.map((m) => m.model).join(", ")})` : ""}; without exclusions: ${v.unexcluded.verdict}`);
  L.push("", "Per model (each model judged alone against the same thresholds):", "");
  for (const v of vs) {
    for (const m of v.perModel) {
      L.push(`- ${v.backend} / ${m.model}: **${m.verdict}**${m.detail.full ? "" : " (directional only)"}${m.excluded ? `, EXCLUDED from the backend verdict: ${m.reason ?? ""}` : ""}`);
    }
  }
  L.push("");
  for (const v of vs) {
    L.push(`### ${v.backend}: ${v.verdict}${v.excluded.length ? ` (without exclusions: ${v.unexcluded.verdict})` : ""}`, "");
    renderVerdictDetail(L, v);
    for (const m of v.excluded) {
      L.push("", `#### Excluded: ${m.model} (own verdict ${m.verdict}, on record)`, "", `- ${m.reason ?? ""}`);
      renderVerdictDetail(L, m.detail);
    }
    if (v.excluded.length) {
      L.push("", `#### ${v.backend} without the exclusion (Amendment 1 only, on record): ${v.unexcluded.verdict}`, "");
      renderVerdictDetail(L, v.unexcluded);
    }
    L.push("");
  }
  return L;
}

export function renderReport(results: readonly RunResult[], generatedAt: string, opts: ReportOptions = {}): string {
  const runs = analyzeRuns(results, opts);
  const L: string[] = [];
  const tasks = new Set(runs.map((r) => r.task)).size;
  const maxRep = Math.max(0, ...runs.map((r) => r.rep));
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const seed = opts.seed ?? BOOTSTRAP_SEED;
  const stats = pairedStats(runs, { resamples, seed, prices: opts.prices });
  const vs = verdicts(stats);
  const fullBackends = vs.filter((v) => v.full).map((v) => v.backend);

  L.push("# REPORT", "");
  L.push(`Generated ${generatedAt} by \`npm run bench:analyze\` from ${runs.length} finished run(s) in \`${opts.rawLabel ?? "bench/results/raw"}\` (${tasks} task(s), up to ${maxRep} rep(s)).`, "");
  if (fullBackends.length === 0) {
    L.push(`**PILOT / PARTIAL DATA: DIRECTIONAL ONLY.** This is not a full run (${FULL_TASKS} tasks x ${FULL_REPS} reps). The PASS/KILL/PARTIAL thresholds of BENCHMARK.md apply to the full run only and are NOT checked here. Use this report to check that the harness works (every run finished, tokens logged, no crashes, arms comparable), not whether D is ahead.`);
  } else if (fullBackends.length < vs.length) {
    L.push(`**FULL-RUN DATA FOR ${fullBackends.join(", ")} ONLY.** The verdict below is computed for those backends; the others are not full runs (${FULL_TASKS} tasks x ${FULL_REPS} reps) and stay directional only.`);
  } else {
    L.push("**FULL-RUN DATA.** The amended PASS/KILL/PARTIAL verdict is computed below, per backend. VERDICT.md (M8) adds the model-quality caveats.");
  }
  L.push("");
  L.push("Compare arms C and D **within one backend and model**. Claude and Codex use different reply formats (BENCHMARK.md, M6b) and are not interchangeable.", "");
  L.push(...renderVerdictSection(vs));

  // 1. Per backend, model and arm.
  L.push("## Per backend, model and arm", "");
  L.push("Means are per task (one run = one task attempt). *Success without refusals* leaves refused runs out of the denominator (sensitivity check). Total tokens = uncached input + cache write + cache read + output (context only).", "");
  L.push("| backend | model | arm | runs | success | refused | success without refusals | code errors/task | turns/task | output tokens/task (median / mean) | total tokens/task | median model latency (ms) |");
  L.push("|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|");
  const rows = groupRows(runs);
  for (const r of rows) {
    L.push(
      `| ${r.backend} | ${r.model} | ${r.arm} | ${r.runs} | ${pct(r.passes, r.runs)} | ${r.refused} | ${pct(r.passes, r.runs - r.refused)} | ${f2(r.codeErrorsPerTask)} | ${f2(r.turnsPerTask)} | ${f0(r.outMedian)} / ${f0(r.outMean)} | ${f0(r.totalMean)} | ${f0(r.latencyMedianMs)} |`,
    );
  }
  L.push("");
  L.push("Token breakdown per task (where the backend reports it; Codex reasoning tokens are part of its output):", "");
  L.push("| backend | model | arm | uncached in | cache write | cache read | output | reasoning |");
  L.push("|---|---|---|---:|---:|---:|---:|---:|");
  for (const r of rows) L.push(`| ${r.backend} | ${r.model} | ${r.arm} | ${f0(r.uncachedIn)} | ${f0(r.cacheWrite)} | ${f0(r.cacheRead)} | ${f0(r.outMean)} | ${f0(r.reasoning)} |`);
  L.push("");

  // 2. Paired statistics.
  L.push("## Paired C vs D, by (task, rep)", "");
  L.push(`Bootstrap: ${resamples.toLocaleString("en-US")} resamples over tasks (all reps of a drawn task come along), percentile 95% CI, seed ${seed}. Ratios are D/C of the per-task means (1 = no change, below 1 = D lower). Differences are D - C per task. McNemar: exact two-sided test on the discordant pairs (b = C pass and D fail, c = C fail and D pass).`, "");
  if (stats.length === 0) L.push("No complete C/D pairs.", "");
  else {
    L.push("| backend | model | pairs (tasks) | output tokens D/C | turns D/C | code errors D-C | code errors D/C | success D-C (points) | McNemar b / c, p | without refusals: pairs, success D-C, McNemar p |");
    L.push("|---|---|---:|---|---|---|---|---|---|---|");
    for (const s of stats) {
      L.push(
        `| ${s.backend} | ${s.model} | ${s.pairs} (${s.tasks}) | ${ci(s.outputRatio)} | ${ci(s.turnsRatio)} | ${ci(s.codeErrorsDiff)} | ${ci(s.codeErrorsRatio)} | ${ci(s.successDiffPoints, f1)} | ${s.mcnemar.b} / ${s.mcnemar.c}, p ${pval(s.mcnemar.p)} | ${s.withoutRefusals.pairs}, ${ci(s.withoutRefusals.successDiffPoints, f1)}, p ${pval(s.withoutRefusals.mcnemar.p)} |`,
      );
    }
    L.push("");
    L.push("Secondary (reported, not gating): total tokens per task, and a cache-weighted cost **ESTIMATE** from `bench/prices.json` (uncached in x input + cache write x cache-write price + cache read x cache_read + output x output, USD per million; subscription runs are not billed per token).", "");
    L.push("| backend | model | total tokens D/C | cost ESTIMATE D/C | cost ESTIMATE per task C / D (USD) | refused C / D |");
    L.push("|---|---|---|---|---|---|");
    for (const s of stats) {
      const cost = s.cost.available ? `${ci(s.cost.ratio)} (cache write at ${s.cost.cacheWriteKey})` : `n/a: ${s.cost.reason}`;
      const each = s.cost.available ? `${s.cost.meanC.toFixed(5)} / ${s.cost.meanD.toFixed(5)}` : "n/a";
      L.push(`| ${s.backend} | ${s.model} | ${ci(s.totalTokensRatio)} | ${cost} | ${each} | ${s.refusedC} / ${s.refusedD} |`);
    }
    L.push("");
  }

  // 3. Sandbox exceptions by kind.
  L.push("## Sandbox exceptions by kind", "");
  L.push("Each sandbox run that ended in an exception or a timeout, classified from its message (and, for reads of undefined, from the code: if every field read just before the failing one is unknown to the server's result types, it counts as a wrong field name). Code errors per task = these + rewrites (a code block sent right after a failed run). Rules: `bench/analysis/classify.ts`.", "");
  const classified = runs.some((r) => r.hasTurnLog);
  for (const [, rs] of [...groupBy(runs, (r) => key(r.backend, r.model)).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = rs[0] as AnalyzedRun;
    const arms = [...new Set(rs.map((r) => r.arm))].sort();
    L.push(`### ${first.backend} / ${first.model}`, "");
    L.push(`| kind | ${arms.map((a) => `${a} count | ${a} per task`).join(" | ")} |`);
    L.push(`|---|${arms.map(() => "---:|---:").join("|")}|`);
    const byArm = new Map(arms.map((a) => [a, rs.filter((r) => r.arm === a)]));
    const cell = (a: string, n: (r: AnalyzedRun) => number): string => {
      const xs = byArm.get(a) ?? [];
      const total = sum(xs, n);
      return `${total} | ${f2(total / xs.length)}`;
    };
    for (const c of ERROR_CATEGORIES) {
      const count = (r: AnalyzedRun): number => r.exceptionList.filter((e) => e.category === c.id).length;
      if (sum(rs, count) === 0) continue;
      L.push(`| ${c.label} | ${arms.map((a) => cell(a, count)).join(" | ")} |`);
    }
    if (sum(rs, (r) => r.unclassified) > 0) L.push(`| unclassified (no turn log) | ${arms.map((a) => cell(a, (r) => r.unclassified)).join(" | ")} |`);
    L.push(`| **all exceptions and timeouts** | ${arms.map((a) => cell(a, (r) => r.exceptionList.length + r.unclassified)).join(" | ")} |`);
    L.push(`| rewrites | ${arms.map((a) => cell(a, (r) => r.rewrites ?? 0)).join(" | ")} |`);
    L.push(`| failed pagination runs whose code never paged (refusals excluded) | ${arms.map((a) => cell(a, (r) => Number(r.neverPaged))).join(" | ")} |`);
    L.push("");
  }
  if (!classified) L.push("No turn logs (`.jsonl`) were found, so exceptions could not be classified.", "");
  const allEx = runs.flatMap((r) => r.exceptionList.map((e) => ({ ...e, arm: r.arm })));
  if (allEx.length) {
    L.push("<details><summary>Exception messages by kind (up to 5 most common per kind)</summary>", "");
    for (const c of ERROR_CATEGORIES) {
      const msgs = allEx.filter((e) => e.category === c.id);
      if (!msgs.length) continue;
      L.push(`**${c.label}**`, "");
      const counts = groupBy(msgs, (e) => e.message.replace(/\s+/g, " ").slice(0, 160));
      for (const [m, es] of [...counts.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
        L.push(`- ${es.length}x (C ${es.filter((e) => e.arm === "C").length}, D ${es.filter((e) => e.arm === "D").length}): \`${m.replace(/`/g, "'")}\``);
      }
      L.push("");
    }
    L.push("</details>", "");
  }

  // 4. Refusals.
  const refused = runs.filter((r) => r.refused);
  L.push("## Refusals", "");
  L.push("A refusal is a failed run whose final answer claims the tools or the data are unavailable instead of answering (regexes in `bench/analysis/classify.ts`). It hits both arms and is a model/protocol problem, not a code error; the tables above show success with and without refused runs.", "");
  if (!refused.length) L.push("None.", "");
  else {
    for (const r of refused) L.push(`- \`${r.id}\` (${r.turns} turn(s), ${(r.sandboxRuns ?? 0) > 0 ? `after ${r.sandboxRuns} code run(s) and ${r.toolCalls} tool call(s)` : "without running any code"}): ${excerpt(r.final)}`);
    L.push("");
  }

  // 5. Per-task table.
  L.push("## Per task, arm C vs D", "");
  L.push("Per (backend, model, task) over its reps: passes, then means per run.", "");
  L.push("| backend | model | task | category | C pass | D pass | C code errors | D code errors | C turns | D turns | C output tok | D output tok |");
  L.push("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [, rs] of [...groupBy(runs, (r) => key(r.backend, r.model, r.task)).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = rs[0] as AnalyzedRun;
    const c = rs.filter((r) => r.arm === "C");
    const d = rs.filter((r) => r.arm === "D");
    const passes = (xs: AnalyzedRun[]): string => (xs.length ? `${xs.filter((r) => r.pass).length}/${xs.length}` : "-");
    const m = (xs: AnalyzedRun[], f: (r: AnalyzedRun) => number, fmt = f1): string => (xs.length ? fmt(mean(xs.map(f))) : "-");
    L.push(
      `| ${first.backend} | ${first.model} | ${first.task} | ${first.category ?? "?"} | ${passes(c)} | ${passes(d)} | ${m(c, (r) => r.codeErrors)} | ${m(d, (r) => r.codeErrors)} | ${m(c, (r) => r.turns)} | ${m(d, (r) => r.turns)} | ${m(c, out, f0)} | ${m(d, out, f0)} |`,
    );
  }
  L.push("");

  // 6. Disagreeing pairs.
  const pairs = pairRuns(runs);
  const disagree = pairs.filter((p) => p.C.pass !== p.D.pass);
  L.push("## Pairs where C and D disagree on pass/fail", "");
  if (!disagree.length) L.push("None.", "");
  else {
    const side = (r: AnalyzedRun): string => {
      const kinds = r.exceptionList.map((e) => e.category);
      return `${r.pass ? "PASS" : "FAIL"}${r.refused ? " (refused)" : ""}, ${r.turns} turn(s), ${r.codeErrors} code error(s)${kinds.length ? ` [${kinds.join(", ")}]` : ""}, final ${excerpt(r.final, 80)}`;
    };
    for (const p of disagree) L.push(`- ${p.backend} / ${p.model} / ${p.task} rep ${p.rep}: C ${side(p.C)}; D ${side(p.D)}`);
    L.push("");
  }

  // 7. Harness checks.
  const zero = runs.filter((r) => !(out(r) > 0));
  const unpaired = runs.length - 2 * pairs.length;
  L.push("## Harness checks (M7 gate material)", "");
  L.push(`- Runs with 0 or missing output tokens: ${zero.length}${zero.length ? ` (${zero.map((r) => r.id).join(", ")})` : ""}`);
  L.push(`- Runs ended by something other than a FINAL answer: ${runs.filter((r) => r.endedBy !== "final").length}`);
  L.push(`- Runs without a C/D partner: ${unpaired}`);
  L.push(`- Runs without a turn log: ${runs.filter((r) => !r.hasTurnLog).length}`);
  L.push(`- Duplicate writes: ${runs.reduce((a, r) => a + (r.duplicateWrites ?? 0), 0)}`);
  L.push("");
  const failed = runs.filter((r) => !r.pass && !r.refused);
  if (failed.length) {
    L.push("## Other failed runs", "");
    for (const r of failed) L.push(`- \`${r.id}\` (${r.endedBy ?? "?"}, ${r.turns} turn(s), ${r.codeErrors} code error(s)): ${excerpt(r.final, 160)}`);
    L.push("");
  }

  // Appendix: every pair.
  L.push("## Appendix: all pairs", "");
  L.push("| backend | model | task | rep | C pass | D pass | C code errors | D code errors | C turns | D turns | C output tok | D output tok |");
  L.push("|---|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|");
  const pf = (r: RunResult): string => (r.pass ? "PASS" : "FAIL");
  for (const p of pairs) {
    L.push(`| ${p.backend} | ${p.model} | ${p.task} | ${p.rep} | ${pf(p.C)} | ${pf(p.D)} | ${p.C.codeErrors} | ${p.D.codeErrors} | ${p.C.turns} | ${p.D.turns} | ${f0(out(p.C))} | ${f0(out(p.D))} |`);
  }
  L.push("");
  return `${L.join("\n")}\n`;
}

/** A short plain-text summary for the console (what the owner pastes back). */
export function renderSummary(results: readonly RunResult[], opts: ReportOptions = {}): string {
  const runs = analyzeRuns(results, opts);
  const stats = pairedStats(runs, opts);
  const vs = verdicts(stats);
  const L: string[] = [vs.some((v) => v.full) ? "Verdict (amended H1, full-run backends only):" : "Directional only: thresholds apply to the full run, none are checked here."];
  for (const v of vs) {
    if (!v.full) continue;
    const cost = v.notes.some((n) => n.includes("HIGHER")) ? " (D's cost ESTIMATE is higher than C's on some model)" : "";
    const ex = v.excluded.length ? ` (excluded: ${v.excluded.map((m) => `${m.model}, arm-C refusal rate ${Math.round(100 * m.refusalRateC)}% > ${Math.round(100 * EXCLUDE_REFUSAL_RATE_C)}%`).join("; ")})` : "";
    L.push(`VERDICT ${v.backend}: ${v.verdict}${cost}${ex} | without exclusions: ${v.unexcluded.verdict}`);
    for (const m of v.perModel) L.push(`  model ${m.model}: ${m.verdict}${m.excluded ? ` (EXCLUDED: ${m.reason ?? ""})` : ""}`);
  }
  for (const r of groupRows(runs)) {
    L.push(`${r.backend} ${r.model} ${r.arm}: ${r.runs} runs, success ${pct(r.passes, r.runs)}, refused ${r.refused}, code errors/task ${f2(r.codeErrorsPerTask)}, turns/task ${f2(r.turnsPerTask)}, output tok/task ${f0(r.outMean)}`);
  }
  for (const s of stats) {
    L.push(`${s.backend} ${s.model} paired (${s.pairs}): output D/C ${ci(s.outputRatio)}, turns D/C ${ci(s.turnsRatio)}, success D-C ${ci(s.successDiffPoints, f1)}, code errors D-C ${ci(s.codeErrorsDiff)}, McNemar ${s.mcnemar.b}/${s.mcnemar.c} p ${pval(s.mcnemar.p)}`);
  }
  const zero = runs.filter((r) => !(out(r) > 0)).length;
  L.push(`checks: ${zero} run(s) with 0 output tokens, ${runs.filter((r) => r.endedBy !== "final").length} not ended by FINAL, ${runs.filter((r) => r.refused).length} refused`);
  return `${L.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { raw: { type: "string" }, out: { type: "string" } }, strict: true });
  const raw = path.resolve(values.raw ?? path.join(HERE, "results", "raw"));
  const outFile = values.out ?? path.join(HERE, "results", "REPORT.md");
  if (!existsSync(raw)) {
    process.stderr.write(`analyze: no such folder ${raw}\n`);
    return 1;
  }
  const results = loadResults(raw);
  if (results.length === 0) {
    process.stderr.write(`analyze: no finished runs in ${raw}\n`);
    return 1;
  }
  const opts: ReportOptions = {
    turns: loadTurns(raw, results.map((r) => r.id)),
    knownFields: loadKnownFields(),
    prices: loadPrices(PRICES),
    rawLabel: path.relative(process.cwd(), raw).split(path.sep).join("/") || raw,
  };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderReport(results, new Date().toISOString(), opts), "utf8");
  process.stdout.write(renderSummary(results, opts));
  process.stdout.write(`analyze: ${results.length} run(s) -> ${outFile}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
