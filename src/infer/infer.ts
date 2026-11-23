// SPEC §3 rules 2-7 and 11: merge recorded shapes into one JSON Schema.
//
// `inferSchema` is a pure function of the multiset of shapes: every decision is made
// on counts and sets, never on arrival order, so shuffling the samples gives the same
// schema byte for byte (property-tested). Objects are closed
// (`additionalProperties: false`), so a never-seen key counts as a schema break (drift)
// and adding samples only ever widens the schema (see NOTES.md for the exceptions).
import type { Shape } from "../proxy/shape.js";
import { homogeneous, MAP_MAX_KEYS } from "../proxy/shape.js";
import { canonicalSchemaJson, TYPE_ORDER, type JsonSchema, type JsonType } from "./schema.js";

/** Containers at this nesting level (root = 0) or deeper become `{}` (rule 11). */
export const MAX_DEPTH = 6;
/**
 * Rule 11 map detection: an object position is a map when it has more than this many keys AND its values are
 * homogeneous (`homogeneous` in shape.ts). The recorder stores no key names for such a value, and the union of
 * keys across samples counts too (the key sets differ). Mixed-type objects stay normal typed objects.
 */
export { MAP_MAX_KEYS } from "../proxy/shape.js";
/** anyOf with more branches than this becomes `{}` (rule 5). */
export const MAX_UNION = 4;
/** Objects merge when |A ∩ B| / min(|A|, |B|) reaches this (rule 5). */
export const MERGE_OVERLAP = 0.5;
/** Enum hints (rule 6): at most this many distinct values ... */
export const ENUM_MAX_DISTINCT = 8;
/** ... seen at least this many times (the tool-level ≥20 samples gate is in tool.ts). */
export const ENUM_MIN_COUNT = 20;

export interface InferOptions {
  /** Per-field value counters from `<tool>.values.json` (SPEC §4), keyed by path like `$.items[].state`. */
  observedValues?: Record<string, Record<string, number>>;
}

type ObjShape = Extract<Shape, { t: "object" }>;
type StrShape = Extract<Shape, { t: "string" }>;
type ArrShape = Extract<Shape, { t: "array" }>;
type MapShape = Extract<Shape, { t: "map" }>;

export function inferSchema(shapes: readonly Shape[], opts: InferOptions = {}): JsonSchema {
  return node(shapes, 0, "$", opts);
}

/** Byte-compare-friendly ordering for strings (never locale dependent). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function setProp(target: Record<string, JsonSchema>, key: string, value: JsonSchema): void {
  // defineProperty so keys like "__proto__" become plain own properties.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function node(shapes: readonly Shape[], depth: number, path: string, opts: InferOptions): JsonSchema {
  if (shapes.length === 0) return {}; // no evidence, e.g. the items of arrays that were always empty
  if (depth >= MAX_DEPTH) return { "x-capped": "depth" };

  const seen = new Set<JsonType>();
  const strings: StrShape[] = [];
  const arrays: ArrShape[] = [];
  const objects: ObjShape[] = [];
  const maps: MapShape[] = [];
  for (const s of shapes) {
    switch (s.t) {
      case "truncated":
        return { "x-capped": "depth" }; // the recorder cut this value off (depth 12)
      case "string":
        strings.push(s);
        seen.add("string");
        break;
      case "array":
        arrays.push(s);
        seen.add("array");
        break;
      case "object":
        objects.push(s);
        break;
      case "map":
        maps.push(s);
        break;
      default:
        seen.add(s.t);
    }
  }
  if (seen.has("number")) seen.delete("integer"); // integer only if every number was an integer

  // Everything that is not an object goes into one schema with a `type` list.
  const restTypes = TYPE_ORDER.filter((t) => seen.has(t));
  const rest: JsonSchema = {};
  if (strings.length > 0) {
    const fmt = strings[0]?.fmt;
    if (fmt !== undefined && strings.every((s) => s.fmt === fmt)) rest.format = fmt; // rule 7: 100% match
    const hint = observedHint(opts.observedValues?.[path]);
    if (hint) rest["x-observed-values"] = hint;
  }
  if (arrays.length > 0) {
    rest.items = node(
      arrays.flatMap((a) => a.items),
      depth + 1,
      `${path}[]`,
      opts,
    );
  }

  const branches = objects.length + maps.length > 0 ? objectBranches(objects, maps, depth, path, opts) : [];
  if (branches.length <= 1) {
    const branch = branches[0];
    const types = TYPE_ORDER.filter((t) => (t === "object" ? branch !== undefined : restTypes.includes(t)));
    const out: JsonSchema = { type: types.length === 1 ? (types[0] as JsonType) : types };
    if (rest.format !== undefined) out.format = rest.format;
    if (rest["x-observed-values"]) out["x-observed-values"] = rest["x-observed-values"];
    if (branch?.properties) out.properties = branch.properties;
    if (branch?.required) out.required = branch.required;
    if (branch?.additionalProperties !== undefined) out.additionalProperties = branch.additionalProperties;
    if (rest.items) out.items = rest.items;
    if (branch?.["x-capped"]) out["x-capped"] = branch["x-capped"];
    return out;
  }
  const anyOf = [...branches];
  if (restTypes.length > 0) {
    anyOf.push({ type: restTypes.length === 1 ? (restTypes[0] as JsonType) : restTypes, ...rest });
  }
  if (anyOf.length > MAX_UNION) return { "x-capped": "union" };
  return { anyOf };
}

function observedHint(counter: Record<string, number> | undefined): string[] | undefined {
  if (!counter) return undefined;
  const entries = Object.entries(counter);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  if (entries.length === 0 || entries.length > ENUM_MAX_DISTINCT || total < ENUM_MIN_COUNT) return undefined;
  return entries.sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([v]) => v);
}

interface KeyStats {
  counts: Map<string, number>;
  /** Smallest index at which the key appeared in any object: a stable, order-free key order. */
  pos: Map<string, number>;
}

