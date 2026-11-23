import { describe, expect, it } from "vitest";
import { BOOTSTRAP_RESAMPLES, clusterBootstrap, mcnemarExact, quantile } from "../bench/analysis/stats.js";

describe("quantile (type 7)", () => {
  it("interpolates linearly", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.025)).toBeCloseTo(1.075, 12);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([7], 0.3)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe("mcnemarExact", () => {
  it("matches hand-computed exact binomial p-values", () => {
    expect(mcnemarExact(0, 5).p).toBeCloseTo(2 / 32, 12);
    expect(mcnemarExact(1, 9).p).toBeCloseTo(22 / 1024, 12);
    expect(mcnemarExact(9, 1).p).toBeCloseTo(22 / 1024, 12);
    expect(mcnemarExact(3, 3).p).toBe(1);
  });
  it("is 1 with no discordant pairs and keeps b and c", () => {
    expect(mcnemarExact(0, 0)).toEqual({ b: 0, c: 0, p: 1 });
  });
  it("stays finite for large counts", () => {
    const p = mcnemarExact(150, 250).p;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-5);
  });
});

interface Item {
  task: string;
  c: number;
  d: number;
}
const items: Item[] = [
  { task: "t1", c: 10, d: 5 },
  { task: "t1", c: 12, d: 6 },
  { task: "t2", c: 8, d: 9 },
  { task: "t2", c: 9, d: 7 },
  { task: "t3", c: 20, d: 11 },
  { task: "t3", c: 18, d: 10 },
  { task: "t4", c: 5, d: 5 },
  { task: "t4", c: 6, d: 4 },
];
const ratio = (xs: readonly Item[]): number => xs.reduce((a, x) => a + x.d, 0) / xs.reduce((a, x) => a + x.c, 0);

describe("clusterBootstrap", () => {
  it("is deterministic for a fixed seed and uses 10,000 resamples by default", () => {
    const a = clusterBootstrap(items, (x) => x.task, ratio, { seed: 42 });
    const b = clusterBootstrap([...items].reverse(), (x) => x.task, ratio, { seed: 42 });
    expect(a).toEqual(b);
    expect(a.resamples).toBe(BOOTSTRAP_RESAMPLES);
    expect(a.tasks).toBe(4);
    expect(a.pairs).toBe(8);
    expect(a.point).toBeCloseTo(57 / 88, 12);
    expect(a.lo).toBeLessThan(a.point);
    expect(a.hi).toBeGreaterThan(a.point);
  });
  it("gives a different interval for a different seed", () => {
    const a = clusterBootstrap(items, (x) => x.task, ratio, { seed: 1, resamples: 500 });
    const b = clusterBootstrap(items, (x) => x.task, ratio, { seed: 2, resamples: 500 });
    expect([a.lo, a.hi]).not.toEqual([b.lo, b.hi]);
  });
  it("resamples whole tasks: every resample keeps both reps of each drawn task", () => {
    const sizes = new Set<number>();
    clusterBootstrap(items, (x) => x.task, (xs) => {
      sizes.add(xs.length);
      return xs.length;
    }, { resamples: 200, seed: 7 });
    expect([...sizes]).toEqual([8]);
    const perTask: number[] = [];
    clusterBootstrap(items, (x) => x.task, (xs) => {
      const counts = new Map<string, number>();
      for (const x of xs) counts.set(x.task, (counts.get(x.task) ?? 0) + 1);
      perTask.push(...counts.values());
      return 0;
    }, { resamples: 200, seed: 7 });
    expect(perTask.every((n) => n % 2 === 0)).toBe(true);
  });
  it("collapses to the point when every task has the same value", () => {
    const flat = ["a", "b", "c"].flatMap((t) => [{ task: t, c: 4, d: 2 }]);
    const r = clusterBootstrap(flat, (x) => x.task, ratio, { seed: 3, resamples: 100 });
    expect(r).toMatchObject({ point: 0.5, lo: 0.5, hi: 0.5, undefinedResamples: 0 });
  });
  it("leaves out resamples where the statistic is undefined, and counts them", () => {
    const zeroC = [
      { task: "a", c: 0, d: 1 },
      { task: "b", c: 2, d: 1 },
    ];
    const r = clusterBootstrap(zeroC, (x) => x.task, ratio, { seed: 5, resamples: 1000 });
    expect(r.undefinedResamples).toBeGreaterThan(0);
    expect(r.undefinedResamples).toBeLessThan(1000);
    expect(Number.isFinite(r.lo) && Number.isFinite(r.hi)).toBe(true);
  });
  it("handles no items", () => {
    const r = clusterBootstrap([] as Item[], (x) => x.task, ratio, { resamples: 10 });
    expect(r.point).toBeNaN();
    expect(r.lo).toBeNaN();
    expect(r.tasks).toBe(0);
  });
});
