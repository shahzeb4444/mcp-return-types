// Paired statistics for arms C vs D (BENCHMARK.md "Analysis"): a percentile bootstrap that resamples
// TASKS (all reps of a drawn task come along), with a fixed seed, and the exact McNemar test.
import { createRng } from "../mock-server/rng.js";

export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 20261122;

/** Linear-interpolation quantile (R type 7) of an ascending array. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return (sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}

export interface BootstrapCI {
  point: number;
  lo: number;
  hi: number;
  resamples: number;
  /** Resamples where the statistic was not finite (e.g. a ratio with a zero denominator); left out. */
  undefinedResamples: number;
  tasks: number;
  pairs: number;
}

/**
 * Percentile bootstrap 95% CI of `stat` over items clustered by `cluster` (the task): each resample draws
 * as many clusters as there are, with replacement, and keeps every item of each drawn cluster.
 * Deterministic for a given seed (clusters are sorted first).
 */
export function clusterBootstrap<T>(
  items: readonly T[],
  cluster: (x: T) => string,
  stat: (xs: readonly T[]) => number,
  opts: { resamples?: number; seed?: number; level?: number } = {},
): BootstrapCI {
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const level = opts.level ?? 0.95;
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const k = cluster(x);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const keys = [...groups.keys()].sort();
  const point = items.length ? stat(items) : NaN;
  const rng = createRng(opts.seed ?? BOOTSTRAP_SEED);
  const values: number[] = [];
  let undef = 0;
  if (keys.length > 0) {
    for (let i = 0; i < resamples; i++) {
      const sample: T[] = [];
      for (let j = 0; j < keys.length; j++) sample.push(...(groups.get(keys[Math.floor(rng.next() * keys.length)] as string) as T[]));
      const v = stat(sample);
      if (Number.isFinite(v)) values.push(v);
      else undef += 1;
    }
  }
  values.sort((a, b) => a - b);
  const a = (1 - level) / 2;
  return { point, lo: quantile(values, a), hi: quantile(values, 1 - a), resamples, undefinedResamples: undef, tasks: keys.length, pairs: items.length };
}

/** ln C(n, k). */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}

export interface McNemar {
  /** C pass, D fail. */
  b: number;
  /** C fail, D pass. */
  c: number;
  /** Exact two-sided p (binomial, p = 0.5 on the b + c discordant pairs); 1 when there are none. */
  p: number;
}

export function mcnemarExact(b: number, c: number): McNemar {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, p: Math.min(1, 2 * tail) };
}
