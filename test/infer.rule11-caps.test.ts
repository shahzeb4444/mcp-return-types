// SPEC §3 rule 11: depth cap 6 and map detection (more than 30 keys with homogeneous values, or key sets that differ).
import { describe, expect, it } from "vitest";
import { emitToolType } from "../src/emit/ts.js";
import { toOpenSchema } from "../src/emit/open.js";
import { inferSchema, MAP_MAX_KEYS, MAX_DEPTH } from "../src/infer/infer.js";
import { fits } from "../src/infer/schema.js";
import { inferTool } from "../src/infer/tool.js";
import { isMapLike, shapeOf, type Shape } from "../src/proxy/shape.js";
import { infer, sample } from "./infer-helpers.js";

/** {a:{a:{...{a: leaf}}}} with `levels` objects. */
const nest = (levels: number, leaf: unknown): unknown => (levels === 0 ? leaf : { a: nest(levels - 1, leaf) });
const keys = (prefix: string, n: number, value: (i: number) => unknown = () => 1) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, value(i)]));

describe("rule 11: depth cap", () => {
  it("types the root plus 5 nested levels; anything at level 6 or deeper becomes {}", () => {
    expect(MAX_DEPTH).toBe(6);
    let s = infer([nest(8, "x")]);
    for (let level = 0; level < MAX_DEPTH; level++) {
      expect(s.type).toBe("object");
      s = s.properties?.a ?? {};
    }
    expect(s).toEqual({ "x-capped": "depth" });
    // Five levels of objects with a string leaf at level 5 are typed fully.
    let t = infer([nest(5, "x")]);
    for (let level = 0; level < 5; level++) t = t.properties?.a ?? {};
    expect(t).toEqual({ type: "string" });
  });

  it("a value the recorder truncated (depth 12) becomes {}", () => {
    const truncated: Shape = { t: "truncated" };
    expect(inferSchema([truncated])).toEqual({ "x-capped": "depth" });
  });

});

/** An environment like server-everything `get-env` returns: 111 variables. */
const ENV = Object.fromEntries(
  Array.from({ length: 111 }, (_, i) => [`SECRET_VAR_NAME_${i}`, i % 3 === 0 ? `C:\Users\someone\dir${i}` : `value-${i}`]),
);
const keyNames = Object.keys(ENV);

