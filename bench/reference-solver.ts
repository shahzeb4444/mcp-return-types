// Scripted reference solver (no LLM). It solves every task the way a careful agent would, through the
// MCP tools only (the official SDK client against a fresh mock server process per task), never through
// the oracles or the seeded data. Passing all 20 tasks on seed 2 proves the tasks are solvable from the
// real response shapes and that the grader accepts correct runs.
//
//   npm run bench:reference            (seed 2, prints the task table)
//   npm run bench:reference -- --seed 1
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { answerSize, EVAL_SEED, expectedOf, gradeRun, loadPilot, loadTasks, type Expected, type GradeResult, type Task } from "./grade.js";
import { readWriteLog } from "./mock-server/writelog.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_SERVER = path.join(HERE, "mock-server", "server.ts");

type Call = (name: string, args: Record<string, unknown>) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface IssueLite {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  labels: { name: string }[];
  assignee?: { login: string };
  comments: number;
  updated_at: string;
  closed_at: string | null;
  milestone: { title: string } | null;
}

/** Start a fresh mock server (fresh state, own write log) and connect the SDK client to it. */
export async function connectMock(seed: number, writeLog: string, latencyMs = 0): Promise<{ client: Client; call: Call }> {
  const client = new Client({ name: "reference-solver", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", MOCK_SERVER, "--seed", String(seed), "--latency", String(latencyMs), "--write-log", writeLog],
      stderr: "inherit",
    }),
  );
  const call: Call = async (name, args) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  };
  return { client, call };
}

async function allIssues(call: Call, repo: string, state: string, label?: string): Promise<IssueLite[]> {
  const out: IssueLite[] = [];
  for (let page: number | null = 1; page !== null; ) {
    const res: { items: IssueLite[]; next_page: number | null } = await call("list_issues", { repo, state, page, ...(label ? { label } : {}) });
    out.push(...res.items);
    page = res.next_page;
  }
  return out;
}
async function allComments(call: Call, repo: string, number: number): Promise<{ user: { login: string } }[]> {
  const out: { user: { login: string } }[] = [];
  for (let page: number | null = 1; page !== null; ) {
    const res: { items: { user: { login: string } }[]; next_page: number | null } = await call("list_comments", { repo, number, page });
    out.push(...res.items);
    page = res.next_page;
  }
  return out;
}
const has = (i: IssueLite, l: string): boolean => i.labels.some((x) => x.name === l);
const tally = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
const topAlpha = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
const atLeast = (m: Map<string, number>, n: number): string[] => [...m].filter(([, c]) => c >= n).map(([k]) => k).sort();
const json = (x: unknown): string => JSON.stringify(x);

/** One solver per task id. Each returns the text it would put after `FINAL:`. */
export const SOLVERS: Record<string, (call: Call) => Promise<string>> = {
  "nested-01": async (call) =>
    String((await allIssues(call, "acme/api", "open", "bug")).filter((i) => !i.assignee && i.comments > 5).length),
  "nested-02": async (call) => {
    const perf = await allIssues(call, "acme/web", "open", "perf");
    const logins: string[] = [];
    for (const i of perf) logins.push(...new Set((await allComments(call, "acme/web", i.number)).map((c) => c.user.login)));
    return json(atLeast(tally(logins), 4));
  },
  "nested-03": async (call) =>
    json((await allIssues(call, "acme/cli", "closed", "security")).filter((i) => i.milestone === null).map((i) => i.number)),
  "nested-04": async (call) =>
    topAlpha(tally((await allIssues(call, "acme/api", "open")).flatMap((i) => (i.milestone ? [i.milestone.title] : [])))),
  "nested-05": async (call) =>
    topAlpha(tally((await allIssues(call, "acme/web", "open")).flatMap((i) => (i.assignee ? [i.assignee.login] : [])))),
  "nested-06": async (call) => {
    const lo = Date.parse("2026-10-01T00:00:00Z");
    const hi = Date.parse("2026-11-01T00:00:00Z");
    return String(
      (await allIssues(call, "acme/cli", "closed")).filter((i) => i.closed_at !== null && Date.parse(i.closed_at) >= lo && Date.parse(i.closed_at) < hi).length,
    );
  },
  "nested-07": async (call) => json((await allIssues(call, "acme/web", "open", "perf")).filter((i) => has(i, "bug")).map((i) => i.number)),
  "nested-08": async (call) => json(atLeast(tally((await allComments(call, "acme/api", 137)).map((c) => c.user.login)), 2)),
  "page-01": async (call) => String((await allIssues(call, "acme/web", "all")).length),
  "page-02": async (call) => json(atLeast(tally((await allComments(call, "acme/cli", 64)).map((c) => c.user.login)), 5)),
  "page-03": async (call) => {
    const open = (await allIssues(call, "acme/api", "open")).filter((i) => i.milestone === null);
    return open.sort((a, b) => a.number - b.number)[0]?.title ?? "";
  },
  "page-04": async (call) => String((await allIssues(call, "acme/cli", "closed")).length),
  "page-05": async (call) => topAlpha(tally((await allIssues(call, "acme/web", "all")).map((i) => i.user.login))),
  "page-06": async (call) =>
    String((await allIssues(call, "acme/web", "all")).sort((a, b) => b.comments - a.comments || a.number - b.number)[0]?.number),
  "write-01": async (call) => {
    for (const i of (await allIssues(call, "acme/cli", "open")).filter((x) => x.labels.length === 0)) {
      await call("add_label", { repo: "acme/cli", number: i.number, label: "needs-triage" });
    }
    return "done";
  },
  "write-02": async (call) => {
    for (const i of (await allIssues(call, "acme/api", "open", "security")).filter((x) => !x.assignee)) {
      await call("assign", { repo: "acme/api", number: i.number, assignee: i.user.login });
    }
    return "done";
  },
  "write-03": async (call) => {
    for (const i of (await allIssues(call, "acme/web", "open", "perf")).filter((x) => x.assignee)) {
      await call("post_comment", { repo: "acme/web", number: i.number, body: `ping @${i.assignee?.login}` });
    }
    return "done";
  },
  "write-04": async (call) => {
    const cutoff = Date.parse("2026-06-01T00:00:00Z");
    const targets = (await allIssues(call, "acme/api", "open", "bug")).filter((x) => x.milestone === null && Date.parse(x.updated_at) < cutoff);
    for (const i of targets) await call("add_label", { repo: "acme/api", number: i.number, label: "stale" });
    return "done";
  },
  "ctrl-01": async (call) => (await call("get_issue", { repo: "acme/api", number: 42 })).title,
  "ctrl-02": async (call) => (await call("get_issue", { repo: "acme/web", number: 7 })).user.login,
};

