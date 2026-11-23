// Match checking for scripts/validate-real-servers.ts: does a fresh REAL tool output validate against the
// schema that `infer` produced from the training run, and if not, why not?
//
// Two validators are used and cross-checked:
//   * `explain`  : our own walker over the real value and the schema exactly as inferred (closed objects).
//                  It also says WHY a value does not fit (optional key, nullable, type drift, format).
//   * Ajv        : the validator `serve` uses (SDK AjvJsonSchemaValidator), run on the OPEN schema
//                  (what `serve` would accept) and on the CLOSED schema (what drift detection means).
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { toOpenSchema } from "../../src/emit/open.js";
import { typesOf, type JsonSchema, type JsonType } from "../../src/infer/schema.js";
import type { ToolUnwrap } from "../../src/infer/tool.js";
import { joinedText, unwrap, type UnwrapPath } from "../../src/proxy/recorder.js";
import { formatClass } from "../../src/proxy/shape.js";

export type ViolationKind =
  | "optional-key" // a key the training run never saw (closed object), or a key that was always present and is now missing
  | "nullable" // null where the schema has no null
  | "type" // type drift (e.g. integer -> number, string -> object)
  | "format" // date-time/uri/email format broken
  | "unwrap" // the result is no longer parsed the way it was (text vs JSON)
  | "union"; // matched no branch of an anyOf

export interface Violation {
  kind: ViolationKind;
  /** JSON path with array indexes collapsed to [] */
  path: string;
  detail: string;
}

export interface EnumMiss {
  path: string;
  value: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function jsonTypeOf(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return "object";
}

const child = (path: string, key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

/** All violations of `value` against `schema` (the schema as inferred: objects closed). Enum hints go to `enums`. */
export function explain(value: unknown, schema: JsonSchema, path: string, out: Violation[], enums: EnumMiss[]): void {
  if (schema.anyOf) {
    let best: Violation[] | undefined;
    let bestEnums: EnumMiss[] = [];
    for (const branch of schema.anyOf) {
      const v: Violation[] = [];
      const e: EnumMiss[] = [];
      explain(value, branch, path, v, e);
      if (v.length === 0) {
        enums.push(...e);
        return;
      }
      if (!best || v.length < best.length) {
        best = v;
        bestEnums = e;
      }
    }
    void bestEnums;
    out.push({ kind: "union", path, detail: `matches no anyOf branch (closest: ${best?.map((x) => `${x.kind} at ${x.path}`).join(", ") ?? "none"})` });
    return;
  }
  const t = jsonTypeOf(value);
  const types = typesOf(schema);
  if (types && !types.includes(t) && !(t === "integer" && types.includes("number"))) {
    if (t === "null") out.push({ kind: "nullable", path, detail: `null where the schema says ${types.join("|")}` });
    else out.push({ kind: "type", path, detail: `${t} where the schema says ${types.join("|")}` });
    return;
  }
  if (typeof value === "string") {
    if (schema.format !== undefined && formatClass(value) !== schema.format) {
      out.push({ kind: "format", path, detail: `not a ${schema.format} (schema format from training)` });
    }
    const observed = schema["x-observed-values"];
    if (observed && !observed.includes(value)) enums.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    if (schema.items) for (const item of value) explain(item, schema.items, `${path}[]`, out, enums);
    return;
  }
  if (isObj(value)) {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) {
      if (!Object.hasOwn(value, k)) out.push({ kind: "optional-key", path: child(path, k), detail: "key was in every training sample, missing now" });
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) explain(v, props[k] as JsonSchema, child(path, k), out, enums);
      else if (schema.additionalProperties === false) out.push({ kind: "optional-key", path: child(path, k), detail: "key never seen in training" });
      else if (isObj(schema.additionalProperties)) explain(v, schema.additionalProperties, `${path}{}`, out, enums);
    }
  }
}

export interface Reading {
  path: UnwrapPath;
  value?: unknown;
}

/**
 * The readings of a real result that a tool's schema can describe (SPEC §3 rule 1). The unwrapped value
 * counts when its path is the one training saw (any path for "mixed"). A JSON-text result also has its
 * plain-text reading, the joined text as a string, for a tool trained on text: the text | parsed union.
 * An empty list means the unwrap path itself changed (e.g. JSON text where training saw structuredContent).
 */
export function readingsFor(trained: ToolUnwrap, result: Record<string, unknown>): Reading[] {
  const un = unwrap(result);
  const out: Reading[] = [];
  if (trained === "mixed" || un.path === trained) out.push(un);
  if (un.path === "json-text" && (trained === "text" || trained === "mixed")) out.push({ path: "text", value: joinedText(result) });
  return out;
}

/** The schema as inferred, minus our own annotations, for a plain JSON Schema validator. */
function stripAnnotations(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAnnotations);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k.startsWith("x-") || k === "$schema") continue;
    Object.defineProperty(out, k, { value: stripAnnotations(v), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export interface Validators {
  closed: (value: unknown) => boolean;
  open: (value: unknown) => boolean;
}

export function compileValidators(schema: JsonSchema): Validators {
  const ajv = new AjvJsonSchemaValidator();
  const closed = ajv.getValidator(stripAnnotations(schema) as never);
  const open = ajv.getValidator(toOpenSchema(schema) as never);
  return { closed: (v) => closed(v).valid, open: (v) => open(v).valid };
}
