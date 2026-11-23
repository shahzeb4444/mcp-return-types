// Environment check before a real benchmark run (M7). Run it in the PowerShell window you will run the
// benchmark from:
//
//   npm run bench:preflight
//
// It prints KEY NAMES and OK / WARN / ERROR only, never a value, and exits 1 if any check is an ERROR.
// Checks: the API key variables are unset; bench/.env exists and parses; every model ID is pinned (no
// alias); BENCH_MAX_RUNS is set; no bench/STOP file; the git working tree is clean (results folders under
// bench/results/ are ignored, so a half-finished pilot does not block the next block).
import spawn from "cross-spawn";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchConfig, parseEnvFile, WEAK_MODEL } from "./harness/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

export type Level = "OK" | "WARN" | "ERROR";
export interface Check {
  level: Level;
  name: string;
  detail: string;
}

export const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;
export const KNOWN_KEYS = new Set([
  "BENCH_BACKENDS",
  "BENCH_CLAUDE_MODELS",
  "BENCH_CODEX_MODELS",
  "BENCH_CODEX_EFFORT",
  "BENCH_MAX_RUNS",
  "BENCH_RATE_LIMIT_SLEEP_MIN",
  "BENCH_MAX_WAIT_HOURS",
  "BENCH_BACKEND_EXTRA",
]);
/** Runs per backend in the pilot (12 tasks x 2 reps x 2 arms x 2 models). */
export const PILOT_RUNS_PER_BACKEND = 96;

const ALIASES = new Set(["haiku", "sonnet", "opus", "fable", "default", "latest", "mini", "luna", "sol"]);

/** A pinned model ID: not an alias, has a version digit, no "latest". */
export function isPinnedModelId(id: string): boolean {
  const m = id.trim().toLowerCase();
  return m !== "" && !ALIASES.has(m) && !m.includes("latest") && /\d/.test(m) && /^[a-z][a-z0-9._-]*$/.test(m);
}

export function checkApiKeys(env: NodeJS.ProcessEnv): Check[] {
  return API_KEYS.map((k) =>
    env[k] === undefined || env[k] === ""
      ? { level: "OK", name: k, detail: "unset" }
      : { level: "ERROR", name: k, detail: `is set in this shell (it would switch a CLI to paid API billing); run: Remove-Item Env:${k}` },
  );
}

/** Syntax of bench/.env: every non-blank, non-comment line is KEY=VALUE. Reports line numbers and key names only. */
export function checkEnvSyntax(text: string): Check[] {
  const checks: Check[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) {
      checks.push({ level: "ERROR", name: "bench/.env", detail: `line ${i + 1} is not KEY=VALUE` });
      return;
    }
    const k = m[1] as string;
    if ((API_KEYS as readonly string[]).includes(k)) checks.push({ level: "ERROR", name: k, detail: "is set in bench/.env; delete that line" });
    else if (!KNOWN_KEYS.has(k)) checks.push({ level: "WARN", name: k, detail: "unknown key in bench/.env (ignored by the harness)" });
  });
  return checks;
}

