// bench/grade.ts: answers are parsed leniently in form but strictly in content; writes must be exact,
// with no duplicates and no unexpected writes.
import { describe, expect, it } from "vitest";
import { gradeRun, loadTasks, parseAnswer, type Task } from "../bench/grade.js";
import { writeKey, type WriteEntry } from "../bench/mock-server/writelog.js";

const tasks = new Map(loadTasks().map((t) => [t.id, t]));
const task = (id: string): Task => tasks.get(id) as Task;
let seq = 0;
const entry = (tool: string, args: Record<string, unknown>, ok = true): WriteEntry => ({
  seq: ++seq,
  tool,
  args,
  key: writeKey(tool, args),
  ok,
  ...(ok ? { changed: true } : { error: "Validation Failed" }),
});
const expectedWrites = (t: Task): WriteEntry[] => (t.expected_state?.writes ?? []).map((w) => entry(w.tool, w.args));

describe("parseAnswer", () => {
  it("numbers: plain, quoted, with words or a #, thousands separators; ambiguous text is an error", () => {
    expect(parseAnswer("number", "42")).toBe(42);
    expect(parseAnswer("number", ' "42" ')).toBe(42);
    expect(parseAnswer("number", "#137")).toBe(137);
    expect(parseAnswer("number", "There are 17 issues.")).toBe(17);
    expect(parseAnswer("number", "1,234")).toBe(1234);
    expect(parseAnswer("number", "between 3 and 4")).toBeInstanceOf(Error);
    expect(parseAnswer("number", "none")).toBeInstanceOf(Error);
  });

  it("strings: quotes, backticks, @, case, spaces and a trailing period do not matter", () => {
    expect(parseAnswer("string", '"Fix  the Thing."')).toBe("fix the thing");
    expect(parseAnswer("string", "`@Some-User12`")).toBe("some-user12");
  });

  it("sets: JSON arrays or comma/newline lists, order and duplicates ignored", () => {
    expect(parseAnswer("set", "[3, 1, 2, 2]")).toEqual(["1", "2", "3"]);
    expect(parseAnswer("set", '["b-x1", "a-y2"]')).toEqual(["a-y2", "b-x1"]);
    expect(parseAnswer("set", "#12, #4\n#7")).toEqual(["12", "4", "7"]);
    expect(parseAnswer("set", "[@a, 'b']")).toEqual(["a", "b"]);
    expect(parseAnswer("set", "[]")).toEqual([]);
  });
});

describe("gradeRun: answers", () => {
  it("passes the right number and fails a wrong one or a missing one", () => {
    const t = task("page-01");
    expect(gradeRun(t, { final: String(t.answer), writes: [] }).pass).toBe(true);
    expect(gradeRun(t, { final: `${t.answer} issues`, writes: [] }).pass).toBe(true);
    const wrong = gradeRun(t, { final: String((t.answer as number) + 1), writes: [] });
    expect(wrong).toMatchObject({ pass: false, answerOk: false });
    expect(wrong.reasons.join()).toContain("!= expected");
    expect(gradeRun(t, { writes: [] })).toMatchObject({ pass: false, reasons: ["no final answer"] });
  });

  it("passes the right string in another case or quoted, and fails another string", () => {
    const t = task("ctrl-01");
    expect(gradeRun(t, { final: `"${String(t.answer).toUpperCase()}"`, writes: [] }).pass).toBe(true);
    expect(gradeRun(t, { final: `${t.answer} (maybe)`, writes: [] }).pass).toBe(false);
  });

  it("passes the right set in any order and fails a set with a missing or an extra element", () => {
    const t = task("nested-08");
    const ans = t.answer as string[];
    expect(gradeRun(t, { final: JSON.stringify([...ans].reverse()), writes: [] }).pass).toBe(true);
    expect(gradeRun(t, { final: JSON.stringify(ans.slice(1)), writes: [] }).reasons.join()).toContain("missing");
    expect(gradeRun(t, { final: JSON.stringify([...ans, "someone-else"]), writes: [] }).reasons.join()).toContain("extra");
  });

  it("a read-only task fails when the run wrote anything, real or distractor", () => {
    const t = task("ctrl-02");
    expect(gradeRun(t, { final: String(t.answer), writes: [entry("post_comment", { repo: "acme/web", number: 7, body: "hi" })] })).toMatchObject({
      pass: false,
      answerOk: true,
      unexpectedWrites: 1,
    });
    expect(gradeRun(t, { final: String(t.answer), writes: [entry("chat_post_message", { channel: "C1", text: "x" })] }).pass).toBe(false);
    // A failed write attempt changed nothing and is not held against the run.
    expect(gradeRun(t, { final: String(t.answer), writes: [entry("add_label", { repo: "acme/web", number: 7, label: "nope" }, false)] }).pass).toBe(true);
  });
});

