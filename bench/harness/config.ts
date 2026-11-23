// Benchmark settings from bench/.env (see bench/.env.example) and the process environment (which wins).
// The file is parsed here only; nothing in it is printed. `--dry-run` never reads it.
import { existsSync, readFileSync } from "node:fs";

export interface BenchConfig {
  backends: string[];
  /** Per backend, in the order given. The weak model is picked by ID (see weakModel), not by position. undefined = CLI default. */
  models: Record<string, (string | undefined)[]>;
  /** Per-backend cap on finished runs in the results folder (default 500). */
  maxRuns: number;
  /** Codex reasoning effort (BENCH_CODEX_EFFORT), default medium. */
  codexEffort: string;
  rateLimitSleepMs: number;
  maxWaitMs: number;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).replace(/(^|\s)#.*$/, "").trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1] as string] = value;
  }
  return out;
}

export function loadEnv(file: string | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const fromFile = file && existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const k of Object.keys(env)) if (k.startsWith("BENCH_")) merged[k] = env[k];
  return merged;
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

function positive(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!(n > 0)) throw new Error(`${name} must be a positive number, got "${v}"`);
  return n;
}

/** The weak model per backend (BENCHMARK.md Definitions, confirmed in M6): used by the smoke set and the H1 weak-model criterion. */
export const WEAK_MODEL: Record<string, string | undefined> = { "claude-cli": "claude-haiku-5-5", "codex-cli": "gpt-6-luna" };

/** The weak model if it is in the list, else the first model. */
export function weakModel(backend: string, models: readonly (string | undefined)[]): string | undefined {
  const weak = WEAK_MODEL[backend];
  return weak !== undefined && models.includes(weak) ? weak : models[0];
}

/** Aliases are refused: the benchmark always passes pinned model IDs. */
const ALIASES = new Set(["haiku", "sonnet", "opus", "fable", "default", "latest"]);

export function benchConfig(env: Record<string, string | undefined>): BenchConfig {
  const claudeModels = list(env.BENCH_CLAUDE_MODELS);
  const codexModels = list(env.BENCH_CODEX_MODELS);
  for (const m of [...claudeModels, ...codexModels]) {
    if (ALIASES.has(m.toLowerCase())) throw new Error(`model "${m}" is an alias; use a pinned model ID`);
  }
  return {
    backends: list(env.BENCH_BACKENDS).length ? list(env.BENCH_BACKENDS) : ["claude-cli", "codex-cli"],
    models: {
      "claude-cli": claudeModels.length ? claudeModels : ["claude-haiku-5-5", "claude-sonnet-5-5"],
      "codex-cli": codexModels.length ? codexModels : [undefined],
      fake: ["fake"],
    },
    codexEffort: (env.BENCH_CODEX_EFFORT ?? "").trim() || "medium",
    maxRuns: Math.floor(positive(env.BENCH_MAX_RUNS, "BENCH_MAX_RUNS", 500)),
    rateLimitSleepMs: positive(env.BENCH_RATE_LIMIT_SLEEP_MIN, "BENCH_RATE_LIMIT_SLEEP_MIN", 30) * 60_000,
    maxWaitMs: positive(env.BENCH_MAX_WAIT_HOURS, "BENCH_MAX_WAIT_HOURS", 24) * 3_600_000,
  };
}

/** The paid-run guard (BENCHMARK.md "Cost formula"): every price must be filled in. */
export function nullPrices(pricesJson: unknown): string[] {
  const nulls: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (v === null) nulls.push(at);
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as object)) walk(x, at ? `${at}.${k}` : k);
  };
  walk(pricesJson, "");
  return nulls;
}
