// `mcp-return-types quickstart -- <server command...>`: one command from "I have a server" to typed results.
// It starts the server behind `mcp-return-types record`, lists its tools, calls only the safe ones (plan.ts),
// then runs infer and emit --ts and prints where the types are, a coverage report, a Code Mode snippet,
// and how to record the skipped tools through the user's real client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateStubs, type StubTool } from "../codemode/stubs.js";
import { runEmitTs } from "../emit/ts.js";
import { runInfer, type ToolEntry } from "../infer/run.js";
import { safeName } from "../proxy/recorder.js";
import { buildReport } from "../report.js";
import { planQuickstart, type Args, type ListedTool, type Plan } from "./plan.js";

export interface QuickstartOptions {
  /** The server command and its arguments. */
  command: string;
  args: string[];
  /** The .typegen folder (samples and schemas). */
  outDir: string;
  /** Where the .d.ts files go. */
  typesDir: string;
  calls: number;
  only?: string[];
  dryRun: boolean;
  /** Server name override, as for `record`. */
  name?: string;
  /** Per-call timeout in ms. */
  timeoutMs: number;
  /** How to start this CLI (for the `record` proxy): node, its flags and the CLI script. */
  self: { command: string; args: string[] };
  version: string;
  out: (line: string) => void;
  err: (line: string) => void;
  cwd?: string;
}

interface CallOutcome {
  ok: number;
  isError: number;
  failed: number;
  firstFailure?: string;
  ms: number;
}

const MAX_STDERR_LINES = 20;

/**
 * Quote one argument for display so it can be pasted into PowerShell or a POSIX shell: plain words stay
 * as they are, anything else goes in single quotes, which both shells read literally.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./\\:=@,+]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "''")}'`; // '' is PowerShell's escape; a POSIX shell would need '\'' (rare in paths)
}

function rel(file: string, cwd: string): string {
  const r = path.relative(cwd, file);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r) ? r : file;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  return env;
}

async function listAllTools(client: Client): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...(res.tools as ListedTool[]));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function fmtArgs(a: Args): string {
  const text = JSON.stringify(a);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The plan as text lines (printed by --dry-run and before the calls). */
export function describePlan(plan: Plan, calls: number): string[] {
  const lines: string[] = [];
  const toCall = plan.items.filter((i) => i.action === "call");
  const skipped = plan.items.filter((i) => i.action === "skip");
  lines.push(`Plan: call ${toCall.length} tool(s) ${calls} time(s) each, skip ${skipped.length}.`);
  for (const i of toCall) {
    if (i.action !== "call") continue;
    const distinct = new Set(i.argSets.map((a) => JSON.stringify(a)));
    const sets = [...distinct].map((t) => fmtArgs(JSON.parse(t) as Args)).join(" ");
    lines.push(`  call  ${i.tool} (${i.because === "--tools" ? "listed in --tools" : "readOnlyHint"}) x${i.argSets.length}: ${sets}`);
  }
  for (const i of skipped) if (i.action === "skip") lines.push(`  skip  ${i.tool}: ${i.reason}`);
  for (const n of plan.unknown) lines.push(`  ????  ${n}: listed in --tools, but the server does not offer it`);
  return lines;
}

