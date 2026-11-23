// Property-style tests over seeded random samples (deterministic, so never flaky):
// order independence, soundness, and "merging never narrows a schema".
import { describe, expect, it } from "vitest";
import { inferSchema } from "../src/infer/infer.js";
import { fits } from "../src/infer/schema.js";
import { shapeOf, type Shape } from "../src/proxy/shape.js";
import { genValue, rng, shuffle } from "./infer-helpers.js";

const RUNS = 200;
const batch = (r: ReturnType<typeof rng>, n: number): Shape[] =>
  Array.from({ length: n }, () => shapeOf(genValue(r)));

describe("inference properties", () => {
  it("merging the same samples in a different order gives the same schema, byte for byte", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(seed);
      const samples = batch(r, 1 + r.int(12));
      const a = JSON.stringify(inferSchema(samples));
      const b = JSON.stringify(inferSchema(shuffle(samples, r)));
      const c = JSON.stringify(inferSchema([...samples].reverse()));
      expect(b, `seed ${seed}`).toBe(a);
      expect(c, `seed ${seed}`).toBe(a);
    }
  });

  it("is sound: every sample validates against the schema inferred from it", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(1000 + seed);
      const samples = batch(r, 1 + r.int(12));
      const schema = inferSchema(samples);
      for (const s of samples) expect(fits(s, schema), `seed ${1000 + seed}`).toBe(true);
    }
  });

  it("merging more samples never narrows: whatever the old schema accepted, the new one accepts", () => {
    let accepted = 0;
    let probes = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(5000 + seed);
      const s = batch(r, 1 + r.int(8));
      const t = batch(r, 1 + r.int(8));
      const before = inferSchema(s);
      const after = inferSchema([...s, ...t]);
      for (const probe of [...s, ...t, ...batch(r, 40)]) {
        probes += 1;
        if (!fits(probe, before)) continue;
        accepted += 1;
        expect(fits(probe, after), `seed ${5000 + seed}: ${JSON.stringify(probe)}`).toBe(true);
      }
    }
    // The check is only meaningful if the old schemas accepted a fair share of the probes.
    expect(accepted).toBeGreaterThan(probes / 10);
  });

  it("merging is associative in effect: (S then T) and (T then S) give the same schema", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(9000 + seed);
      const s = batch(r, 1 + r.int(6));
      const t = batch(r, 1 + r.int(6));
      expect(JSON.stringify(inferSchema([...s, ...t]))).toBe(JSON.stringify(inferSchema([...t, ...s])));
    }
  });
});

describe("schema validator (fits)", () => {
  it("checks types, required keys, closed objects, items and anyOf", () => {
    const schema = inferSchema([shapeOf({ a: [1], b: "x" }), shapeOf({ a: [2] })]);
    expect(fits(shapeOf({ a: [] }), schema)).toBe(true);
    expect(fits(shapeOf({ a: ["s"] }), schema)).toBe(false);
    expect(fits(shapeOf({ b: "x" }), schema)).toBe(false);
    expect(fits(shapeOf("x"), schema)).toBe(false);
    expect(fits(shapeOf(1), { anyOf: [{ type: "string" }, { type: "integer" }] })).toBe(true);
    expect(fits(shapeOf(true), { anyOf: [{ type: "string" }, { type: "integer" }] })).toBe(false);
    expect(fits({ t: "truncated" }, {})).toBe(true);
    expect(fits({ t: "truncated" }, { type: "object" })).toBe(false);
  });
});
