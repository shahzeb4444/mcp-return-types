// Shared helpers for the inference tests. Values go through the real recorder
// `shapeOf`, so the tests see exactly what M1 writes to the sample files.
import { inferSchema, type InferOptions } from "../src/infer/infer.js";
import type { JsonSchema } from "../src/infer/schema.js";
import type { Sample } from "../src/proxy/recorder.js";
import { shapeOf, type Shape } from "../src/proxy/shape.js";

export const shapes = (...values: unknown[]): Shape[] => values.map((v) => shapeOf(v));

/** Infer a schema from raw JSON values (converted to shapes first). */
export const infer = (values: unknown[], opts?: InferOptions): JsonSchema => inferSchema(shapes(...values), opts);

let seq = 0;
/** A success sample with a shape from `value`. Override any field, e.g. `{ isError: true }`. */
export function sample(value: unknown, over: Partial<Sample> = {}): Sample {
  seq += 1;
  return {
    v: 1,
    ts: "2026-11-22T10:00:00.000Z",
    tool: "t",
    args: `args-${seq}`,
    isError: false,
    unwrap: "json-text",
    blocks: ["text"],
    shape: shapeOf(value),
    ...over,
  };
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number): { next: () => number; int: (n: number) => number; pick: <T>(xs: readonly T[]) => T } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return { next, int, pick: (xs) => xs[int(xs.length)] as (typeof xs)[number] };
}

export function shuffle<T>(xs: readonly T[], r: ReturnType<typeof rng>): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const STRINGS = ["", "x", "hello world", "2026-01-01T00:00:00Z", "a@b.co", "https://example.com/a"];

/**
 * Random JSON values for property tests. Objects come from two key families
 * ({id,name,tags,meta} always with id, and {url,size,mime} always with url), so at
 * any position there are at most 2 object groups (the union cap is never reached).
 * Arrays are never empty and nesting stays under the depth cap.
 */
export function genValue(r: ReturnType<typeof rng>, depth = 0): unknown {
  const kind = r.int(depth >= 3 ? 5 : 8);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return r.next() < 0.5;
    case 2:
      return r.int(100) - 50;
    case 3:
      return r.int(100) + 0.5;
    case 4:
      return r.pick(STRINGS);
    case 5:
      return Array.from({ length: 1 + r.int(3) }, () => genValue(r, depth + 1));
    default: {
      const family = r.next() < 0.6 ? ["name", "tags", "meta"] : ["size", "mime"];
      const head = family.length === 3 ? "id" : "url";
      const extra = family.filter(() => r.next() < 0.6);
      if (extra.length === 0) extra.push(r.pick(family));
      const obj: Record<string, unknown> = { [head]: genValue(r, depth + 1) };
      for (const k of extra) obj[k] = genValue(r, depth + 1);
      return obj;
    }
  }
}
