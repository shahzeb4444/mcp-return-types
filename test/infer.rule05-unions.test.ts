// SPEC §3 rule 5: unions, the 50% overlap rule (against the smaller key set), anyOf capped at 4.
import { describe, expect, it } from "vitest";
import { MAX_UNION, overlap } from "../src/infer/infer.js";
import { fits } from "../src/infer/schema.js";
import { shapeOf } from "../src/proxy/shape.js";
import { infer } from "./infer-helpers.js";

const obj = (...keys: string[]): Record<string, number> => Object.fromEntries(keys.map((k) => [k, 1]));

describe("rule 5: unions", () => {
  it("overlap is |A ∩ B| / min(|A|, |B|); a subset or the empty set overlaps fully", () => {
    expect(overlap(["a", "b"], ["a", "b", "c", "d", "e", "f"])).toBe(1);
    expect(overlap(["a", "b", "c", "d"], ["a", "b", "x", "y", "z", "w"])).toBe(0.5);
    expect(overlap(["a", "b", "c", "d"], ["a", "x", "y", "z"])).toBe(0.25);
    expect(overlap([], ["a"])).toBe(1);
  });

  it("merges a small object into a big one it is a subset of (Jaccard 2/6 would have split them)", () => {
    const s = infer([obj("a", "b"), obj("a", "b", "c", "d", "e", "f")]);
    expect(s.anyOf).toBeUndefined();
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["a", "b"]);
    expect(Object.keys(s.properties ?? {})).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("merges at exactly 50% overlap", () => {
    const s = infer([obj("a", "b", "c", "d"), obj("a", "b", "x", "y", "z", "w")]);
    expect(s.anyOf).toBeUndefined();
    expect(s.required).toEqual(["a", "b"]);
  });

  it("below 50% overlap the objects become anyOf branches (larger group first)", () => {
    const s = infer([obj("a", "b", "c", "d"), obj("a", "x", "y", "z"), obj("a", "x", "y", "z")]);
    expect(s.anyOf).toHaveLength(2);
    expect(Object.keys(s.anyOf?.[0]?.properties ?? {})).toEqual(["a", "x", "y", "z"]);
    expect(Object.keys(s.anyOf?.[1]?.properties ?? {})).toEqual(["a", "b", "c", "d"]);
    expect(fits(shapeOf(obj("a", "b", "c", "d")), s)).toBe(true);
    expect(fits(shapeOf(obj("a", "b", "y", "z")), s)).toBe(false);
  });

  it("joins groups transitively through a bridging shape (connected components)", () => {
    // {a,b} and {c,d} share nothing, but {a,b,c,d} overlaps both fully.
    expect(infer([obj("a", "b"), obj("c", "d")]).anyOf).toHaveLength(2);
    const s = infer([obj("a", "b"), obj("c", "d"), obj("a", "b", "c", "d")]);
    expect(s.anyOf).toBeUndefined();
    expect(s.required).toBeUndefined();
  });

  it("an object plus primitives stays one schema with a type list", () => {
    expect(infer([{ id: 1 }, "oops", null])).toEqual({
      type: ["object", "string", "null"],
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("keeps up to 4 anyOf branches: 3 object groups plus the primitive branch", () => {
    const s = infer([obj("a"), obj("b"), obj("c"), "text", 3]);
    expect(MAX_UNION).toBe(4);
    expect(s.anyOf).toHaveLength(4);
    expect(s.anyOf?.[3]).toEqual({ type: ["string", "integer"] });
  });

  it("caps at 4 branches: a 5th branch turns the position into {} (marked x-capped)", () => {
    expect(infer([obj("a"), obj("b"), obj("c"), obj("d"), obj("e")])).toEqual({ "x-capped": "union" });
    expect(infer([obj("a"), obj("b"), obj("c"), obj("d"), null])).toEqual({ "x-capped": "union" });
    expect(infer([obj("a"), obj("b"), obj("c"), obj("d")]).anyOf).toHaveLength(4);
  });
});
