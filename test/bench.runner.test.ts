// Harness loop tests: fake backend, in-process mock server (same logic as the stdio one), fake clock.
// No model, no CLI, no network.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeBackend, scripted, type FakePolicy } from "../bench/backends/fake.js";
import { RateLimitError, type ModelBackend } from "../bench/backends/types.js";
import { loadPilot, loadTasks, type Task } from "../bench/grade.js";
import { buildStubs, buildSystemPrompt, ENVELOPE_FORMAT, renderConversation, SYSTEM_PROMPT_HEAD } from "../bench/harness/prompt.js";
import { armOrder, LimitBudget, planRuns, readResult, runBench, runId, runOne, type Clock, type RunDeps, type RunSpec } from "../bench/harness/runner.js";
import { inProcessSession } from "../bench/harness/session.js";
import { loadArmD, smokeTasks } from "../bench/run.js";
import { MockGithub } from "../bench/mock-server/server.js";
import { tmpDir } from "./helpers.js";

const TASKS = loadTasks();
const task = (id: string): Task => TASKS.find((t) => t.id === id) as Task;
const INFERRED = loadArmD();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const out = (): string => {
  const d = tmpDir("bench-runner-");
  dirs.push(d);
  return d;
};

function fakeClock(): Clock & { sleeps: number[]; t: number } {
  const c = {
    t: Date.parse("2026-11-22T00:00:00Z"),
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
  return c;
}

const CTRL_SOLVE = ['```ts\nconst i = await tools.get_issue({ repo: "acme/api", number: 42 }) as { title: string };\nreturn i.title;\n```'];
/** Solves ctrl-01 for real: reads the title from the previous sandbox output. */
const ctrlPolicy: FakePolicy = (req) => {
  const m = /Return value:\n"([^"]*)"/.exec(req.prompt);
  return m ? `FINAL: ${m[1]}` : (CTRL_SOLVE[0] as string);
};

const deps = (backend: ModelBackend, outDir: string, extra: Partial<RunDeps> = {}): RunDeps => ({
  backend,
  openSession: inProcessSession,
  inferred: INFERRED,
  outDir,
  latencyMs: 0,
  sandboxTimeoutMs: 5000,
  clock: fakeClock(),
  ...extra,
});
const spec = (t: string, arm: "C" | "D" = "C", rep = 1, backend = "fake", model: string | undefined = "fake"): RunSpec => ({ backend, model, arm, task: task(t), rep });
const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("one run", () => {
  it("solves a control task through the sandbox and grades it as a pass", async () => {
    const dir = out();
    const r = await runOne(spec("ctrl-01"), deps(fakeBackend(ctrlPolicy), dir));
    expect(r).toMatchObject({ pass: true, turns: 2, toolCalls: 1, sandboxRuns: 1, codeErrors: 0, endedBy: "final" });
    const log = lines(path.join(dir, `${r.id}.jsonl`));
    expect(log.map((l) => l.type)).toEqual(["turn", "turn", "result"]);
    for (const key of ["arm", "model", "task", "rep", "turn", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "latency_ms", "tool_calls", "rewrite", "reply", "raw"]) {
      expect(log[0], key).toHaveProperty(key);
    }
    expect(log[1]).toMatchObject({ reply_kind: "final", final_answer: r.final });
    expect(readResult(dir, r.id)).toEqual(r);
  });

  it("counts exceptions, rewrites, malformed replies, and stops at 12 turns", async () => {
    const dir = out();
    const b = fakeBackend(scripted(["```ts\nconst x: any = null; return x.y;\n```", "```ts\nreturn 1;\n```", "no protocol here", "```ts\nwhile(true){}\n```", "```ts\nreturn 2;\n```"]));
    const r = await runOne(spec("ctrl-01"), deps(b, dir, { sandboxTimeoutMs: 4000 }));
    expect(r.turns).toBe(12);
    expect(r.endedBy).toBe("max-turns");
    expect(r.final).toBeNull();
    expect(r.pass).toBe(false);
    // turn 1 exception, turn 2 rewrite, turn 3 malformed, turn 4 timeout, turn 5 rewrite, turns 6-12 ok
    expect(r).toMatchObject({ exceptions: 1, timeouts: 1, rewrites: 2, codeErrors: 4, malformed: 1, sandboxRuns: 11 });
    expect(b.requests).toHaveLength(12);
    expect(b.requests[1]?.prompt).toContain("Sandbox output:\nException: TypeError");
  }, 30_000);

  it("records failed writes and duplicates from the run's own fresh server", async () => {
    const dir = out();
    const code = '```ts\nfor (let k = 0; k < 2; k++) await tools.add_label({ repo: "acme/cli", number: 1, label: "needs-triage" });\nreturn "ok";\n```';
    const r = await runOne(spec("write-01"), deps(fakeBackend(scripted([code, "FINAL: done"])), dir));
    expect(r.duplicateWrites).toBe(1);
    expect(r.pass).toBe(false);
    // a second run starts from fresh state: no duplicate carried over
    const r2 = await runOne(spec("write-01", "D"), deps(fakeBackend(scripted(["FINAL: done"])), dir));
    expect(r2.duplicateWrites).toBe(0);
  });
});

