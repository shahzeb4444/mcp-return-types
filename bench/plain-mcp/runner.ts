// The plain-MCP run loop (BENCHMARK.md Amendment 3). One run = (workload, backend, model, arm, task, rep) =
// ONE client invocation with the arm's MCP server command. Sequential only.
//   - results: <out>/<id>.json (atomic, v:1, status "done") + <id>.raw.jsonl (the client's stdout as is);
//     a run without a valid .json is redone from scratch, so a restart resumes;
//   - limits: the existing `callModel` loop of bench/harness/runner.ts (sleep BENCH_RATE_LIMIT_SLEEP_MIN and
//     retry the WHOLE run on a fresh server, up to BENCH_MAX_WAIT_HOURS; other CLI failures retry twice);
//   - bench/STOP is checked before each run and after each limit sleep; BENCH_MAX_RUNS caps finished runs per backend;
//   - arms interleaved by (task, rep) in a seeded order, so a half-finished run set is still balanced.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRefusal } from "../analysis/classify.js";
import { BackendError, NotLoggedInError, type ModelBackend } from "../backends/types.js";
import { gradeRun, type Task } from "../grade.js";
import { callModel, LimitBudget, LimitBudgetExhausted, modelSlug, realClock, StopRequested, type Clock } from "../harness/runner.js";
import { readWriteLog } from "../mock-server/writelog.js";
import { parseClientOutput, type ClientOutput, type ParsedRun, type PlainClient } from "./clients.js";
import { claudeToolNames, DEFAULT_LATENCY_MS, makeRunPaths, MCP_NAME, serverSpec, WORKLOAD_TOOLS, type PlainArm, type RunPaths, type ServerSpec, type Workload } from "./config.js";
import { extractFinal, plainPrompt } from "./prompt.js";

export const PLAIN_RESULT_VERSION = 1;

export interface PlainSpec {
  workload: Workload;
  backend: string;
  model: string | undefined;
  arm: PlainArm;
  task: Task;
  rep: number;
}

/** `<workload>-<arm>-<model>-<task>-<rep>`. */
export const plainRunId = (s: Pick<PlainSpec, "workload" | "backend" | "model" | "arm" | "rep"> & { task: { id: string } }): string =>
  `${s.workload}-${s.arm}-${modelSlug(s.backend, s.model)}-${s.task.id}-${s.rep}`;

/** Seeded arm order per (workload, task, rep, model), so a restart plans the same order. */
export function plainArmOrder(arms: readonly PlainArm[], key: string): PlainArm[] {
  const bytes = createHash("sha256").update(key).digest();
  const out = [...arms];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (bytes[i] as number) % (i + 1);
    [out[i], out[j]] = [out[j] as PlainArm, out[i] as PlainArm];
  }
  return out;
}

/** Interleaved plan: rep, then task, then backend, then the arms in seeded order. */
export function planPlain(opts: { workload: Workload; tasks: Task[]; reps: number; backends: { name: string; model: string | undefined }[]; arms: readonly PlainArm[] }): PlainSpec[] {
  const out: PlainSpec[] = [];
  for (let rep = 1; rep <= opts.reps; rep++) {
    for (const task of opts.tasks) {
      for (const b of opts.backends) {
        for (const arm of plainArmOrder(opts.arms, `${opts.workload}:${task.id}:${rep}:${modelSlug(b.name, b.model)}`)) {
          out.push({ workload: opts.workload, backend: b.name, model: b.model, arm, task, rep });
        }
      }
    }
  }
  return out;
}

