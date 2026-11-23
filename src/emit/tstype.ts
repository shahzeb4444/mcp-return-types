// JSON Schema -> TypeScript type text. Used for inferred result types (`emit --ts`) and for the input
// schemas of the Code Mode stubs. Anything it does not understand becomes `unknown`.

export interface TsType {
  text: string;
  /** True when the text is a union or an intersection and needs parentheses inside `T[]`. */
  compound: boolean;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const isIdentifier = (s: string): boolean => IDENT.test(s);
export const propKey = (k: string): string => (isIdentifier(k) ? k : JSON.stringify(k));

type Schema = Record<string, unknown>;
const isSchema = (x: unknown): x is Schema => typeof x === "object" && x !== null && !Array.isArray(x);
const UNKNOWN: TsType = { text: "unknown", compound: false };
const simple = (text: string): TsType => ({ text, compound: false });

const pad = (level: number): string => "  ".repeat(level);

/** Comment text must not be able to end the comment. */
export const safeComment = (s: string): string => s.replace(/\*\//g, "*\\/").replace(/\r?\n/g, " ").trim();

function wrap(t: TsType): string {
  return t.compound ? `(${t.text})` : t.text;
}

function union(parts: TsType[]): TsType {
  const texts: string[] = [];
  for (const p of parts) if (!texts.includes(p.text)) texts.push(p.text);
  if (texts.includes("unknown")) return UNKNOWN;
  if (texts.length === 0) return simple("never");
  if (texts.length === 1) return parts.find((p) => p.text === texts[0]) as TsType;
  return { text: texts.join(" | "), compound: true };
}

function literal(v: unknown): TsType {
  return simple(JSON.stringify(v) ?? "undefined");
}

/** Doc comment lines for a property or tool, or [] when there is nothing to say. */
function docLines(schema: Schema): string[] {
  const lines: string[] = [];
  if (typeof schema.description === "string") {
    lines.push(...schema.description.split(/\r?\n/).map(safeComment).filter((l) => l !== ""));
  }
  if (typeof schema.format === "string") lines.push(`format: ${safeComment(schema.format)}`);
  const observed = schema["x-observed-values"];
  if (Array.isArray(observed) && observed.length > 0) {
    lines.push(`observed values (a hint, not exhaustive): ${observed.map((v) => safeComment(JSON.stringify(v))).join(", ")}`);
  }
  return lines;
}

function objectType(schema: Schema, level: number): TsType {
  const props = isSchema(schema.properties) ? schema.properties : undefined;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
  );
  const ap = schema.additionalProperties;
  const capped = schema["x-capped"] === "keys";
  const names = props ? Object.keys(props) : [];
  const valueSchema = isSchema(ap) ? ap : undefined;

  if (names.length === 0) {
    if (valueSchema) return simple(`{ [key: string]: ${typeOf(valueSchema, level + 1).text} }`);
    return simple("Record<string, unknown>");
  }
  const lines: string[] = [];
  for (const name of names) {
    const child = (props as Schema)[name];
    const doc = isSchema(child) ? docLines(child) : [];
    if (doc.length === 1) lines.push(`${pad(level + 1)}/** ${doc[0]} */`);
    else if (doc.length > 1) {
      lines.push(`${pad(level + 1)}/**`, ...doc.map((d) => `${pad(level + 1)} * ${d}`), `${pad(level + 1)} */`);
    }
    lines.push(`${pad(level + 1)}${propKey(name)}${required.has(name) ? "" : "?"}: ${typeOf(child, level + 1).text};`);
  }
  // Keys beyond the key cap are allowed but untyped; a map schema next to properties cannot be typed precisely.
  if (capped || valueSchema) lines.push(`${pad(level + 1)}[key: string]: unknown;`);
  return simple(`{\n${lines.join("\n")}\n${pad(level)}}`);
}

/** The TypeScript type for a JSON Schema (object form). Booleans and unknown shapes give `unknown`. */
export function typeOf(schema: unknown, level = 0): TsType {
  if (schema === false) return simple("never");
  if (!isSchema(schema)) return UNKNOWN;
  if (schema["x-capped"] === "union" || schema["x-capped"] === "depth") return UNKNOWN;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return union(schema.enum.map(literal));
  if ("const" in schema) return literal(schema.const);

  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (branches && branches.length > 0) return union(branches.map((b) => typeOf(b, level)));
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const parts = schema.allOf.map((b) => typeOf(b, level)).filter((p) => p.text !== "unknown");
    if (parts.length === 0) return UNKNOWN;
    if (parts.length === 1) return parts[0] as TsType;
    return { text: parts.map(wrap).join(" & "), compound: true };
  }

  const declared = schema.type;
  const types = Array.isArray(declared) ? declared : typeof declared === "string" ? [declared] : [];
  if (types.length === 0) return schema.properties !== undefined ? objectType(schema, level) : UNKNOWN;

  const parts: TsType[] = [];
  for (const t of types) {
    switch (t) {
      case "object":
        parts.push(objectType(schema, level));
        break;
      case "array":
        parts.push(
          schema.items === undefined || Array.isArray(schema.items)
            ? simple("unknown[]")
            : simple(`${wrap(typeOf(schema.items, level))}[]`),
        );
        break;
      case "string":
        parts.push(simple("string"));
        break;
      case "integer":
      case "number":
        parts.push(simple("number"));
        break;
      case "boolean":
        parts.push(simple("boolean"));
        break;
      case "null":
        parts.push(simple("null"));
        break;
      default:
        return UNKNOWN;
    }
  }
  return union(parts);
}

/** Doc comment lines for a whole schema (tool and argument descriptions in the stubs). */
export function docOf(schema: unknown): string[] {
  return isSchema(schema) ? docLines(schema) : [];
}

export function pascalCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const base = joined === "" ? "Tool" : joined;
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

/** `list_issues` -> `ListIssuesResult`. Names that collide get a numeric suffix. */
export function resultTypeNames(tools: readonly string[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const tool of tools) {
    const base = `${pascalCase(tool)}Result`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    out.set(tool, name);
  }
  return out;
}
