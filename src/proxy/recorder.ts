import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, isMapLike, sampleItems, shapeOf, type Shape } from "./shape.js";

export interface RecorderOptions {
  outDir: string;
  /** Server name override. Otherwise serverInfo.name from `initialize`, then the command basename. */
  name?: string;
  fallbackName: string;
  keepValues?: boolean;
  observedValues?: boolean;
  onWarn?: (msg: string) => void;
}

export type UnwrapPath = "structuredContent" | "json-text" | "text" | "none";

export interface Sample {
  v: 1;
  ts: string;
  tool: string;
  /** Salted SHA-256 of the canonical JSON of the call arguments. */
  args: string;
  isError: boolean;
  unwrap: UnwrapPath;
  /** Content block types in order, e.g. ["text","image"]. */
  blocks: string[];
  /** Shape of the unwrapped value. Absent for JSON-RPC errors and results with no text. */
  shape?: Shape;
  /** Set when the server answered with a JSON-RPC error (code only, never the message). */
  rpcError?: { code: number };
  /** Raw unwrapped value, only with --keep-values. */
  value?: unknown;
}

interface PendingCall {
  tool: string;
  args: string;
}

/** Values-counter limits from SPEC §4. */
const MAX_DISTINCT = 8;
const MAX_VALUE_LEN = 40;

interface ValuesFile {
  fields: Record<string, Record<string, number>>;
  highCardinality: string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Plain objects used as maps must not inherit "constructor", "__proto__" and friends. */
function nullProto<T>(src?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, src);
}

/** `samples/<server>/_tools.json`: what `tools/list` said about each tool (names and booleans only). */
export const TOOL_LIST_FILE = "_tools.json";

export interface ToolListEntry {
  /** The server declares its own outputSchema for this tool. */
  outputSchema: boolean;
  readOnlyHint?: boolean;
}

export interface ToolListFile {
  v: 1;
  tools: Record<string, ToolListEntry>;
}

export function readToolList(file: string): ToolListFile | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ToolListFile>;
    if (parsed.v !== 1 || !isObj(parsed.tools)) return undefined;
    return { v: 1, tools: nullProto(parsed.tools as Record<string, ToolListEntry>) };
  } catch {
    return undefined;
  }
}

