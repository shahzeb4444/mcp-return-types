// The benchmark loop (BENCHMARK.md "Backends", "Models and reps", "Logged per model turn").
//   - one run = (backend, model, arm, task, rep): a fresh mock server on seed 2, up to 12 model turns;
//   - every turn is appended to <out>/<id>.jsonl, the finished run is written to <out>/<id>.json;
//   - finished runs (valid .json) are skipped, so a restart resumes; a half-done run starts over;
//   - rate/usage limits: sleep (default 30 min) and retry the same turn, up to BENCH_MAX_WAIT_HOURS in all;
//   - bench/STOP stops cleanly before the next run; BENCH_MAX_RUNS caps finished runs per backend;
//   - strictly sequential, arms interleaved by (task, rep) in a seeded random order.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EmitTool } from "../../src/emit/ts.js";
import { gradeRun, type GradeResult, type Task } from "../grade.js";
import { BackendError, NotLoggedInError, RateLimitError, type ModelBackend, type ModelReply, type ModelRequest, type Usage } from "../backends/types.js";
import { malformedFeedback, malformedFeedbackEnvelope, parseReply } from "./protocol.js";
import { ARMS, buildStubs, buildSystemPrompt, MAX_TURNS, renderConversation, sandboxFeedback, type Arm, type Message } from "./prompt.js";
import { runSandbox, type SandboxResult } from "./sandbox.js";
import type { OpenSession } from "./session.js";

export const RESULT_VERSION = 1;
export const EVAL_SEED = 2;
export const DEFAULT_LATENCY_MS = 150;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface RunSpec {
  backend: string;
  /** Pinned model ID, or undefined for the CLI's default model. */
  model: string | undefined;
  arm: Arm;
  task: Task;
  rep: number;
}

export const modelSlug = (backend: string, model: string | undefined): string =>
  (model ?? `${backend.replace(/-cli$/, "")}-default`).replace(/[^A-Za-z0-9._-]+/g, "_");
/** `<arm>-<model>-<task>-<rep>` (BENCHMARK.md). */
export const runId = (s: Pick<RunSpec, "backend" | "model" | "arm" | "rep"> & { task: { id: string } }): string =>
  `${s.arm}-${modelSlug(s.backend, s.model)}-${s.task.id}-${s.rep}`;

/** Arm order per (task, rep, model): seeded, so a restart plans the same order. */
export function armOrder(taskId: string, rep: number, model: string): Arm[] {
  const byte = createHash("sha256").update(`${taskId}:${rep}:${model}`).digest()[0] as number;
  return byte % 2 === 0 ? [...ARMS] : [...ARMS].reverse();
}

/** Interleaved plan: rep, then task, then backend and model, then both arms in seeded random order. */
export function planRuns(opts: {
  tasks: Task[];
  reps: number;
  backends: { name: string; models: (string | undefined)[] }[];
  arms?: readonly Arm[];
}): RunSpec[] {
  const arms = opts.arms ?? ARMS;
  const out: RunSpec[] = [];
  for (let rep = 1; rep <= opts.reps; rep++) {
    for (const task of opts.tasks) {
      for (const b of opts.backends) {
        for (const model of b.models) {
          for (const arm of armOrder(task.id, rep, modelSlug(b.name, model))) {
            if (arms.includes(arm)) out.push({ backend: b.name, model, arm, task, rep });
          }
        }
      }
    }
  }
  return out;
}

export interface TurnLog {
  type: "turn";
  backend: string;
  arm: Arm;
  model: string;
  task: string;
  rep: number;
  turn: number;
  input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens?: number | null;
  latency_ms: number;
  reply_kind: "code" | "final" | "malformed";
  malformed_reason?: string;
  tool_calls: number;
  sandbox_status?: SandboxResult["status"];
  sandbox_exception?: string;
  sandbox_ms?: number;
  truncated_chars?: number;
  rewrite: boolean;
  final_answer?: string;
  rate_limit_waits: number;
  reply: string;
  raw: unknown;
}

