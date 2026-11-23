// `claude-cli` backend: one `claude -p` call per model turn, on the owner's Claude subscription.
// ALL flags live in CLAUDE_CLI below. Verified in M6 (2026-11-22) against `claude --help`, `claude -p --help`
// and real calls (Claude Code 2.1.330); see NOTES.md.
import { runCli } from "./spawn.js";
import { BackendError, matchesAny, NotLoggedInError, RateLimitError, type ModelBackend, type ModelReply, type ModelRequest, type Usage } from "./types.js";

export interface ClaudeCliConfig {
  command: string;
  /** Inserted before every other argument (tests point `command` at node and this at a fake CLI script). */
  prefixArgs: string[];
  /** `-p` / `--print`: listed in --help. */
  printFlag: string;
  /** `--model <id>`: listed. Always a pinned ID (claude-haiku-5-5, claude-sonnet-5-5), never an alias. */
  modelFlag: string;
  /** `--tools ""` = no built-in tools: listed ("" for none). */
  toolsArgs: string[];
  /**
   * `--system-prompt <text>` (listed; `--system-prompt-file` is NOT a real flag). Owner decision (M6): only
   * this SHORT text goes on the command line; the benchmark instructions and the type stubs go at the top of
   * the stdin message, followed by the conversation (same layout as codex-cli).
   */
  systemPromptFlag: string;
  shortSystemPrompt: string;
  /** Line between the instructions and the conversation on stdin. */
  systemSeparator: string;
  /** `--no-session-persistence`: listed (only works with --print). */
  noSessionFlag: string;
  /** `--output-format json`: listed. */
  outputFormatArgs: string[];
  /**
   * Isolation flags, checked in M6 with the stream-json init event (see NOTES.md): `--safe-mode` (no user
   * plugins, memory, CLAUDE.md, hooks, MCP; auth works), `--disable-slash-commands` (no skills),
   * `--strict-mcp-config` (no MCP servers). Never `--bare` (it ignores the subscription login).
   */
  isolationArgs: string[];
  timeoutMs: number;
  /** How a limit or a missing login shows up: none was seen in M6 (see NOTES.md); these patterns are guesses covered by tests. */
  rateLimitPatterns: RegExp[];
  notLoggedInPatterns: RegExp[];
}

export const CLAUDE_CLI: ClaudeCliConfig = {
  command: "claude",
  prefixArgs: [],
  printFlag: "-p",
  modelFlag: "--model",
  toolsArgs: ["--tools", ""],
  systemPromptFlag: "--system-prompt",
  shortSystemPrompt: "Follow the instructions at the top of the user message exactly.",
  systemSeparator: "\n\n----- END OF INSTRUCTIONS -----\n\n",
  noSessionFlag: "--no-session-persistence",
  outputFormatArgs: ["--output-format", "json"],
  isolationArgs: ["--safe-mode", "--disable-slash-commands", "--strict-mcp-config"],
  timeoutMs: 10 * 60_000,
  rateLimitPatterns: [/usage limit/i, /rate[ _-]?limit/i, /\b429\b/, /too many requests/i, /limit reached/i],
  notLoggedInPatterns: [/not logged in/i, /please run \/login/i, /invalid api key/i, /authentication[_ ]error/i, /oauth token/i],
};

export function claudeStdin(cfg: ClaudeCliConfig, req: ModelRequest): string {
  return `${req.system}${cfg.systemSeparator}${req.prompt}`;
}

export function claudeArgs(cfg: ClaudeCliConfig, req: ModelRequest): string[] {
  const args = [...cfg.prefixArgs, cfg.printFlag];
  if (req.model) args.push(cfg.modelFlag, req.model);
  args.push(...cfg.toolsArgs);
  args.push(cfg.systemPromptFlag, cfg.shortSystemPrompt);
  args.push(cfg.noSessionFlag, ...cfg.outputFormatArgs, ...cfg.isolationArgs);
  return args;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Usage from the `--output-format json` result. Field names verified in M6. */
export function claudeUsage(json: Record<string, unknown>): Usage {
  const u = (json.usage ?? {}) as Record<string, unknown>;
  return {
    input_tokens: num(u.input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    output_tokens: num(u.output_tokens),
  };
}

export function parseClaudeOutput(cfg: ClaudeCliConfig, out: { code: number | null; stdout: string; stderr: string }): { text: string; usage: Usage; raw: unknown } {
  const all = `${out.stdout}\n${out.stderr}`;
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(out.stdout.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  const isError = json ? json.is_error === true || (typeof json.subtype === "string" && json.subtype !== "success") : out.code !== 0;
  if (!json || isError || out.code !== 0) {
    const detail = json && typeof json.result === "string" ? json.result : all;
    if (matchesAny(detail, cfg.notLoggedInPatterns)) throw new NotLoggedInError(`claude-cli is not signed in: ${detail.trim().slice(0, 300)}`);
    if (matchesAny(detail, cfg.rateLimitPatterns)) throw new RateLimitError(`claude-cli limit: ${detail.trim().slice(0, 300)}`);
    throw new BackendError(`claude-cli failed (exit ${String(out.code)}): ${detail.trim().slice(0, 500)}`);
  }
  if (typeof json.result !== "string") throw new BackendError("claude-cli: the JSON output has no string `result`");
  return { text: json.result, usage: claudeUsage(json), raw: json };
}

export function claudeCliBackend(cfg: ClaudeCliConfig = CLAUDE_CLI): ModelBackend {
  return {
    name: "claude-cli",
    paid: false,
    async call(req: ModelRequest): Promise<ModelReply> {
      const r = await runCli({
        command: cfg.command,
        args: () => claudeArgs(cfg, req),
        stdin: claudeStdin(cfg, req),
        timeoutMs: cfg.timeoutMs,
      });
      if (r.timedOut) throw new BackendError(`claude-cli timed out after ${cfg.timeoutMs} ms`);
      const parsed = parseClaudeOutput(cfg, r);
      return { ...parsed, latencyMs: r.latencyMs, raw: { output: parsed.raw, stderr: r.stderr || undefined, cwdWasEmpty: r.cwdWasEmpty } };
    },
  };
}
