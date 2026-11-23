// SPEC §3 rule 9: a new sample that breaks the current schema widens it, logs a drift
// event and bumps the schema version.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInfer, updateEntry, type SchemasFile } from "../src/infer/run.js";
import { fits } from "../src/infer/schema.js";
import { inferTool } from "../src/infer/tool.js";
import type { Sample } from "../src/proxy/recorder.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");

function store() {
  const inDir = tmpDir();
  const dir = path.join(inDir, "samples", "srv");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "get_issue.jsonl");
  const add = (...values: unknown[]): void =>
    appendFileSync(file, values.map((v) => `${JSON.stringify(sample(v, { tool: "get_issue" }))}\n`).join(""));
  const run = () => {
    runInfer({ inDir, now });
    const out = JSON.parse(readFileSync(path.join(inDir, "schemas", "srv.json"), "utf8")) as SchemasFile;
    return out.tools.get_issue as SchemasFile["tools"][string];
  };
  return { inDir, file, add, run };
}

describe("rule 9: drift", () => {
  it("first inference is version 1 with no drift", () => {
    const s = store();
    s.add({ number: 1, title: "a" }, { number: 2, title: "b" });
    const e = s.run();
    expect(e).toMatchObject({ version: 1, seen: 2, drift: [] });
    expect(existsSync(path.join(s.inDir, "drift.jsonl"))).toBe(false);
  });

  it("a sample with a new key breaks the schema: widened (key optional), drift logged, version bumped", () => {
    const s = store();
    s.add({ number: 1, title: "a" }, { number: 2, title: "b" });
    s.run();
    s.add({ number: 3, title: "c", assignee: { login: "x" } });
    const e = s.run();
    expect(e.version).toBe(2);
    expect(e.drift).toEqual([{ at: now.toISOString(), fromVersion: 1, toVersion: 2, brokenSamples: 1 }]);
    expect(e.schema.required).toEqual(["number", "title"]);
    expect(e.schema.properties?.assignee?.type).toBe("object");
    const log = readFileSync(path.join(s.inDir, "drift.jsonl"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] as string)).toMatchObject({ source: "infer", server: "srv", tool: "get_issue", toVersion: 2 });
  });

  it("null where a string was seen and a fraction where integers were seen both widen the schema", () => {
    const s = store();
    s.add({ closed_at: "2026-01-01T00:00:00Z", score: 1 });
    s.run();
    s.add({ closed_at: null, score: 2.5 });
    const e = s.run();
    expect(e.version).toBe(2);
    expect(e.drift[0]?.brokenSamples).toBe(1);
    expect(e.schema.properties?.closed_at?.type).toEqual(["string", "null"]);
    expect(e.schema.properties?.score?.type).toBe("number");
  });

  it("a new sample that fits changes nothing: same version, no drift", () => {
    const s = store();
    s.add({ number: 1, title: "a" });
    s.run();
    s.add({ number: 9, title: "zzz" });
    const e = s.run();
    expect(e).toMatchObject({ version: 1, seen: 2, drift: [] });
  });

  it("the widened schema still accepts every older sample", () => {
    const s = store();
    s.add({ a: 1 }, { a: 2, b: "x" });
    s.run();
    s.add({ c: [1] }, { a: null });
    const e = s.run();
    for (const line of readFileSync(s.file, "utf8").trim().split("\n")) {
      expect(fits((JSON.parse(line) as Sample).shape as NonNullable<Sample["shape"]>, e.schema)).toBe(true);
    }
  });

  it("when the samples file was reset (shorter than before), all its samples count as new", () => {
    const s = store();
    s.add({ a: 1 }, { a: 2 }, { a: 3 });
    s.run();
    writeFileSync(s.file, "");
    s.add({ a: "now a string" });
    const e = s.run();
    expect(e).toMatchObject({ version: 2, seen: 1 });
    expect(e.drift[0]?.brokenSamples).toBe(1);
  });

  it("updateEntry bumps the version on any schema change, and logs drift only for breaking samples", () => {
    const old = [sample({ items: [] }), sample({ items: [] })];
    const prev = updateEntry(undefined, inferTool("t", old, { now }), old, now).entry;
    // Items learned from new data narrow `items: {}`; nothing was broken, but the schema changed.
    const more = [...old, sample({ items: [1] })];
    const { entry, drift } = updateEntry(prev, inferTool("t", more, { now }), more, now);
    expect(drift).toBeUndefined();
    expect(entry.version).toBe(2);
  });
});
