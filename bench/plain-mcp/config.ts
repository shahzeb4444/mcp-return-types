// M11 plain-MCP test (BENCHMARK.md Amendment 3): arms, workloads, and the MCP server command each arm hands
// to the client. The arms differ ONLY in the proxy part of that command; the upstream server part is the same.
//
//   P  = plain pass-through proxy (bench/plain-mcp/passthrough.ts: src/proxy/proxy.ts with no observer/rewriter)
//   S  = mcp-return-types serve (default mode: structuredContent only), reading the seed-1 inferred schemas
//   S2 = mcp-return-types serve --declare-schemas (exploratory, not gating)
//
// Both proxies run from source through the same tsx loader, so their start-up path is identical.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..", "..");

export const PLAIN_ARMS = ["P", "S", "S2"] as const;
export type PlainArm = (typeof PLAIN_ARMS)[number];
/** The arms of the verdict (Amendment 3). S2 is exploratory. */
export const GATING_ARMS: readonly PlainArm[] = ["P", "S"];

export const WORKLOADS = ["mock", "everything"] as const;
export type Workload = (typeof WORKLOADS)[number];

/** Amendment 3: the 6 tasks of the gating workload. */
export const MOCK_TASK_IDS = ["ctrl-01", "nested-03", "nested-06", "page-02", "page-04", "write-01"] as const;
export const DEFAULT_REPS: Record<Workload, number> = { mock: 2, everything: 1 };

/** Amendment 3: one pinned model per backend. */
export const PLAIN_MODELS: Record<string, string> = { "claude-cli": "claude-haiku-5-5", "codex-cli": "gpt-6.2-sol" };
export const PLAIN_BACKENDS = ["claude-cli", "codex-cli"] as const;

/** The name the client knows the MCP server by (Claude tool names become mcp__<name>__<tool>). */
export const MCP_NAME: Record<Workload, string> = { mock: "github", everything: "everything" };
/** The schemas file `serve --name` reads: <in>/schemas/<name>.json. */
export const SCHEMA_NAME: Record<Workload, string> = { mock: "mock-github", everything: "everything" };
export const SCHEMAS_FILE: Record<Workload, string> = {
  mock: path.join(ROOT, "bench", "arm-d", "mock-github.json"),
  everything: path.join(HERE, "everything", "schemas", "everything.json"),
};
/** The tools each workload exposes (and the only ones the client may call). */
export const WORKLOAD_TOOLS: Record<Workload, readonly string[]> = {
  mock: ["list_issues", "get_issue", "list_comments", "search_issues", "add_label", "assign", "post_comment", "list_prs"],
  everything: ["echo", "get-sum", "get-structured-content"],
};

export const TSX_LOADER = path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs");
export const PASSTHROUGH = path.join(HERE, "passthrough.ts");
export const CLI_SOURCE = path.join(ROOT, "src", "cli.ts");
export const MOCK_SERVER = path.join(ROOT, "bench", "mock-server", "server.ts");
export const EVERYTHING_SERVER = path.join(ROOT, "node_modules", "@modelcontextprotocol", "server-everything", "dist", "index.js");
export const EVAL_SEED = 2;
export const DEFAULT_LATENCY_MS = 150;

/** `--import <file URL>`: the client starts the server with an empty temp cwd, so a bare `--import tsx` would not resolve. */
export const tsxImport = (): string[] => ["--import", pathToFileURL(TSX_LOADER).href];

/** Per-run files, all OUTSIDE the client's working directory (which stays empty). */
export interface RunPaths {
  dir: string;
  /** The mock server's write log (graded). */
  writeLog: string;
  /** `serve --in` (a copy of the schemas; drift.jsonl lands here). Created for every arm, read only by S/S2. */
  typegenDir: string;
}

export interface ServerSpec {
  /** Key in the client's MCP config. */
  name: string;
  command: string;
  args: string[];
}

