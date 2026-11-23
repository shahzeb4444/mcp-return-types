// bench/mock-server: workload as BENCHMARK.md specifies it (tools, shapes, seeds, latency, write log, reset).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorld, HOT_ISSUES, REPOS } from "../bench/mock-server/data.js";
import { DISTRACTOR_TOOLS } from "../bench/mock-server/distractors.js";
import { GITHUB_TOOLS, PAGE_SIZE, SEARCH_LIMIT } from "../bench/mock-server/github.js";
import { DEFAULT_LATENCY_MS, MockGithub } from "../bench/mock-server/server.js";
import { duplicateWrites, readWriteLog } from "../bench/mock-server/writelog.js";
import { MOCK_SERVER } from "../bench/reference-solver.js";
import { tmpDir } from "./helpers.js";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const parse = (r: { content: { text: string }[]; isError?: boolean }): Obj => {
  expect(r.isError).toBeUndefined();
  return JSON.parse(r.content[0]?.text as string) as Obj;
};
const mock = (seed = 2, writeLogFile?: string): MockGithub => new MockGithub({ seed, writeLogFile });
const allPages = (m: MockGithub, tool: string, args: Obj): Obj[] => {
  const out: Obj[] = [];
  for (let page: number | null = 1; page !== null; ) {
    const r = parse(m.call(tool, { ...args, page }));
    out.push(...(r.items as Obj[]));
    page = r.next_page as number | null;
  }
  return out;
};

