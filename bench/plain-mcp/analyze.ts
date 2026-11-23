// Paired S/P report of the plain-MCP test (BENCHMARK.md Amendment 3). Reuses the bootstrap and McNemar of
// bench/analysis/stats.ts (10,000 resamples over TASKS, seed 20261122) and the helpers of bench/analyze.ts.
//
//   node --import tsx bench/plain-mcp/analyze.ts [--raw bench/results/plain-mcp] [--everything bench/results/plain-mcp-everything]
//        [--out bench/results/plain-mcp/REPORT.md]
//
// Verdict per backend (gating arms P and S, mock workload only); S2 vs P is exploratory; the server-everything
// runs are a "no harm" table. Ratios are sum over pairs / sum over pairs.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, clusterBootstrap, mcnemarExact, type BootstrapCI, type McNemar } from "../analysis/stats.js";
import { mean, median } from "../analyze.js";
import { PLAIN_ARMS, ROOT, type PlainArm } from "./config.js";
import { loadPlainResults, type PlainResult } from "./runner.js";
import { NI_MARGIN, OUTPUT_UPPER, plainVerdict, TURNS_UPPER, type PlainVerdictResult } from "./verdict.js";

export interface PlainPair {
  workload: string;
  backend: string;
  model: string;
  task: string;
  rep: number;
  base: PlainResult;
  test: PlainResult;
}

const key = (...xs: (string | number)[]): string => xs.join("\u0000");
const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

/** Complete (base, test) pairs by (workload, backend, model, task, rep). */
export function pairPlain(results: readonly PlainResult[], base: PlainArm = "P", test: PlainArm = "S"): PlainPair[] {
  const cells = new Map<string, Partial<Record<PlainArm, PlainResult>>>();
  for (const r of results) {
    const k = key(r.workload, r.backend, r.model, r.task, r.rep);
    cells.set(k, { ...cells.get(k), [r.arm]: r });
  }
  const pairs: PlainPair[] = [];
  for (const c of cells.values()) {
    const b = c[base];
    const t = c[test];
    if (b && t) pairs.push({ workload: b.workload, backend: b.backend, model: b.model, task: b.task, rep: b.rep, base: b, test: t });
  }
  return pairs.sort((a, b) => key(a.workload, a.backend, a.model, a.task, String(a.rep).padStart(4, "0")).localeCompare(key(b.workload, b.backend, b.model, b.task, String(b.rep).padStart(4, "0"))));
}

export interface PlainPairedStats {
  workload: string;
  backend: string;
  model: string;
  base: PlainArm;
  test: PlainArm;
  pairs: number;
  tasks: number;
  minRepsPerTask: number;
  outputRatio: BootstrapCI;
  turnsRatio: BootstrapCI;
  successDiffPoints: BootstrapCI;
  totalTokensRatio: BootstrapCI;
  toolCallsRatio: BootstrapCI;
  wallRatio: BootstrapCI;
  mcnemar: McNemar;
  refused: { base: number; test: number };
  duplicateWrites: { base: number; test: number };
}

export function plainPairedStats(pairs: readonly PlainPair[], opts: { resamples?: number; seed?: number } = {}): PlainPairedStats[] {
  const groups = new Map<string, PlainPair[]>();
  for (const p of pairs) groups.set(key(p.workload, p.backend, p.model, p.base.arm, p.test.arm), [...(groups.get(key(p.workload, p.backend, p.model, p.base.arm, p.test.arm)) ?? []), p]);
  const out: PlainPairedStats[] = [];
  for (const ps of groups.values()) {
    const first = ps[0] as PlainPair;
    const boot = (stat: (xs: readonly PlainPair[]) => number): BootstrapCI => clusterBootstrap(ps, (p) => p.task, stat, opts);
    const ratio = (f: (r: PlainResult) => number) => boot((xs) => sum(xs, (p) => f(p.test)) / sum(xs, (p) => f(p.base)));
    const perTask = new Map<string, number>();
    for (const p of ps) perTask.set(p.task, (perTask.get(p.task) ?? 0) + 1);
    out.push({
      workload: first.workload,
      backend: first.backend,
      model: first.model,
      base: first.base.arm,
      test: first.test.arm,
      pairs: ps.length,
      tasks: perTask.size,
      minRepsPerTask: Math.min(...perTask.values()),
      outputRatio: ratio((r) => r.usage.output_tokens),
      turnsRatio: ratio((r) => r.turns),
      successDiffPoints: boot((xs) => (100 * sum(xs, (p) => Number(p.test.pass) - Number(p.base.pass))) / xs.length),
      totalTokensRatio: ratio((r) => r.totalTokens),
      toolCallsRatio: ratio((r) => r.toolCalls),
      wallRatio: ratio((r) => r.wallMs),
      mcnemar: mcnemarExact(ps.filter((p) => p.base.pass && !p.test.pass).length, ps.filter((p) => !p.base.pass && p.test.pass).length),
      refused: { base: ps.filter((p) => p.base.refused).length, test: ps.filter((p) => p.test.refused).length },
      duplicateWrites: { base: sum(ps, (p) => p.base.duplicateWrites), test: sum(ps, (p) => p.test.duplicateWrites) },
    });
  }
  return out.sort((a, b) => key(a.workload, a.backend, a.model, a.test).localeCompare(key(b.workload, b.backend, b.model, b.test)));
}

