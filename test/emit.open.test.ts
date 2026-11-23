import { describe, expect, it } from "vitest";
import { hasClosedObject, isDeclarableRoot, toOpenSchema } from "../src/emit/open.js";
import type { JsonSchema } from "../src/infer/schema.js";
import { genValue, infer, rng } from "./infer-helpers.js";

describe("open schemas for the wire (owner decision: serve and outputSchema must be open)", () => {
  it("removes additionalProperties:false at every level", () => {
    const closed: JsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        a: { type: "object", additionalProperties: false, properties: { b: { type: "string" } }, required: ["b"] },
        list: { type: "array", items: { type: "object", additionalProperties: false, properties: { c: { type: "number" } } } },
        either: { anyOf: [{ type: "object", additionalProperties: false, properties: {} }, { type: "string" }] },
        map: { type: "object", additionalProperties: { type: "object", additionalProperties: false, properties: { d: { type: "null" } } } },
      },
      required: ["a"],
    };
    expect(hasClosedObject(closed)).toBe(true);
    const open = toOpenSchema(closed);
    expect(hasClosedObject(open)).toBe(false);
    expect(JSON.stringify(open)).not.toContain('"additionalProperties":false');
    // Everything else stays: types, required lists, and the map's value schema.
    expect(open.required).toEqual(["a"]);
    expect(open.properties?.a?.required).toEqual(["b"]);
    expect(open.properties?.map?.additionalProperties).toMatchObject({ type: "object", properties: { d: { type: "null" } } });
  });

  it("does not change the schema it is given", () => {
    const closed: JsonSchema = { type: "object", additionalProperties: false, properties: { a: { type: "string" } }, "x-capped": "keys" };
    const before = JSON.stringify(closed);
    toOpenSchema(closed);
    expect(JSON.stringify(closed)).toBe(before);
  });

  it("drops x- annotations and $schema, but keeps properties that happen to be named like keywords", () => {
    const open = toOpenSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      "x-capped": "keys",
      properties: {
        "x-observed-values": { type: "string", "x-observed-values": ["a"], format: "email" },
        additionalProperties: { type: "boolean" },
        $schema: { type: "string" },
      },
    });
    expect(open.$schema).toBeUndefined();
    expect(open["x-capped"]).toBeUndefined();
    expect(Object.keys(open.properties ?? {}).sort()).toEqual(["$schema", "additionalProperties", "x-observed-values"]);
    expect(open.properties?.["x-observed-values"]).toEqual({ type: "string", format: "email" });
    expect(open.properties?.additionalProperties).toEqual({ type: "boolean" });
  });

  it("every schema that infer produces becomes open (property test over random values)", () => {
    const r = rng(2026);
    for (let i = 0; i < 100; i++) {
      const values = Array.from({ length: 1 + r.int(5) }, () => genValue(r));
      const closed = infer(values);
      const open = toOpenSchema(closed);
      expect(hasClosedObject(open), JSON.stringify(closed)).toBe(false);
    }
  });

  it("only object roots can be declared as an outputSchema", () => {
    expect(isDeclarableRoot(infer([{ a: 1 }]))).toBe(true);
    expect(isDeclarableRoot(infer([[{ a: 1 }]]))).toBe(false);
    expect(isDeclarableRoot(infer(["x"]))).toBe(false);
    expect(isDeclarableRoot(infer([{ a: 1 }, null]))).toBe(false);
    expect(isDeclarableRoot(infer([{ a: 1 }, "x"]))).toBe(false);
  });
});
