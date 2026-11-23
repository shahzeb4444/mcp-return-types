// The JSON Schema 2020-12 subset that `infer` produces, plus a validator that checks
// a recorded Shape (SPEC §4) against it. `fits` is used for drift detection (§3 rule 9)
// and by the property tests.
import type { Shape } from "../proxy/shape.js";

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type JsonType = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";

/** Canonical order of `type` entries: containers first, `null` last (reads well as `X | null`). */
export const TYPE_ORDER: readonly JsonType[] = ["object", "array", "string", "integer", "number", "boolean", "null"];

export type CapReason = "depth" | "keys" | "union";

export interface JsonSchema {
  $schema?: string;
  type?: JsonType | JsonType[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  /** SPEC §3 rule 6: a hint only, never a hard enum. */
  "x-observed-values"?: string[];
  /** Set where a cap from SPEC §3 rule 5 or 11 replaced detail with `{}` or an open object. */
  "x-capped"?: CapReason;
}

export function typesOf(schema: JsonSchema): JsonType[] | undefined {
  if (schema.type === undefined) return undefined;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** True when the schema puts no constraint on a value (`{}` plus annotations only). */
export function acceptsAnything(schema: JsonSchema): boolean {
  return (
    schema.type === undefined &&
    schema.anyOf === undefined &&
    schema.format === undefined &&
    schema.properties === undefined &&
    schema.required === undefined &&
    schema.items === undefined &&
    (schema.additionalProperties === undefined || schema.additionalProperties === true)
  );
}

/** Does a value with this shape validate against the schema? */
export function fits(shape: Shape, schema: JsonSchema): boolean {
  if (schema.anyOf && !schema.anyOf.some((b) => fits(shape, b))) return false;
  if (shape.t === "truncated") return acceptsAnything(schema);
  const types = typesOf(schema);
  const t: JsonType = shape.t === "map" ? "object" : shape.t;
  if (types && !types.includes(t) && !(t === "integer" && types.includes("number"))) return false;
  switch (shape.t) {
    case "map": {
      // Key names were not recorded, so only a schema that types every key the same way can be checked.
      if (shape.values.length === 0) return (schema.required ?? []).length === 0;
      if ((schema.required ?? []).length > 0 || schema.additionalProperties === false) return false;
      if (Object.keys(schema.properties ?? {}).length > 0) return false;
      const ap = schema.additionalProperties;
      return typeof ap !== "object" || shape.values.every((v) => fits(v, ap));
    }
    case "string":
      return schema.format === undefined || shape.fmt === schema.format;
    case "array":
      return schema.items === undefined || shape.items.every((s) => fits(s, schema.items as JsonSchema));
    case "object": {
      const props = schema.properties ?? {};
      for (const k of schema.required ?? []) if (!Object.hasOwn(shape.keys, k)) return false;
      for (const [k, child] of Object.entries(shape.keys)) {
        if (Object.hasOwn(props, k)) {
          if (!fits(child, props[k] as JsonSchema)) return false;
        } else if (schema.additionalProperties === false) {
          return false;
        } else if (typeof schema.additionalProperties === "object" && !fits(child, schema.additionalProperties)) {
          return false;
        }
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * True when the schema accepts a plain string (SPEC §3 rule 1, text | parsed union): the joined text
 * of a result is always a string, so a text tool whose text happens to parse as JSON still fits.
 */
export function acceptsText(schema: JsonSchema): boolean {
  return fits({ t: "string", len: "long" }, schema);
}

/** `fits`, for a recorded sample: a JSON-text result also fits through its plain-text reading. */
export function sampleFits(sample: { unwrap: string; shape?: Shape }, schema: JsonSchema): boolean {
  if (sample.shape === undefined) return true;
  return fits(sample.shape, schema) || (sample.unwrap === "json-text" && acceptsText(schema));
}

/** JSON with object keys sorted at every level: equal schemas give equal text. */
export function canonicalSchemaJson(schema: unknown): string {
  if (schema === null || typeof schema !== "object") return JSON.stringify(schema);
  if (Array.isArray(schema)) return `[${schema.map(canonicalSchemaJson).join(",")}]`;
  const obj = schema as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalSchemaJson(obj[k])}`)
    .join(",")}}`;
}
