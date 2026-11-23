// bench/tasks: 20 tasks in the BENCHMARK.md categories, the fixed pilot, up-to-date answer files, and
// the anti-leak property (seed-1 warm-up traffic can never contain a seed-2 answer).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerSize, loadPilot, loadTasks, TASKS_DIR } from "../bench/grade.js";
import { buildWorld } from "../bench/mock-server/data.js";
import { pilotJson, serialize, taskJson } from "../bench/tasks/build.js";
import { PILOT_IDS, TASKS } from "../bench/tasks/defs.js";

const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

describe("tasks", () => {
  const tasks = loadTasks();

  it("has 20 tasks: 8 nested/optional, 6 pagination, 4 writes, 2 single-call controls", () => {
    expect(tasks).toHaveLength(20);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(20);
    expect(count(tasks.map((t) => t.category))).toEqual({ nested: 8, pagination: 6, write: 4, control: 2 });
  });

  it("the pilot is the fixed 12-task stratified subset: 5 nested, 4 pagination, 2 writes, 1 control", () => {
    const pilot = loadPilot();
    expect(pilot).toEqual(PILOT_IDS);
    expect(new Set(pilot).size).toBe(12);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(pilot.every((id) => byId.has(id))).toBe(true);
    expect(count(pilot.map((id) => byId.get(id)?.category as string))).toEqual({ nested: 5, pagination: 4, write: 2, control: 1 });
  });

  it("the task files are exactly what `npm run bench:tasks` writes (seed-2 answers from the oracles)", () => {
    for (const def of TASKS) {
      expect(readFileSync(path.join(TASKS_DIR, `${def.id}.json`), "utf8").replace(/\r\n/g, "\n"), def.id).toBe(serialize(taskJson(def)));
    }
    expect(readFileSync(path.join(TASKS_DIR, "pilot.json"), "utf8").replace(/\r\n/g, "\n")).toBe(serialize(pilotJson()));
  });

  it("every task has a code-checkable answer or expected writes, never both, never empty", () => {
    for (const t of tasks) {
      if (t.category === "write") {
        expect(t.answer_type, t.id).toBe("none");
        expect(t.answer, t.id).toBeUndefined();
        expect(t.expected_state?.writes.length, t.id).toBeGreaterThan(0);
      } else {
        expect(t.expected_state, t.id).toBeUndefined();
        expect(t.answer, t.id).toBeDefined();
        expect(answerSize(t), t.id).toBeGreaterThan(0);
      }
    }
  });

  it("prompts never contain their own answer", () => {
    for (const t of tasks) {
      if (t.answer_type === "string") expect(t.prompt.toLowerCase(), t.id).not.toContain(String(t.answer).toLowerCase());
      if (t.answer_type === "set") for (const a of t.answer as string[]) if (typeof a === "string") expect(t.prompt, t.id).not.toContain(a);
    }
  });
});

describe("anti-leak: seed 1 (warm-up) and seed 2 (evaluation) give different answers for every task", () => {
  const w1 = buildWorld(1);
  const w2 = buildWorld(2);
  for (const def of TASKS) {
    it(def.id, () => {
      const a = def.oracle(w1);
      const b = def.oracle(w2);
      const key = (x: typeof a): string => JSON.stringify(x.answer ?? x.writes);
      expect(key(a)).not.toBe(key(b));
      // Both seeds give a usable task: no empty set, no empty write list, no empty string.
      for (const x of [a, b]) {
        if (Array.isArray(x.answer)) expect(x.answer.length).toBeGreaterThan(0);
        if (typeof x.answer === "string") expect(x.answer).not.toBe("");
        if (x.writes) expect(x.writes.length).toBeGreaterThan(0);
      }
      // A set answer from seed 1 shares no element with seed 2 only by accident; at least it is not a subset.
      if (Array.isArray(a.answer) && Array.isArray(b.answer)) {
        expect(b.answer.every((x) => (a.answer as unknown[]).includes(x))).toBe(false);
      }
    });
  }
});