export interface SolveResult {
  task: Task;
  final: string;
  grade: GradeResult;
  calls: number;
}

/**
 * Solve one task on a fresh server and grade it. `expected` defaults to the task file (seed 2).
 * `tamper` lets tests change the final answer or add calls after solving (to prove the grader fails).
 */
export async function solveTask(
  task: Task,
  opts: { seed?: number; expected?: Expected; tamper?: (final: string, call: Call) => Promise<string> } = {},
): Promise<SolveResult> {
  const seed = opts.seed ?? EVAL_SEED;
  const solver = SOLVERS[task.id];
  if (!solver) throw new Error(`no reference solver for ${task.id}`);
  const logFile = path.join(mkdtempSync(path.join(tmpdir(), "mock-writes-")), "writes.jsonl");
  const { client, call } = await connectMock(seed, logFile);
  let calls = 0;
  const counted: Call = (n, a) => {
    calls += 1;
    return call(n, a);
  };
  let final: string;
  try {
    final = await solver(counted);
    if (opts.tamper) final = await opts.tamper(final, counted);
  } finally {
    await client.close();
  }
  const grade = gradeRun(task, { final, writes: readWriteLog(logFile) }, { seed, expected: opts.expected ?? expectedOf(task) });
  return { task, final, grade, calls };
}

function isEntryPoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  const { values } = parseArgs({ options: { seed: { type: "string", default: String(EVAL_SEED) } }, strict: true });
  const seed = Number(values.seed);
  const tasks = loadTasks();
  const pilot = new Set(loadPilot());
  let expectedFor: (t: Task) => Expected = expectedOf;
  if (seed !== EVAL_SEED) {
    // Other seeds: compute the expected answers with the oracles (the task files hold seed 2 only).
    const { TASKS } = await import("./tasks/defs.js");
    const { buildWorld } = await import("./mock-server/data.js");
    expectedFor = (t) => {
      const r = TASKS.find((d) => d.id === t.id)?.oracle(buildWorld(seed)) ?? {};
      return { answer: r.answer, writes: r.writes ?? [] };
    };
  }
  const rows: string[][] = [];
  let passed = 0;
  for (const task of tasks) {
    const r = await solveTask(task, { seed, expected: expectedFor(task) });
    if (r.grade.pass) passed += 1;
    const size = seed === EVAL_SEED ? answerSize(task) : answerSize({ ...task, answer: expectedFor(task).answer, expected_state: { writes: expectedFor(task).writes } });
    rows.push([task.category, task.id, pilot.has(task.id) ? "yes" : "", task.answer_type === "none" ? "writes" : task.answer_type, String(size), String(r.calls), r.grade.pass ? "PASS" : `FAIL: ${r.grade.reasons.join("; ")}`]);
  }
  const order = ["nested", "pagination", "write", "control"];
  rows.sort((a, b) => order.indexOf(a[0] as string) - order.indexOf(b[0] as string) || (a[1] as string).localeCompare(b[1] as string));
  const head = ["category", "task", "pilot", "answer", "expected size", "tool calls", "reference solver"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (r: string[]): string => `| ${r.map((c, i) => c.padEnd(widths[i] as number)).join(" | ")} |`;
  console.log(`Reference solver, seed ${seed}, latency 0 ms\n`);
  console.log(line(head));
  console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const r of rows) console.log(line(r));
  const byCat = order.map((c) => `${c} ${rows.filter((r) => r[0] === c).length}`).join(", ");
  console.log(`\n${passed}/${tasks.length} passed (${byCat}; pilot ${pilot.size})`);
  process.exitCode = passed === tasks.length ? 0 : 1;
}