export interface PlainResult {
  v: typeof PLAIN_RESULT_VERSION;
  id: string;
  status: "done";
  workload: Workload;
  backend: string;
  model: string;
  arm: PlainArm;
  task: string;
  category: string;
  rep: number;
  pass: boolean;
  answerOk: boolean;
  stateOk: boolean;
  final: string | null;
  refused: boolean;
  gradeReasons: string[];
  /** Amendment 3 turns = tool-call rounds. */
  turns: number;
  toolCalls: number;
  toolErrors: number;
  toolsCalled: Record<string, number>;
  shellCalls: number;
  numTurns: number | null;
  clientError: string | null;
  usage: ParsedRun["usage"];
  /** uncached input + cache write + cache read + output. */
  totalTokens: number;
  wallMs: number;
  duplicateWrites: number;
  unexpectedWrites: number;
  missingWrites: number;
  /** Mock workload: the server truncates its write log at start, so a missing log = the server never started. null = not knowable. */
  serverStarted: boolean | null;
  /** serve drift events written during the run (S/S2; 0 for P). */
  driftEvents: number;
  mcpServers: { name: string; status: string }[] | null;
  offeredTools: string[] | null;
  usageCrossCheck: ParsedRun["usageCrossCheck"] | null;
  cwdWasEmpty: boolean;
  rateLimitWaits: number;
  promptSha256: string;
  /** The arm's MCP server command with the per-run temp paths replaced by placeholders (for checking arms differ only in the proxy). */
  serverCommand: string[];
  stderrTail: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface PlainDeps {
  clients: Record<string, PlainClient>;
  outDir: string;
  latencyMs?: number;
  clock?: Clock;
  budget?: LimitBudget;
  stopFile?: string;
  backendRetries?: number;
  backendRetryDelayMs?: number;
  /** Parent folder of the per-run temp folders (tests). */
  tmpBase?: string;
  log?: (line: string) => void;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const countLines = (file: string): number => (existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").length : 0);

/** The server command with run-specific paths replaced, so two runs (and two arms) can be compared as text. */
export function normalizedCommand(server: ServerSpec, paths: RunPaths): string[] {
  return [server.command, ...server.args].map((a) => a.split(paths.dir).join("<run>"));
}

/** Run one spec to the end and write its result file. */
export async function runOnePlain(spec: PlainSpec, deps: PlainDeps): Promise<PlainResult> {
  const clock = deps.clock ?? realClock;
  const id = plainRunId(spec);
  const client = deps.clients[spec.backend];
  if (!client) throw new Error(`no client "${spec.backend}"`);
  mkdirSync(deps.outDir, { recursive: true });
  const prompt = plainPrompt(spec.task, MCP_NAME[spec.workload]);
  const allowedTools = client.name === "codex-cli" ? [...WORKLOAD_TOOLS[spec.workload]] : claudeToolNames(spec.workload);
  const startedAt = new Date(clock.now()).toISOString();

  // Each attempt (a limit retry included) gets a fresh run folder, so a retried run starts from a fresh server.
  let paths: RunPaths | undefined;
  let server: ServerSpec | undefined;
  let output: ClientOutput | undefined;
  const attempt: ModelBackend = {
    name: spec.backend,
    paid: false,
    async call() {
      if (paths) rmSync(paths.dir, { recursive: true, force: true });
      paths = makeRunPaths(spec.workload, deps.tmpBase);
      server = serverSpec(spec.arm, spec.workload, paths, deps.latencyMs ?? DEFAULT_LATENCY_MS);
      output = await client.run({ model: spec.model, prompt, server, allowedTools, runDir: paths.dir, taskId: spec.task.id });
      if (output.timedOut) throw new BackendError(`${spec.backend} timed out after ${output.latencyMs} ms`);
      const parsed = parseClientOutput(client.format, output); // throws RateLimitError / NotLoggedInError / BackendError
      return { text: parsed.text ?? "", usage: parsed.usage, latencyMs: output.latencyMs, raw: parsed };
    },
  };
  try {
    const { reply, waits } = await callModel(
      { backend: attempt, openSession: () => Promise.reject(new Error("unused")), inferred: {}, outDir: deps.outDir, clock, budget: deps.budget, stopFile: deps.stopFile, backendRetries: deps.backendRetries, backendRetryDelayMs: deps.backendRetryDelayMs, log: deps.log },
      { model: spec.model, system: "", prompt },
    );
    const parsed = reply.raw as ParsedRun;
    const p = paths as RunPaths;
    const out = output as ClientOutput;
    const final = extractFinal(parsed.text);
    const writes = spec.workload === "mock" && existsSync(p.writeLog) ? readWriteLog(p.writeLog) : [];
    const grade = gradeRun(spec.task, { final, writes });
    const u = parsed.usage;
    const result: PlainResult = {
      v: PLAIN_RESULT_VERSION,
      id,
      status: "done",
      workload: spec.workload,
      backend: spec.backend,
      model: modelSlug(spec.backend, spec.model),
      arm: spec.arm,
      task: spec.task.id,
      category: spec.task.category,
      rep: spec.rep,
      pass: grade.pass,
      answerOk: grade.answerOk,
      stateOk: grade.stateOk,
      final: final ?? null,
      refused: isRefusal(final, grade.pass),
      gradeReasons: grade.reasons,
      turns: parsed.rounds,
      toolCalls: parsed.toolCalls,
      toolErrors: parsed.toolErrors,
      toolsCalled: parsed.toolsCalled,
      shellCalls: parsed.shellCalls,
      numTurns: parsed.numTurns ?? null,
      clientError: parsed.clientError ?? null,
      usage: u,
      totalTokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens,
      wallMs: out.latencyMs,
      duplicateWrites: grade.duplicates,
      unexpectedWrites: grade.unexpectedWrites,
      missingWrites: grade.missingWrites,
      serverStarted: spec.workload === "mock" ? existsSync(p.writeLog) : null,
      driftEvents: countLines(path.join(p.typegenDir, "drift.jsonl")),
      mcpServers: parsed.mcpServers ?? null,
      offeredTools: parsed.offeredTools ?? null,
      usageCrossCheck: parsed.usageCrossCheck ?? null,
      cwdWasEmpty: out.cwdWasEmpty,
      rateLimitWaits: waits,
      promptSha256: sha(prompt),
      serverCommand: normalizedCommand(server as ServerSpec, p),
      stderrTail: out.stderr ? out.stderr.slice(-2000) : null,
      startedAt,
      finishedAt: new Date(clock.now()).toISOString(),
    };
    writeFileSync(path.join(deps.outDir, `${id}.raw.jsonl`), out.stdout);
    writeAtomic(path.join(deps.outDir, `${id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (paths) rmSync(paths.dir, { recursive: true, force: true });
  }
}

/** A finished run's result, or undefined (missing, partial or invalid file). */
export function readPlainResult(outDir: string, id: string): PlainResult | undefined {
  const file = path.join(outDir, `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as PlainResult;
    return r.v === PLAIN_RESULT_VERSION && r.status === "done" && r.id === id ? r : undefined;
  } catch {
    return undefined;
  }
}

export function loadPlainResults(dir: string): PlainResult[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readPlainResult(dir, f.slice(0, -5)))
    .filter((r): r is PlainResult => r !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface PlainSummary {
  planned: number;
  skipped: number;
  ran: number;
  capped: number;
  /** Runs not started because --limit was reached. */
  limited: number;
  stoppedBy?: "stop-file" | "limit-budget" | "not-logged-in" | "backend-error";
  message?: string;
  results: PlainResult[];
}

export async function runPlain(plan: PlainSpec[], deps: PlainDeps & { maxRuns: number; limit?: number }): Promise<PlainSummary> {
  const log = deps.log ?? (() => undefined);
  const finished = new Map<string, number>();
  for (const r of loadPlainResults(deps.outDir)) finished.set(r.backend, (finished.get(r.backend) ?? 0) + 1);
  const summary: PlainSummary = { planned: plan.length, skipped: 0, ran: 0, capped: 0, limited: 0, results: [] };
  const budget = deps.budget ?? new LimitBudget(30 * 60_000, 24 * 3_600_000);
  for (const [i, spec] of plan.entries()) {
    const id = plainRunId(spec);
    if (readPlainResult(deps.outDir, id)) {
      summary.skipped += 1;
      continue;
    }
    if ((finished.get(spec.backend) ?? 0) >= deps.maxRuns) {
      summary.capped += 1;
      continue;
    }
    if (deps.limit !== undefined && summary.ran >= deps.limit) {
      summary.limited += 1;
      continue;
    }
    if (deps.stopFile && existsSync(deps.stopFile)) {
      summary.stoppedBy = "stop-file";
      summary.message = `${deps.stopFile} exists: stopped before run ${id}`;
      break;
    }
    try {
      const r = await runOnePlain(spec, { ...deps, budget });
      summary.ran += 1;
      summary.results.push(r);
      finished.set(spec.backend, (finished.get(spec.backend) ?? 0) + 1);
      log(
        `[${i + 1}/${plan.length}] ${id}: ${r.pass ? "PASS" : "FAIL"}, ${r.turns} round(s), ${r.toolCalls} tool call(s), ${r.usage.output_tokens} output tokens, ${Math.round(r.wallMs / 1000)} s${r.pass ? "" : ` (${r.gradeReasons.join("; ") || r.clientError || "no FINAL"})`}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof StopRequested) summary.stoppedBy = "stop-file";
      else if (e instanceof LimitBudgetExhausted) summary.stoppedBy = "limit-budget";
      else if (e instanceof NotLoggedInError) summary.stoppedBy = "not-logged-in";
      else if (e instanceof BackendError) summary.stoppedBy = "backend-error";
      else throw e;
      summary.message = `run ${id} not finished: ${msg}`;
      break;
    }
  }
  if (summary.capped > 0) log(`${summary.capped} run(s) not started: BENCH_MAX_RUNS (${deps.maxRuns}) reached for a backend`);
  return summary;
}