async function callTool(client: Client, tool: string, args: Args, timeoutMs: number): Promise<{ isError: boolean } | { error: string }> {
  try {
    // A plain request: the SDK's callTool() would also validate against a declared outputSchema and throw,
    // and the point here is only that the proxy sees the real result.
    const res = await client.request({ method: "tools/call", params: { name: tool, arguments: args } }, CallToolResultSchema, {
      timeout: timeoutMs,
    });
    return { isError: res.isError === true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Code Mode snippet: the stubs of up to two tools before (unknown) and after (inferred types). Tools with
 * a structured (JSON) result are shown first, because a plain-text result only becomes `string`.
 */
export function codeModeSnippet(listed: readonly ListedTool[], entries: Readonly<Record<string, ToolEntry>>): string[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const score = (name: string): number => {
    const e = entries[name] as ToolEntry;
    return (e.unwrap === "text" ? 10 : 0) + rank[e.confidence];
  };
  const typed = listed
    .filter((t) => Object.hasOwn(entries, t.name) && entries[t.name]?.unwrap !== "none")
    .sort((a, b) => score(a.name) - score(b.name) || (a.name < b.name ? -1 : 1))
    .slice(0, 2);
  if (typed.length === 0) return [];
  const stubs: StubTool[] = typed.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const before = generateStubs(stubs).trimEnd();
  const after = generateStubs(stubs, { outputs: entries }).trimEnd();
  return ["// before: every call returns unknown", ...before.split("\n"), "", "// after: paste the result types and use them as the return types", ...after.split("\n")];
}

export async function runQuickstart(o: QuickstartOptions): Promise<number> {
  const cwd = o.cwd ?? process.cwd();
  const serverText = [o.command, ...o.args].map(shellQuote).join(" ");
  const recordArgs = ["record", "--out", o.outDir, "--kill-timeout", "500", ...(o.name ? ["--name", o.name] : []), "--", o.command, ...o.args];
  const transport = o.dryRun
    ? new StdioClientTransport({ command: o.command, args: o.args, env: processEnv(), stderr: "pipe", cwd })
    : new StdioClientTransport({ command: o.self.command, args: [...o.self.args, ...recordArgs], env: processEnv(), stderr: "pipe", cwd });
  const stderrTail: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => {
    for (const line of c.toString("utf8").split(/\r?\n/)) if (line.trim() !== "") stderrTail.push(line);
    stderrTail.splice(0, Math.max(0, stderrTail.length - MAX_STDERR_LINES));
  });
  const client = new Client({ name: "mcp-return-types-quickstart", version: o.version });

  let listed: ListedTool[];
  let serverName: string;
  try {
    await client.connect(transport);
    const info = client.getServerVersion();
    serverName = o.name ?? info?.name ?? path.basename(o.command).replace(/\.(cmd|exe|bat|js|mjs|cjs)$/i, "");
    listed = await listAllTools(client);
    o.out(`mcp-return-types quickstart: ${info?.name ?? serverName} ${info?.version ?? ""}`.trimEnd() + `, ${listed.length} tool(s) listed`);
  } catch (e) {
    o.err(`mcp-return-types: could not start or list the tools of: ${serverText}`);
    o.err(`  ${e instanceof Error ? e.message : String(e)}`);
    for (const l of stderrTail) o.err(`  server: ${l}`);
    await client.close().catch(() => undefined);
    return 1;
  }

  const plan = planQuickstart(listed, { only: o.only, calls: o.calls });
  o.out("");
  for (const l of describePlan(plan, o.calls)) o.out(l);
  if (o.dryRun) {
    await client.close().catch(() => undefined);
    o.out("");
    o.out("Dry run: nothing was called and nothing was written.");
    return 0;
  }

  o.out("");
  const outcomes = new Map<string, CallOutcome>();
  for (const item of plan.items) {
    if (item.action !== "call") continue;
    const res: CallOutcome = { ok: 0, isError: 0, failed: 0, ms: 0 };
    const start = Date.now();
    for (const args of item.argSets) {
      const r = await callTool(client, item.tool, args, o.timeoutMs);
      if ("error" in r) {
        res.failed += 1;
        res.firstFailure ??= r.error;
      } else if (r.isError) res.isError += 1;
      else res.ok += 1;
    }
    res.ms = Date.now() - start;
    outcomes.set(item.tool, res);
    const parts = [`${res.ok} ok`];
    if (res.isError > 0) parts.push(`${res.isError} error result(s)`);
    if (res.failed > 0) parts.push(`${res.failed} failed (${res.firstFailure ?? "?"})`);
    o.out(`  called ${item.tool}: ${parts.join(", ")} (${(res.ms / 1000).toFixed(1)} s)`);
  }
  await client.close().catch(() => undefined);

  const dirName = safeName(serverName);
  const inferred = runInfer({ inDir: o.outDir, servers: [dirName] });
  const server = inferred.servers.find((s) => s.server === dirName);
  const okCalls = [...outcomes.values()].reduce((n, r) => n + r.ok, 0);
  const skipped = plan.items.filter((i) => i.action === "skip");

  o.out("");
  if (!server || okCalls === 0) {
    o.out("No tool returned a successful result, so no types were written.");
  } else {
    const emitted = runEmitTs({ inDir: o.outDir, outDir: o.typesDir, version: o.version, servers: [dirName] });
    const entries: Record<string, ToolEntry> = {};
    for (const t of server.tools) Object.defineProperty(entries, t.tool, { value: t, enumerable: true });
    const stubsFile = path.join(o.typesDir, `${dirName}.codemode.d.ts`);
    mkdirSync(o.typesDir, { recursive: true });
    const header = `// Code Mode stubs generated by mcp-return-types ${o.version} quickstart for "${dirName}": inputs from tools/list, results inferred.\n`;
    writeFileSync(stubsFile, header + generateStubs(listed, { outputs: entries }));
    for (const f of emitted.files) o.out(`Types:      ${rel(f.file, cwd)} (${f.tools} tool(s) with inferred result types)`);
    o.out(`Code Mode:  ${rel(stubsFile, cwd)} (stubs for all ${listed.length} tool(s), inferred return types for ${server.tools.length})`);
    o.out("");
    o.out("Coverage:");
    for (const l of buildReport({ inDir: o.outDir, servers: [dirName] })) o.out(`  ${l}`);
    const snippet = codeModeSnippet(listed, entries);
    if (snippet.length > 0) {
      o.out("");
      o.out("Code Mode snippet (the full set is in the Code Mode file above):");
      o.out("");
      for (const l of snippet) o.out(`  ${l}`);
    }
  }

  const notCalled = [...skipped.map((i) => (i.action === "skip" ? `${i.tool}: ${i.reason}` : "")), ...plan.unknown.map((n) => `${n}: not offered by the server`)];
  const failedTools = [...outcomes.entries()].filter(([, r]) => r.ok === 0).map(([t, r]) => `${t}: no successful result (${r.isError > 0 ? "error results" : (r.firstFailure ?? "failed")})`);
  if (notCalled.length + failedTools.length > 0) {
    o.out("");
    o.out(`Not typed (${notCalled.length + failedTools.length}):`);
    for (const l of [...failedTools, ...notCalled]) o.out(`  - ${l}`);
    o.out("");
    o.out("To type these, record them through your real MCP client: in the client's server config, put");
    o.out("`mcp-return-types record` in front of the server command, use the tools as usual, then infer and emit again:");
    o.out("");
    o.out(`  mcp-return-types record --out ${shellQuote(rel(o.outDir, cwd))} -- ${serverText}`);
    o.out(`  mcp-return-types infer --in ${shellQuote(rel(o.outDir, cwd))}`);
    o.out(`  mcp-return-types emit --ts --in ${shellQuote(rel(o.outDir, cwd))} --out ${shellQuote(rel(o.typesDir, cwd))}`);
    o.out("");
    o.out("For example, in a JSON client config (Claude Code .mcp.json and similar):");
    const cfg = { mcpServers: { [serverName.split("/").pop() || dirName]: { command: "mcp-return-types", args: ["record", "--out", rel(o.outDir, cwd), "--", o.command, ...o.args] } } };
    for (const l of JSON.stringify(cfg, null, 2).split("\n")) o.out(`  ${l}`);
  }
  return server && okCalls > 0 ? 0 : 1;
}
