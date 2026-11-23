// `codex-cli` backend: one `codex exec` call per model turn, on the owner's ChatGPT login.
// Every flag and output field below was verified in M6 (2026-11-22, Codex 0.171.0) with `codex exec --help`
// and real calls; see NOTES.md. This object is the only place the flags live.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvelope } from "../harness/protocol.js";
import { runCli } from "./spawn.js";
import { BackendError, matchesAny, NotLoggedInError, RateLimitError, type ModelBackend, type ModelReply, type ModelRequest, type Usage } from "./types.js";

export interface CodexCliConfig {
  command: string;
  /** Inserted before every other argument (tests). */
  prefixArgs: string[];
  /** `exec --json --ephemeral --skip-git-repo-check --sandbox read-only`: all listed in `codex exec --help`. */
  execArgs: string[];
  /** `-m <model>`: listed; omitted when no model is set (Codex default). */
  modelFlag: string;
  /** `-c model_reasoning_effort=<low|medium|high>` (`-c key=value` is listed). From BENCH_CODEX_EFFORT; default medium. */
  effort: string;
  /** `--output-schema <FILE>` (listed in `codex exec --help`): the JSON envelope the final message must follow. */
  outputSchemaFlag: string;
  /** Absolute path of the schema file (bench/harness/codex-envelope.schema.json); the call's cwd is an empty temp dir. */
  outputSchemaPath: string;
  /** `-o <file>` writes the last agent message to a file: listed. */
  lastMessageFlag: string;
  /** `-` = read the prompt from stdin: listed. */
  stdinArg: string;
  /**
   * codex exec has no system-prompt flag, so the system prompt is sent at the top of the stdin prompt,
   * separated by this line (the same layout as claude-cli, so C and D stay comparable).
   */
  systemSeparator: string;
  /**
   * `--ignore-user-config` (no config.toml: user plugins' skills, project trust entries; auth still works)
   * plus `--disable <feature>` for the account-level connectors (the `canva` etc. apps) and tools the
   * benchmark does not need. Checked in M6 by asking the model to list its tools (see NOTES.md).
   */
  isolationArgs: string[];
  timeoutMs: number;
  rateLimitPatterns: RegExp[];
  notLoggedInPatterns: RegExp[];
}

export const CODEX_CLI: CodexCliConfig = {
  command: "codex",
  prefixArgs: [],
  execArgs: ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only"],
  modelFlag: "-m",
  effort: "medium",
  outputSchemaFlag: "--output-schema",
  outputSchemaPath: fileURLToPath(new URL("../harness/codex-envelope.schema.json", import.meta.url)),
  lastMessageFlag: "-o",
  stdinArg: "-",
  systemSeparator: "\n\n----- END OF INSTRUCTIONS -----\n\n",
  isolationArgs: [
    "--ignore-user-config",
    ...["apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent"].flatMap((f) => ["--disable", f]),
  ],
  timeoutMs: 10 * 60_000,
  rateLimitPatterns: [/usage limit/i, /rate[ _-]?limit/i, /\b429\b/, /too many requests/i, /hit your .*limit/i, /quota/i],
  notLoggedInPatterns: [/not logged in/i, /codex login/i, /unauthorized/i, /\b401\b/],
};

const LAST_MESSAGE_FILE = "last-message.txt";

export function codexArgs(cfg: CodexCliConfig, req: ModelRequest, filesDir: string): string[] {
  const args = [...cfg.prefixArgs, ...cfg.execArgs];
  if (req.model) args.push(cfg.modelFlag, req.model);
  if (cfg.effort) args.push("-c", `model_reasoning_effort=${cfg.effort}`);
  args.push(...cfg.isolationArgs, cfg.outputSchemaFlag, cfg.outputSchemaPath, cfg.lastMessageFlag, path.join(filesDir, LAST_MESSAGE_FILE), cfg.stdinArg);
  return args;
}

export function codexStdin(cfg: CodexCliConfig, req: ModelRequest): string {
  return `${req.system}${cfg.systemSeparator}${req.prompt}`;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Parse the `--json` event stream (verified: thread.started, turn.started, item.completed, turn.completed; failures: error, turn.failed). */
export function parseCodexOutput(
  cfg: CodexCliConfig,
  out: { code: number | null; stdout: string; stderr: string },
  lastMessage: string | undefined,
): { text: string; usage: Usage; raw: unknown } {
  const events: Record<string, unknown>[] = [];
  for (const line of out.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const e: unknown = JSON.parse(line);
      if (e && typeof e === "object" && !Array.isArray(e)) events.push(e as Record<string, unknown>);
    } catch {
      /* non-JSON noise */
    }
  }
  const errors = events
    .filter((e) => e.type === "error" || e.type === "turn.failed")
    .map((e) => JSON.stringify(e.message ?? e.error ?? e));
  const detail = [...errors, out.stderr].join("\n");
  let text = lastMessage?.replace(/\r?\n$/, "");
  if (text === undefined || text === "") {
    for (const e of events) {
      const item = e.item as Record<string, unknown> | undefined;
      if (e.type === "item.completed" && item && (item.type === "agent_message" || item.item_type === "assistant_message") && typeof item.text === "string") {
        text = item.text;
      }
    }
  }
  if (out.code !== 0 || errors.length > 0 || text === undefined) {
    if (matchesAny(detail, cfg.notLoggedInPatterns)) throw new NotLoggedInError(`codex-cli is not signed in: ${detail.trim().slice(0, 300)}`);
    if (matchesAny(detail, cfg.rateLimitPatterns)) throw new RateLimitError(`codex-cli limit: ${detail.trim().slice(0, 300)}`);
    throw new BackendError(`codex-cli failed (exit ${String(out.code)}): ${detail.trim().slice(0, 500) || "no agent message"}`);
  }
  const completed = events.filter((e) => e.type === "turn.completed").at(-1);
  const u = (completed?.usage ?? {}) as Record<string, unknown>;
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens);
  const usage: Usage = {
    // Codex reports cached tokens as part of input_tokens (verified in M6: cached_input_tokens <= input_tokens); store the uncached part.
    input_tokens: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
    cache_read_input_tokens: cached,
    output_tokens: num(u.output_tokens),
    reasoning_output_tokens: num(u.reasoning_output_tokens),
  };
  return { text, usage, raw: events };
}

export function codexCliBackend(cfg: CodexCliConfig = CODEX_CLI): ModelBackend {
  return {
    name: "codex-cli",
    paid: false,
    replyFormat: "json-envelope",
    async call(req: ModelRequest): Promise<ModelReply> {
      const r = await runCli({
        command: cfg.command,
        args: (filesDir) => codexArgs(cfg, req, filesDir),
        stdin: codexStdin(cfg, req),
        readBack: [LAST_MESSAGE_FILE],
        timeoutMs: cfg.timeoutMs,
      });
      if (r.timedOut) throw new BackendError(`codex-cli timed out after ${cfg.timeoutMs} ms`);
      const parsed = parseCodexOutput(cfg, r, r.readBack[LAST_MESSAGE_FILE]);
      return { text: parsed.text, usage: parsed.usage, parsed: parseEnvelope(parsed.text), latencyMs: r.latencyMs, raw: { events: parsed.raw, stderr: r.stderr || undefined, cwdWasEmpty: r.cwdWasEmpty } };
    },
  };
}
