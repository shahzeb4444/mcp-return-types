// SPEC §3 rule 2: primitive types; integer only if every sample is an integer.
import { describe, expect, it } from "vitest";
import { fits } from "../src/infer/schema.js";
import { shapeOf } from "../src/proxy/shape.js";
import { infer } from "./infer-helpers.js";

describe("rule 2: primitive types", () => {
  it("infers string, boolean and null", () => {
    expect(infer(["a", "b"])).toEqual({ type: "string" });
    expect(infer([true, false])).toEqual({ type: "boolean" });
    expect(infer([null])).toEqual({ type: "null" });
  });

  it("detects integers when every sample is an integer (incl. 0, negatives and large values)", () => {
    expect(infer([0, -7, 42, 2 ** 40])).toEqual({ type: "integer" });
  });

  it("widens to number as soon as one sample has a fraction", () => {
    expect(infer([1, 2, 3.25])).toEqual({ type: "number" });
    expect(infer([3.25, 1])).toEqual({ type: "number" });
  });

  it("1 vs 1.0: JSON 1.0 is the same number as 1, so it is an integer (as in JSON Schema 2020-12)", () => {
    const parsed = JSON.parse('{"a": 1.0, "b": 1, "c": 1.5}') as Record<string, number>;
    expect(shapeOf(parsed.a)).toEqual({ t: "integer" });
    expect(infer([parsed.a, parsed.b])).toEqual({ type: "integer" });
    expect(infer([parsed.a, parsed.c])).toEqual({ type: "number" });
  });

  it("an integer value fits a number schema, a fractional value does not fit an integer schema", () => {
    expect(fits({ t: "integer" }, { type: "number" })).toBe(true);
    expect(fits({ t: "number" }, { type: "integer" })).toBe(false);
  });

  it("mixed primitives become a type list in a fixed order with null last", () => {
    expect(infer([null, 1, "x", true])).toEqual({ type: ["string", "integer", "boolean", "null"] });
    expect(infer([1.5, 2, null])).toEqual({ type: ["number", "null"] });
  });
});