/** Make a name safe to use as a single file or directory name. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  const base = cleaned.length > 0 ? cleaned.slice(0, 80) : "_";
  if (base === name) return base;
  // Different names must not collide after cleaning.
  const h = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${base}-${h}`;
}

/** Add the out dir to .gitignore when the current folder is inside a git repo. Returns the line added, if any. */
export function ensureGitignore(cwd: string, outDir: string): string | undefined {
  let dir = path.resolve(cwd);
  let inRepo = false;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      inRepo = true;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!inRepo) return undefined;
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, outDir));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const entry = rel.split(path.sep).join("/");
  const file = path.join(cwd, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  // An ignored parent folder (for example ".typegen" when the out dir is ".typegen/real-servers/x") covers the out dir too.
  const parts = entry.split("/");
  const candidates = parts.flatMap((_, i) => {
    const e = parts.slice(0, i + 1).join("/");
    return [e, `${e}/`, `/${e}`, `/${e}/`];
  });
  const present = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => candidates.includes(l));
  if (present) return undefined;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${existing}${sep}${entry}/\n`);
  return `${entry}/`;
}

export class Recorder {
  private readonly pending = new Map<string, PendingCall>();
  private readonly initIds = new Set<string>();
  private readonly listIds = new Set<string>();
  private serverInfoName: string | undefined;
  private salt: string | undefined;
  private readonly values = new Map<string, ValuesFile>();
  private warned = false;

  constructor(private readonly opts: RecorderOptions) {}

  private warn(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.opts.onWarn?.(`mcp-return-types: recording problem (proxying continues): ${String(err)}`);
  }

  private serverName(): string {
    return safeName(this.opts.name ?? this.serverInfoName ?? this.opts.fallbackName);
  }

  /** Observe one JSON-RPC message sent by the client to the server. */
  fromClient(msg: unknown): void {
    try {
      if (Array.isArray(msg)) return msg.forEach((m) => this.fromClient(m));
      if (!isObj(msg)) return;
      const method = msg.method;
      if (typeof method !== "string") return; // client replies to server requests: not tracked
      if (method === "initialize" && msg.id !== undefined) this.initIds.add(JSON.stringify(msg.id));
      if (method === "tools/list" && msg.id !== undefined) this.listIds.add(JSON.stringify(msg.id));
      if (method === "tools/call" && msg.id !== undefined && isObj(msg.params)) {
        const tool = msg.params.name;
        if (typeof tool !== "string") return;
        this.pending.set(JSON.stringify(msg.id), {
          tool,
          args: this.hashArgs(msg.params.arguments),
        });
      }
      if (method === "notifications/cancelled" && isObj(msg.params) && msg.params.requestId !== undefined) {
        this.pending.delete(JSON.stringify(msg.params.requestId));
      }
    } catch (err) {
      this.warn(err);
    }
  }

  /** Observe one JSON-RPC message sent by the server to the client. */
  fromServer(msg: unknown): void {
    try {
      if (Array.isArray(msg)) return msg.forEach((m) => this.fromServer(m));
      if (!isObj(msg) || typeof msg.method === "string" || msg.id === undefined) return; // not a response
      const key = JSON.stringify(msg.id);
      if (this.initIds.delete(key)) {
        const info = isObj(msg.result) && isObj(msg.result.serverInfo) ? msg.result.serverInfo : undefined;
        if (typeof info?.name === "string") this.serverInfoName = info.name;
        return;
      }
      if (this.listIds.delete(key)) {
        if (isObj(msg.result) && Array.isArray(msg.result.tools)) this.recordToolList(msg.result.tools);
        return;
      }
      const call = this.pending.get(key);
      if (!call) return;
      this.pending.delete(key);
      this.record(call, msg);
    } catch (err) {
      this.warn(err);
    }
  }

  /**
   * Remember, per tool, whether the server declares its own `outputSchema` (and its readOnlyHint), so
   * `report` can say how a tool is really served. Only tool names and booleans are stored.
   */
  private recordToolList(tools: unknown[]): void {
    const dir = path.join(this.opts.outDir, "samples", this.serverName());
    const file = path.join(dir, TOOL_LIST_FILE);
    const current = readToolList(file) ?? { v: 1, tools: nullProto<ToolListEntry>() };
    for (const t of tools) {
      if (!isObj(t) || typeof t.name !== "string") continue;
      const entry: ToolListEntry = { outputSchema: isObj(t.outputSchema) };
      if (isObj(t.annotations) && typeof t.annotations.readOnlyHint === "boolean") entry.readOnlyHint = t.annotations.readOnlyHint;
      current.tools[t.name] = entry;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(current)}\n`);
  }

  private getSalt(): string {
    if (this.salt) return this.salt;
    mkdirSync(this.opts.outDir, { recursive: true });
    const file = path.join(this.opts.outDir, "salt");
    try {
      writeFileSync(file, randomBytes(16).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    this.salt = readFileSync(file, "utf8").trim();
    return this.salt;
  }

  private hashArgs(args: unknown): string {
    return createHash("sha256")
      .update(this.getSalt())
      .update("\0")
      .update(canonicalJson(args ?? {}))
      .digest("hex")
      .slice(0, 32);
  }

  private record(call: PendingCall, msg: Record<string, unknown>): void {
    const sample: Sample = {
      v: 1,
      ts: new Date().toISOString(),
      tool: call.tool,
      args: call.args,
      isError: false,
      unwrap: "none",
      blocks: [],
    };
    let counted: unknown;
    if (isObj(msg.error)) {
      const code = msg.error.code;
      sample.rpcError = { code: typeof code === "number" ? code : 0 };
    } else if (isObj(msg.result)) {
      const res = msg.result;
      sample.isError = res.isError === true;
      const content = Array.isArray(res.content) ? res.content : [];
      sample.blocks = content.map((c) => (isObj(c) && typeof c.type === "string" ? c.type : "unknown"));
      const unwrapped = unwrap(res);
      sample.unwrap = unwrapped.path;
      if (unwrapped.path !== "none") {
        sample.shape = shapeOf(unwrapped.value);
        if (this.opts.keepValues) sample.value = unwrapped.value;
        // Plain (non-JSON) text is never counted: it would store raw values.
        if (unwrapped.path !== "text" && !sample.isError) counted = unwrapped.value;
      }
    } else {
      return;
    }
    const dir = path.join(this.opts.outDir, "samples", this.serverName());
    mkdirSync(dir, { recursive: true });
    const base = safeName(call.tool);
    appendFileSync(path.join(dir, `${base}.jsonl`), `${JSON.stringify(sample)}\n`);
    if (counted !== undefined && this.opts.observedValues !== false) {
      this.count(path.join(dir, `${base}.values.json`), counted);
    }
  }

  private count(file: string, value: unknown): void {
    let vf = this.values.get(file);
    if (!vf) {
      vf = { fields: nullProto(), highCardinality: [] };
      if (existsSync(file)) {
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ValuesFile>;
          vf = { fields: nullProto(parsed.fields), highCardinality: parsed.highCardinality ?? [] };
          for (const k of Object.keys(vf.fields)) vf.fields[k] = nullProto(vf.fields[k]);
        } catch {
          // unreadable counter file: start over
        }
      }
      this.values.set(file, vf);
    }
    const state = vf;
    const high = new Set(state.highCardinality);
    const visit = (v: unknown, p: string, depth: number): void => {
      if (depth > 12) return;
      if (typeof v === "string") {
        if (high.has(p)) return;
        const counter = state.fields[p] ?? (state.fields[p] = nullProto<number>());
        if (v.length > MAX_VALUE_LEN || (!Object.hasOwn(counter, v) && Object.keys(counter).length >= MAX_DISTINCT)) {
          delete state.fields[p];
          high.add(p);
          return;
        }
        counter[v] = (counter[v] ?? 0) + 1;
      } else if (Array.isArray(v)) {
        sampleItems(v).forEach((x) => visit(x, `${p}[]`, depth + 1));
      } else if (isObj(v)) {
        // A map-like object is recorded without its key names (SPEC §3 rule 11), so it gets no counters:
        // the counter paths would hold the key names, and its values (environment values, say) are data.
        if (isMapLike(v)) return;
        for (const [k, x] of Object.entries(v)) visit(x, `${p}.${k}`, depth + 1);
      }
    };
    visit(value as Json, "$", 0);
    state.highCardinality = [...high].sort();
    writeFileSync(file, JSON.stringify(state));
  }
}

/** The text parts of a result joined with "\n" (as rule 1 joins them), or undefined when there are none. */
export function joinedText(result: Record<string, unknown>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content
    .filter((c): c is Record<string, unknown> => isObj(c) && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return texts.length === 0 ? undefined : texts.join("\n");
}

/** SPEC §3 rule 1: structuredContent first, else the joined text parts parsed as JSON, else plain text. */
export function unwrap(result: Record<string, unknown>): { path: UnwrapPath; value?: unknown } {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return { path: "structuredContent", value: result.structuredContent };
  }
  const joined = joinedText(result);
  if (joined === undefined) return { path: "none" };
  try {
    return { path: "json-text", value: JSON.parse(joined) as unknown };
  } catch {
    return { path: "text", value: joined };
  }
}