describe("arms C and D differ only in return types", () => {
  const tools = new MockGithub({ seed: 2 }).listTools();
  const c = buildStubs(tools, "C", INFERRED);
  const d = buildStubs(tools, "D", INFERRED);

  it("arm D has every tool typed, arm C has every return unknown", () => {
    expect(c).not.toMatch(/Promise<(?!unknown>)/);
    expect((d.match(/Promise<\w+Result>/g) ?? []).length).toBe(tools.length);
  });
  it("removing the type declarations and return types from D gives exactly C", () => {
    const stripped = d
      .slice(d.indexOf("declare const tools"))
      .replace(/Promise<\w+Result>/g, "Promise<unknown>")
      .split("\n")
      .filter((l) => l.trim() !== "// low confidence")
      .join("\n");
    expect(stripped).toBe(c);
  });
  it("the system prompts are identical outside the stubs", () => {
    const pc = buildSystemPrompt(c);
    const pd = buildSystemPrompt(d);
    expect(pc.replace(c.trimEnd(), "<STUBS>")).toBe(pd.replace(d.trimEnd(), "<STUBS>"));
  });
  it("in real runs the only difference in what the model gets is the stubs", async () => {
    const dir = out();
    const bc = fakeBackend(scripted(["FINAL: x"]));
    const bd = fakeBackend(scripted(["FINAL: x"]));
    await runOne(spec("ctrl-01", "C"), deps(bc, dir));
    await runOne(spec("ctrl-01", "D"), deps(bd, dir));
    const [rc, rd] = [bc.requests[0], bd.requests[0]];
    expect(rc?.prompt).toBe(rd?.prompt);
    expect(rc?.prompt).toBe(renderConversation([{ role: "user", content: task("ctrl-01").prompt }]));
    expect(rc?.system).toBe(buildSystemPrompt(c));
    expect(rd?.system).toBe(buildSystemPrompt(d));
  });
});

