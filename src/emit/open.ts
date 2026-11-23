// Open schemas for the wire. `infer` keeps objects closed (`additionalProperties: false`) so that a
// never-seen key counts as drift. A schema that is shown to a client must not do that: a harmless new
// server field would otherwise make a strict client reject a result that used to work.
import type { JsonSchema } from "../infer/schema.js";

/** Keys whose value is a map of name -> schema (the names are data, not keywords). */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keys whose value is one schema or a list of schemas. */
const SCHEMA_KEYS = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
]);

function define(target: object, key: string, value: unknown): void {
  // defineProperty so keys like "__proto__" stay plain own properties.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function walk(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(walk);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    // Annotations of ours (x-capped, x-observed-values) and the dialect marker are not sent to clients.
    // Without `$schema` the MCP default (JSON Schema 2020-12) applies.
    if (k.startsWith("x-") || k === "$schema") continue;
    if ((k === "additionalProperties" || k === "unevaluatedProperties") && v === false) continue;
    if (SCHEMA_MAPS.has(k) && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const map: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(v as Record<string, unknown>)) define(map, name, walk(child));
      define(out, k, map);
    } else if (SCHEMA_KEYS.has(k)) {
      define(out, k, walk(v));
    } else {
      define(out, k, v);
    }
  }
  return out;
}

/** A copy of an inferred schema that allows extra keys at every level and carries no `x-` annotations. */
export function toOpenSchema(schema: JsonSchema): JsonSchema {
  return walk(schema) as JsonSchema;
}

/** True if `additionalProperties: false` appears anywhere in the schema. */
export function hasClosedObject(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasClosedObject);
  if (schema === null || typeof schema !== "object") return false;
  return Object.entries(schema as Record<string, unknown>).some(
    ([k, v]) => ((k === "additionalProperties" || k === "unevaluatedProperties") && v === false) || hasClosedObject(v),
  );
}

/**
 * MCP requires an `outputSchema` to be an object schema (`type: "object"` at the root) and
 * `structuredContent` to be an object. Other roots (arrays, strings, unions) cannot be declared.
 */
export function isDeclarableRoot(schema: JsonSchema): boolean {
  return schema.type === "object" && schema.anyOf === undefined;
}