/** The Amendment 3 verdict per backend: mock workload, S vs P. */
export function plainVerdicts(stats: readonly PlainPairedStats[]): (PlainVerdictResult & { backend: string; model: string })[] {
  return stats.filter((s) => s.workload === "mock" && s.base === "P" && s.test === "S").map((s) => ({ backend: s.backend, model: s.model, ...plainVerdict(s) }));
}

const f0 = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a");
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
const ci = (c: BootstrapCI, f = f2): string => `${f(c.point)} [${f(c.lo)}, ${f(c.hi)}]`;
const pct = (a: number, b: number): string => (b > 0 ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "n/a");
const pval = (p: number): string => (p < 0.001 ? "< 0.001" : p.toFixed(3));

export interface ArmRow {
  workload: string;
  backend: string;
  model: string;
  arm: PlainArm;
  runs: number;
  passes: number;
  refused: number;
  outMedian: number;
  outMean: number;
  turnsMean: number;
  toolCallsMean: number;
  totalMean: number;
  wallMedianS: number;
  duplicates: number;
  toolErrors: number;
  shellCalls: number;
  driftEvents: number;
}

export function armRows(results: readonly PlainResult[]): ArmRow[] {
  const g = new Map<string, PlainResult[]>();
  for (const r of results) g.set(key(r.workload, r.backend, r.model, r.arm), [...(g.get(key(r.workload, r.backend, r.model, r.arm)) ?? []), r]);
  return [...g.values()]
    .map((rs) => {
      const f = rs[0] as PlainResult;
      return {
        workload: f.workload,
        backend: f.backend,
        model: f.model,
        arm: f.arm,
        runs: rs.length,
        passes: rs.filter((r) => r.pass).length,
        refused: rs.filter((r) => r.refused).length,
        outMedian: median(rs.map((r) => r.usage.output_tokens)),
        outMean: mean(rs.map((r) => r.usage.output_tokens)),
        turnsMean: mean(rs.map((r) => r.turns)),
        toolCallsMean: mean(rs.map((r) => r.toolCalls)),
        totalMean: mean(rs.map((r) => r.totalTokens)),
        wallMedianS: median(rs.map((r) => r.wallMs)) / 1000,
        duplicates: sum(rs, (r) => r.duplicateWrites),
        toolErrors: sum(rs, (r) => r.toolErrors),
        shellCalls: sum(rs, (r) => r.shellCalls),
        driftEvents: sum(rs, (r) => r.driftEvents),
      };
    })
    .sort((a, b) => key(a.workload, a.backend, a.model, PLAIN_ARMS.indexOf(a.arm)).localeCompare(key(b.workload, b.backend, b.model, PLAIN_ARMS.indexOf(b.arm))));
}

