// Seed-1 warm-up traffic for arm D (BENCHMARK.md "Seed-1 warm-up traffic"). No model is involved.
// It calls every tool (real and distractor) at least 10 times on seed 1 THROUGH `mcp-return-types record`,
// with varied arguments (each state, several labels, first/middle/last pages, issues with and without
// assignee, milestone and closed_at) and at least one error result per real tool. Then it runs `infer`
// and `emit` and writes bench/arm-d/mock-github.json (the inferred schemas the harness reads) and
// bench/arm-d/mock-github.d.ts (the same types for people). The recording itself goes to a temp folder.
//
//   npm run bench:warmup
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/cli.js";
import { runEmitTs } from "../src/emit/ts.js";
import { describeEntry, runInfer } from "../src/infer/run.js";
import { REPOS } from "./mock-server/data.js";
import { DISTRACTOR_TOOLS } from "./mock-server/distractors.js";
import type { ToolDef } from "./mock-server/github.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
export const ARM_D_DIR = path.join(HERE, "arm-d");
export const WARMUP_SEED = 1;
export const SERVER_NAME = "mock-github";
const MIN_CALLS = 10;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Issue {
  number: number;
  state: string;
  user: { login: string };
  assignee?: unknown;
  milestone: unknown;
  closed_at: string | null;
  comments: number;
}

class Caller {
  readonly counts = new Map<string, number>();
  readonly errors = new Map<string, number>();
  constructor(private readonly client: Client) {}

  async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; value: Json }> {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    const r = (await this.client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text ?? "").join("\n");
    if (r.isError) {
      this.errors.set(name, (this.errors.get(name) ?? 0) + 1);
      return { ok: false, value: text };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: true, value: text };
    }
  }

  async walk(name: string, args: Record<string, unknown>, maxPages = 100): Promise<Json[]> {
    const items: Json[] = [];
    for (let page: number | null = 1; page !== null && page <= maxPages; ) {
      const r = await this.call(name, { ...args, page });
      if (!r.ok) break;
      items.push(...(r.value.items as Json[]));
      page = r.value.next_page as number | null;
    }
    return items;
  }
}

async function realTraffic(c: Caller): Promise<void> {
  const issuesByRepo = new Map<string, Issue[]>();
  for (const repo of REPOS) {
    for (const state of ["open", "closed", "all"]) {
      const items = (await c.walk("list_issues", { repo, state })) as Issue[];
      if (state === "all") issuesByRepo.set(repo, items);
    }
    for (const label of ["bug", "perf", "security", "good first issue", "no-such-label"]) await c.call("list_issues", { repo, state: "all", label });
    await c.call("list_issues", { repo }); // defaults
  }
  await c.call("list_issues", { repo: "acme/nope" });
  await c.call("list_issues", { repo: "acme/api", page: 0 });

  const logins: string[] = [];
  for (const repo of REPOS) {
    const issues = issuesByRepo.get(repo) ?? [];
    logins.push(...issues.slice(0, 5).map((i) => i.user.login));
    const picks = [
      issues.find((i) => i.assignee !== undefined),
      issues.find((i) => i.assignee === undefined),
      issues.find((i) => i.milestone !== null),
      issues.find((i) => i.milestone === null),
      issues.find((i) => i.closed_at !== null),
      issues.find((i) => i.state === "open"),
    ];
    for (const i of picks) if (i) await c.call("get_issue", { repo, number: i.number });
    // comments: a few ordinary threads, one empty thread, a second page
    const withComments = issues.filter((i) => i.comments > 0).slice(0, 3);
    for (const i of withComments) await c.call("list_comments", { repo, number: i.number });
    const none = issues.find((i) => i.comments === 0);
    if (none) await c.call("list_comments", { repo, number: none.number });
    if (withComments[0]) await c.call("list_comments", { repo, number: withComments[0].number, page: 2 });
  }
  await c.walk("list_comments", { repo: "acme/api", number: 137 });
  await c.walk("list_comments", { repo: "acme/cli", number: 64 });
  await c.call("get_issue", { repo: "acme/api", number: 999999 });
  await c.call("get_issue", { repo: "acme/nope", number: 1 });
  await c.call("list_comments", { repo: "acme/web", number: 999999 });

  const someone = logins[0] ?? "nobody";
  for (const q of [
    "repo:acme/api is:open label:bug",
    "repo:acme/web no:assignee",
    "is:closed label:perf",
    "repo:acme/cli no:milestone is:open",
    'label:"good first issue"',
    `author:${someone}`,
    `assignee:${logins[1] ?? someone}`,
    "crash",
    "is:open",
    "repo:acme/api label:security label:bug",
    "zzzz-no-match-anywhere",
  ]) {
    await c.call("search_issues", { q });
  }
  await c.call("search_issues", { q: "foo:bar" });
  await c.call("search_issues", {});

  const targets = REPOS.flatMap((repo) => (issuesByRepo.get(repo) ?? []).slice(0, 4).map((i) => ({ repo, number: i.number })));
  const labels = ["needs-triage", "stale", "docs"];
  for (const [k, t] of targets.slice(0, 10).entries()) await c.call("add_label", { ...t, label: labels[k % labels.length] });
  if (targets[0]) await c.call("add_label", { ...targets[0], label: labels[0] }); // idempotent repeat
  await c.call("add_label", { repo: "acme/api", number: 1, label: "no-such-label" });
  await c.call("add_label", { repo: "acme/api", number: 999999, label: "docs" });
  for (const [k, t] of targets.slice(0, 10).entries()) await c.call("assign", { ...t, assignee: logins[k % logins.length] ?? someone });
  await c.call("assign", { repo: "acme/api", number: 1, assignee: "no-such-user-xyz" });
  for (const [k, t] of targets.slice(0, 10).entries()) await c.call("post_comment", { ...t, body: `warm-up note ${k}` });
  await c.call("post_comment", { repo: "acme/api", number: 1, body: "  " });

  for (const repo of REPOS) {
    for (const state of ["open", "closed", "all"]) await c.call("list_prs", { repo, state });
    await c.call("list_prs", { repo });
  }
  await c.call("list_prs", { repo: "acme/nope" });
  await c.call("list_prs", { repo: "acme/api", state: "merged" });
}

