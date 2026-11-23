// SPEC §6: the TypeScript declaration block that a Code Mode `run_code` tool shows the model.
// The benchmark builds two versions from the same tool list: with no `outputs` every return is
// `Promise<unknown>` (arm C), with `outputs` the returns are the inferred types (arm D). Everything
// else in the block is identical, and the unwrap note lives outside the stubs (BENCHMARK.md).
import { isIdentifier, resultTypeNames, safeComment, typeOf } from "../emit/tstype.js";
import { emitToolType, type EmitTool } from "../emit/ts.js";

export interface StubTool {
  name: string;
  description?: string;
  /** The tool's MCP input schema (JSON Schema). */
  inputSchema?: unknown;
}

export interface StubOptions {
  /** Name of the object the model calls, as in `tools.list_issues({...})`. Default "tools". */
  namespace?: string;
  /** Inferred results by tool name. Omit for `Promise<unknown>` everywhere. Tools missing here stay `unknown`. */
  outputs?: Readonly<Record<string, EmitTool | undefined>>;
}

type Schema = Record<string, unknown>;
const isObj = (x: unknown): x is Schema => typeof x === "object" && x !== null && !Array.isArray(x);

function jsdoc(lines: string[], indent: string): string[] {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`];
}

/** `args: {...}` for a tool, or nothing when the tool takes no arguments. */
function argsParam(inputSchema: unknown): string {
  if (!isObj(inputSchema)) return "args?: Record<string, unknown>";
  const props = isObj(inputSchema.properties) ? Object.keys(inputSchema.properties) : [];
  const required = Array.isArray(inputSchema.required) && inputSchema.required.length > 0;
  if (props.length === 0 && !required && inputSchema.additionalProperties === undefined) return "";
  const type = typeOf(inputSchema, 1).text;
  return `args${required ? "" : "?"}: ${type}`;
}

export function generateStubs(tools: readonly StubTool[], opts: StubOptions = {}): string {
  const namespace = opts.namespace ?? "tools";
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const typeNames = resultTypeNames(sorted.map((t) => t.name));

  const typeBlocks: string[] = [];
  const members: string[] = [];
  for (const tool of sorted) {
    const inferred = opts.outputs?.[tool.name];
    let ret = "unknown";
    const comments: string[] = [];
    if (inferred) {
      const typeName = typeNames.get(tool.name) as string;
      typeBlocks.push(emitToolType(inferred, typeName, { exported: false, notes: false }));
      ret = typeName;
      if (inferred.confidence === "low") comments.push("// low confidence");
    }
    const description = (tool.description ?? "")
      .split(/\r?\n/)
      .map(safeComment)
      .filter((l) => l !== "");
    const name = isIdentifier(tool.name) ? tool.name : JSON.stringify(tool.name);
    members.push(
      [...jsdoc(description, "  "), ...comments.map((c) => `  ${c}`), `  ${name}(${argsParam(tool.inputSchema)}): Promise<${ret}>;`].join("\n"),
    );
  }

  const out: string[] = [];
  if (typeBlocks.length > 0) out.push(typeBlocks.join("\n\n"));
  out.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
  return `${out.join("\n\n")}\n`;
}