/** Things that would make a run meaningless: listed, never silently dropped. */
export function harnessChecks(results: readonly PlainResult[]): string[] {
  const L: string[] = [];
  const ids = (rs: PlainResult[]): string => rs.map((r) => r.id).join(", ");
  const add = (label: string, rs: PlainResult[]): void => {
    L.push(`- ${label}: ${rs.length}${rs.length ? ` (${ids(rs)})` : ""}`);
  };
  add("mock server never started (no write log)", results.filter((r) => r.serverStarted === false));
  add("claude: MCP server not reported as connected in the init event", results.filter((r) => r.mcpServers !== null && !r.mcpServers.some((m) => m.status === "connected")));
  add("claude: offered tools other than the workload's MCP tools", results.filter((r) => r.offeredTools !== null && r.offeredTools.some((t) => !t.startsWith("mcp__"))));
  add("no tool call at all", results.filter((r) => r.toolCalls === 0));
  add("every tool call errored (harness problem, e.g. Codex MCP approval denied; the run says nothing about the arms)", results.filter((r) => r.toolCalls > 0 && r.toolErrors >= r.toolCalls));
  add("ended without a FINAL line", results.filter((r) => r.final === null));
  add("client error (not a normal answer)", results.filter((r) => r.clientError !== null));
  add("0 output tokens", results.filter((r) => !(r.usage.output_tokens > 0)));
  add("codex: shell commands run (prompt says not to)", results.filter((r) => r.shellCalls > 0));
  add("claude: usage.output_tokens differs from the modelUsage sum", results.filter((r) => r.usageCrossCheck != null && !r.usageCrossCheck.matches));
  add("client working directory not empty after the run", results.filter((r) => !r.cwdWasEmpty));
  add("serve drift events (S/S2)", results.filter((r) => r.driftEvents > 0));
  const prompts = new Map<string, Set<string>>();
  for (const r of results) prompts.set(key(r.workload, r.task), (prompts.get(key(r.workload, r.task)) ?? new Set()).add(r.promptSha256));
  const differing = [...prompts.entries()].filter(([, s]) => s.size > 1).map(([k]) => k.split("\u0000").join("/"));
  L.push(`- tasks whose prompt differs between runs (must be 0): ${differing.length}${differing.length ? ` (${differing.join(", ")})` : ""}`);
  return L;
}

