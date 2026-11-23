// The two ordinary MCP clients of the plain-MCP test, plus a fake one for tests and --dry-run.
// One RUN = one client invocation: the client starts the MCP server itself (the arm's command), calls the
// tools natively and answers. Every invocation gets a fresh EMPTY temp cwd (bench/backends/spawn.ts), API key
// variables are removed from its environment, and nothing is written to the CLIs' own config folders.
//
// claude: claude -p --model <id> --tools "" --mcp-config <file> --strict-mcp-config --allowedTools <the
//   server's tools> --permission-prompts none --disable-slash-commands --setting-sources project,local
//   --no-session-persistence --output-format stream-json --verbose   (prompt on stdin; never --bare)
//   NOT --safe-mode: its --help says it disables MCP servers. stream-json (one JSON event per line; the last,
//   `result`, is the same object as --output-format json) is used because it is the only output that shows
//   which assistant message made which tool call, i.e. the tool-call rounds of Amendment 3.
// codex: codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only -m <id>
//   -c model_reasoning_effort=<e> --ignore-user-config --disable apps ... -c approval_policy="never"
//   -c mcp_servers.<name>.command=... -c mcp_servers.<name>.args=[...] -c mcp_servers.<name>.default_tools_approval_mode="approve"
//   -o <file> -   (no --output-schema). The approval mode is per server (not a global bypass), same in every arm.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_CLI, claudeUsage } from "../backends/claude-cli.js";
import { CODEX_CLI, parseCodexOutput } from "../backends/codex-cli.js";
import { runCli, type CliResult } from "../backends/spawn.js";
import { BackendError, matchesAny, NotLoggedInError, RateLimitError, type Usage } from "../backends/types.js";
import { claudeMcpConfig, codexMcpOverrides, type ServerSpec } from "./config.js";

export type ClientName = "claude-cli" | "codex-cli" | "fake";
/** Which parser reads the output: claude's stream-json, or codex's --json events. */
export type OutputFormat = "claude-stream" | "codex-json";

export interface ClientRequest {
  model?: string;
  prompt: string;
  server: ServerSpec;
  /** Exactly the tools the client may call (claude: mcp__<server>__<tool>). */
  allowedTools: string[];
  /** Per-run folder outside the cwd (MCP config file, last-message file). */
  runDir: string;
  /** Fake client only: which scripted solver to run. */
  taskId?: string;
}

export interface ClientOutput extends Pick<CliResult, "code" | "stdout" | "stderr" | "latencyMs" | "timedOut" | "cwdWasEmpty"> {
  /** codex -o file. */
  lastMessage?: string;
}

export interface PlainClient {
  readonly name: ClientName;
  readonly format: OutputFormat;
  run(req: ClientRequest): Promise<ClientOutput>;
}

// ---------------------------------------------------------------- claude

export interface ClaudePlainConfig {
  command: string;
  prefixArgs: string[];
  /** Isolation without --safe-mode (which would drop the MCP server). Checked on the smoke run via the init event. */
  isolationArgs: string[];
  outputArgs: string[];
  /** Claude Code's MCP start-up timeout (ms), via the MCP_TIMEOUT environment variable. */
  mcpTimeoutMs: number;
  timeoutMs: number;
}

export const CLAUDE_PLAIN: ClaudePlainConfig = {
  command: CLAUDE_CLI.command,
  prefixArgs: [],
  isolationArgs: ["--strict-mcp-config", "--permission-prompts", "none", "--disable-slash-commands", "--setting-sources", "project,local", "--no-session-persistence"],
  outputArgs: ["--output-format", "stream-json", "--verbose"],
  mcpTimeoutMs: 60_000,
  timeoutMs: 15 * 60_000,
};

export const MCP_CONFIG_FILE = "mcp-config.json";

export function claudePlainArgs(cfg: ClaudePlainConfig, req: ClientRequest): string[] {
  const args = [...cfg.prefixArgs, CLAUDE_CLI.printFlag];
  if (req.model) args.push(CLAUDE_CLI.modelFlag, req.model);
  args.push(...CLAUDE_CLI.toolsArgs); // --tools "": no built-in tools; MCP tools are separate
  args.push("--mcp-config", path.join(req.runDir, MCP_CONFIG_FILE));
  args.push("--allowedTools", req.allowedTools.join(","));
  args.push(...cfg.isolationArgs, ...cfg.outputArgs);
  return args;
}

