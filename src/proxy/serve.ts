// `mcp-return-types serve`: a proxy that adds `structuredContent` to results that provably match their
// inferred schema (SPEC §3 rule 12). Declaring the inferred `outputSchema`s in `tools/list` is opt-in
// (`--declare-schemas`), because a strict client rejects every declared-tool result that serve has to
// pass through without `structuredContent` (see NOTES.md, M3 SDK finding).
//
// Fail-open: every problem here (no schemas file, a schema that does not compile, a result that does
// not match, an exception) leaves the server's message exactly as it was. `serve` never changes a
// schema; widening happens in `record`/`infer`.
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeclarableRoot, toOpenSchema } from "../emit/open.js";
import type { SchemasFile, ToolEntry } from "../infer/run.js";
import { SCHEMAS_FILE_VERSION } from "../infer/run.js";
import { acceptsText, typesOf, type JsonSchema } from "../infer/schema.js";
import { safeName, unwrap } from "./recorder.js";

export interface ServeOptions {
  /** The `.typegen` folder that holds `schemas/<server>.json`; drift events are appended to `drift.jsonl` there. */
  inDir: string;
  /** Server name override (as for `record`). Otherwise serverInfo.name from `initialize`, then `fallbackName`. */
  name?: string;
  fallbackName: string;
  /**
   * True for `--declare-schemas`: also inject the inferred `outputSchema` into `tools/list`.
   * Default false (also what `--no-output-schema` asks for): only add `structuredContent`.
   */
  declareSchemas?: boolean;
  onWarn?: (msg: string) => void;
  now?: () => Date;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

interface ToolPlan {
  /** The open schema that is sent to clients and that results are validated against. */
  open: JsonSchema;
  validate: (value: unknown) => { valid: boolean; errorMessage?: string };
  unwrap: ToolEntry["unwrap"];
  /** The schema accepts a plain string (a text | parsed union, SPEC §3 rule 1): plain text is expected, not drift. */
  acceptsText: boolean;
  /** `--declare-schemas` may declare this tool's schema (object root only). */
  declarable: boolean;
}

/** True when an object can validate against the schema (an object root, or an object branch of a union). */
export function allowsObject(schema: JsonSchema): boolean {
  if (schema.anyOf) return schema.anyOf.some(allowsObject);
  const types = typesOf(schema);
  return types === undefined ? false : types.includes("object");
}

/**
 * Tools that `serve` adds `structuredContent` to: medium or high confidence, and an object can match
 * (an object root, or the object branch of a text | object union).
 */
export function isServable(entry: Pick<ToolEntry, "confidence" | "schema">): boolean {
  return (entry.confidence === "medium" || entry.confidence === "high") && allowsObject(entry.schema);
}

/** Tools whose inferred schema `serve --declare-schemas` may inject as `outputSchema`: servable, with a plain object root. */
export function isDeclarable(entry: Pick<ToolEntry, "confidence" | "schema">): boolean {
  return isServable(entry) && isDeclarableRoot(entry.schema);
}

export class ServeRewriter {
  private readonly lists = new Set<string>();
  private readonly calls = new Map<string, string>();
  private readonly inits = new Set<string>();
  private serverInfoName: string | undefined;
  private entries: Record<string, ToolEntry> | undefined;
  private readonly plans = new Map<string, ToolPlan | null>();
  private readonly reported = new Set<string>();
  private readonly validator = new AjvJsonSchemaValidator();
  private warnedMissing = false;

  constructor(private readonly opts: ServeOptions) {}

  private warn(msg: string): void {
    this.opts.onWarn?.(`mcp-return-types: ${msg}`);
  }

  /** Observe one client -> server message, to know which responses belong to which request. */
  fromClient(msg: unknown): void {
    try {
      if (Array.isArray(msg)) return msg.forEach((m) => this.fromClient(m));
      if (!isObj(msg) || typeof msg.method !== "string") return;
      if (msg.id !== undefined) {
        const key = JSON.stringify(msg.id);
        if (msg.method === "initialize") this.inits.add(key);
        else if (msg.method === "tools/list") this.lists.add(key);
        else if (msg.method === "tools/call" && isObj(msg.params) && typeof msg.params.name === "string") {
          this.calls.set(key, msg.params.name);
        }
      }
      if (msg.method === "notifications/cancelled" && isObj(msg.params) && msg.params.requestId !== undefined) {
        const key = JSON.stringify(msg.params.requestId);
        this.lists.delete(key);
        this.calls.delete(key);
      }
    } catch (err) {
      this.warn(`serve problem (proxying continues): ${String(err)}`);
    }
  }