export function makeRunPaths(workload: Workload, base = tmpdir()): RunPaths {
  const dir = mkdtempSync(path.join(base, "plain-mcp-run-"));
  const typegenDir = path.join(dir, "typegen");
  mkdirSync(path.join(typegenDir, "schemas"), { recursive: true });
  const schemas = SCHEMAS_FILE[workload];
  if (!existsSync(schemas)) throw new Error(`missing ${schemas}${workload === "everything" ? ': run "npm run bench:plain:prepare" first' : ""}`);
  copyFileSync(schemas, path.join(typegenDir, "schemas", `${SCHEMA_NAME[workload]}.json`));
  return { dir, writeLog: path.join(dir, "writes.jsonl"), typegenDir };
}

/** The upstream server (identical in every arm). */
export function upstreamCommand(workload: Workload, paths: RunPaths, latencyMs = DEFAULT_LATENCY_MS): string[] {
  if (workload === "mock") {
    return [process.execPath, ...tsxImport(), MOCK_SERVER, "--seed", String(EVAL_SEED), "--latency", String(latencyMs), "--write-log", paths.writeLog, "--tools", "real"];
  }
  return [process.execPath, EVERYTHING_SERVER, "stdio"];
}

/** The proxy part of the command: the ONLY thing that differs between arms. */
export function proxyArgs(arm: PlainArm, workload: Workload, paths: RunPaths): string[] {
  if (arm === "P") return [...tsxImport(), PASSTHROUGH, "--"];
  const serve = [...tsxImport(), CLI_SOURCE, "serve", "--in", paths.typegenDir, "--name", SCHEMA_NAME[workload]];
  return arm === "S2" ? [...serve, "--declare-schemas", "--"] : [...serve, "--"];
}

export function serverSpec(arm: PlainArm, workload: Workload, paths: RunPaths, latencyMs = DEFAULT_LATENCY_MS): ServerSpec {
  return { name: MCP_NAME[workload], command: process.execPath, args: [...proxyArgs(arm, workload, paths), ...upstreamCommand(workload, paths, latencyMs)] };
}

/** Claude Code tool names of a workload: mcp__<server>__<tool>. */
export const claudeToolNames = (workload: Workload): string[] => WORKLOAD_TOOLS[workload].map((t) => `mcp__${MCP_NAME[workload]}__${t}`);

/** The `--mcp-config` file for claude -p (one stdio server). */
export function claudeMcpConfig(server: ServerSpec): { mcpServers: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> } {
  return { mcpServers: { [server.name]: { type: "stdio", command: server.command, args: server.args, env: {} } } };
}

/** A TOML string for a `-c key=value` override: a literal string when possible (no escapes needed), else a basic one. */
export function tomlString(s: string): string {
  if (!/['\r\n]/.test(s)) return `'${s}'`;
  return JSON.stringify(s); // JSON string escapes are valid TOML basic-string escapes
}

/**
 * Codex approval mode for THIS server's tools only (docs: developers.openai.com/codex/mcp, `default_tools_approval_mode`;
 * values auto | prompt | writes | approve). Needed because in `codex exec` an MCP tool call otherwise needs an approval
 * nobody can give ("MCP tool call requires approval, but approval policy is never", seen in the first smoke run).
 * Scoped to the one server key, so it is not a global bypass; the sandbox is not touched. Same value in every arm.
 */
export const CODEX_MCP_APPROVAL_MODE = "approve";

/** Codex `-c` overrides that define the server for this run only (nothing is written to CODEX_HOME). */
export function codexMcpOverrides(server: ServerSpec, timeouts = { startupSec: 60, toolSec: 120 }): string[] {
  const key = `mcp_servers.${server.name}`;
  return [
    "-c", `${key}.command=${tomlString(server.command)}`,
    "-c", `${key}.args=[${server.args.map(tomlString).join(", ")}]`,
    "-c", `${key}.startup_timeout_sec=${timeouts.startupSec}`,
    "-c", `${key}.tool_timeout_sec=${timeouts.toolSec}`,
    "-c", `${key}.default_tools_approval_mode="${CODEX_MCP_APPROVAL_MODE}"`,
  ];
}