export function claudePlainClient(cfg: ClaudePlainConfig = CLAUDE_PLAIN): PlainClient {
  return {
    name: "claude-cli",
    format: "claude-stream",
    async run(req) {
      writeFileSync(path.join(req.runDir, MCP_CONFIG_FILE), `${JSON.stringify(claudeMcpConfig(req.server), null, 2)}\n`);
      const r = await runCli({
        command: cfg.command,
        args: () => claudePlainArgs(cfg, req),
        stdin: req.prompt,
        timeoutMs: cfg.timeoutMs,
        env: { MCP_TIMEOUT: String(cfg.mcpTimeoutMs) },
      });
      return r;
    },
  };
}

// ---------------------------------------------------------------- codex

export interface CodexPlainConfig {
  command: string;
  prefixArgs: string[];
  effort: string;
  /** Default read-only (as in the Code Mode benchmark). A lever if the smoke shows the sandbox blocks the MCP server. */
  sandbox: string;
  /** Extra writable directory for the sandbox (e.g. the run folder); none by default. */
  addDir?: string;
  timeoutMs: number;
}

export const CODEX_PLAIN: CodexPlainConfig = { command: CODEX_CLI.command, prefixArgs: [], effort: CODEX_CLI.effort, sandbox: "read-only", timeoutMs: 15 * 60_000 };
export const LAST_MESSAGE_FILE = "last-message.txt";

export function codexPlainArgs(cfg: CodexPlainConfig, req: ClientRequest): string[] {
  // CODEX_CLI.execArgs = exec --json --ephemeral --skip-git-repo-check --sandbox read-only; the sandbox value is ours.
  const exec = [...CODEX_CLI.execArgs];
  const s = exec.indexOf("--sandbox");
  if (s !== -1) exec[s + 1] = cfg.sandbox;
  const args = [...cfg.prefixArgs, ...exec];
  if (cfg.addDir) args.push("--add-dir", cfg.addDir);
  if (req.model) args.push(CODEX_CLI.modelFlag, req.model);
  if (cfg.effort) args.push("-c", `model_reasoning_effort=${cfg.effort}`);
  args.push(...CODEX_CLI.isolationArgs);
  args.push("-c", 'approval_policy="never"');
  args.push(...codexMcpOverrides(req.server));
  args.push(CODEX_CLI.lastMessageFlag, path.join(req.runDir, LAST_MESSAGE_FILE), CODEX_CLI.stdinArg);
  return args;
}

export function codexPlainClient(cfg: CodexPlainConfig = CODEX_PLAIN): PlainClient {
  return {
    name: "codex-cli",
    format: "codex-json",
    async run(req) {
      const r = await runCli({ command: cfg.command, args: () => codexPlainArgs(cfg, req), stdin: req.prompt, timeoutMs: cfg.timeoutMs });
      let lastMessage: string | undefined;
      try {
        lastMessage = readFileSync(path.join(req.runDir, LAST_MESSAGE_FILE), "utf8");
      } catch {
        lastMessage = undefined;
      }
      return { ...r, lastMessage };
    },
  };
}

// ---------------------------------------------------------------- parsing