export interface RunResult {
  v: typeof RESULT_VERSION;
  id: string;
  status: "done";
  backend: string;
  arm: Arm;
  model: string;
  task: string;
  category: string;
  rep: number;
  pass: boolean;
  answerOk: boolean;
  stateOk: boolean;
  final: string | null;
  endedBy: "final" | "max-turns";
  turns: number;
  toolCalls: number;
  sandboxRuns: number;
  exceptions: number;
  timeouts: number;
  rewrites: number;
  /** BENCHMARK.md: failed sandbox runs (exception or timeout) + code blocks sent directly after one. */
  codeErrors: number;
  malformed: number;
  duplicateWrites: number;
  unexpectedWrites: number;
  missingWrites: number;
  gradeReasons: string[];
  usage: Required<Pick<Usage, "input_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens" | "output_tokens">> & { reasoning_output_tokens: number };
  /** Turns whose usage was missing a field (0 expected; M6 checks the real field names). */
  turnsMissingUsage: number;
  modelLatencyMs: number;
  systemPromptSha256: string;
  startedAt: string;
  finishedAt: string;
}

/** Shared wait budget for rate/usage limits (BENCH_MAX_WAIT_HOURS over one harness invocation). */
export class LimitBudget {
  waitedMs = 0;
  constructor(
    readonly sleepMs: number,
    readonly maxWaitMs: number,
  ) {}
}

export class LimitBudgetExhausted extends Error {
  override name = "LimitBudgetExhausted";
}
export class StopRequested extends Error {
  override name = "StopRequested";
}

export interface RunDeps {
  backend: ModelBackend;
  openSession: OpenSession;
  /** Arm D return types by tool name (bench/arm-d/mock-github.json). */
  inferred: Readonly<Record<string, EmitTool>>;
  outDir: string;
  clock?: Clock;
  budget?: LimitBudget;
  stopFile?: string;
  latencyMs?: number;
  sandboxTimeoutMs?: number;
  /** Short retries for other CLI failures (BackendError). */
  backendRetries?: number;
  backendRetryDelayMs?: number;
  log?: (line: string) => void;
}

/** One model turn, with the rate-limit sleep-and-retry loop. */
export async function callModel(deps: RunDeps, req: ModelRequest): Promise<{ reply: ModelReply; waits: number }> {
  const clock = deps.clock ?? realClock;
  const budget = deps.budget ?? new LimitBudget(30 * 60_000, 24 * 3_600_000);
  const log = deps.log ?? (() => undefined);
  let waits = 0;
  let failures = 0;
  for (;;) {
    try {
      return { reply: await deps.backend.call(req), waits };
    } catch (e) {
      if (e instanceof RateLimitError) {
        if (budget.waitedMs + budget.sleepMs > budget.maxWaitMs) {
          throw new LimitBudgetExhausted(`rate/usage limits: already waited ${Math.round(budget.waitedMs / 60_000)} min, the limit is ${Math.round(budget.maxWaitMs / 60_000)} min (${e.message})`);
        }
        log(`${deps.backend.name}: ${e.message}; sleeping ${Math.round(budget.sleepMs / 60_000)} min, then retrying the same turn`);
        await clock.sleep(budget.sleepMs);
        budget.waitedMs += budget.sleepMs;
        waits += 1;
        if (deps.stopFile && existsSync(deps.stopFile)) throw new StopRequested("bench/STOP found while waiting for a rate limit");
        continue;
      }
      if (e instanceof BackendError && failures < (deps.backendRetries ?? 2)) {
        failures += 1;
        log(`${deps.backend.name}: ${e.message}; retry ${failures} in ${Math.round((deps.backendRetryDelayMs ?? 60_000) / 1000)} s`);
        await clock.sleep(deps.backendRetryDelayMs ?? 60_000);
        continue;
      }
      throw e;
    }
  }
}

