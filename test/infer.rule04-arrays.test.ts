// SPEC §3 rule 4: merge the item schemas of all elements across all samples.
import { describe, expect, it } from "vitest";
import { inferTool } from "../src/infer/tool.js";
import { infer, sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");

describe("rule 4: arrays", () => {
  it("merges all elements of one array into one item schema", () => {
    expect(infer([[1, "a", null]])).toEqual({ type: "array", items: { type: ["string", "integer", "null"] } });
  });

  it("merges array items across samples: object keys missing in some items become optional", () => {
    const s = infer([
      { items: [{ number: 1, assignee: "a" }] },
      { items: [{ number: 2 }, { number: 3, assignee: null }] },
    ]);
    expect(s.properties?.items).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { number: { type: "integer" }, assignee: { type: ["string", "null"] } },
        required: ["number"],
        additionalProperties: false,
      },
    });
  });

  it("every array empty: items are {} and the tool gets low confidence", () => {
    expect(infer([[], []])).toEqual({ type: "array", items: {} });
    const values = [{ labels: [] }, { labels: [] }, { labels: [] }];
    const r = inferTool(
      "t",
      values.map((v, i) => sample(v, { args: `a${i}` })),
      { now },
    );
    expect(r.schema.properties?.labels).toEqual({ type: "array", items: {} });
    expect(r.confidence).toBe("low");
    expect(r.confidenceReasons).toContain("every array seen was empty");
  });

  it("empty arrays next to non-empty ones take the items of the non-empty ones", () => {
    expect(infer([[], [1, 2], []])).toEqual({ type: "array", items: { type: "integer" } });
  });

  it("handles nested arrays and nullable arrays", () => {
    expect(infer([[[1], [2.5]], [[]]])).toEqual({ type: "array", items: { type: "array", items: { type: "number" } } });
    expect(infer([[1], null])).toEqual({ type: ["array", "null"], items: { type: "integer" } });
  });
});
