// Benchmark harness entry point (BENCHMARK.md). Sequential, resumable, interleaved.
//
//   npm run bench -- --dry-run                       fake backend, arms C and D on 2 pilot tasks, no model calls
//   npm run bench -- --set smoke|pilot|full [--backend claude-cli] [--models a,b] [--tasks id,id] [--reps n]
//
// Results: bench/results/raw/<arm>-<model>-<task>-<rep>.json (+ .jsonl per turn); --dry-run writes to
// bench/results/dry-run/. Create bench/STOP to stop cleanly before the next run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { EmitTool } from "../src/emit/ts.js";
import type { SchemasFile } from "../src/infer/run.js";
import { makeBackend } from "./backends/index.js";
import type { ModelBackend } from "./backends/types.js";
import { loadPilot, loadTasks, type Task } from "./grade.js";
import { benchConfig, loadEnv, nullPrices, weakModel } from "./harness/config.js";
import { ARMS, type Arm } from "./harness/prompt.js";
import { DEFAULT_LATENCY_MS, LimitBudget, planRuns, runBench, type RunSpec } from "./harness/runner.js";
import { stdioSession } from "./harness/session.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARM_D_SCHEMAS = path.join(HERE, "arm-d", "mock-github.json");
export const STOP_FILE = path.join(HERE, "STOP");
const RAW_DIR = path.join(HERE, "results", "raw");
const DRY_DIR = path.join(HERE, "results", "dry-run");

/** Arm D's inferred return types, built from seed-1 traffic by bench/warmup.ts. */
export function loadArmD(file = ARM_D_SCHEMAS): Record<string, EmitTool> {
  let parsed: SchemasFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as SchemasFile;
  } catch {
    throw new Error(`cannot read ${file}: run "npm run bench:warmup" first`);
  }
  return parsed.tools;
}

/** Smoke set: the first pilot task of each of these categories (3 tasks). */
export function smokeTasks(tasks: Task[], pilot: string[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const pilotTasks = pilot.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
  return ["control", "nested", "pagination"].map((c) => pilotTasks.find((t) => t.category === c)).filter((t): t is Task => t !== undefined);
}

const list = (v: string | undefined): string[] | undefined => v?.split(",").map((s) => s.trim()).filter((s) => s !== "");

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      set: { type: "string" },
      backend: { type: "string" },
      models: { type: "string" },
      tasks: { type: "string" },
      reps: { type: "string" },
      arms: { type: "string" },
      out: { type: "string" },
      latency: { type: "string" },
    },
    strict: true,
  });
  const dry = values["dry-run"];
  const allTasks = loadTasks();
  const pilot = loadPilot();
  if (!dry && !values.set) {
    process.stderr.write("bench: pass --set smoke|pilot|full (or --dry-run)\n");
    return 2;
  }
  const set = dry ? "dry-run" : (values.set as string);
  if (!["dry-run", "smoke", "pilot", "full"].includes(set)) {
    process.stderr.write(`bench: unknown set "${set}"\n`);
    return 2;
  }

  // --dry-run never reads bench/.env and never touches a model CLI.
  const cfg = benchConfig(dry ? {} : loadEnv(path.join(HERE, ".env")));
  const backendNames = dry ? ["fake"] : (list(values.backend) ?? cfg.backends);
  if (dry && values.backend && values.backend !== "fake") {
    process.stderr.write("bench: --dry-run always uses the fake backend\n");
    return 2;
  }

  let tasks: Task[];
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const wanted = list(values.tasks);
  if (wanted) {
    const missing = wanted.filter((id) => !byId.has(id));
    if (missing.length) {
      process.stderr.write(`bench: unknown task(s) ${missing.join(", ")}\n`);
      return 2;
    }
    tasks = wanted.map((id) => byId.get(id) as Task);
  } else if (set === "dry-run") tasks = pilot.slice(0, 2).map((id) => byId.get(id) as Task);
  else if (set === "smoke") tasks = smokeTasks(allTasks, pilot);
  else if (set === "pilot") tasks = pilot.map((id) => byId.get(id) as Task);
  else tasks = allTasks;

  const reps = values.reps ? Number(values.reps) : set === "pilot" ? 2 : set === "full" ? 5 : 1;
  if (!Number.isInteger(reps) || reps < 1) {
    process.stderr.write("bench: --reps must be a positive integer\n");
    return 2;
  }
  const arms = (list(values.arms) ?? [...ARMS]) as Arm[];
  if (arms.some((a) => !ARMS.includes(a))) {
    process.stderr.write("bench: --arms takes C and/or D\n");
    return 2;
  }

  const backends: Record<string, ModelBackend> = {};
  const planBackends: { name: string; models: (string | undefined)[] }[] = [];
  for (const name of backendNames) {
    backends[name] = makeBackend(name, { codexEffort: cfg.codexEffort });
    const all = list(values.models) ?? cfg.models[name] ?? [undefined];
    planBackends.push({ name, models: set === "smoke" ? [weakModel(name, all)] : all });
    if (backends[name].paid) {
      const nulls = nullPrices(JSON.parse(readFileSync(path.join(HERE, "prices.json"), "utf8")));
      if (nulls.length) {
        process.stderr.write(`bench: refusing a paid run while prices are null: ${nulls.join(", ")}\n`);
        return 2;
      }
    }
  }

  const plan: RunSpec[] = planRuns({ tasks, reps, backends: planBackends, arms });
  const outDir = values.out ? path.resolve(values.out) : dry ? DRY_DIR : RAW_DIR;
  const latencyMs = values.latency !== undefined ? Number(values.latency) : dry ? 0 : DEFAULT_LATENCY_MS;
  const inferred = arms.includes("D") ? loadArmD() : {};
  const log = (l: string): void => {
    console.log(l);
  };
  log(`bench: set ${set}, ${plan.length} run(s) planned (${tasks.length} task(s) x ${reps} rep(s) x arms ${arms.join("+")}), backends ${backendNames.join(", ")}, results in ${path.relative(process.cwd(), outDir) || outDir}`);

  const summary = await runBench(plan, {
    backends,
    openSession: stdioSession,
    inferred,
    outDir,
    stopFile: STOP_FILE,
    latencyMs,
    maxRuns: cfg.maxRuns,
    budget: new LimitBudget(cfg.rateLimitSleepMs, cfg.maxWaitMs),
    log,
  });
  log(`bench: ${summary.ran} run(s) done, ${summary.skipped} already finished (skipped), ${summary.capped} capped${summary.stoppedBy ? `; stopped: ${summary.message}` : ""}`);
  if (summary.stoppedBy === "not-logged-in") {
    log("bench: WAITING-HUMAN: sign in to the CLI named above, then rerun (finished runs are kept)");
    return 4;
  }
  if (summary.stoppedBy === "limit-budget") return 3;
  if (summary.stoppedBy === "backend-error") return 1;
  return 0;
}

function isEntryPoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`bench: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
