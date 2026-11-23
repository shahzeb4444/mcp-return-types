// SPEC §3 rule 6: x-observed-values hints from the per-field value counters (SPEC §4).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSamples } from "../src/infer/run.js";
import { fits } from "../src/infer/schema.js";
import { inferTool, type ValuesFile } from "../src/infer/tool.js";
import { Recorder } from "../src/proxy/recorder.js";
import { shapeOf } from "../src/proxy/shape.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");
const many = (n: number, value: unknown) => Array.from({ length: n }, (_, i) => sample(value, { args: `a${i}` }));
const values = (fields: ValuesFile["fields"]): ValuesFile => ({ fields, highCardinality: [] });

describe("rule 6: enum hints", () => {
  it("adds x-observed-values (most frequent first) for ≤8 distinct values over ≥20 samples", () => {
    const r = inferTool("t", many(20, { state: "open" }), {
      now,
      values: values({ "$.state": { closed: 5, open: 15 } }),
    });
    expect(r.schema.properties?.state).toEqual({ type: "string", "x-observed-values": ["open", "closed"] });
  });

  it("gives no hint below 20 samples", () => {
    const r = inferTool("t", many(19, { state: "open" }), { now, values: values({ "$.state": { open: 19 } }) });
    expect(r.schema.properties?.state).toEqual({ type: "string" });
  });

  it("gives no hint when the field's counter saw fewer than 20 values, or was dropped as high-cardinality", () => {
    const rare = inferTool("t", many(25, { state: "open" }), { now, values: values({ "$.state": { open: 3 } }) });
    expect(rare.schema.properties?.state).toEqual({ type: "string" });
    const high = inferTool("t", many(25, { id: "x" }), {
      now,
      values: { fields: {}, highCardinality: ["$.id"] },
    });
    expect(high.schema.properties?.id).toEqual({ type: "string" });
  });

  it("takes values only from the counters, never from stored sample values (--keep-values)", () => {
    const kept = Array.from({ length: 20 }, (_, i) => ({ ...sample({ s: "a" }, { args: `a${i}` }), value: { s: "a" } }));
    expect(inferTool("t", kept, { now }).schema.properties?.s).toEqual({ type: "string" });
  });

  it("is a hint, not an enum: other values still validate", () => {
    const r = inferTool("t", many(20, { state: "open" }), { now, values: values({ "$.state": { open: 20 } }) });
    expect(JSON.stringify(r.schema)).not.toContain("\"enum\"");
    expect(fits(shapeOf({ state: "merged" }), r.schema)).toBe(true);
  });

  it("works end to end with real recorder counters, including fields inside arrays", () => {
    const outDir = tmpDir();
    const rec = new Recorder({ outDir, fallbackName: "srv" });
    const states = ["open", "closed", "open", "all"];
    for (let i = 0; i < 20; i++) {
      const payload = {
        items: [{ state: states[i % 4], title: `title number ${i}` }],
      };
      rec.fromClient({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "list", arguments: { page: i } } });
      rec.fromServer({ jsonrpc: "2.0", id: i, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
    }
    const dir = path.join(outDir, "samples", "srv");
    const { samples } = readSamples(path.join(dir, "list.jsonl"));
    const vf = JSON.parse(readFileSync(path.join(dir, "list.values.json"), "utf8")) as ValuesFile;
    const r = inferTool("list", samples, { now, values: vf });
    const item = r.schema.properties?.items?.items;
    expect(item?.properties?.state).toEqual({ type: "string", "x-observed-values": ["open", "all", "closed"] });
    expect(item?.properties?.title).toEqual({ type: "string" }); // 20 distinct titles: high-cardinality
  });
});