export interface ParsedRun {
  /** The final reply text (claude `result`, codex last agent message); the FINAL line is extracted later. */
  text: string | undefined;
  usage: Required<Pick<Usage, "input_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens" | "output_tokens">> & { reasoning_output_tokens: number };
  /** Amendment 3 turns = tool-call rounds (see parseClaudeStream / parseCodexEvents). */
  rounds: number;
  toolCalls: number;
  toolErrors: number;
  /** Calls by tool name (as the client names them). */
  toolsCalled: Record<string, number>;
  /** Codex shell commands (should be 0: the prompt says not to run commands). */
  shellCalls: number;
  /** claude `num_turns` (model requests in its loop); undefined for codex. */
  numTurns?: number;
  /** A client-side end other than a normal answer (e.g. claude `error_max_turns`); the run is graded as it stands. */
  clientError?: string;
  /** claude init event: the MCP servers and their status, the tools the model was offered. */
  mcpServers?: { name: string; status: string }[];
  offeredTools?: string[];
  /** claude only: whether usage.output_tokens equals the sum of modelUsage outputTokens (a cross-check). */
  usageCrossCheck?: { modelUsageOutput: number; matches: boolean };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const o = obj(JSON.parse(line));
      if (o) out.push(o);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/**
 * claude -p stream-json. Rounds = distinct assistant message ids with at least one tool_use block (Claude Code
 * may emit one message as several events with the same id, so ids are counted, not events). Tool calls =
 * distinct tool_use ids. Limit and login errors throw (the runner sleeps / stops); any other error result is
 * kept as `clientError` and graded like any run. No result event at all = BackendError.
 */
export function parseClaudeStream(out: Pick<ClientOutput, "code" | "stdout" | "stderr">): ParsedRun {
  const events = jsonLines(out.stdout);
  const result = events.filter((e) => e.type === "result").at(-1);
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const detailOf = (r: Record<string, unknown> | undefined): string => `${typeof r?.result === "string" ? r.result : ""}\n${JSON.stringify(r?.errors ?? "")}\n${out.stderr}`;
  if (!result) {
    const detail = `${out.stderr}\n${out.stdout.slice(-2000)}`;
    if (matchesAny(detail, CLAUDE_CLI.notLoggedInPatterns)) throw new NotLoggedInError(`claude-cli is not signed in: ${detail.trim().slice(0, 300)}`);
    if (matchesAny(detail, CLAUDE_CLI.rateLimitPatterns)) throw new RateLimitError(`claude-cli limit: ${detail.trim().slice(0, 300)}`);
    throw new BackendError(`claude-cli gave no result event (exit ${String(out.code)}): ${detail.trim().slice(0, 500)}`);
  }
  const failed = result.is_error === true || result.subtype !== "success";
  if (failed) {
    const detail = detailOf(result);
    if (matchesAny(detail, CLAUDE_CLI.notLoggedInPatterns)) throw new NotLoggedInError(`claude-cli is not signed in: ${detail.trim().slice(0, 300)}`);
    if (matchesAny(detail, CLAUDE_CLI.rateLimitPatterns)) throw new RateLimitError(`claude-cli limit: ${detail.trim().slice(0, 300)}`);
  }
  const roundIds = new Set<string>();
  const toolIds = new Set<string>();
  const toolsCalled: Record<string, number> = {};
  let anon = 0;
  let toolErrors = 0;
  for (const e of events) {
    const msg = obj(e.message);
    const content = Array.isArray(msg?.content) ? (msg?.content as unknown[]) : [];
    if (e.type === "assistant") {
      const uses = content.map(obj).filter((c) => c?.type === "tool_use") as Record<string, unknown>[];
      if (uses.length === 0) continue;
      roundIds.add(typeof msg?.id === "string" ? msg.id : `anon-${anon++}`);
      for (const u of uses) {
        const id = typeof u.id === "string" ? u.id : `anon-${anon++}`;
        if (toolIds.has(id)) continue;
        toolIds.add(id);
        const name = typeof u.name === "string" ? u.name : "?";
        toolsCalled[name] = (toolsCalled[name] ?? 0) + 1;
      }
    } else if (e.type === "user") {
      toolErrors += content.map(obj).filter((c) => c?.type === "tool_result" && c.is_error === true).length;
    }
  }
  const u = claudeUsage(result);
  const modelUsage = obj(result.modelUsage);
  const modelUsageOutput = modelUsage ? Object.values(modelUsage).reduce<number>((a, m) => a + num(obj(m)?.outputTokens), 0) : undefined;
  const mcp = Array.isArray(init?.mcp_servers) ? (init?.mcp_servers as unknown[]).map(obj).filter((m): m is Record<string, unknown> => m !== undefined) : undefined;
  return {
    text: typeof result.result === "string" ? result.result : undefined,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      reasoning_output_tokens: 0,
    },
    rounds: roundIds.size,
    toolCalls: toolIds.size,
    toolErrors,
    toolsCalled,
    shellCalls: 0,
    numTurns: typeof result.num_turns === "number" ? result.num_turns : undefined,
    ...(failed ? { clientError: `${String(result.subtype)}${typeof result.result === "string" ? `: ${result.result.slice(0, 300)}` : ""}` } : {}),
    ...(mcp ? { mcpServers: mcp.map((m) => ({ name: String(m.name), status: String(m.status) })) } : {}),
    ...(Array.isArray(init?.tools) ? { offeredTools: (init?.tools as unknown[]).map(String) } : {}),
    ...(modelUsageOutput !== undefined ? { usageCrossCheck: { modelUsageOutput, matches: modelUsageOutput === (u.output_tokens ?? 0) } } : {}),
  };
}

/**
 * codex exec --json (errors, limits, login and usage via the existing parseCodexOutput). Rounds = groups of
 * consecutive completed `mcp_tool_call` items: Codex does not mark which calls share one model request, so any
 * other completed item (reasoning, agent_message, command_execution) between two calls starts a new round.
 */
