// M9: the match checker used by scripts/validate-real-servers.ts must be able to FAIL.
// These are the negative controls: schemas inferred from small training sets, then values that break them.
import { describe, expect, it } from "vitest";
import { compileValidators, explain, readingsFor, type EnumMiss, type Violation } from "../scripts/real-servers/check.js";
import { inferSchema } from "../src/infer/infer.js";
import { shapeOf } from "../src/proxy/shape.js";

const train = (...values: unknown[]) => inferSchema(values.map((v) => shapeOf(v)));
const check = (schema: ReturnType<typeof train>, value: unknown): { violations: Violation[]; enums: EnumMiss[]; closed: boolean; open: boolean } => {
  const violations: Violation[] = [];
  const enums: EnumMiss[] = [];
  explain(value, schema, "$", violations, enums);
  const v = compileValidators(schema);
  return { violations, enums, closed: v.closed(value), open: v.open(value) };
};

describe("M9 match checker (negative controls)", () => {
  it("accepts a value of the trained shape", () => {
    const s = train({ a: 1, b: "x" }, { a: 2, b: "y" });
    const r = check(s, { a: 3, b: "z" });
    expect(r.violations).toEqual([]);
    expect(r.closed).toBe(true);
    expect(r.open).toBe(true);
  });

  it("reports a key never seen in training as optional-key; serve (open schema) still accepts it", () => {
    const s = train({ a: 1 }, { a: 2 });
    const r = check(s, { a: 3, extra: true });
    expect(r.violations.map((v) => [v.kind, v.path])).toEqual([["optional-key", "$.extra"]]);
    expect(r.closed).toBe(false);
    expect(r.open).toBe(true);
  });

  it("reports a key that was always present and is now missing", () => {
    const s = train({ a: 1, b: 1 }, { a: 2, b: 2 });
    const r = check(s, { a: 3 });
    expect(r.violations.map((v) => [v.kind, v.path])).toEqual([["optional-key", "$.b"]]);
    expect(r.closed).toBe(false);
    expect(r.open).toBe(false);
  });

  it("does not report a key that training already saw as optional", () => {
    const s = train({ a: 1, b: 1 }, { a: 2 });
    expect(check(s, { a: 3 }).violations).toEqual([]);
    expect(check(s, { a: 3, b: 4 }).violations).toEqual([]);
  });

  it("reports null where training never saw null as nullable, and not where it did", () => {
    const s = train({ a: "x" }, { a: "y" });
    const r = check(s, { a: null });
    expect(r.violations.map((v) => [v.kind, v.path])).toEqual([["nullable", "$.a"]]);
    expect(r.closed).toBe(false);
    expect(check(train({ a: "x" }, { a: null }), { a: null }).violations).toEqual([]);
  });

  it("reports a type change as type drift, but integer -> number is drift and number -> integer is fine", () => {
    const ints = train({ n: 1 }, { n: 2 });
    expect(check(ints, { n: 1.5 }).violations.map((v) => v.kind)).toEqual(["type"]);
    expect(check(ints, { n: "1" }).violations.map((v) => v.kind)).toEqual(["type"]);
    const nums = train({ n: 1.5 }, { n: 2 });
    expect(check(nums, { n: 7 }).violations).toEqual([]);
  });

  it("reports array item drift with the path collapsed to []", () => {
    const s = train({ list: [{ id: 1 }, { id: 2 }] });
    const r = check(s, { list: [{ id: 3 }, { id: "x" }, { id: 4 }, { id: "y" }] });
    expect(r.violations.map((v) => [v.kind, v.path])).toEqual([
      ["type", "$.list[].id"],
      ["type", "$.list[].id"],
    ]);
  });

  it("reports a format that training saw on 100% of values and is now broken", () => {
    const s = train({ at: "2026-11-23T10:00:00Z" }, { at: "2026-11-22T09:30:00Z" });
    expect(check(s, { at: "2026-11-24T10:00:00Z" }).violations).toEqual([]);
    expect(check(s, { at: "yesterday" }).violations.map((v) => v.kind)).toEqual(["format"]);
  });

  it("lists a value outside x-observed-values as an enum hint miss, not a violation", () => {
    const s = { type: "object", properties: { st: { type: "string", "x-observed-values": ["open", "closed"] } }, required: ["st"], additionalProperties: false } as ReturnType<typeof train>;
    const r = check(s, { st: "merged" });
    expect(r.violations).toEqual([]);
    expect(r.enums).toEqual([{ path: "$.st", value: "merged" }]);
    expect(r.closed).toBe(true);
  });

  it("treats a root type change (object -> string) as drift and agrees with Ajv", () => {
    const s = train({ a: 1 }, { a: 2 });
    const r = check(s, "now plain text");
    expect(r.violations.map((v) => v.kind)).toEqual(["type"]);
    expect(r.closed).toBe(false);
  });

  it("explain and Ajv (closed) agree on a set of mixed cases", () => {
    const s = train({ a: 1, b: "x", c: [1, 2] }, { a: 2, b: "y", c: [] });
    const cases = [{ a: 1, b: "q", c: [9] }, { a: 1, b: null, c: [] }, { a: 1.5, b: "q", c: [] }, { a: 1, b: "q", c: ["s"] }, { b: "q", c: [] }, { a: 1, b: "q", c: [], d: 1 }, [], null];
    for (const c of cases) {
      const r = check(s, c);
      expect(r.closed, JSON.stringify(c)).toBe(r.violations.length === 0);
    }
  });
});

describe("readingsFor: text | parsed union (M9 read_file finding)", () => {
  const text = (s: string) => ({ content: [{ type: "text", text: s }] });

  it("a JSON-text result of a text-trained tool can be read as text, so a string schema matches it", () => {
    const readings = readingsFor("text", text('{"a":1}'));
    expect(readings).toEqual([{ path: "text", value: '{"a":1}' }]);
    const s = train("hello", "world");
    expect(check(s, readings[0]?.value).violations).toEqual([]);
  });

  it("a mixed tool gets both readings; a json-text tool gets only the parsed one", () => {
    expect(readingsFor("mixed", text('{"a":1}'))).toEqual([
      { path: "json-text", value: { a: 1 } },
      { path: "text", value: '{"a":1}' },
    ]);
    expect(readingsFor("json-text", text('{"a":1}'))).toEqual([{ path: "json-text", value: { a: 1 } }]);
  });

  it("still finds a real unwrap change: plain text for a json-text tool, JSON text for a structuredContent tool", () => {
    expect(readingsFor("json-text", text("not json"))).toEqual([]);
    expect(readingsFor("structuredContent", text('{"a":1}'))).toEqual([]);
  });
});
