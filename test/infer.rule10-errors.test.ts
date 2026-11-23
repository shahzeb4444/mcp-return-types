// SPEC §3 rule 10: error results (isError: true) get a separate shape, never merged into success.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInfer, type SchemasFile } from "../src/infer/run.js";
import { inferTool } from "../src/infer/tool.js";
import type { Sample } from "../src/proxy/recorder.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");
const rpcError = (code: number): Sample => ({ ...sample(null), shape: undefined, unwrap: "none", blocks: [], rpcError: { code } });

describe("rule 10: error results", () => {
  it("keeps isError shapes out of the success schema and in their own error schema", () => {
    const r = inferTool(
      "t",
      [sample({ id: 1 }), sample({ message: "not found", code: 404 }, { isError: true }), sample({ id: 2 })],
      { now },
    );
    expect(Object.keys(r.schema.properties ?? {})).toEqual(["id"]);
    expect(r.schema.required).toEqual(["id"]);
    expect(r.error?.samples).toBe(1);
    expect(r.error?.schema?.properties).toEqual({ message: { type: "string" }, code: { type: "integer" } });
  });

  it("counts JSON-RPC errors by code only", () => {
    const r = inferTool("t", [sample({ id: 1 }), rpcError(-32602), rpcError(-32602), rpcError(-32603)], { now });
    expect(r.error).toEqual({ samples: 0, unwrapCounts: {}, rpcErrors: { "-32602": 2, "-32603": 1 } });
  });

  it("plain-text error messages give a string error schema", () => {
    const r = inferTool("t", [sample({ id: 1 }), sample("Tool failed", { isError: true, unwrap: "text" })], { now });
    expect(r.error?.schema?.type).toBe("string");
    expect(r.error?.unwrapCounts).toEqual({ text: 1 });
    expect(r.unwrap).toBe("json-text");
  });

  it("errors do not count towards confidence (samples, argument sets)", () => {
    const errs = Array.from({ length: 12 }, (_, i) => sample({ e: 1 }, { isError: true, args: `e${i}` }));
    const r = inferTool("t", [sample({ id: 1 }), ...errs], { now });
    expect(r).toMatchObject({ samples: 1, distinctArgs: 1, confidence: "low" });
  });

  it("an error-only tool has an empty success schema and low confidence", () => {
    const r = inferTool("t", [sample("boom", { isError: true, unwrap: "text" })], { now });
    expect(r.schema).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema" });
    expect(r.confidence).toBe("low");
    expect(r.unwrap).toBe("none");
  });

  it("an error result with a new shape is not drift", () => {
    const inDir = tmpDir();
    const dir = path.join(inDir, "samples", "srv");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "t.jsonl");
    appendFileSync(file, `${JSON.stringify(sample({ id: 1 }))}\n`);
    runInfer({ inDir, now });
    appendFileSync(file, `${JSON.stringify(sample({ totally: "different" }, { isError: true }))}\n`);
    runInfer({ inDir, now });
    const out = JSON.parse(readFileSync(path.join(inDir, "schemas", "srv.json"), "utf8")) as SchemasFile;
    expect(out.tools.t).toMatchObject({ version: 1, drift: [] });
    expect(out.tools.t?.error?.samples).toBe(1);
  });
});