export function parseCodexEvents(out: ClientOutput): ParsedRun {
  const parsed = parseCodexOutput(CODEX_CLI, out, out.lastMessage);
  const events = parsed.raw as Record<string, unknown>[];
  let rounds = 0;
  let inGroup = false;
  let toolCalls = 0;
  let toolErrors = 0;
  let shellCalls = 0;
  const toolsCalled: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "item.completed") continue;
    const item = obj(e.item);
    if (!item) continue;
    if (item.type === "mcp_tool_call") {
      if (!inGroup) rounds += 1;
      inGroup = true;
      toolCalls += 1;
      const name = `${String(item.server ?? "?")}/${String(item.tool ?? "?")}`;
      toolsCalled[name] = (toolsCalled[name] ?? 0) + 1;
      if (item.status === "failed" || (item.error !== undefined && item.error !== null) || obj(item.result)?.isError === true) toolErrors += 1;
    } else {
      inGroup = false;
      if (item.type === "command_execution") shellCalls += 1;
    }
  }
  const u = parsed.usage;
  return {
    text: parsed.text,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      reasoning_output_tokens: u.reasoning_output_tokens ?? 0,
    },
    rounds,
    toolCalls,
    toolErrors,
    toolsCalled,
    shellCalls,
  };
}

export function parseClientOutput(format: OutputFormat, out: ClientOutput): ParsedRun {
  return format === "claude-stream" ? parseClaudeStream(out) : parseCodexEvents(out);
}

// ---------------------------------------------------------------- fake

/** A scripted solver: calls tools through `call` (results already unwrapped) and returns the final answer. */
export type FakeSolver = (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<string>;

export interface FakeClientOptions {
  solvers: Record<string, FakeSolver>;
  /** Errors to throw instead of running, one per call (e.g. a RateLimitError), then normal runs. */
  failures?: Error[];
  onRun?: (req: ClientRequest) => void;
}

/**
 * Fake client (tests, --dry-run; no model): starts the arm's MCP server command exactly as a real client would,
 * runs the task's scripted solver over it with the SDK client, and prints claude-style stream-json, so the
 * whole chain (proxy, serve, mock, write log, parser, grader) runs for real. Its extra `fake` field on the
 * result event counts results that came with structuredContent. Token numbers are synthetic.
 */
export function fakePlainClient(opts: FakeClientOptions): PlainClient {
  const failures = [...(opts.failures ?? [])];
  return {
    name: "fake",
    format: "claude-stream",
    async run(req) {
      opts.onRun?.(req);
      const failure = failures.shift();
      if (failure) throw failure;
      const started = Date.now();
      const solver = opts.solvers[req.taskId ?? ""];
      if (!solver) throw new BackendError(`fake client: no solver for task ${String(req.taskId)}`);
      const client = new Client({ name: "plain-mcp-fake", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: req.server.command, args: req.server.args, stderr: "ignore", cwd: req.runDir }));
      const lines: unknown[] = [];
      let calls = 0;
      let structured = 0;
      try {
        const { tools } = await client.listTools();
        lines.push({ type: "system", subtype: "init", tools: tools.map((t) => `mcp__${req.server.name}__${t.name}`), mcp_servers: [{ name: req.server.name, status: "connected" }], model: req.model ?? "fake" });
        const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
          calls += 1;
          const id = `toolu_${calls}`;
          lines.push({ type: "assistant", message: { id: `msg_${calls}`, content: [{ type: "tool_use", id, name: `mcp__${req.server.name}__${name}`, input: args }] } });
          const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
          const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
          lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: r.isError === true }] } });
          if (r.isError) throw new Error(`${name} failed: ${text}`);
          if (r.structuredContent !== undefined) {
            structured += 1;
            return r.structuredContent;
          }
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        };
        const answer = await solver(call);
        const text = `Done.\nFINAL: ${answer}`;
        lines.push({ type: "assistant", message: { id: `msg_${calls + 1}`, content: [{ type: "text", text }] } });
        const output = 20 * calls + 10;
        lines.push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: text,
          num_turns: calls + 1,
          usage: { input_tokens: 5, cache_creation_input_tokens: 100 * (calls + 1), cache_read_input_tokens: 0, output_tokens: output },
          modelUsage: { [req.model ?? "fake"]: { outputTokens: output } },
          fake: { structuredResults: structured, toolCalls: calls },
        });
      } finally {
        await client.close();
      }
      return { code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "", latencyMs: Date.now() - started, timedOut: false, cwdWasEmpty: true };
    },
  };
}
