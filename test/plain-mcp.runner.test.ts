// M11 plain-MCP test: the run loop with fake clients (no model). Resume, bench/STOP, rate-limit sleep and
// retry, BENCH_MAX_RUNS, --limit, and one end-to-end pass through the REAL P and S proxy chains (pass-through
// proxy / mcp-return-types serve -> mock server) with a scripted client.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackendError, NotLoggedInError, RateLimitError } from "../bench/backends/types.js";
import type { Task } from "../bench/grade.js";
import { LimitBudget, type Clock } from "../bench/harness/runner.js";
import { fakePlainClient, type ClientRequest, type PlainClient } from "../bench/plain-mcp/clients.js";
import { loadPlainResults, planPlain, plainRunId, runPlain, type PlainDeps } from "../bench/plain-mcp/runner.js";
import { FAKE_SOLVERS, tasksFor } from "../bench/plain-mcp/run.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "plain-mcp-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fixture = readFileSync(path.join("test", "fixtures", "plain-mcp", "claude-stream.jsonl"), "utf8");

/** Replays the recorded-format claude stream (its answer solves ctrl-01) without starting anything. */
function cannedClient(opts: { failures?: Error[]; onRun?: (r: ClientRequest) => void } = {}): PlainClient & { requests: ClientRequest[] } {
  const failures = [...(opts.failures ?? [])];
  const requests: ClientRequest[] = [];
  return {
    name: "claude-cli",
    format: "claude-stream",
    requests,
    async run(req) {
      requests.push(req);
      opts.onRun?.(req);
      const f = failures.shift();
      if (f) throw f;
      return { code: 0, stdout: fixture, stderr: "", latencyMs: 1234, timedOut: false, cwdWasEmpty: true };
    },
  };
}

const fakeClock = (): Clock & { slept: number[] } => {
  let t = Date.parse("2026-11-23T00:00:00Z");
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) };
};

const ctrl = tasksFor("mock", ["ctrl-01"]);
const plan2 = () => planPlain({ workload: "mock", tasks: ctrl, reps: 1, backends: [{ name: "claude-cli", model: "claude-haiku-5-5" }], arms: ["P", "S"] });
const deps = (outDir: string, client: PlainClient, extra: Partial<PlainDeps> = {}) => ({
  clients: { "claude-cli": client },
  outDir,
  maxRuns: 500,
  clock: fakeClock(),
  backendRetryDelayMs: 1,
  latencyMs: 0,
  ...extra,
});

describe("runPlain with a recorded-format client output", () => {
  it("writes a graded result per run and the raw stream, and a restart skips finished runs", async () => {
    const out = tmp();
    const client = cannedClient();
    const s1 = await runPlain(plan2(), deps(out, client));
    expect(s1.ran).toBe(2);
    const results = loadPlainResults(out);
    expect(results.map((r) => r.arm).sort()).toEqual(["P", "S"]);
    for (const r of results) {
      expect(r.pass).toBe(true);
      expect(r.final).toBe("Memory leak when resizing nested tables behind a proxy");
      expect(r.turns).toBe(2);
      expect(r.toolCalls).toBe(3);
      expect(r.usage.output_tokens).toBe(310);
      expect(r.totalTokens).toBe(9 + 3200 + 14000 + 310);
      expect(r.wallMs).toBe(1234);
      expect(r.refused).toBe(false);
      expect(existsSync(path.join(out, `${r.id}.raw.jsonl`))).toBe(true);
    }
    // same prompt for both arms; the MCP command differs
    expect(new Set(results.map((r) => r.promptSha256)).size).toBe(1);
    expect(client.requests[0]?.prompt).toBe(client.requests[1]?.prompt);
    expect(results[0]?.serverCommand).not.toEqual(results[1]?.serverCommand);

    const s2 = await runPlain(plan2(), deps(out, client));
    expect(s2).toMatchObject({ ran: 0, skipped: 2 });
    expect(client.requests).toHaveLength(2);
  });

  it("an invalid or half-written result file is redone", async () => {
    const out = tmp();
    const [first] = plan2();
    writeFileSync(path.join(out, `${plainRunId(first as never)}.json`), "{ not json");
    const s = await runPlain(plan2(), deps(out, cannedClient()));
    expect(s.ran).toBe(2);
  });

  it("bench/STOP stops before the next run", async () => {
    const out = tmp();
    const stop = path.join(tmp(), "STOP");
    writeFileSync(stop, "");
    const client = cannedClient();
    const s = await runPlain(plan2(), deps(out, client, { stopFile: stop }));
    expect(s).toMatchObject({ ran: 0, stoppedBy: "stop-file" });
    expect(client.requests).toHaveLength(0);
  });

  it("STOP created during a run stops after that run", async () => {
    const out = tmp();
    const stop = path.join(tmp(), "STOP");
    const s = await runPlain(plan2(), deps(out, cannedClient({ onRun: () => writeFileSync(stop, "") }), { stopFile: stop }));
    expect(s).toMatchObject({ ran: 1, stoppedBy: "stop-file" });
  });

  it("a rate limit sleeps, then retries the whole run on a fresh run folder", async () => {
    const out = tmp();
    const clock = fakeClock();
    const client = cannedClient({ failures: [new RateLimitError("limit")] });
    const s = await runPlain(plan2().slice(0, 1), deps(out, client, { clock, budget: new LimitBudget(30 * 60_000, 3_600_000) }));
    expect(s.ran).toBe(1);
    expect(clock.slept).toEqual([30 * 60_000]);
    expect(loadPlainResults(out)[0]?.rateLimitWaits).toBe(1);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.runDir).not.toBe(client.requests[1]?.runDir);
    expect(existsSync(client.requests[0]?.runDir as string)).toBe(false); // run folders are cleaned up
  });

  it("STOP found after a rate-limit sleep stops cleanly; an exhausted wait budget stops with limit-budget", async () => {
    const stop = path.join(tmp(), "STOP");
    const sleepy: Clock = { now: () => 0, sleep: async () => void writeFileSync(stop, "") };
    const s = await runPlain(plan2(), deps(tmp(), cannedClient({ failures: [new RateLimitError("limit")] }), { clock: sleepy, stopFile: stop }));
    expect(s).toMatchObject({ ran: 0, stoppedBy: "stop-file" });
    const b = await runPlain(plan2(), deps(tmp(), cannedClient({ failures: [new RateLimitError("a"), new RateLimitError("b")] }), { budget: new LimitBudget(60_000, 90_000) }));
    expect(b).toMatchObject({ ran: 0, stoppedBy: "limit-budget" });
  });

  it("not logged in stops at once; repeated CLI failures stop with backend-error after 2 retries", async () => {
    const n = await runPlain(plan2(), deps(tmp(), cannedClient({ failures: [new NotLoggedInError("no")] })));
    expect(n.stoppedBy).toBe("not-logged-in");
    const client = cannedClient({ failures: [new BackendError("x"), new BackendError("y"), new BackendError("z")] });
    const b = await runPlain(plan2(), deps(tmp(), client));
    expect(b.stoppedBy).toBe("backend-error");
    expect(client.requests).toHaveLength(3);
  });

  it("BENCH_MAX_RUNS caps finished runs per backend, --limit caps new runs per invocation", async () => {
    const out = tmp();
    const capped = await runPlain(plan2(), { ...deps(out, cannedClient()), maxRuns: 1 });
    expect(capped).toMatchObject({ ran: 1, capped: 1 });
    const limited = await runPlain(planPlain({ workload: "mock", tasks: tasksFor("mock", ["ctrl-01", "nested-03"]), reps: 1, backends: [{ name: "claude-cli", model: "m" }], arms: ["P", "S"] }), { ...deps(tmp(), cannedClient()), limit: 1 });
    expect(limited).toMatchObject({ ran: 1, limited: 3 });
  });
});

