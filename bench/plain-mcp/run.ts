// Plain-MCP test entry point (BENCHMARK.md Amendment 3, docs/PLAIN-MCP.md). Sequential, resumable, interleaved.
//
//   node --import tsx bench/plain-mcp/run.ts --dry-run                      fake client, no model call
//   node --import tsx bench/plain-mcp/run.ts --backend claude-cli [--workload mock|everything] [--arms "P,S"]
//        [--tasks "id,id"] [--reps n] [--model id] [--limit n] [--out dir] [--latency ms] [--codex-sandbox mode]
//
// Defaults: workload mock, arms P and S, the 6 Amendment 3 tasks (everything: its 3 tasks), 2 reps (everything: 1),
// both backends, claude-haiku-5-5 and gpt-6.2-sol, results in bench/results/plain-mcp (everything:
// bench/results/plain-mcp-everything). Create bench/STOP to stop cleanly before the next run.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadTasks, type Task } from "../grade.js";
import { benchConfig, loadEnv } from "../harness/config.js";
import { LimitBudget } from "../harness/runner.js";
import { SOLVERS } from "../reference-solver.js";
import { claudePlainClient, CODEX_PLAIN, codexPlainClient, fakePlainClient, type FakeSolver, type PlainClient } from "./clients.js";
import { DEFAULT_LATENCY_MS, DEFAULT_REPS, GATING_ARMS, MOCK_TASK_IDS, PLAIN_ARMS, PLAIN_BACKENDS, PLAIN_MODELS, ROOT, WORKLOADS, type PlainArm, type Workload } from "./config.js";
import { EVERYTHING_SOLVERS, EVERYTHING_TASKS } from "./everything-tasks.js";
import { planPlain, runPlain } from "./runner.js";

const BENCH = path.join(ROOT, "bench");
export const STOP_FILE = path.join(BENCH, "STOP");
export const PLAIN_OUT: Record<Workload, string> = {
  mock: path.join(BENCH, "results", "plain-mcp"),
  everything: path.join(BENCH, "results", "plain-mcp-everything"),
};
/** --dry-run output (bench/results/dry-run is git-ignored). */
export const PLAIN_DRY_OUT = path.join(BENCH, "results", "dry-run", "plain-mcp");

const list = (v: string | undefined): string[] | undefined => v?.split(",").map((s) => s.trim()).filter((s) => s !== "");

export function tasksFor(workload: Workload, ids?: string[]): Task[] {
  const all = workload === "mock" ? loadTasks() : EVERYTHING_TASKS;
  const byId = new Map(all.map((t) => [t.id, t]));
  const wanted = ids ?? (workload === "mock" ? [...MOCK_TASK_IDS] : EVERYTHING_TASKS.map((t) => t.id));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`unknown task(s) for workload ${workload}: ${missing.join(", ")}`);
  return wanted.map((id) => byId.get(id) as Task);
}

/** The fake client's scripted solvers: the reference solver (mock) and the no-harm solvers (everything). */
export const FAKE_SOLVERS: Record<string, FakeSolver> = { ...(SOLVERS as Record<string, FakeSolver>), ...EVERYTHING_SOLVERS };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      backend: { type: "string" },
      workload: { type: "string", default: "mock" },
      arms: { type: "string" },
      tasks: { type: "string" },
      reps: { type: "string" },
      model: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      latency: { type: "string" },
      "codex-sandbox": { type: "string" },
    },
    strict: true,
  });
  const fail = (m: string): number => {
    process.stderr.write(`plain-mcp: ${m}\n`);
    return 2;
  };
  const dry = values["dry-run"];
  const workload = values.workload as Workload;
  if (!WORKLOADS.includes(workload)) return fail(`--workload takes ${WORKLOADS.join(" or ")}`);
  const arms = (list(values.arms) ?? [...GATING_ARMS]) as PlainArm[];
  if (arms.length === 0 || arms.some((a) => !PLAIN_ARMS.includes(a))) return fail(`--arms takes ${PLAIN_ARMS.join(", ")}`);
  let tasks: Task[];
  try {
    tasks = tasksFor(workload, list(values.tasks));
  } catch (e) {
    return fail((e as Error).message);
  }
  const reps = values.reps ? Number(values.reps) : DEFAULT_REPS[workload];
  if (!Number.isInteger(reps) || reps < 1) return fail("--reps must be a positive integer");
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) return fail("--limit must be a positive integer");

  // --dry-run never reads bench/.env and never starts a model CLI.
  const cfg = benchConfig(dry ? {} : loadEnv(path.join(BENCH, ".env")));
  const backendNames = dry ? ["fake"] : (list(values.backend) ?? [...PLAIN_BACKENDS]);
  if (dry && values.backend && values.backend !== "fake") return fail("--dry-run always uses the fake client");
  if (!dry && backendNames.some((b) => !(PLAIN_BACKENDS as readonly string[]).includes(b))) return fail(`--backend takes ${PLAIN_BACKENDS.join(" and/or ")}`);
  if (values.model && backendNames.length !== 1) return fail("--model needs exactly one --backend");

  const clients: Record<string, PlainClient> = {};
  for (const b of backendNames) {
    if (b === "fake") clients[b] = fakePlainClient({ solvers: FAKE_SOLVERS });
    else if (b === "claude-cli") clients[b] = claudePlainClient();
    else clients[b] = codexPlainClient({ ...CODEX_PLAIN, effort: cfg.codexEffort, sandbox: values["codex-sandbox"] ?? CODEX_PLAIN.sandbox });
  }
  const backends = backendNames.map((name) => ({ name, model: values.model ?? (name === "fake" ? "fake" : PLAIN_MODELS[name]) }));
  const plan = planPlain({ workload, tasks, reps, backends, arms });
  const outDir = values.out ? path.resolve(values.out) : dry ? path.join(PLAIN_DRY_OUT, workload) : PLAIN_OUT[workload];
  const latencyMs = values.latency !== undefined ? Number(values.latency) : dry ? 0 : DEFAULT_LATENCY_MS;
  if (!(latencyMs >= 0)) return fail("--latency must be a number of milliseconds");
  const log = (l: string): void => console.log(l);
  log(
    `plain-mcp: workload ${workload}, ${plan.length} run(s) planned (${tasks.length} task(s) x ${reps} rep(s) x arms ${arms.join("+")} x ${backends.map((b) => `${b.name}/${b.model}`).join(", ")})${limit ? `, at most ${limit} new run(s) now` : ""}, results in ${path.relative(process.cwd(), outDir) || outDir}`,
  );
  const summary = await runPlain(plan, {
    clients,
    outDir,
    latencyMs,
    stopFile: STOP_FILE,
    maxRuns: cfg.maxRuns,
    limit,
    budget: new LimitBudget(cfg.rateLimitSleepMs, cfg.maxWaitMs),
    log,
  });
  log(
    `plain-mcp: ${summary.ran} run(s) done, ${summary.skipped} already finished (skipped), ${summary.capped} capped, ${summary.limited} left for later (--limit)${summary.stoppedBy ? `; stopped: ${summary.message}` : ""}`,
  );
  if (summary.stoppedBy === "not-logged-in") {
    log("plain-mcp: WAITING-HUMAN: sign in to the CLI named above, then rerun (finished runs are kept)");
    return 4;
  }
  if (summary.stoppedBy === "limit-budget") return 3;
  if (summary.stoppedBy === "backend-error") return 1;
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`plain-mcp: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
