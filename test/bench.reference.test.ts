// M4 "Done when": the scripted reference solver (no LLM, SDK client against a fresh mock server per
// task) passes all 20 tasks on seed 2. Also: it passes seed 1 against the oracles (it is not tuned to
// seed 2), and the same real pipeline FAILS on wrong answers and on duplicate or extra writes.
import { describe, expect, it } from "vitest";
import { loadTasks, type Task } from "../bench/grade.js";
import { buildWorld } from "../bench/mock-server/data.js";
import { solveTask } from "../bench/reference-solver.js";
import { TASKS } from "../bench/tasks/defs.js";

const tasks = loadTasks();
const byId = new Map(tasks.map((t) => [t.id, t]));

describe("reference solver", () => {
  it("passes all 20 tasks on seed 2", async () => {
    const failures: string[] = [];
    for (const task of tasks) {
      const r = await solveTask(task);
      if (!r.grade.pass) failures.push(`${task.id}: ${r.grade.reasons.join("; ")}`);
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it("passes all 20 tasks on seed 1 too, graded against the seed-1 oracles", async () => {
    const w1 = buildWorld(1);
    const failures: string[] = [];
    for (const def of TASKS) {
      const r0 = def.oracle(w1);
      const r = await solveTask(byId.get(def.id) as Task, { seed: 1, expected: { answer: r0.answer, writes: r0.writes ?? [] } });
      if (!r.grade.pass) failures.push(`${def.id}: ${r.grade.reasons.join("; ")}`);
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it("seed-2 answers fail on seed 1 (the grader really checks the seed)", async () => {
    const r = await solveTask(byId.get("page-01") as Task, { seed: 1 });
    expect(r.grade.pass).toBe(false);
  }, 60_000);
});

describe("the grader fails real runs that are wrong", () => {
  it("a wrong answer", async () => {
    const r = await solveTask(byId.get("nested-01") as Task, { tamper: async (final) => String(Number(final) + 1) });
    expect(r.grade).toMatchObject({ pass: false, answerOk: false });
  }, 60_000);

  it("a duplicate write through the real server (state is still right)", async () => {
    const task = byId.get("write-01") as Task;
    const first = task.expected_state?.writes[0];
    const r = await solveTask(task, {
      tamper: async (final, call) => {
        await call("add_label", { ...first?.args });
        return final;
      },
    });
    expect(r.grade).toMatchObject({ pass: false, duplicates: 1, missingWrites: 0, unexpectedWrites: 0 });
  }, 60_000);

  it("a duplicate comment, and an extra write on another issue", async () => {
    const task = byId.get("write-03") as Task;
    const first = task.expected_state?.writes[0];
    const r = await solveTask(task, {
      tamper: async (final, call) => {
        await call("post_comment", { ...first?.args });
        await call("add_label", { repo: "acme/web", number: 1, label: "stale" });
        return final;
      },
    });
    expect(r.grade).toMatchObject({ pass: false, duplicates: 1, unexpectedWrites: 1 });
  }, 60_000);
});
