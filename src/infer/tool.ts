// Per-tool inference: unwrap bookkeeping (rule 1), success vs error shapes (rule 10),
// enum hints (rule 6) and confidence (rule 8).
import type { Sample, UnwrapPath } from "../proxy/recorder.js";
import type { Shape } from "../proxy/shape.js";
import { confidence, type Confidence } from "./confidence.js";
import { inferSchema } from "./infer.js";
import { SCHEMA_DIALECT, type JsonSchema } from "./schema.js";

/** Rule 6: hints need at least this many success samples of the tool. */
export const ENUM_MIN_SAMPLES = 20;

export interface ValuesFile {
  fields: Record<string, Record<string, number>>;
  highCardinality: string[];
}

export type ToolUnwrap = UnwrapPath | "mixed";

export interface ErrorShape {
  /** `isError: true` results. */
  samples: number;
  unwrapCounts: Partial<Record<UnwrapPath, number>>;
  /** Shape of the unwrapped error results; never merged into the success schema. */
  schema?: JsonSchema;
  /** JSON-RPC errors by code (the recorder keeps only the code). */
  rpcErrors: Record<string, number>;
}

export interface ToolInference {
  tool: string;
  /** How the stub must unwrap results: the only path seen, or "mixed". "none" = no text and no structuredContent. */
  unwrap: ToolUnwrap;
  unwrapCounts: Partial<Record<UnwrapPath, number>>;
  /** Success samples only. */
  samples: number;
  distinctArgs: number;
  newest?: string;
  confidence: Confidence;
  confidenceReasons: string[];
  schema: JsonSchema;
  error?: ErrorShape;
}

function countArrays(shape: Shape, acc: { seen: number; nonEmpty: number }): void {
  if (shape.t === "array") {
    acc.seen += 1;
    if (shape.n > 0) acc.nonEmpty += 1;
    shape.items.forEach((s) => countArrays(s, acc));
  } else if (shape.t === "object") {
    Object.values(shape.keys).forEach((s) => countArrays(s, acc));
  } else if (shape.t === "map") {
    shape.values.forEach((s) => countArrays(s, acc));
  }
}

function newestOf(samples: readonly Sample[]): Date | undefined {
  let best: number | undefined;
  for (const s of samples) {
    const t = Date.parse(s.ts);
    if (!Number.isNaN(t) && (best === undefined || t > best)) best = t;
  }
  return best === undefined ? undefined : new Date(best);
}

function countBy<T extends string>(items: readonly T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const i of [...items].sort()) out[i] = (out[i] ?? 0) + 1;
  return out;
}

export function isSuccess(s: Sample): boolean {
  return s.rpcError === undefined && !s.isError;
}

export function inferTool(
  tool: string,
  samples: readonly Sample[],
  opts: { now: Date; values?: ValuesFile },
): ToolInference {
  const ok = samples.filter(isSuccess);
  const errors = samples.filter((s) => s.rpcError === undefined && s.isError);
  const rpc = samples.filter((s) => s.rpcError !== undefined);

  const shapes = ok.flatMap((s) => (s.shape ? [s.shape] : []));
  const observedValues = ok.length >= ENUM_MIN_SAMPLES ? opts.values?.fields : undefined;
  const schema: JsonSchema = { $schema: SCHEMA_DIALECT, ...inferSchema(shapes, { observedValues }) };

  const unwrapCounts = countBy(ok.map((s) => s.unwrap));
  const paths = Object.keys(unwrapCounts) as UnwrapPath[];
  const unwrap: ToolUnwrap = paths.length === 0 ? "none" : paths.length === 1 ? (paths[0] as UnwrapPath) : "mixed";

  const arrays = { seen: 0, nonEmpty: 0 };
  shapes.forEach((s) => countArrays(s, arrays));
  const newest = newestOf(ok);
  const conf = confidence({
    samples: ok.length,
    distinctArgs: new Set(ok.map((s) => s.args)).size,
    arraysSeen: arrays.seen,
    nonEmptyArrays: arrays.nonEmpty,
    newest,
    now: opts.now,
  });

  const result: ToolInference = {
    tool,
    unwrap,
    unwrapCounts,
    samples: ok.length,
    distinctArgs: new Set(ok.map((s) => s.args)).size,
    ...(newest ? { newest: newest.toISOString() } : {}),
    confidence: conf.level,
    confidenceReasons: conf.reasons,
    schema,
  };
  if (errors.length > 0 || rpc.length > 0) {
    const errShapes = errors.flatMap((s) => (s.shape ? [s.shape] : []));
    const rpcErrors: Record<string, number> = {};
    for (const code of rpc.map((s) => String(s.rpcError?.code)).sort()) {
      rpcErrors[code] = (rpcErrors[code] ?? 0) + 1;
    }
    result.error = {
      samples: errors.length,
      unwrapCounts: countBy(errors.map((s) => s.unwrap)),
      ...(errShapes.length > 0 ? { schema: { $schema: SCHEMA_DIALECT, ...inferSchema(errShapes) } } : {}),
      rpcErrors,
    };
  }
  return result;
}