const n = (v: number | undefined): number | null => (typeof v === "number" ? v : null);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Run one (backend, model, arm, task, rep) to the end and write its result file. */
export async function runOne(spec: RunSpec, deps: RunDeps): Promise<RunResult> {
  const clock = deps.clock ?? realClock;
  const id = runId(spec);
  const model = modelSlug(spec.backend, spec.model);
  mkdirSync(deps.outDir, { recursive: true });
  const turnsFile = path.join(deps.outDir, `${id}.jsonl`);
  writeFileSync(turnsFile, ""); // a half-done earlier attempt starts over
  const startedAt = new Date(clock.now()).toISOString();

  const session = await deps.openSession({ seed: EVAL_SEED, latencyMs: deps.latencyMs ?? DEFAULT_LATENCY_MS });
  try {
    const system = buildSystemPrompt(buildStubs(session.tools, spec.arm, spec.arm === "D" ? deps.inferred : {}), deps.backend.replyFormat ?? "fenced");
    const toolNames = session.tools.map((t) => t.name);
    const messages: Message[] = [{ role: "user", content: spec.task.prompt }];
    const totals = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    let final: string | undefined;
    let turns = 0;
    let toolCalls = 0;
    let sandboxRuns = 0;
    let exceptions = 0;
    let timeouts = 0;
    let rewrites = 0;
    let malformed = 0;
    let missingUsage = 0;
    let modelLatencyMs = 0;
    let lastRunFailed = false;

    while (turns < MAX_TURNS && final === undefined) {
      turns += 1;
      const { reply, waits } = await callModel(deps, { model: spec.model, system, prompt: renderConversation(messages) });
      modelLatencyMs += reply.latencyMs;
      const u = reply.usage;
      if ([u.input_tokens, u.output_tokens].some((x) => typeof x !== "number")) missingUsage += 1;
      totals.input_tokens += u.input_tokens ?? 0;
      totals.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
      totals.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      totals.output_tokens += u.output_tokens ?? 0;
      totals.reasoning_output_tokens += u.reasoning_output_tokens ?? 0;

      const parsed = reply.parsed ?? parseReply(reply.text);
      messages.push({ role: "assistant", content: reply.text });
      const line: TurnLog = {
        type: "turn",
        backend: spec.backend,
        arm: spec.arm,
        model,
        task: spec.task.id,
        rep: spec.rep,
        turn: turns,
        input_tokens: n(u.input_tokens),
        cache_creation_input_tokens: n(u.cache_creation_input_tokens),
        cache_read_input_tokens: n(u.cache_read_input_tokens),
        output_tokens: n(u.output_tokens),
        ...(u.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: u.reasoning_output_tokens } : {}),
        latency_ms: reply.latencyMs,
        reply_kind: parsed.kind,
        tool_calls: 0,
        rewrite: false,
        rate_limit_waits: waits,
        reply: reply.text,
        raw: reply.raw,
      };
      if (parsed.kind === "final") {
        final = parsed.answer;
        line.final_answer = parsed.answer;
      } else if (parsed.kind === "malformed") {
        malformed += 1;
        line.malformed_reason = parsed.reason;
        messages.push({ role: "user", content: deps.backend.replyFormat === "json-envelope" ? malformedFeedbackEnvelope(parsed.reason) : malformedFeedback(parsed.reason) });
      } else {
        if (lastRunFailed) {
          rewrites += 1;
          line.rewrite = true;
        }
        const res = await runSandbox(parsed.code, { tools: toolNames, callTool: (name, args) => session.callTool(name, args), timeoutMs: deps.sandboxTimeoutMs });
        sandboxRuns += 1;
        toolCalls += res.toolCalls;
        if (res.status === "exception") exceptions += 1;
        if (res.status === "timeout") timeouts += 1;
        lastRunFailed = res.status !== "ok";
        Object.assign(line, {
          tool_calls: res.toolCalls,
          sandbox_status: res.status,
          sandbox_ms: res.durationMs,
          truncated_chars: res.truncatedChars,
          ...(res.error ? { sandbox_exception: res.error } : {}),
        });
        messages.push({ role: "user", content: sandboxFeedback(res.output) });
      }
      appendFileSync(turnsFile, `${JSON.stringify(line)}\n`);
    }

    const grade: GradeResult = gradeRun(spec.task, { final, writes: session.writes() });
    const result: RunResult = {
      v: RESULT_VERSION,
      id,
      status: "done",
      backend: spec.backend,
      arm: spec.arm,
      model,
      task: spec.task.id,
      category: spec.task.category,
      rep: spec.rep,
      pass: grade.pass,
      answerOk: grade.answerOk,
      stateOk: grade.stateOk,
      final: final ?? null,
      endedBy: final === undefined ? "max-turns" : "final",
      turns,
      toolCalls,
      sandboxRuns,
      exceptions,
      timeouts,
      rewrites,
      codeErrors: exceptions + timeouts + rewrites,
      malformed,
      duplicateWrites: grade.duplicates,
      unexpectedWrites: grade.unexpectedWrites,
      missingWrites: grade.missingWrites,
      gradeReasons: grade.reasons,
      usage: totals,
      turnsMissingUsage: missingUsage,
      modelLatencyMs,
      systemPromptSha256: sha(system),
      startedAt,
      finishedAt: new Date(clock.now()).toISOString(),
    };
    appendFileSync(turnsFile, `${JSON.stringify({ type: "result", ...result })}\n`);
    writeAtomic(path.join(deps.outDir, `${id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await session.close();
  }
}

/** A finished run's result, or undefined if the run has not finished (missing, partial or invalid file). */
export function readResult(outDir: string, id: string): RunResult | undefined {
  const file = path.join(outDir, `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as RunResult;
    return r.v === RESULT_VERSION && r.status === "done" && r.id === id ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Finished runs per backend in the results folder (for the per-backend cap). */
export function finishedByBackend(outDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(outDir)) return counts;
  for (const f of readdirSync(outDir)) {
    if (!f.endsWith(".json")) continue;
    const r = readResult(outDir, f.slice(0, -5));
    if (r) counts.set(r.backend, (counts.get(r.backend) ?? 0) + 1);
  }
  return counts;
}

export interface BenchSummary {
  planned: number;
  skipped: number;
  ran: number;
  /** Runs not started because a backend reached BENCH_MAX_RUNS. */
  capped: number;
  stoppedBy?: "stop-file" | "limit-budget" | "not-logged-in" | "backend-error";
  message?: string;
  results: RunResult[];
}

export async function runBench(
  plan: RunSpec[],
  deps: Omit<RunDeps, "backend"> & { backends: Record<string, ModelBackend>; maxRuns: number },
): Promise<BenchSummary> {
  const log = deps.log ?? (() => undefined);
  const finished = finishedByBackend(deps.outDir);
  const summary: BenchSummary = { planned: plan.length, skipped: 0, ran: 0, capped: 0, results: [] };
  const budget = deps.budget ?? new LimitBudget(30 * 60_000, 24 * 3_600_000);
  for (const [i, spec] of plan.entries()) {
    const id = runId(spec);
    if (readResult(deps.outDir, id)) {
      summary.skipped += 1;
      continue;
    }
    if ((finished.get(spec.backend) ?? 0) >= deps.maxRuns) {
      summary.capped += 1;
      continue;
    }
    if (deps.stopFile && existsSync(deps.stopFile)) {
      summary.stoppedBy = "stop-file";
      summary.message = `${deps.stopFile} exists: stopped before run ${id}`;
      break;
    }
    const backend = deps.backends[spec.backend];
    if (!backend) throw new Error(`no backend "${spec.backend}"`);
    try {
      const r = await runOne(spec, { ...deps, backend, budget });
      summary.ran += 1;
      summary.results.push(r);
      finished.set(spec.backend, (finished.get(spec.backend) ?? 0) + 1);
      log(
        `[${i + 1}/${plan.length}] ${id}: ${r.pass ? "PASS" : "FAIL"} in ${r.turns} turn(s), ${r.toolCalls} tool call(s), ${r.codeErrors} code error(s), ${r.usage.output_tokens} output tokens${r.pass ? "" : ` (${r.gradeReasons.join("; ") || r.endedBy})`}`,
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
