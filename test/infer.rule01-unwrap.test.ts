// SPEC §3 rule 1: unwrap first, and record which unwrap path was used.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSamples } from "../src/infer/run.js";
import { inferTool } from "../src/infer/tool.js";
import { Recorder, type Sample } from "../src/proxy/recorder.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");

describe("rule 1: unwrap path", () => {
  it("records structuredContent as the unwrap path and infers from it", () => {
    const r = inferTool("t", [sample({ temp: 20 }, { unwrap: "structuredContent" })], { now });
    expect(r.unwrap).toBe("structuredContent");
    expect(r.unwrapCounts).toEqual({ structuredContent: 1 });
    expect(r.schema.properties?.temp).toEqual({ type: "integer" });
  });

  it("types a plain-text tool as a string with unwrap 'text'", () => {
    const r = inferTool("t", [sample("Echo: hi", { unwrap: "text" }), sample("Echo: there", { unwrap: "text" })], {
      now,
    });
    expect(r.unwrap).toBe("text");
    expect(r.schema).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" });
  });

  it("marks a tool that sometimes returns JSON and sometimes plain text as 'mixed' and keeps both types", () => {
    const r = inferTool("t", [sample({ ok: true }), sample("not json", { unwrap: "text" })], { now });
    expect(r.unwrap).toBe("mixed");
    expect(r.unwrapCounts).toEqual({ "json-text": 1, text: 1 });
    expect(r.schema.type).toEqual(["object", "string"]);
  });

  it("uses unwrap 'none' and an empty schema when results had no text and no structuredContent", () => {
    const img: Sample = { ...sample(null, { unwrap: "none", blocks: ["image"] }), shape: undefined };
    const r = inferTool("t", [img], { now });
    expect(r.unwrap).toBe("none");
    expect(r.schema).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema" });
  });

  it("works on real recorder output: several text parts are joined before JSON.parse", () => {
    const outDir = tmpDir();
    const rec = new Recorder({ outDir, fallbackName: "srv" });
    const parts = ['{"items": [1, 2],', ' "next_page": null}'];
    rec.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list", arguments: {} } });
    rec.fromServer({
      jsonrpc: "2.0",
      id: 1,
      result: { content: parts.map((text) => ({ type: "text", text })) },
    });
    const { samples } = readSamples(path.join(outDir, "samples", "srv", "list.jsonl"));
    const r = inferTool("list", samples, { now });
    expect(r.unwrap).toBe("json-text");
    expect(r.schema.properties).toEqual({ items: { type: "array", items: { type: "integer" } }, next_page: { type: "null" } });
  });
});