function keyStats(objects: readonly ObjShape[]): KeyStats {
  const counts = new Map<string, number>();
  const pos = new Map<string, number>();
  for (const o of objects) {
    Object.keys(o.keys).forEach((k, i) => {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      pos.set(k, Math.min(pos.get(k) ?? i, i));
    });
  }
  return { counts, pos };
}

const byPosition =
  ({ pos }: KeyStats) =>
  (a: string, b: string): number =>
    (pos.get(a) ?? 0) - (pos.get(b) ?? 0) || cmp(a, b);

/** Overlap of two key sets measured against the smaller one. A subset (or empty set) overlaps fully. */
export function overlap(a: readonly string[], b: readonly string[]): number {
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  if (small.length === 0) return 1;
  const bigSet = new Set(big);
  return small.filter((k) => bigSet.has(k)).length / small.length;
}

/** Rule 11 map detection, then rule 5 clustering into one schema per group of similar objects. */
function objectBranches(
  objects: readonly ObjShape[],
  maps: readonly MapShape[],
  depth: number,
  path: string,
  opts: InferOptions,
): JsonSchema[] {
  const stats = keyStats(objects);
  const values = [...objects.flatMap((o) => Object.values(o.keys)), ...maps.flatMap((m) => m.values)];
  if (maps.length > 0 || (stats.counts.size > MAP_MAX_KEYS && homogeneous(values))) {
    // A map: one value schema for every key, and no key names anywhere in the schema.
    // Value counters are per real key, so a map's values get no enum hint.
    return [{ type: "object", additionalProperties: node(values, depth + 1, `${path}.*`, {}) }];
  }

  // Group objects by key set, then join groups whose key sets overlap enough. Connected
  // components do not depend on the order in which key sets were seen, and adding
  // objects can only join components, never split them.
  const groups = new Map<string, { keys: string[]; objs: ObjShape[] }>();
  for (const o of objects) {
    const keys = Object.keys(o.keys).sort(cmp);
    const sig = keys.join("\u0000");
    const g = groups.get(sig) ?? { keys, objs: [] };
    g.objs.push(o);
    groups.set(sig, g);
  }
  const list = [...groups.values()];
  const parent = list.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] as number] as number;
    return i;
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj && overlap((list[i] as { keys: string[] }).keys, (list[j] as { keys: string[] }).keys) >= MERGE_OVERLAP) {
        parent[rj] = ri;
      }
    }
  }
  const components = new Map<number, ObjShape[]>();
  list.forEach((g, i) => {
    const root = find(i);
    components.set(root, [...(components.get(root) ?? []), ...g.objs]);
  });
  return [...components.values()]
    .map((objs) => ({ n: objs.length, schema: objectSchema(objs, depth, path, opts) }))
    .map((b) => ({ ...b, key: canonicalSchemaJson(b.schema) }))
    .sort((a, b) => b.n - a.n || cmp(a.key, b.key))
    .map((b) => b.schema);
}

/** Rule 3: union of keys; `required` = keys present in every object; null values make a key nullable. */
function objectSchema(objects: readonly ObjShape[], depth: number, path: string, opts: InferOptions): JsonSchema {
  const stats = keyStats(objects);
  // More than MAP_MAX_KEYS keys are possible here when the values are mixed (not a map, rule 11).
  const keys = [...stats.counts.keys()].sort(byPosition(stats));
  const properties: Record<string, JsonSchema> = {};
  for (const k of keys) {
    const values = objects.filter((o) => Object.hasOwn(o.keys, k)).map((o) => o.keys[k] as Shape);
    setProp(properties, k, node(values, depth + 1, `${path}.${k}`, opts));
  }
  const required = keys.filter((k) => stats.counts.get(k) === objects.length);
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;
  out.additionalProperties = false;
  return out;
}
