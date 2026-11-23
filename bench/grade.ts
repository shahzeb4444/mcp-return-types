// Pure-code grader for the benchmark tasks (BENCHMARK.md "Tasks"). A run passes when
//   1. its final answer equals the task's answer (number, string or set; parsing is lenient about
//      quotes, `#`, `@`, brackets and case, never about content), and
//   2. its successful writes are exactly the expected writes, with no duplicates and no other writes
//      (read-only tasks expect none), and the replayed final state shows every expected effect.
// The answers in bench/tasks/*.json are for seed 2; for another seed pass `expected` (from the oracles).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorld, type RepoName, type World } from "./mock-server/data.js";
import { callGithubTool, WRITE_TOOLS } from "./mock-server/github.js";
import { duplicateWrites, writeKey, type WriteEntry } from "./mock-server/writelog.js";
import type { Answer, AnswerType, Category, ExpectedWrite } from "./tasks/defs.js";

export const TASKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "tasks");
export const EVAL_SEED = 2;

export interface Task {
  id: string;
  category: Category;
  prompt: string;
  answer_type: AnswerType;
  /** Seed-2 answer (absent for write tasks). */
  answer?: Answer;
  /** Seed-2 expected writes (write tasks only). */
  expected_state?: { writes: ExpectedWrite[] };
}

export interface Expected {
  answer?: Answer;
  writes: ExpectedWrite[];
}

export interface RunOutcome {
  /** The text after `FINAL:` (undefined if the run never gave one). */
  final?: string;
  /** The run's write log (bench/mock-server/writelog.ts). */
  writes: WriteEntry[];
}

export interface GradeResult {
  task: string;
  pass: boolean;
  answerOk: boolean;
  stateOk: boolean;
  duplicates: number;
  missingWrites: number;
  unexpectedWrites: number;
  reasons: string[];
}

export function loadTasks(dir = TASKS_DIR): Task[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "pilot.json")
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Task);
}

export function loadPilot(dir = TASKS_DIR): string[] {
  return (JSON.parse(readFileSync(path.join(dir, "pilot.json"), "utf8")) as { tasks: string[] }).tasks;
}

export const expectedOf = (task: Task): Expected => ({ answer: task.answer, writes: task.expected_state?.writes ?? [] });

// ---------- answers ----------

const unquote = (s: string): string => {
  let t = s.trim();
  for (;;) {
    const m = /^(["'`])([\s\S]*)\1$/.exec(t);
    if (!m) return t;
    t = (m[2] as string).trim();
  }
};
/** Normalization used for strings and set elements: case, outer quotes, a leading # or @, a trailing period, spaces. */
export const norm = (x: unknown): string =>
  unquote(String(x))
    .replace(/^[#@]/, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function parseAnswer(type: AnswerType, raw: string): number | string | string[] | Error {
  const text = raw.trim();
  if (type === "none") return text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (type === "number") {
    if (typeof json === "number") return json;
    const nums = unquote(text).replace(/(\d),(\d{3})\b/g, "$1$2").match(/-?\d+(?:\.\d+)?/g) ?? [];
    return nums.length === 1 ? Number(nums[0]) : new Error(`expected one number, got ${JSON.stringify(raw)}`);
  }
  if (type === "string") return norm(typeof json === "string" ? json : text);
  // set
  let items: unknown[];
  if (Array.isArray(json)) items = json;
  else {
    const inner = text.replace(/^\[/, "").replace(/\]$/, "").trim();
    items = inner === "" ? [] : inner.split(/[,\n;]/);
  }
  return [...new Set(items.map(norm).filter((s) => s !== ""))].sort();
}

function answerMatches(type: AnswerType, expected: Answer | undefined, raw: string | undefined): string | undefined {
  if (type === "none") return undefined;
  if (raw === undefined) return "no final answer";
  const got = parseAnswer(type, raw);
  if (got instanceof Error) return got.message;
  if (type === "number") return got === expected ? undefined : `answer ${String(got)} != expected ${String(expected)}`;
  if (type === "string") return got === norm(expected) ? undefined : `answer ${JSON.stringify(got)} != expected ${JSON.stringify(norm(expected))}`;
  const want = [...new Set((expected as (string | number)[]).map(norm))].sort();
  const have = got as string[];
  const missing = want.filter((x) => !have.includes(x));
  const extra = have.filter((x) => !want.includes(x));
  return missing.length === 0 && extra.length === 0
    ? undefined
    : `set differs: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`;
}

// ---------- state ----------

/** Apply the run's successful real writes to a fresh world of `seed` (the same code the server runs). */
export function replay(seed: number, writes: WriteEntry[]): World {
  const world = buildWorld(seed);
  for (const w of writes) if (w.ok && WRITE_TOOLS.has(w.tool)) callGithubTool(world, w.tool, w.args);
  return world;
}

function effectPresent(world: World, w: ExpectedWrite): boolean {
  const repo = world.repos.get(w.args.repo as RepoName);
  const issue = repo?.issues[w.args.number - 1];
  if (!repo || !issue) return false;
  if (w.tool === "add_label") return issue.labels.some((l) => l.name === w.args.label);
  if (w.tool === "assign") return issue.assignee?.login === w.args.assignee;
  const bot = (repo.comments.get(issue.number) ?? []).filter((c) => c.user.login === world.bot.login && c.body === w.args.body);
  return bot.length === 1;
}

export function gradeRun(task: Task, run: RunOutcome, opts: { seed?: number; expected?: Expected } = {}): GradeResult {
  const expected = opts.expected ?? expectedOf(task);
  const seed = opts.seed ?? EVAL_SEED;
  const reasons: string[] = [];

  const answerProblem = answerMatches(task.answer_type, expected.answer, run.final);
  if (answerProblem) reasons.push(answerProblem);

  const okWrites = run.writes.filter((w) => w.ok);
  const dups = duplicateWrites(run.writes);
  const want = new Map(expected.writes.map((w) => [writeKey(w.tool, w.args), w]));
  const have = new Set(okWrites.map((w) => w.key));
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const unexpected = [...have].filter((k) => !want.has(k));
  if (dups.length) reasons.push(`${dups.length} duplicate write(s): ${[...new Set(dups.map((d) => d.key))].join(" ")}`);
  if (missing.length) reasons.push(`${missing.length} missing write(s): ${missing.slice(0, 5).join(" ")}${missing.length > 5 ? " ..." : ""}`);
  if (unexpected.length) reasons.push(`${unexpected.length} unexpected write(s): ${unexpected.slice(0, 5).join(" ")}${unexpected.length > 5 ? " ..." : ""}`);
  let stateOk = dups.length === 0 && missing.length === 0 && unexpected.length === 0;
  if (expected.writes.length > 0) {
    const world = replay(seed, run.writes);
    const absent = expected.writes.filter((w) => !effectPresent(world, w));
    if (absent.length) {
      stateOk = false;
      reasons.push(`final state lacks ${absent.length} expected effect(s)`);
    }
  }
  const answerOk = answerProblem === undefined;
  return {
    task: task.id,
    pass: answerOk && stateOk,
    answerOk,
    stateOk,
    duplicates: dups.length,
    missingWrites: missing.length,
    unexpectedWrites: unexpected.length,
    reasons,
  };
}

/** Number of items a correct answer has: 1 for a number or string, the set size, or the number of writes. */
export function answerSize(task: Task): number {
  if (task.answer_type === "none") return task.expected_state?.writes.length ?? 0;
  return Array.isArray(task.answer) ? task.answer.length : 1;
}