export function renderPlainReport(results: readonly PlainResult[], generatedAt: string, opts: { resamples?: number; seed?: number; rawLabel?: string } = {}): string {
  const L: string[] = [];
  const mock = results.filter((r) => r.workload === "mock");
  const ev = results.filter((r) => r.workload === "everything");
  const gating = plainPairedStats(pairPlain(mock, "P", "S"), opts);
  const exploratory = plainPairedStats(pairPlain(mock, "P", "S2"), opts);
  L.push("# Plain-MCP test report (M11, BENCHMARK.md Amendment 3)", "");
  L.push(`Generated ${generatedAt} from ${opts.rawLabel ?? "the result files"}: ${results.length} run(s) (${mock.length} mock, ${ev.length} server-everything). Bootstrap: ${opts.resamples ?? BOOTSTRAP_RESAMPLES} resamples over tasks, seed ${opts.seed ?? BOOTSTRAP_SEED}. Ratios are S/P (sum over pairs / sum over pairs).`, "");
  L.push("## Verdict (per backend, S vs P, mock workload)", "");
  L.push(`Criteria (pre-registered): PASS = output S/P upper < ${OUTPUT_UPPER} and turns S/P upper <= ${TURNS_UPPER} and success S-P lower >= ${NI_MARGIN} points; KILL = output CI entirely above ${OUTPUT_UPPER} or non-inferiority fails; INCONCLUSIVE = the output CI contains ${OUTPUT_UPPER}; else PARTIAL. The Code Mode (H1) results do not carry over to this setting.`, "");
  const vs = plainVerdicts(gating);
  if (vs.length === 0) L.push("No complete P/S pairs yet: NOT CHECKED.", "");
  for (const v of vs) {
    L.push(`**${v.backend} (${v.model}): ${v.verdict}**`, "");
    for (const c of v.checks) L.push(`- ${c}`);
    L.push("");
  }
  const pairedTable = (stats: PlainPairedStats[]): void => {
    L.push("| backend | model | pairs (tasks) | output ratio | turns ratio | success diff (points) | McNemar b/c, p | total tokens ratio | tool calls ratio | wall time ratio | refused base/test | duplicate writes base/test |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of stats) {
      L.push(
        `| ${s.backend} | ${s.model} | ${s.pairs} (${s.tasks}) | ${ci(s.outputRatio)} | ${ci(s.turnsRatio)} | ${ci(s.successDiffPoints, f1)} | ${s.mcnemar.b}/${s.mcnemar.c}, ${pval(s.mcnemar.p)} | ${ci(s.totalTokensRatio)} | ${ci(s.toolCallsRatio)} | ${ci(s.wallRatio)} | ${s.refused.base}/${s.refused.test} | ${s.duplicateWrites.base}/${s.duplicateWrites.test} |`,
      );
    }
    L.push("");
  };
  L.push("## Paired S vs P (gating)", "");
  if (gating.length) pairedTable(gating);
  else L.push("No pairs.", "");
  L.push("## Paired S2 vs P (exploratory, `serve --declare-schemas`, not gating)", "");
  if (exploratory.length) pairedTable(exploratory);
  else L.push("No S2 runs.", "");
  L.push("## Per arm", "");
  L.push("| workload | backend | model | arm | runs | success | refused | output median | output mean | turns mean | tool calls mean | total tokens mean | wall median (s) | duplicate writes | tool errors | shell calls | drift events |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of armRows(results)) {
    L.push(
      `| ${r.workload} | ${r.backend} | ${r.model} | ${r.arm} | ${r.runs} | ${pct(r.passes, r.runs)} | ${r.refused} | ${f0(r.outMedian)} | ${f0(r.outMean)} | ${f2(r.turnsMean)} | ${f2(r.toolCallsMean)} | ${f0(r.totalMean)} | ${f1(r.wallMedianS)} | ${r.duplicates} | ${r.toolErrors} | ${r.shellCalls} | ${r.driftEvents} |`,
    );
  }
  L.push("");
  L.push("## No-harm check (server-everything, not gating)", "");
  if (ev.length === 0) L.push("No server-everything runs.", "");
  else {
    L.push("| backend | task | arm | pass | final | turns | output tokens | client error |", "|---|---|---|---|---|---|---|---|");
    for (const r of ev) L.push(`| ${r.backend} | ${r.task} | ${r.arm} | ${r.pass ? "PASS" : "FAIL"} | ${(r.final ?? "(none)").replace(/\|/g, "\\|").slice(0, 60)} | ${r.turns} | ${f0(r.usage.output_tokens)} | ${r.clientError ?? ""} |`);
    L.push("");
  }
  L.push("## Per run", "");
  L.push("| id | pass | final | turns | tool calls | output | total | wall (s) | reasons |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    L.push(`| ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${(r.final ?? "(none)").replace(/\|/g, "\\|").slice(0, 60)} | ${r.turns} | ${r.toolCalls} | ${f0(r.usage.output_tokens)} | ${f0(r.totalTokens)} | ${f1(r.wallMs / 1000)} | ${r.gradeReasons.join("; ").replace(/\|/g, "\\|").slice(0, 120)} |`);
  }
  L.push("", "## Harness checks", "", ...harnessChecks(results), "");
  return `${L.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { raw: { type: "string" }, everything: { type: "string" }, out: { type: "string" } }, strict: true });
  const raw = path.resolve(values.raw ?? path.join(ROOT, "bench", "results", "plain-mcp"));
  const evDir = path.resolve(values.everything ?? path.join(ROOT, "bench", "results", "plain-mcp-everything"));
  const outFile = values.out ?? path.join(raw, "REPORT.md");
  const results = [...loadPlainResults(raw), ...(existsSync(evDir) && evDir !== raw ? loadPlainResults(evDir) : [])];
  if (results.length === 0) {
    process.stderr.write(`plain-mcp analyze: no finished runs in ${raw}\n`);
    return 1;
  }
  const rel = (p: string): string => path.relative(process.cwd(), p).split(path.sep).join("/") || p;
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderPlainReport(results, new Date().toISOString(), { rawLabel: `${rel(raw)} and ${rel(evDir)}` }), "utf8");
  for (const v of plainVerdicts(plainPairedStats(pairPlain(results.filter((r) => r.workload === "mock"))))) {
    console.log(`VERDICT ${v.backend} (${v.model}): ${v.verdict}`);
    for (const c of v.checks) console.log(`  ${c}`);
  }
  console.log(`plain-mcp analyze: ${results.length} run(s) -> ${outFile}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
