// `mcp-return-types quickstart`: which tools may be called, and with which arguments (pure functions).
//
// Safety rules (M10):
//   * By default only tools whose `annotations.readOnlyHint` is exactly `true` are called. A tool with
//     no annotations, or `readOnlyHint: false`, may have side effects and is never called by default.
//   * `--tools a,b` replaces that default: exactly the listed tools are called (the user chose them).
//   * A tool is called only if every REQUIRED argument has a value derivable from its input schema
//     (default, const, the first enum value, examples, minimum, boolean false). Otherwise it is skipped,
//     with the reason. Nothing is ever invented for a free-form string, object or array argument.
import { canonicalJson } from "../proxy/shape.js";

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

export type Args = Record<string, unknown>;

export type PlanItem =
  | { tool: string; action: "call"; because: "readOnlyHint" | "--tools"; argSets: Args[] }
  | { tool: string; action: "skip"; reason: string };

export interface Plan {
  items: PlanItem[];
  /** Names given with --tools that the server does not offer. */
  unknown: string[];
}

export interface PlanOptions {
  /** `--tools`: call exactly these tools, whatever their annotations. */
  only?: readonly string[];
  /** Calls per tool (`--calls`, default 3). */
  calls: number;
}

type Schema = Record<string, unknown>;
const isObj = (x: unknown): x is Schema => typeof x === "object" && x !== null && !Array.isArray(x);

function typesOf(s: Schema): string[] {
  return Array.isArray(s.type) ? s.type.filter((t): t is string => typeof t === "string") : typeof s.type === "string" ? [s.type] : [];
}

/**
 * Values for one argument that come straight from its schema, most realistic first:
 * default, const, enum values, examples, then minimum / exclusiveMinimum for numbers, then false/true
 * for booleans. An empty list means nothing can be derived.
 */
export function candidates(schema: unknown): unknown[] {
  if (!isObj(schema)) return [];
  const out: unknown[] = [];
  const seen = new Set<string>();
  const add = (v: unknown): void => {
    if (v === undefined) return;
    const key = canonicalJson(v);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  if ("default" in schema) add(schema.default);
  if ("const" in schema) add(schema.const);
  if (Array.isArray(schema.enum)) schema.enum.forEach(add);
  if (Array.isArray(schema.examples)) schema.examples.forEach(add);
  const types = typesOf(schema);
  if (types.includes("integer") || types.includes("number")) {
    if (typeof schema.minimum === "number") add(types.includes("integer") ? Math.ceil(schema.minimum) : schema.minimum);
    else if (typeof schema.exclusiveMinimum === "number") add(Math.floor(schema.exclusiveMinimum) + 1);
  }
  if (types.includes("boolean")) {
    add(false);
    add(true);
  }
  if (out.length === 0) {
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = schema[key];
      if (!Array.isArray(branches)) continue;
      for (const b of branches) {
        const c = candidates(b);
        if (c.length > 0) {
          c.forEach(add);
          break;
        }
      }
    }
  }
  return out;
}

function describeType(schema: unknown): string {
  if (!isObj(schema)) return "untyped";
  const t = typesOf(schema);
  return t.length > 0 ? t.join("|") : "untyped";
}

/**
 * Argument sets for `calls` calls: the first uses only the required arguments, each at its first
 * candidate; the others vary one argument at a time (other candidates of required arguments, then the
 * candidates of optional ones), so the recorded samples have several distinct argument sets. When there
 * are fewer distinct sets than calls, they are repeated in order.
 * Returns a reason string instead when a required argument has no derivable value.
 */
export function argSetsFor(inputSchema: unknown, calls: number): Args[] | string {
  const props = isObj(inputSchema) && isObj(inputSchema.properties) ? inputSchema.properties : {};
  const required = isObj(inputSchema) && Array.isArray(inputSchema.required) ? inputSchema.required.filter((r): r is string => typeof r === "string") : [];
  const base: Args = {};
  const variants: Args[] = [];
  for (const name of required) {
    const c = candidates(props[name]);
    if (c.length === 0) {
      return `required argument "${name}" (${describeType(props[name])}) has no default, enum, const, example or minimum in its schema`;
    }
    base[name] = c[0];
  }
  for (const name of required) for (const v of candidates(props[name]).slice(1)) variants.push({ ...base, [name]: v });
  for (const name of Object.keys(props).sort()) {
    if (required.includes(name)) continue;
    for (const v of candidates(props[name])) variants.push({ ...base, [name]: v });
  }
  const distinct: Args[] = [];
  const seen = new Set<string>();
  for (const a of [base, ...variants]) {
    const key = canonicalJson(a);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(a);
  }
  return Array.from({ length: calls }, (_, i) => distinct[i % distinct.length] as Args);
}

/** Why a tool is not safe to call by default, or undefined when it is (readOnlyHint === true). */
export function unsafeReason(tool: ListedTool): string | undefined {
  const a = isObj(tool.annotations) ? tool.annotations : undefined;
  if (a?.readOnlyHint === true) return undefined;
  if (a?.destructiveHint === true) return "marked destructive (annotations.destructiveHint is true)";
  if (a?.readOnlyHint === false) return "may have side effects (annotations.readOnlyHint is false)";
  return "not marked read-only (no annotations.readOnlyHint: true), so it may have side effects";
}

export function planQuickstart(tools: readonly ListedTool[], opts: PlanOptions): Plan {
  const only = opts.only ? new Set(opts.only) : undefined;
  const offered = new Set(tools.map((t) => t.name));
  const items: PlanItem[] = [];
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (only && !only.has(tool.name)) {
      items.push({ tool: tool.name, action: "skip", reason: "not listed in --tools" });
      continue;
    }
    if (!only) {
      const unsafe = unsafeReason(tool);
      if (unsafe) {
        items.push({ tool: tool.name, action: "skip", reason: unsafe });
        continue;
      }
    }
    const sets = argSetsFor(tool.inputSchema, opts.calls);
    if (typeof sets === "string") items.push({ tool: tool.name, action: "skip", reason: sets });
    else items.push({ tool: tool.name, action: "call", because: only ? "--tools" : "readOnlyHint", argSets: sets });
  }
  const unknown = only ? [...only].filter((n) => !offered.has(n)).sort() : [];
  return { items, unknown };
}