/** Argument values by parameter name, varied by the call index. */
function argFor(prop: string, schema: { type?: string }, i: number): unknown {
  const pick = <T>(xs: T[]): T => xs[i % xs.length] as T;
  switch (prop) {
    case "project":
      return pick([...REPOS]);
    case "status":
      return pick(["running", "success", "failed"]);
    case "id":
    case "pipeline_id":
    case "job_id":
      return 10_000 + i * 7;
    case "tail":
      return 5 + i;
    case "ref":
      return pick(["main", "release", "dev"]);
    case "environment":
      return pick(["staging", "production", "review"]);
    case "channel":
      return `C${100 + i}`;
    case "cursor":
      return `cur${i}`;
    case "ts":
      return `1700000000.${100000 + i}`;
    case "emoji":
      return pick(["+1", "eyes", "tada"]);
    case "user":
      return `U${i + 1}`;
    default:
      if (schema.type === "integer") return i + 1;
      if (schema.type === "boolean") return i % 4 === 0;
      return `warm-up ${prop} ${i}`;
  }
}

async function distractorTraffic(c: Caller, tools: ToolDef[]): Promise<void> {
  for (const t of tools) {
    const props = t.inputSchema.properties as Record<string, { type?: string }>;
    const required = new Set(t.inputSchema.required ?? []);
    for (let i = 0; i < MIN_CALLS; i++) {
      const args: Record<string, unknown> = {};
      for (const [p, s] of Object.entries(props)) if (required.has(p) || i % 2 === 0) args[p] = argFor(p, s, i);
      await c.call(t.name, args);
    }
    if (required.size > 0) await c.call(t.name, {}); // missing required argument -> error result
  }
}

export async function warmup(opts: { outDir?: string; log?: (s: string) => void } = {}): Promise<{ counts: Map<string, number>; errors: Map<string, number>; schemasFile: string; dtsFile: string }> {
  const outDir = opts.outDir ?? ARM_D_DIR;
  const log = opts.log ?? ((s: string) => console.log(s));
  const rec = mkdtempSync(path.join(tmpdir(), "bench-warmup-"));
  try {
    const client = new Client({ name: "bench-warmup", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import", "tsx", path.join(ROOT, "src", "cli.ts"), "record", "--out", rec, "--name", SERVER_NAME, "--",
          process.execPath, "--import", "tsx", path.join(HERE, "mock-server", "server.ts"), "--seed", String(WARMUP_SEED), "--latency", "0",
        ],
        cwd: ROOT,
        stderr: "inherit",
      }),
    );
    const c = new Caller(client);
    const { tools } = await client.listTools();
    await realTraffic(c);
    await distractorTraffic(c, DISTRACTOR_TOOLS);
    await client.close();

    const missing = tools.filter((t) => (c.counts.get(t.name) ?? 0) < MIN_CALLS).map((t) => t.name);
    if (missing.length) throw new Error(`warm-up called these tools fewer than ${MIN_CALLS} times: ${missing.join(", ")}`);

    // The proxy writes samples while it forwards; give its shutdown a moment before reading them.
    await new Promise((r) => setTimeout(r, 300));
    const inferred = runInfer({ inDir: rec });
    const server = inferred.servers.find((s) => s.server === SERVER_NAME);
    if (!server) throw new Error("infer produced no schemas for mock-github");
    mkdirSync(outDir, { recursive: true });
    const schemasFile = path.join(outDir, `${SERVER_NAME}.json`);
    copyFileSync(path.join(rec, "schemas", `${SERVER_NAME}.json`), schemasFile);
    const emitted = runEmitTs({ inDir: rec, outDir, version: VERSION });
    const dtsFile = emitted.files.find((f) => f.server === SERVER_NAME)?.file ?? path.join(outDir, `${SERVER_NAME}.d.ts`);
    const total = [...c.counts.values()].reduce((a, b) => a + b, 0);
    log(`warm-up: ${total} calls on seed ${WARMUP_SEED} over ${c.counts.size} tools (${[...c.errors.values()].reduce((a, b) => a + b, 0)} error results)`);
    for (const t of server.tools) log(`  ${describeEntry(t)}`);
    log(`wrote ${path.relative(process.cwd(), schemasFile)} and ${path.relative(process.cwd(), dtsFile)}`);
    return { counts: c.counts, errors: c.errors, schemasFile, dtsFile };
  } finally {
    rmSync(rec, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  warmup().then(
    () => undefined,
    (e: unknown) => {
      process.stderr.write(`warm-up: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