describe("reply format per backend (Codex envelope vs fenced)", () => {
  const tools = new MockGithub({ seed: 2 }).listTools();
  const c = buildStubs(tools, "C", INFERRED);
  const d = buildStubs(tools, "D", INFERRED);
  const ENV_PARAGRAPH =
    "Reply in the required JSON format. Use action run_code with your TypeScript in code (and an empty answer) when you want the harness to run code, or action final with your answer in answer (and empty code) when done.";

  it("the fenced prompt is the default and still says no tools exist", () => {
    expect(buildSystemPrompt(c)).toBe(buildSystemPrompt(c, "fenced"));
    expect(buildSystemPrompt(c)).toContain(SYSTEM_PROMPT_HEAD);
    expect(buildSystemPrompt(c)).toContain("NO tools exist");
    expect(buildSystemPrompt(c)).toContain("```ts");
  });
  it("the envelope prompt swaps only the reply-format paragraph", () => {
    expect(ENVELOPE_FORMAT).toBe(ENV_PARAGRAPH);
    const f = buildSystemPrompt(c, "fenced");
    const e = buildSystemPrompt(c, "json-envelope");
    expect(e).toContain(ENV_PARAGRAPH);
    expect(e).toContain("NO tools exist");
    expect(e).not.toContain("FINAL:");
    // everything outside the reply-format paragraph is byte-identical
    const headF = SYSTEM_PROMPT_HEAD.split("\n");
    const start = headF.findIndex((l) => l.startsWith("The only way to run code"));
    const end = headF.findIndex((l) => l.startsWith("Every reply is therefore"));
    const fencedParagraph = headF.slice(start, end + 1).join("\n");
    expect(f.replace(fencedParagraph, ENV_PARAGRAPH)).toBe(e);
  });
  it.each(["fenced", "json-envelope"] as const)("arms C and D are identical outside the stubs (%s)", (fmt) => {
    const pc = buildSystemPrompt(c, fmt);
    const pd = buildSystemPrompt(d, fmt);
    expect(pc.replace(c.trimEnd(), "<STUBS>")).toBe(pd.replace(d.trimEnd(), "<STUBS>"));
  });
  const envBackend = (replies: string[]): ModelBackend => {
    const fb = fakeBackend(scripted(replies));
    return { ...fb, replyFormat: "json-envelope", requests: fb.requests } as ModelBackend & { requests: unknown[] };
  };
  it("a run on an envelope backend sends the envelope prompt, identical for C and D except stubs", async () => {
    const dir = out();
    const bc = envBackend(["FINAL: x"]) as ModelBackend & { requests: { system: string }[] };
    const bd = envBackend(["FINAL: x"]) as ModelBackend & { requests: { system: string }[] };
    await runOne(spec("ctrl-01", "C", 1, "codex-cli"), deps(bc, dir));
    await runOne(spec("ctrl-01", "D", 1, "codex-cli"), deps(bd, dir));
    expect(bc.requests[0]?.system).toBe(buildSystemPrompt(c, "json-envelope"));
    expect(bd.requests[0]?.system).toBe(buildSystemPrompt(d, "json-envelope"));
  });
  it("uses reply.parsed, counts a non-JSON turn as malformed, and sends the JSON reminder", async () => {
    const dir = out();
    const seen: string[] = [];
    let n = 0;
    const backend: ModelBackend = {
      name: "codex-cli",
      paid: false,
      replyFormat: "json-envelope",
      async call(req) {
        seen.push(req.prompt);
        n += 1;
        const text = n === 1 ? "FINAL: 42" : '{"action":"final","code":"","answer":"42"}';
        const parsed = n === 1 ? ({ kind: "malformed", reason: "the reply is not valid JSON" } as const) : ({ kind: "final", answer: "42" } as const);
        return { text, parsed, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 0, raw: {} };
      },
    };
    const r = await runOne(spec("ctrl-01", "C", 1, "codex-cli"), deps(backend, dir));
    expect(r).toMatchObject({ malformed: 1, final: "42", turns: 2 });
    expect(seen[1]).toContain("required JSON format");
    const l = lines(path.join(dir, `${runId(spec("ctrl-01", "C", 1, "codex-cli"))}.jsonl`));
    expect(l[0]).toMatchObject({ reply_kind: "malformed" });
    expect(l[1]).toMatchObject({ reply_kind: "final" });
  });
});

describe("rate-limit sleep and retry (fake clock)", () => {
  it("sleeps the configured time and retries the same turn", async () => {
    const dir = out();
    const clock = fakeClock();
    let calls = 0;
    const b = fakeBackend((req, i) => {
      calls += 1;
      if (i < 2) throw new RateLimitError("usage limit reached");
      return ctrlPolicy(req, i);
    });
    const r = await runOne(spec("ctrl-01"), deps(b, dir, { clock, budget: new LimitBudget(30 * 60_000, 24 * 3_600_000) }));
    expect(clock.sleeps).toEqual([30 * 60_000, 30 * 60_000]);
    expect(calls).toBe(4);
    expect(r.pass).toBe(true);
    expect(r.turns).toBe(2);
    expect(lines(path.join(dir, `${r.id}.jsonl`))[0]).toMatchObject({ turn: 1, rate_limit_waits: 2 });
    expect(b.requests[0]).toEqual(b.requests[2]); // the very same turn was retried
  });

  it("gives up when the total wait would exceed BENCH_MAX_WAIT_HOURS, without writing a result", async () => {
    const dir = out();
    const clock = fakeClock();
    const b = fakeBackend(() => {
      throw new RateLimitError("rate limit");
    });
    const s = await runBench([spec("ctrl-01")], { ...deps(b, dir, { clock }), backends: { fake: b }, maxRuns: 500, budget: new LimitBudget(30 * 60_000, 60 * 60_000) });
    expect(clock.sleeps).toEqual([30 * 60_000, 30 * 60_000]);
    expect(s.stoppedBy).toBe("limit-budget");
    expect(s.ran).toBe(0);
    expect(existsSync(path.join(dir, `${runId(spec("ctrl-01"))}.json`))).toBe(false);
  });

  it("the wait budget is shared by the whole invocation", async () => {
    const dir = out();
    const clock = fakeClock();
    let i = 0;
    const b = fakeBackend(() => {
      i += 1;
      if (i === 1 || i === 3) throw new RateLimitError("limit");
      return "FINAL: x";
    });
    const s = await runBench([spec("ctrl-01", "C"), spec("ctrl-01", "D")], { ...deps(b, dir, { clock }), backends: { fake: b }, maxRuns: 500, budget: new LimitBudget(30 * 60_000, 30 * 60_000) });
    expect(s.ran).toBe(1);
    expect(s.stoppedBy).toBe("limit-budget");
  });
});