describe("rule 11: map-like objects (more than 30 keys with homogeneous values, or key sets that differ)", () => {
  it("the threshold is 30 keys", () => {
    expect(MAP_MAX_KEYS).toBe(30);
  });

  it("records an object with more than 30 keys as a map: key count and value shapes, no key names", () => {
    const s = shapeOf(ENV);
    expect(s.t).toBe("map");
    if (s.t !== "map") return;
    expect(s.n).toBe(111);
    expect(s.values.length).toBe(50); // values are sampled like array items
    const text = JSON.stringify(s);
    for (const k of keyNames) expect(text).not.toContain(k);
    expect(text).not.toContain("someone");
  });

  it("keeps an object with exactly 30 keys as an object (boundary)", () => {
    const thirty = keys("k", 30);
    expect(shapeOf(thirty).t).toBe("object");
    const s = infer([thirty, thirty, thirty]);
    expect(Object.keys(s.properties ?? {})).toHaveLength(30);
    expect(s.required).toHaveLength(30);
    expect(shapeOf(keys("k", 31)).t).toBe("map");
  });

  it("get-env-like: 111 keys, the same in every sample, is a map of strings, and no key name reaches the schema or the type", () => {
    const samples = [sample(ENV), sample(ENV), sample(ENV)];
    const t = inferTool("get-env", samples, { now: new Date("2026-11-22T12:00:00Z") });
    expect(t.schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: { type: "string" },
    });
    const ts = emitToolType(t, "GetEnvResult", { exported: true });
    expect(ts).toContain("export type GetEnvResult = { [key: string]: string };");
    const all = JSON.stringify(samples) + JSON.stringify(t) + ts + JSON.stringify(toOpenSchema(t.schema));
    for (const k of keyNames) expect(all).not.toContain(k);
    expect(fits(shapeOf({ ...ENV, NEW_VAR: "x" }), t.schema)).toBe(true);
    expect(fits(shapeOf({ ...ENV, NEW_VAR: 1 }), t.schema)).toBe(false); // a value of a new type is drift
  });

  it("key sets that differ: objects of at most 30 keys whose union exceeds 30 are a map", () => {
    const samples = Array.from({ length: 4 }, (_, j) => keys(`user-${j}-`, 10, (i) => ({ score: i, name: "n" })));
    samples.forEach((o) => expect(shapeOf(o).t).toBe("object"));
    const s = infer(samples);
    expect(s).toEqual({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { score: { type: "integer" }, name: { type: "string" } },
        required: ["score", "name"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(s)).not.toContain("user-");
    expect(fits(shapeOf({ "never-seen-key": { score: 1, name: "x" } }), s)).toBe(true);
  });

  it("is not a map when the union of keys is exactly 30", () => {
    const a = keys("a", 15);
    const b = { ...keys("a", 10), ...keys("b", 15) }; // overlap 10/15, union: a0..a14 and b0..b14 = 30 keys
    const s = infer([a, b]);
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties ?? {})).toHaveLength(30);
    const c = { ...b, c0: 1 }; // 31 keys in the union
    expect(infer([a, b, c]).properties).toBeUndefined();
  });

  it("60 single-key objects with different keys are a map (the old >50 rule is covered)", () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ [`repo-${i}`]: { stars: i, url: "https://x.test" } }));
    const s = infer(samples);
    expect(s.properties).toBeUndefined();
    expect(s.additionalProperties).toEqual({
      type: "object",
      properties: { stars: { type: "integer" }, url: { type: "string", format: "uri" } },
      required: ["stars", "url"],
      additionalProperties: false,
    });
  });

  it("a key shared by every sample does not stop map detection once the key sets differ beyond 30", () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ id: i, [`dyn${i}`]: 1 }));
    const s = infer(samples);
    expect(s).toEqual({ type: "object", additionalProperties: { type: "integer" } });
  });

  it("small objects next to map shapes at the same position are merged into the map", () => {
    const s = infer([{ env: ENV }, { env: { ONE: "x" } }]);
    expect(s.properties?.env).toEqual({ type: "object", additionalProperties: { type: "string" } });
  });

  it("a map's value schema merges every value: nullable, unions and nested objects", () => {
    const samples = Array.from({ length: 6 }, (_, j) => keys(`s${j}-`, 50, (i) => (i % 2 ? "v" : null)));
    const s = infer(samples);
    expect(s["x-capped"]).toBeUndefined();
    expect(s.properties).toBeUndefined();
    expect(s.additionalProperties).toEqual({ type: ["string", "null"] });
  });

  it("a map shape does not fit a closed object schema, so an object that becomes map-like is drift", () => {
    const closed = infer([{ a: 1, b: 2 }]);
    expect(fits(shapeOf(ENV), closed)).toBe(false);
    expect(fits(shapeOf(ENV), {})).toBe(true);
  });

  it("mixed value types stay a typed object even with 80 keys (GitHub-repo-like)", () => {
    const repo = (n: number): Record<string, unknown> => ({
      ...Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => {
          const kind = i % 5;
          const v = kind === 0 ? `s${i}` : kind === 1 ? i : kind === 2 ? i % 2 === 0 : kind === 3 ? { id: i } : ["t"];
          return [`field_${i}`, v];
        }),
      ),
      stargazers_count: n,
    });
    expect(shapeOf(repo(1)).t).toBe("object");
    const s = infer([repo(1), repo(2), repo(3)]);
    expect(Object.keys(s.properties ?? {})).toHaveLength(81);
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toHaveLength(81);
    expect(s.properties?.field_0).toEqual({ type: "string" });
    expect(s.properties?.field_1).toEqual({ type: "integer" });
    expect(s.properties?.field_2).toEqual({ type: "boolean" });
    // the same through a differing union of keys (infer time, not only record time)
    const u = infer([{ ...repo(1), extra_a: 1 }, { ...repo(2), extra_b: 1 }]);
    expect(u.properties?.field_0).toEqual({ type: "string" });
  });

  it("boundary: 30 homogeneous keys is an object, 31 is a map; 31 mixed keys is an object", () => {
    expect(shapeOf(keys("k", 30)).t).toBe("object");
    expect(shapeOf(keys("k", 31)).t).toBe("map");
    const mixed31 = keys("k", 31, (i) => (i === 0 ? "x" : 1));
    expect(shapeOf(mixed31).t).toBe("object");
    expect(Object.keys(infer([mixed31]).properties ?? {})).toHaveLength(31);
    expect(infer([keys("k", 31)])).toEqual({ type: "object", additionalProperties: { type: "integer" } });
  });

  it("a map of homogeneous objects (same shape, different key sets) is a map", () => {
    const o = keys("id", 40, (i) => (i % 2 ? { name: "n", age: i } : { name: "m" }));
    expect(shapeOf(o).t).toBe("map");
    const s = infer([o]);
    expect(s.properties).toBeUndefined();
    expect((s.additionalProperties as { properties?: object }).properties).toEqual({
      name: { type: "string" },
      age: { type: "integer" },
    });
    expect(JSON.stringify(s)).not.toContain("id1");
  });

  it("objects whose shared keys disagree on type are not homogeneous, so they stay objects", () => {
    const o = keys("id", 40, (i) => ({ v: i % 2 ? "s" : 1 }));
    expect(shapeOf(o).t).toBe("object");
  });

  it("a mixed 40-key object records value counters and key names; a homogeneous one records none", () => {
    expect(isMapLike(keys("k", 40, (i) => (i ? 1 : "x")))).toBe(false);
    expect(isMapLike(keys("k", 40))).toBe(true);
  });
});