  /** Called with every server -> client message that contains a result. Returns a replacement, or undefined. */
  rewrite(msg: unknown): unknown {
    if (Array.isArray(msg)) {
      let changed = false;
      const out = msg.map((m) => {
        const r = this.rewrite(m);
        if (r !== undefined) changed = true;
        return r ?? m;
      });
      return changed ? out : undefined;
    }
    if (!isObj(msg) || typeof msg.method === "string" || msg.id === undefined || !isObj(msg.result)) return undefined;
    const key = JSON.stringify(msg.id);
    if (this.inits.delete(key)) {
      const info = msg.result.serverInfo;
      if (isObj(info) && typeof info.name === "string") this.serverInfoName = info.name;
      return undefined;
    }
    if (this.lists.delete(key)) return this.rewriteList(msg, msg.result);
    const tool = this.calls.get(key);
    if (tool !== undefined) {
      this.calls.delete(key);
      return this.rewriteCall(msg, msg.result, tool);
    }
    return undefined;
  }

  private serverName(): string {
    return safeName(this.opts.name ?? this.serverInfoName ?? this.opts.fallbackName);
  }

  private load(): Record<string, ToolEntry> {
    if (this.entries) return this.entries;
    const file = path.join(this.opts.inDir, "schemas", `${this.serverName()}.json`);
    let tools: Record<string, ToolEntry> = {};
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as SchemasFile;
        if (parsed.v === SCHEMAS_FILE_VERSION && isObj(parsed.tools)) tools = parsed.tools;
      }
    } catch (err) {
      this.warn(`could not read ${file}: ${String(err)}`);
    }
    if (Object.keys(tools).length === 0 && !this.warnedMissing) {
      this.warnedMissing = true;
      this.warn(`no inferred schemas in ${file}; passing everything through (run "record" then "infer" first)`);
    }
    this.entries = tools;
    return tools;
  }

  private plan(tool: string): ToolPlan | undefined {
    const cached = this.plans.get(tool);
    if (cached !== undefined) return cached ?? undefined;
    let plan: ToolPlan | null = null;
    const entries = this.load();
    const entry = Object.hasOwn(entries, tool) ? entries[tool] : undefined;
    if (entry && isServable(entry)) {
      try {
        const open = toOpenSchema(entry.schema);
        const check = this.validator.getValidator(open as never);
        plan = {
          open,
          validate: (v) => check(v),
          unwrap: entry.unwrap,
          acceptsText: acceptsText(entry.schema),
          declarable: isDeclarable(entry),
        };
      } catch (err) {
        this.warn(`schema for "${tool}" does not compile; serving it without a schema: ${String(err)}`);
      }
    }
    this.plans.set(tool, plan);
    return plan ?? undefined;
  }

  private rewriteList(msg: Record<string, unknown>, result: Record<string, unknown>): unknown {
    if (this.opts.declareSchemas !== true || !Array.isArray(result.tools)) return undefined;
    let changed = false;
    const tools = result.tools.map((t: unknown) => {
      if (!isObj(t) || typeof t.name !== "string" || t.outputSchema !== undefined) return t; // never override a declared schema
      const plan = this.plan(t.name);
      if (!plan?.declarable) return t;
      changed = true;
      return { ...t, outputSchema: plan.open };
    });
    return changed ? { ...msg, result: { ...result, tools } } : undefined;
  }

  private rewriteCall(msg: Record<string, unknown>, result: Record<string, unknown>, tool: string): unknown {
    if (result.isError === true) return undefined; // the success schema never applies to errors
    if (result.structuredContent !== undefined && result.structuredContent !== null) return undefined;
    const plan = this.plan(tool);
    if (!plan) return undefined;
    const unwrapped = unwrap(result);
    if (unwrapped.path === "none") return undefined;
    // A text | parsed union: plain text, or JSON that only fits as text, passes through without drift.
    if (unwrapped.path === "text") return plan.acceptsText ? undefined : this.drift(tool, "result is no longer JSON");
    const verdict = plan.validate(unwrapped.value);
    if (verdict.valid && isObj(unwrapped.value)) return { ...msg, result: { ...result, structuredContent: unwrapped.value } };
    if (verdict.valid || plan.acceptsText) return undefined; // e.g. null in an object | null schema: nothing to add
    if (!isObj(unwrapped.value)) return this.drift(tool, "result is JSON but not an object");
    return this.drift(tool, `does not match the inferred schema: ${verdict.errorMessage ?? "unknown"}`);
  }

  /** Log a drift event (once per tool and reason per process) and return undefined, so the caller passes the result through. */
  private drift(tool: string, reason: string): undefined {
    const key = `${tool}\0${reason}`;
    if (this.reported.has(key)) return undefined;
    this.reported.add(key);
    try {
      const at = (this.opts.now?.() ?? new Date()).toISOString();
      mkdirSync(this.opts.inDir, { recursive: true });
      appendFileSync(
        path.join(this.opts.inDir, "drift.jsonl"),
        `${JSON.stringify({ ts: at, source: "serve", server: this.serverName(), tool, reason })}\n`,
      );
      this.warn(`drift in "${tool}": ${reason} (result passed through without structuredContent)`);
    } catch (err) {
      this.warn(`could not log drift: ${String(err)}`);
    }
    return undefined;
  }
}