function listEntries(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const positiveNumber = (v: string): boolean => v.trim() !== "" && Number(v) > 0;

/**
 * The settings the harness will use: bench/.env with BENCH_* from the process environment on top (the same
 * merge as bench/harness/config.ts loadEnv). `fromProcess` names the keys that came from the process.
 */
export function checkSettings(merged: Record<string, string | undefined>, fromProcess: ReadonlySet<string>): Check[] {
  const checks: Check[] = [];
  const src = (k: string): string => (fromProcess.has(k) ? " (from the process environment, which overrides bench/.env)" : "");
  for (const [k, backend] of [
    ["BENCH_CLAUDE_MODELS", "claude-cli"],
    ["BENCH_CODEX_MODELS", "codex-cli"],
  ] as const) {
    const entries = listEntries(merged[k]);
    if (entries.length === 0) {
      checks.push({ level: "ERROR", name: k, detail: `not set; set pinned IDs as in bench/.env.example${src(k)}` });
      continue;
    }
    const bad = entries.map((e, i) => (isPinnedModelId(e) ? -1 : i + 1)).filter((i) => i > 0);
    if (bad.length) checks.push({ level: "ERROR", name: k, detail: `entry ${bad.join(", ")} is an alias or not a pinned model ID${src(k)}` });
    else checks.push({ level: "OK", name: k, detail: `${entries.length} pinned model ID(s)${src(k)}` });
    const weak = WEAK_MODEL[backend];
    if (weak !== undefined && !entries.includes(weak)) checks.push({ level: "WARN", name: k, detail: `does not list the weak model ${weak} (the full run needs it)` });
  }
  const maxRuns = merged.BENCH_MAX_RUNS;
  if (maxRuns === undefined || maxRuns.trim() === "") checks.push({ level: "ERROR", name: "BENCH_MAX_RUNS", detail: "not set; set a per-backend cap, e.g. as in bench/.env.example" });
  else if (!positiveNumber(maxRuns) || !Number.isInteger(Number(maxRuns))) checks.push({ level: "ERROR", name: "BENCH_MAX_RUNS", detail: `is not a positive integer${src("BENCH_MAX_RUNS")}` });
  else if (Number(maxRuns) < PILOT_RUNS_PER_BACKEND) checks.push({ level: "WARN", name: "BENCH_MAX_RUNS", detail: `is below ${PILOT_RUNS_PER_BACKEND}, the pilot runs per backend; the run will stop early${src("BENCH_MAX_RUNS")}` });
  else checks.push({ level: "OK", name: "BENCH_MAX_RUNS", detail: `set${src("BENCH_MAX_RUNS")}` });
  for (const k of ["BENCH_RATE_LIMIT_SLEEP_MIN", "BENCH_MAX_WAIT_HOURS"]) {
    const v = merged[k];
    if (v === undefined || v.trim() === "") checks.push({ level: "OK", name: k, detail: "not set (harness default)" });
    else if (!positiveNumber(v)) checks.push({ level: "ERROR", name: k, detail: `is not a positive number${src(k)}` });
    else checks.push({ level: "OK", name: k, detail: `set${src(k)}` });
  }
  const effort = merged.BENCH_CODEX_EFFORT;
  if (effort !== undefined && effort.trim() !== "" && !["minimal", "low", "medium", "high", "xhigh"].includes(effort.trim())) {
    checks.push({ level: "WARN", name: "BENCH_CODEX_EFFORT", detail: "is not one of minimal, low, medium, high, xhigh" });
  }
  try {
    benchConfig(merged);
    checks.push({ level: "OK", name: "harness config", detail: "accepted by bench/harness/config.ts" });
  } catch {
    checks.push({ level: "ERROR", name: "harness config", detail: "rejected by bench/harness/config.ts (see the errors above)" });
  }
  return checks;
}

/** `git status --porcelain` output: anything outside bench/results/ makes the tree dirty. */
export function checkGitStatus(porcelain: string | undefined): Check {
  if (porcelain === undefined) return { level: "ERROR", name: "git", detail: "could not run git status (is git on PATH, and is this the repo folder?)" };
  const paths = porcelain
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((p) => !p.startsWith("bench/results/"));
  if (paths.length === 0) return { level: "OK", name: "git", detail: "working tree clean (bench/results/ ignored)" };
  const shown = paths.slice(0, 10).join(", ");
  return { level: "ERROR", name: "git", detail: `working tree not clean: ${shown}${paths.length > 10 ? `, and ${paths.length - 10} more` : ""}; commit or stash, or ask the agent` };
}

export interface PreflightInput {
  env: NodeJS.ProcessEnv;
  /** bench/.env contents, or undefined if the file does not exist. */
  envFileText: string | undefined;
  stopFileExists: boolean;
  gitPorcelain: string | undefined;
}

export function preflight(input: PreflightInput): Check[] {
  const checks: Check[] = [...checkApiKeys(input.env)];
  if (input.envFileText === undefined) {
    checks.push({ level: "ERROR", name: "bench/.env", detail: "missing; copy bench/.env.example to bench/.env and edit it" });
  } else {
    const syntax = checkEnvSyntax(input.envFileText);
    checks.push(...syntax);
    if (!syntax.some((c) => c.name === "bench/.env" && c.level === "ERROR")) {
      const file = parseEnvFile(input.envFileText);
      checks.push({ level: "OK", name: "bench/.env", detail: `parses; keys: ${Object.keys(file).sort().join(", ") || "(none)"}` });
    }
    const merged: Record<string, string | undefined> = { ...parseEnvFile(input.envFileText) };
    const fromProcess = new Set<string>();
    for (const k of Object.keys(input.env)) {
      if (k.startsWith("BENCH_")) {
        merged[k] = input.env[k];
        fromProcess.add(k);
      }
    }
    checks.push(...checkSettings(merged, fromProcess));
  }
  checks.push(
    input.stopFileExists
      ? { level: "ERROR", name: "bench/STOP", detail: "exists, so the benchmark would stop at once; run: Remove-Item bench\\STOP" }
      : { level: "OK", name: "bench/STOP", detail: "absent" },
  );
  checks.push(checkGitStatus(input.gitPorcelain));
  return checks;
}

export function renderChecks(checks: readonly Check[]): string {
  const lines = checks.map((c) => `${c.level.padEnd(5)} ${c.name}: ${c.detail}`);
  const errors = checks.filter((c) => c.level === "ERROR").length;
  const warns = checks.filter((c) => c.level === "WARN").length;
  lines.push(errors ? `preflight: ${errors} ERROR(s), ${warns} warning(s): fix the errors before running the benchmark` : `preflight: OK (${warns} warning(s))`);
  return `${lines.join("\n")}\n`;
}

function gitPorcelain(): string | undefined {
  const r = spawn.sync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: REPO, encoding: "utf8", windowsHide: true });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : undefined;
}

function main(): number {
  const envFile = path.join(HERE, ".env");
  const checks = preflight({
    env: process.env,
    envFileText: existsSync(envFile) ? readFileSync(envFile, "utf8") : undefined,
    stopFileExists: existsSync(path.join(HERE, "STOP")),
    gitPorcelain: gitPorcelain(),
  });
  process.stdout.write(renderChecks(checks));
  return checks.some((c) => c.level === "ERROR") ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
