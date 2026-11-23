// Classification for the analysis (M7): what kind of mistake each sandbox exception is, which final
// answers are refusals ("the tools are unavailable"), and failed pagination runs that never paged.
// All rules are plain regexes over logged text, so a reader can check every label by hand.

export const ERROR_CATEGORIES = [
  { id: "undefined-or-null-property", label: "read a property of undefined or null" },
  { id: "wrong-type-method", label: "method or iteration on the wrong type (e.g. .map on a non-array)" },
  { id: "json-or-string-vs-object", label: "JSON.parse or string-vs-object confusion" },
  { id: "wrong-field-name", label: "wrong field, argument or tool name" },
  { id: "pagination", label: "bad page argument (pagination)" },
  { id: "tool-error", label: "tool returned an error (not found, validation)" },
  { id: "syntax-error", label: "code did not compile (syntax)" },
  { id: "timeout", label: "timeout (sandbox limit)" },
  { id: "other", label: "other" },
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]["id"];

/** The exception as logged: `sandbox_exception` is `Name: message` (bench/harness/sandbox.ts). */
export interface ExceptionInput {
  status: "exception" | "timeout";
  message: string;
  /** The code block that failed, if known: used to tell a wrong field name from a missing optional field. */
  code?: string;
}

const UNDEFINED_READ =
  /Cannot read propert(?:y|ies) .*of (?:undefined|null)|Cannot set propert(?:y|ies) of (?:undefined|null)|Cannot destructure|Cannot convert undefined or null to object|(?:undefined|null) is not an object|Cannot use 'in' operator to search for .* in (?:undefined|null)\s*$/;

/**
 * Property names read directly before `prop` in the code (`x.parent.prop`, `x["parent"].prop`).
 * Used only for "Cannot read properties of undefined (reading 'prop')".
 */
export function parentsOf(code: string, prop: string): string[] {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = new Set<string>();
  const dot = new RegExp(`\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*${p}(?![\\w$])`, "g");
  const bracket = new RegExp(`\\[\\s*["']([A-Za-z_$][\\w$]*)["']\\s*\\]\\s*\\.\\s*${p}(?![\\w$])`, "g");
  for (const re of [dot, bracket]) for (const m of code.matchAll(re)) out.add(m[1] as string);
  return [...out];
}

/**
 * One category per exception, first match wins:
 *  timeout; tool errors (bad page argument -> pagination, bad/missing argument name or unknown tool ->
 *  wrong name, Not Found / Validation Failed -> tool-error); `tools.x is not a function` -> wrong name;
 *  SyntaxError mentioning JSON -> JSON confusion, other SyntaxError -> syntax-error; "[object Object]",
 *  property on a string -> JSON/string confusion; reading a property of undefined/null -> that category,
 *  unless every field read just before it in the code is unknown to the server's result types (then
 *  wrong-field-name); "is not a function/iterable" -> wrong-type-method; anything else -> other.
 * `knownFields` = every property name in the inferred result schemas (bench/arm-d).
 */
export function classifyException(e: ExceptionInput, knownFields: ReadonlySet<string>): ErrorCategory {
  const msg = e.message;
  if (e.status === "timeout" || /^Timeout:/.test(msg)) return "timeout";
  if (/argument "page"/.test(msg)) return "pagination";
  if (/missing required argument|argument "[^"]+" must be|unknown qualifier|unknown tool/.test(msg)) return "wrong-field-name";
  if (/^Error: (?:Not Found|Validation Failed)/.test(msg)) return "tool-error";
  if (/\btools\.[\w$]+ is not a function/.test(msg)) return "wrong-field-name";
  if (/^SyntaxError:/.test(msg)) return /JSON/.test(msg) ? "json-or-string-vs-object" : "syntax-error";
  if (/\[object Object\]|Cannot create property .* on string|Cannot use 'in' operator to search for .* in (?!undefined|null)/.test(msg)) return "json-or-string-vs-object";
  if (UNDEFINED_READ.test(msg)) {
    const prop = /\(reading '([^']+)'\)/.exec(msg)?.[1];
    if (prop !== undefined && e.code !== undefined) {
      const parents = parentsOf(e.code, prop);
      if (parents.length > 0 && parents.every((p) => !knownFields.has(p))) return "wrong-field-name";
    }
    return "undefined-or-null-property";
  }
  if (/is not a function|is not iterable|is not a constructor/.test(msg)) return "wrong-type-method";
  return "other";
}

/** Every property name in a JSON Schema (walks properties, items, anyOf/oneOf/allOf, additionalProperties). */
export function schemaFieldNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) schemaFieldNames(s, into);
    return into;
  }
  if (schema === null || typeof schema !== "object") return into;
  const o = schema as Record<string, unknown>;
  if (o.properties && typeof o.properties === "object") {
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      into.add(k);
      schemaFieldNames(v, into);
    }
  }
  for (const k of ["items", "anyOf", "oneOf", "allOf", "additionalProperties", "prefixItems"]) schemaFieldNames(o[k], into);
  return into;
}

/** Field names of every tool's success and error schema in an inferred schemas file. */
export function knownFieldsFromSchemas(file: { tools?: Record<string, { schema?: unknown; error?: { schema?: unknown } }> }): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(file.tools ?? {})) {
    schemaFieldNames(t.schema, out);
    schemaFieldNames(t.error?.schema, out);
  }
  return out;
}

const REFUSAL = [
  /\b(?:is|are|was|were)\s*n't\s+(?:available|accessible|exposed|provided)\b/,
  /\b(?:is|are|was|were)\s+not\s+(?:available|accessible|exposed|provided)\b/,
  /\bnot\s+(?:available|accessible|exposed)\s+(?:here|in this|to me)\b/,
  /\bunavailable\b/,
  /\b(?:does|do)\s*(?:n't|\s+not)\s+(?:expose|provide|have access|give me access)\b/,
  /\b(?:no|without)\s+access\s+to\b/,
  /\bwith the available tools\b/,
  /\b(?:could|can)\s*(?:n't|not)\s+(?:retrieve|access|call|use|reach|fetch|run)\b/,
  /\bcannot\s+(?:retrieve|access|call|use|reach|fetch|run)\b/,
  /\bunable to\s+(?:retrieve|access|call|use|reach|fetch|run)\b/,
];

/**
 * A final answer that claims the tools (or the data) are unavailable instead of answering. Only failed
 * runs count as refused: a passing answer is graded correct, whatever else it says.
 */
export function isRefusal(final: string | null | undefined, pass: boolean): boolean {
  if (pass || !final) return false;
  const text = final.replace(/[‘’ʼ]/g, "'").toLowerCase();
  return REFUSAL.some((re) => re.test(text));
}

/** True if any code block reads `next_page` or passes a `page` other than the literal 1. */
export function codePaginates(codes: readonly string[]): boolean {
  return codes.some((c) => /next_page/.test(c) || /\bpage\s*:\s*(?!1(?![\w.]))[\w$(]/.test(c) || /[{,]\s*page\s*[,}]/.test(c));
}
