// Shape-only description of a JSON value (SPEC §4). Strings become a length class
// and a format class, numbers become "integer" or "number". Raw values never end
// up in a Shape.

export type LenClass = "empty" | "short" | "medium" | "long";
export type FormatClass = "date-time" | "uri" | "email";

export type Shape =
  | { t: "null" }
  | { t: "boolean" }
  | { t: "integer" }
  | { t: "number" }
  | { t: "string"; len: LenClass; fmt?: FormatClass }
  | { t: "array"; n: number; items: Shape[] }
  | { t: "object"; keys: Record<string, Shape> }
  /**
   * A map-like object (SPEC §3 rule 11): more than MAP_MAX_KEYS keys and homogeneous values. Only the key count and the
   * shapes of (at most MAX_ARRAY_ITEMS) values are kept, never the key names.
   */
  | { t: "map"; n: number; values: Shape[] }
  | { t: "truncated" };

export const MAX_RECORD_DEPTH = 12;
export const MAX_ARRAY_ITEMS = 50;
/** An object with more keys than this is recorded as a map, without its key names (SPEC §3 rule 11). */
export const MAP_MAX_KEYS = 30;

function typeClass(s: Shape): string {
  return s.t === "integer" || s.t === "number" ? "number" : s.t === "map" ? "object" : s.t;
}

/**
 * SPEC §3 rule 11: are these value shapes all of the same type? Integer and number count as one type.
 * Objects must also agree on the type of every key they share (their merged shape). Nulls are ignored
 * everywhere, since a null only makes a value nullable.
 */
export function homogeneous(shapes: readonly Shape[]): boolean {
  const list = shapes.filter((s) => s.t !== "null");
  if (list.length === 0) return true;
  if (new Set(list.map(typeClass)).size > 1) return false;
  if ((list[0] as Shape).t !== "object" && (list[0] as Shape).t !== "map") return true;
  const byKey = new Map<string, Shape[]>();
  for (const s of list) {
    if (s.t !== "object") continue;
    for (const [k, v] of Object.entries(s.keys)) byKey.set(k, [...(byKey.get(k) ?? []), v]);
  }
  return [...byKey.values()].every((vs) => homogeneous(vs));
}

/** True for a plain object with more than MAP_MAX_KEYS keys whose values are homogeneous (recorded as a map). */
export function isMapLike(value: object): boolean {
  const values = Object.values(value);
  return values.length > MAP_MAX_KEYS && homogeneous(values.map((v) => shapeOf(v, 1)));
}

/**
 * Which elements of an array are recorded: all of them up to MAX_ARRAY_ITEMS, otherwise
 * MAX_ARRAY_ITEMS evenly spaced ones, always including the first and the last. Taking only
 * the first 50 would never see how a long, sorted or paged list changes towards its end.
 * Anything still missed is caught at serve time, which validates the full value.
 */
export function sampleItems<T>(items: readonly T[]): T[] {
  if (items.length <= MAX_ARRAY_ITEMS) return [...items];
  const out: T[] = [];
  for (let i = 0; i < MAX_ARRAY_ITEMS; i++) {
    out.push(items[Math.floor((i * (items.length - 1)) / (MAX_ARRAY_ITEMS - 1))] as T);
  }
  return out;
}

export function lenClass(s: string): LenClass {
  if (s.length === 0) return "empty";
  if (s.length <= 16) return "short";
  if (s.length <= 256) return "medium";
  return "long";
}

/** RFC 3339 `date-time`, as JSON Schema defines it: `T` separator, seconds and a time zone are mandatory. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

function isRfc3339DateTime(s: string): boolean {
  const m = DATE_TIME.exec(s);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  if (day > days) return false;
  // A leap second (:60) is legal in RFC 3339 but strict validators disagree on it, so it is not claimed.
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return true;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/;

export function formatClass(s: string): FormatClass | undefined {
  if (s.length > 2048) return undefined;
  if (isRfc3339DateTime(s)) return "date-time";
  if (EMAIL.test(s)) return "email";
  if (URI.test(s)) {
    try {
      new URL(s);
      return "uri";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined) return { t: "null" };
  switch (typeof value) {
    case "boolean":
      return { t: "boolean" };
    case "number":
      return { t: Number.isInteger(value) ? "integer" : "number" };
    case "string": {
      const fmt = formatClass(value);
      return fmt ? { t: "string", len: lenClass(value), fmt } : { t: "string", len: lenClass(value) };
    }
    case "object": {
      if (depth >= MAX_RECORD_DEPTH) return { t: "truncated" };
      if (Array.isArray(value)) {
        return {
          t: "array",
          n: value.length,
          items: sampleItems(value).map((v) => shapeOf(v, depth + 1)),
        };
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const keys: Record<string, Shape> = Object.create(null) as Record<string, Shape>;
      for (const [k, v] of entries) keys[k] = shapeOf(v, depth + 1);
      if (entries.length > MAP_MAX_KEYS && homogeneous(Object.values(keys))) {
        // Map-like (environment, headers, user-keyed data): the key names are data, so they are not recorded.
        return { t: "map", n: entries.length, values: sampleItems(Object.values(keys)) };
      }
      return { t: "object", keys };
    }
    default:
      return { t: "null" };
  }
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}