describe("end to end through the real proxies (scripted fake client, no model)", () => {
  it("P forwards unchanged, S adds structuredContent; the write task is graded from the mock's write log", async () => {
    const out = tmp();
    const tasks: Task[] = tasksFor("mock", ["ctrl-01", "write-01"]);
    const plan = planPlain({ workload: "mock", tasks, reps: 1, backends: [{ name: "fake", model: "fake" }], arms: ["P", "S"] });
    const s = await runPlain(plan, { clients: { fake: fakePlainClient({ solvers: FAKE_SOLVERS }) }, outDir: out, maxRuns: 500, latencyMs: 0 });
    expect(s.ran).toBe(4);
    const results = loadPlainResults(out);
    for (const r of results) {
      expect(r.pass, r.gradeReasons.join("; ")).toBe(true);
      expect(r.serverStarted).toBe(true);
      expect(r.mcpServers).toEqual([{ name: "github", status: "connected" }]);
      expect(r.offeredTools).toHaveLength(8); // only the real tools
      expect(r.driftEvents).toBe(0);
    }
    const structured = (id: string): number => {
      const result = readFileSync(path.join(out, `${id}.raw.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; fake?: { structuredResults: number } }).find((e) => e.type === "result");
      return result?.fake?.structuredResults ?? -1;
    };
    for (const task of ["ctrl-01", "write-01"]) {
      expect(structured(`mock-P-fake-${task}-1`)).toBe(0);
      expect(structured(`mock-S-fake-${task}-1`)).toBeGreaterThan(0);
    }
    const w = results.find((r) => r.id === "mock-S-fake-write-01-1");
    expect(w?.duplicateWrites).toBe(0);
    expect(w?.toolCalls).toBeGreaterThan(13); // 13 labels plus the listing calls
  }, 120_000);

  it("the server-everything no-harm tasks pass through P and S", async () => {
    const out = tmp();
    const plan = planPlain({ workload: "everything", tasks: tasksFor("everything"), reps: 1, backends: [{ name: "fake", model: "fake" }], arms: ["P", "S"] });
    await runPlain(plan, { clients: { fake: fakePlainClient({ solvers: FAKE_SOLVERS }) }, outDir: out, maxRuns: 500, latencyMs: 0 });
    const results = loadPlainResults(out);
    expect(results).toHaveLength(6);
    for (const r of results) {
      expect(r.pass, `${r.id}: ${r.final} ${r.gradeReasons.join("; ")}`).toBe(true);
      expect(r.serverStarted).toBeNull();
    }
  }, 120_000);
});
