// Small deterministic PRNG (mulberry32) and helpers. Same seed => same world, on every platform.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [lo, hi] (both inclusive). */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  /** Pick by weight (weights need not sum to 1). */
  weighted<T>(xs: readonly T[], weights: readonly number[]): T;
  shuffle<T>(xs: readonly T[]): T[];
  /** Fork an independent stream, so adding draws in one part of the world does not shift another part. */
  fork(label: string): Rng;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed: number | string): Rng {
  const root = typeof seed === "number" ? seed >>> 0 : hash32(seed);
  let a = root;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)] as never,
    weighted: (xs, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (let i = 0; i < xs.length; i++) {
        r -= weights[i] as number;
        if (r < 0) return xs[i] as never;
      }
      return xs[xs.length - 1] as never;
    },
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as never, out[i] as never];
      }
      return out;
    },
    fork: (label) => createRng(hash32(`${root}:${label}`)),
  };
  return rng;
}
