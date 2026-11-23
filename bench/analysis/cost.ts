// Cache-weighted cost ESTIMATE per run (BENCHMARK.md "Cost formula"), from bench/prices.json only:
//   cost = uncached_in x p_in + cache_write x p_write + cache_read x p_read + output x p_out   (USD per million tokens)
// Subscription runs are not billed per token, so this is always labelled an estimate. A model with any
// needed price missing or null gets no estimate (never a guess).
import { readFileSync } from "node:fs";

export interface ModelPrices {
  input?: number | null;
  cache_write_1h?: number | null;
  cache_write_5m?: number | null;
  cache_read?: number | null;
  output?: number | null;
}
export type PriceTable = Record<string, ModelPrices | string>;

export interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

export type Pricing = { ok: true; input: number; write: number; read: number; output: number; cacheWriteKey: string } | { ok: false; reason: string };

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Read the price table; null when the file is missing or not JSON. */
export function loadPrices(file: string): PriceTable | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PriceTable) : null;
  } catch {
    return null;
  }
}

/**
 * The prices for one model. The cache-write price is `cache_write_1h` when given (the Claude CLI writes the
 * 1-hour cache), else `cache_write_5m`; the key used is returned so the report can say which.
 */
export function pricingFor(table: PriceTable | null | undefined, model: string): Pricing {
  if (!table) return { ok: false, reason: "no bench/prices.json" };
  const p = table[model];
  if (!p || typeof p !== "object") return { ok: false, reason: `no prices for ${model} in bench/prices.json` };
  const cacheWriteKey = num(p.cache_write_1h) ? "cache_write_1h" : "cache_write_5m";
  const write = num(p.cache_write_1h) ? p.cache_write_1h : p.cache_write_5m;
  const missing = [["input", p.input], [cacheWriteKey, write], ["cache_read", p.cache_read], ["output", p.output]].filter(([, v]) => !num(v)).map(([k]) => k);
  if (missing.length) return { ok: false, reason: `price(s) ${missing.join(", ")} missing or null for ${model} in bench/prices.json` };
  return { ok: true, input: p.input as number, write: write as number, read: p.cache_read as number, output: p.output as number, cacheWriteKey };
}

/** Estimated USD for one run's usage (uncached input, cache write, cache read, output). */
export function costOf(u: Usage | undefined, p: Extract<Pricing, { ok: true }>): number {
  const m = 1e6;
  return ((u?.input_tokens ?? 0) * p.input + (u?.cache_creation_input_tokens ?? 0) * p.write + (u?.cache_read_input_tokens ?? 0) * p.read + (u?.output_tokens ?? 0) * p.output) / m;
}