describe("resume", () => {
  it("skips finished runs and redoes unfinished ones from scratch", async () => {
    const dir = out();
    const plan = [spec("ctrl-01", "C"), spec("ctrl-01", "D"), spec("ctrl-02", "C"), spec("ctrl-02", "D")];
    const b1 = fakeBackend(scripted(["FINAL: x"]));
    const s1 = await runBench(plan, { ...deps(b1, dir), backends: { fake: b1 }, maxRuns: 500 });
    expect(s1).toMatchObject({ ran: 4, skipped: 0 });

    // one run lost its result file (crash after the last turn), one has a corrupt result, one a stale partial log
    const [a, bId, cId] = plan.map((p) => runId(p));
    rmSync(path.join(dir, `${a}.json`));
    writeFileSync(path.join(dir, `${bId}.json`), "{ not json");
    writeFileSync(path.join(dir, `${cId}.jsonl`), "stale line that must disappear\n", { flag: "a" });

    const b2 = fakeBackend(scripted(["FINAL: y"]));
    const s2 = await runBench(plan, { ...deps(b2, dir), backends: { fake: b2 }, maxRuns: 500 });
    expect(s2).toMatchObject({ ran: 2, skipped: 2 });
    expect(b2.requests).toHaveLength(2);
    expect(readResult(dir, a as string)?.final).toBe("y");
    expect(lines(path.join(dir, `${a}.jsonl`)).map((l) => l.type)).toEqual(["turn", "result"]);

    const b3 = fakeBackend(scripted(["FINAL: z"]));
    const s3 = await runBench(plan, { ...deps(b3, dir), backends: { fake: b3 }, maxRuns: 500 });
    expect(s3).toMatchObject({ ran: 0, skipped: 4 });
    expect(b3.requests).toHaveLength(0);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("bench/STOP", () => {
  it("does not start any run while the file exists", async () => {
    const dir = out();
    const stopFile = path.join(dir, "STOP");
    writeFileSync(stopFile, "");
    const b = fakeBackend(scripted(["FINAL: x"]));
    const s = await runBench([spec("ctrl-01")], { ...deps(b, dir, { stopFile }), backends: { fake: b }, maxRuns: 500 });
    expect(s).toMatchObject({ ran: 0, stoppedBy: "stop-file" });
    expect(b.requests).toHaveLength(0);
  });
  it("finishes the current run, then stops", async () => {
    const dir = out();
    const stopFile = path.join(dir, "STOP");
    const b = fakeBackend((_req, i) => {
      if (i === 0) writeFileSync(stopFile, ""); // created while run 1 is in progress
      return "FINAL: x";
    });
    const plan = [spec("ctrl-01", "C"), spec("ctrl-01", "D"), spec("ctrl-02", "C")];
    const s = await runBench(plan, { ...deps(b, dir, { stopFile }), backends: { fake: b }, maxRuns: 500 });
    expect(s).toMatchObject({ ran: 1, stoppedBy: "stop-file" });
    expect(readResult(dir, runId(plan[0] as RunSpec))).toBeDefined();
  });
  it("is honoured while sleeping on a rate limit", async () => {
    const dir = out();
    const stopFile = path.join(dir, "STOP");
    const clock = fakeClock();
    const b = fakeBackend(() => {
      writeFileSync(stopFile, "");
      throw new RateLimitError("limit");
    });
    const s = await runBench([spec("ctrl-01")], { ...deps(b, dir, { stopFile, clock }), backends: { fake: b }, maxRuns: 500 });
    expect(s.stoppedBy).toBe("stop-file");
    expect(clock.sleeps).toHaveLength(1);
  });
});

describe("BENCH_MAX_RUNS is a per-backend cap", () => {
  it("counts finished runs per backend, across invocations", async () => {
    const dir = out();
    const a = fakeBackend(scripted(["FINAL: x"]), "fake-a");
    const b = fakeBackend(scripted(["FINAL: x"]), "fake-b");
    const plan = planRuns({ tasks: [task("ctrl-01"), task("ctrl-02")], reps: 1, backends: [{ name: "fake-a", models: ["m"] }, { name: "fake-b", models: ["n"] }] });
    expect(plan).toHaveLength(8);
    const s1 = await runBench(plan, { ...deps(a, dir), backends: { "fake-a": a, "fake-b": b }, maxRuns: 3 });
    expect(s1).toMatchObject({ ran: 6, capped: 2 });
    expect(a.requests).toHaveLength(3);
    expect(b.requests).toHaveLength(3);
    const s2 = await runBench(plan, { ...deps(a, dir), backends: { "fake-a": a, "fake-b": b }, maxRuns: 3 });
    expect(s2).toMatchObject({ ran: 0, skipped: 6, capped: 2 });
    const s3 = await runBench(plan, { ...deps(a, dir), backends: { "fake-a": a, "fake-b": b }, maxRuns: 4 });
    expect(s3).toMatchObject({ ran: 2, skipped: 6, capped: 0 });
  });
});

describe("plan", () => {
  it("interleaves by (task, rep) with a seeded arm order and both arms every time", () => {
    const tasks = [task("ctrl-01"), task("nested-01"), task("page-01")];
    const plan = planRuns({ tasks, reps: 2, backends: [{ name: "claude-cli", models: ["claude-haiku-5-5", "claude-sonnet-5-5"] }] });
    expect(plan).toHaveLength(2 * 3 * 2 * 2);
    for (let i = 0; i < plan.length; i += 2) {
      const [x, y] = [plan[i] as RunSpec, plan[i + 1] as RunSpec];
      expect([x.task.id, x.rep, x.model]).toEqual([y.task.id, y.rep, y.model]);
      expect(new Set([x.arm, y.arm])).toEqual(new Set(["C", "D"]));
    }
    expect(plan.slice(0, 12).every((p) => p.rep === 1)).toBe(true);
    const orders = new Set(plan.map((p, i) => (i % 2 === 0 ? p.arm : "")).filter((x) => x));
    expect(orders.size).toBe(2); // both orders occur
    expect(planRuns({ tasks, reps: 2, backends: [{ name: "claude-cli", models: ["claude-haiku-5-5", "claude-sonnet-5-5"] }] })).toEqual(plan);
    expect(armOrder("ctrl-01", 1, "claude-haiku-5-5")).toEqual(armOrder("ctrl-01", 1, "claude-haiku-5-5"));
  });
  it("names result files <arm>-<model>-<task>-<rep>", () => {
    expect(runId(spec("ctrl-01", "D", 3, "claude-cli", "claude-haiku-5-5"))).toBe("D-claude-haiku-5-5-ctrl-01-3");
    expect(runId({ ...spec("ctrl-01", "C", 1, "codex-cli"), model: undefined })).toBe("C-codex-default-ctrl-01-1");
  });
  it("the smoke set is 3 pilot tasks: control, nested, pagination", () => {
    const pilot = loadPilot();
    const smoke = smokeTasks(TASKS, pilot);
    expect(smoke.map((t) => t.category)).toEqual(["control", "nested", "pagination"]);
    expect(smoke.every((t) => pilot.includes(t.id))).toBe(true);
  });
});

describe("committed arm D types (bench/arm-d)", () => {
  it("cover every mock tool at medium or high confidence", () => {
    const tools = new MockGithub({ seed: 2 }).listTools().map((t) => t.name).sort();
    expect(Object.keys(INFERRED).sort()).toEqual(tools);
    for (const t of Object.values(INFERRED)) expect(["medium", "high"], t.tool).toContain(t.confidence);
  });
});

describe("M6b shared prompt wording", () => {
  it("states that no tools exist and names the ts block and FINAL: protocol", () => {
    const p = buildSystemPrompt("declare const tools: {};");
    expect(p).toContain("NO tools exist");
    expect(p).toContain("Ignore any tools");
    expect(p).toContain("fenced code block tagged ts");
    expect(p).toContain("one line starting with `FINAL:`");
  });
});