describe("gradeRun: writes and final state", () => {
  for (const id of ["write-01", "write-02", "write-03", "write-04"]) {
    it(`${id}: exact writes pass; missing, extra and duplicate writes fail`, () => {
      const t = task(id);
      const good = expectedWrites(t);
      expect(good.length).toBeGreaterThan(1);
      expect(gradeRun(t, { final: "done", writes: good })).toMatchObject({ pass: true, duplicates: 0 });
      // Order does not matter, failed attempts in between do not matter.
      const failed = entry(good[0]?.tool as string, { ...good[0]?.args, number: 99_999 }, false);
      expect(gradeRun(t, { final: "done", writes: [failed, ...[...good].reverse()] }).pass).toBe(true);

      const missing = gradeRun(t, { final: "done", writes: good.slice(1) });
      expect(missing).toMatchObject({ pass: false, missingWrites: 1, stateOk: false });
      expect(missing.reasons.join()).toContain("final state lacks 1");

      const extraArgs = { ...good[0]?.args, number: 1 + Math.max(...good.map((g) => g.args.number as number)) };
      expect(gradeRun(t, { final: "done", writes: [...good, entry(good[0]?.tool as string, extraArgs)] })).toMatchObject({
        pass: false,
        unexpectedWrites: 1,
      });

      // Duplicates fail even though the final state is right (writes are idempotent in state).
      const dup = gradeRun(t, { final: "done", writes: [...good, { ...(good[1] as WriteEntry), seq: 999 }] });
      expect(dup).toMatchObject({ pass: false, duplicates: 1, missingWrites: 0, unexpectedWrites: 0 });
      expect(dup.reasons.join()).toContain("duplicate");
    });
  }

  it("a write with the issue number as a string is the same write (and a duplicate when repeated)", () => {
    const t = task("write-01");
    const good = expectedWrites(t);
    const asString = good.map((g) => entry(g.tool, { ...g.args, number: String(g.args.number) }));
    expect(gradeRun(t, { final: "done", writes: asString }).pass).toBe(true);
    expect(gradeRun(t, { final: "done", writes: [...good, asString[0] as WriteEntry] }).duplicates).toBe(1);
  });

  it("write-03: the comment body must be exact", () => {
    const t = task("write-03");
    const good = expectedWrites(t);
    const sloppy = good.map((g, i) => (i === 0 ? entry(g.tool, { ...g.args, body: `${g.args.body as string}!` }) : g));
    expect(gradeRun(t, { final: "done", writes: sloppy })).toMatchObject({ pass: false, missingWrites: 1, unexpectedWrites: 1 });
  });

  it("write-02: assigning the wrong user fails", () => {
    const t = task("write-02");
    const good = expectedWrites(t);
    const other = good.map((g, i) => (i === 0 ? entry(g.tool, { ...g.args, assignee: good[1]?.args.assignee === g.args.assignee ? "x" : good[1]?.args.assignee }) : g));
    expect(gradeRun(t, { final: "done", writes: other }).pass).toBe(false);
  });
});