describe("mock server: tools", () => {
  it("has the 8 real GitHub-like tools and 30 distractors, and declares no outputSchema", () => {
    expect(GITHUB_TOOLS.map((t) => t.name).sort()).toEqual(
      ["add_label", "assign", "get_issue", "list_comments", "list_issues", "list_prs", "post_comment", "search_issues"],
    );
    expect(DISTRACTOR_TOOLS).toHaveLength(30);
    expect(new Set(DISTRACTOR_TOOLS.map((t) => t.name)).size).toBe(30);
    expect(DISTRACTOR_TOOLS.every((t) => /^(ci|chat)_/.test(t.name))).toBe(true);
    const tools = mock().listTools();
    expect(tools).toHaveLength(38);
    for (const t of tools) {
      expect(t).not.toHaveProperty("outputSchema");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("returns every JSON result as a JSON string in content[0].text, with no structuredContent", () => {
    const m = mock();
    for (const t of m.listTools()) {
      const args: Obj = { repo: "acme/api", number: 1, q: "is:open", label: "bug", assignee: m.world.users[0]?.login, body: "x" };
      for (const key of t.inputSchema.required ?? []) if (args[key] === undefined) args[key] = key.endsWith("id") ? 5 : "c1";
      const r = m.call(t.name, args);
      expect(r).not.toHaveProperty("structuredContent");
      expect(r.content).toHaveLength(1);
      expect(r.content[0]?.type).toBe("text");
      if (t.name === "ci_get_job_log") expect(() => JSON.parse(r.content[0]?.text as string)).toThrow(); // plain text on purpose
      else expect(() => JSON.parse(r.content[0]?.text as string)).not.toThrow();
    }
  });
});

describe("mock server: realistic nested shapes", () => {
  const m = mock();
  const api = allPages(m, "list_issues", { repo: "acme/api", state: "all" });

  it("issues have user{login,id} and labels[{name,color}]", () => {
    for (const i of api) {
      expect(Object.keys(i.user as Obj).sort()).toEqual(["id", "login"]);
      expect(typeof i.user.login).toBe("string");
      expect(Number.isInteger(i.user.id)).toBe(true);
      for (const l of i.labels as Obj[]) expect(Object.keys(l).sort()).toEqual(["color", "name"]);
    }
    expect(api.some((i) => (i.labels as Obj[]).length === 0)).toBe(true);
    expect(api.some((i) => (i.labels as Obj[]).length >= 2)).toBe(true);
  });

  it("assignee is ABSENT (not null) when nobody is assigned", () => {
    const without = api.filter((i) => !("assignee" in i));
    const withA = api.filter((i) => "assignee" in i);
    expect(without.length).toBeGreaterThan(50);
    expect(withA.length).toBeGreaterThan(50);
    expect(api.some((i) => i.assignee === null)).toBe(false);
    for (const i of withA) expect(Object.keys(i.assignee as Obj).sort()).toEqual(["id", "login"]);
    // the same holds for get_issue
    const n = without[0]?.number as number;
    expect(parse(m.call("get_issue", { repo: "acme/api", number: n }))).not.toHaveProperty("assignee");
  });

  it("closed_at and milestone are null when unset, and objects/strings when set", () => {
    for (const i of api) {
      expect("closed_at" in i && "milestone" in i).toBe(true);
      if (i.state === "open") expect(i.closed_at).toBeNull();
      else expect(i.closed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    }
    expect(api.some((i) => i.milestone === null)).toBe(true);
    const ms = api.find((i) => i.milestone !== null)?.milestone as Obj;
    expect(Object.keys(ms).sort()).toEqual(["due_on", "number", "title"]);
  });

  it("paginates {items, next_page|null} in pages of 50, newest first", () => {
    const p1 = parse(m.call("list_issues", { repo: "acme/web", state: "all" }));
    expect(Object.keys(p1).sort()).toEqual(["items", "next_page"]);
    expect(p1.items).toHaveLength(PAGE_SIZE);
    expect(p1.next_page).toBe(2);
    const all = allPages(m, "list_issues", { repo: "acme/web", state: "all" });
    expect(all.map((i) => i.number)).toEqual([...all.map((i) => i.number)].sort((a, b) => b - a));
    const last = Math.ceil(all.length / PAGE_SIZE);
    expect(parse(m.call("list_issues", { repo: "acme/web", state: "all", page: last })).next_page).toBeNull();
    expect(parse(m.call("list_issues", { repo: "acme/web", state: "all", page: last + 1 }))).toEqual({ items: [], next_page: null });
  });

  it("list_issues filters by state (default open) and by one label", () => {
    const open = allPages(m, "list_issues", { repo: "acme/api" });
    expect(open.every((i) => i.state === "open")).toBe(true);
    const bugs = allPages(m, "list_issues", { repo: "acme/api", state: "all", label: "bug" });
    expect(bugs.length).toBe(api.filter((i) => (i.labels as Obj[]).some((l) => l.name === "bug")).length);
  });

  it("comments are paginated too, and the hot issues need several pages", () => {
    const hot = HOT_ISSUES["acme/cli"] as number;
    const comments = allPages(m, "list_comments", { repo: "acme/cli", number: hot });
    expect(comments.length).toBeGreaterThan(2 * PAGE_SIZE);
    expect(Object.keys(comments[0] as Obj).sort()).toEqual(["author_association", "body", "created_at", "id", "user"]);
    const issue = parse(m.call("get_issue", { repo: "acme/cli", number: hot }));
    expect(issue.comments).toBe(comments.length);
    expect(typeof issue.body).toBe("string");
  });

  it("search_issues has qualifiers, caps its items and says so with incomplete_results", () => {
    const big = parse(m.call("search_issues", { q: "is:open" }));
    expect(big.incomplete_results).toBe(true);
    expect(big.items).toHaveLength(SEARCH_LIMIT);
    expect(big.items[0]).toHaveProperty("repository");
    const narrow = parse(m.call("search_issues", { q: "repo:acme/cli is:closed label:security no:milestone" }));
    for (const i of narrow.items as Obj[]) {
      expect(i.repository).toBe("acme/cli");
      expect(i.state).toBe("closed");
      expect(i.milestone).toBeNull();
    }
    expect(m.call("search_issues", { q: "bogus:1" }).isError).toBe(true);
  });

  it("list_prs returns a JSON array (not paginated) with nested head/base and nullable merged_at", () => {
    const prs = JSON.parse(m.call("list_prs", { repo: "acme/api", state: "all" }).content[0]?.text as string) as Obj[];
    expect(Array.isArray(prs)).toBe(true);
    expect(prs.length).toBeGreaterThan(20);
    expect(prs.some((p) => p.merged_at === null)).toBe(true);
    expect(prs[0]).toMatchObject({ head: { ref: expect.any(String) }, base: { ref: expect.any(String) } });
  });

  it("errors are isError results with a message", () => {
    for (const [tool, args] of [
      ["get_issue", { repo: "acme/api", number: 99_999 }],
      ["get_issue", { repo: "nope/nope", number: 1 }],
      ["list_issues", {}],
      ["list_issues", { repo: "acme/api", state: "merged" }],
      ["add_label", { repo: "acme/api", number: 1, label: "no-such-label" }],
      ["assign", { repo: "acme/api", number: 1, assignee: "no-such-user" }],
      ["post_comment", { repo: "acme/api", number: 1, body: "  " }],
      ["no_such_tool", {}],
    ] as [string, Obj][]) {
      const r = m.call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content[0]?.text).not.toBe("");
    }
  });
});

describe("mock server: seeded data", () => {
  it("3 repos, about 1,500 issues and about 12,000 comments, for both seeds", () => {
    for (const seed of [1, 2]) {
      const w = buildWorld(seed);
      expect([...w.repos.keys()]).toEqual([...REPOS]);
      const issues = [...w.repos.values()].reduce((s, r) => s + r.issues.length, 0);
      const comments = [...w.repos.values()].reduce((s, r) => s + [...r.comments.values()].reduce((t, c) => t + c.length, 0), 0);
      expect(issues).toBeGreaterThan(1350);
      expect(issues).toBeLessThan(1650);
      expect(comments).toBeGreaterThan(10_500);
      expect(comments).toBeLessThan(13_500);
    }
  });

  it("is deterministic per seed, and seeds 1 and 2 differ", () => {
    const a = mock(2).call("list_issues", { repo: "acme/api", state: "all", page: 3 });
    expect(mock(2).call("list_issues", { repo: "acme/api", state: "all", page: 3 })).toEqual(a);
    expect(mock(1).call("list_issues", { repo: "acme/api", state: "all", page: 3 })).not.toEqual(a);
    const logins = (seed: number): string[] => buildWorld(seed).users.map((u) => u.login);
    expect(logins(1).filter((l) => logins(2).includes(l))).toEqual([]);
  });
});

describe("mock server: writes, write log and reset", () => {
  it("logs every write; repeats are idempotent in state but show up as duplicates", () => {
    const file = path.join(tmpDir("mock-log-"), "w.jsonl");
    const m = mock(2, file);
    const target = m.world.repos.get("acme/cli")?.issues.find((i) => i.labels.length === 0) as { number: number };
    const args = { repo: "acme/cli", number: target.number, label: "needs-triage" };
    expect(parse(m.call("add_label", args)).labels).toEqual([expect.objectContaining({ name: "needs-triage" })]);
    expect(parse(m.call("add_label", { ...args, number: String(target.number) })).labels).toHaveLength(1); // same issue, same state
    m.call("add_label", { ...args, label: "no-such-label" }); // failed write: logged, never a duplicate
    const log = readWriteLog(file);
    expect(log.map((e) => [e.ok, e.changed])).toEqual([[true, true], [true, false], [false, undefined]]);
    expect(duplicateWrites(log)).toHaveLength(1);
    expect(m.call("list_issues", { repo: "acme/cli" })).toBeTruthy(); // reads are not logged
    expect(readWriteLog(file)).toHaveLength(3);
  });

  it("post_comment with the same body twice keeps one comment; assign replaces the assignee", () => {
    const m = mock();
    const before = parse(m.call("get_issue", { repo: "acme/web", number: 3 })).comments as number;
    const c1 = parse(m.call("post_comment", { repo: "acme/web", number: 3, body: "hello" }));
    const c2 = parse(m.call("post_comment", { repo: "acme/web", number: 3, body: "hello" }));
    expect(c2.id).toBe(c1.id);
    expect(c1.user.login).toBe("bench-bot");
    expect(parse(m.call("get_issue", { repo: "acme/web", number: 3 })).comments).toBe(before + 1);
    expect(duplicateWrites(m.log.entries)).toHaveLength(1);
    const login = m.world.users[5]?.login as string;
    expect(parse(m.call("assign", { repo: "acme/web", number: 3, assignee: login })).assignee.login).toBe(login);
    expect(parse(m.call("get_issue", { repo: "acme/web", number: 3 })).assignee.login).toBe(login);
  });

  it("distractor writes are logged too", () => {
    const m = mock();
    m.call("chat_post_message", { channel: "C1", text: "hi" });
    m.call("chat_list_channels", {});
    expect(m.log.entries.map((e) => e.tool)).toEqual(["chat_post_message"]);
  });

  it("every server starts from fresh seeded state and truncates its write log", () => {
    const file = path.join(tmpDir("mock-reset-"), "w.jsonl");
    const a = mock(2, file);
    a.call("add_label", { repo: "acme/api", number: 1, label: "stale" });
    expect(readWriteLog(file)).toHaveLength(1);
    const b = mock(2, file);
    expect(readFileSync(file, "utf8")).toBe("");
    const labels = (x: MockGithub): string[] => (parse(x.call("get_issue", { repo: "acme/api", number: 1 })).labels as Obj[]).map((l) => l.name);
    expect(labels(a)).toContain("stale");
    expect(labels(b)).not.toContain("stale");
  });
});

describe("mock server over stdio with the SDK client", () => {
  const connect = async (extra: string[]): Promise<Client> => {
    const client = new Client({ name: "mock-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", MOCK_SERVER, ...extra], stderr: "ignore" }));
    return client;
  };

  it("serves 38 tools with no outputSchema, JSON text results, and a write log file", async () => {
    const file = path.join(tmpDir("mock-stdio-"), "w.jsonl");
    const client = await connect(["--seed", "2", "--latency", "0", "--write-log", file]);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(38);
      expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
      const r = (await client.callTool({ name: "get_issue", arguments: { repo: "acme/api", number: 42 } })) as Obj;
      expect(r.structuredContent).toBeUndefined();
      expect(JSON.parse(r.content[0].text as string)).toMatchObject({ number: 42, title: buildWorld(2).repos.get("acme/api")?.issues[41]?.title });
      await client.callTool({ name: "add_label", arguments: { repo: "acme/api", number: 42, label: "stale" } });
      expect(readWriteLog(file)).toMatchObject([{ tool: "add_label", ok: true, changed: true }]);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("injects the configured latency per call (default 150 ms)", async () => {
    expect(DEFAULT_LATENCY_MS).toBe(150);
    const client = await connect(["--seed", "1", "--latency", "150"]);
    try {
      await client.callTool({ name: "get_issue", arguments: { repo: "acme/api", number: 1 } }); // warm
      const t0 = performance.now();
      await client.callTool({ name: "get_issue", arguments: { repo: "acme/api", number: 2 } });
      expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
    } finally {
      await client.close();
    }
  }, 60_000);
});
