// The model backend interface (BENCHMARK.md "Backends"). A backend answers ONE model turn: the
// harness keeps the whole conversation itself and re-sends it every turn, so no backend keeps state.

import type { Reply } from "../harness/protocol.js";

/** How the model must reply: `fenced` = a ts block or a FINAL: line (all backends but codex); `json-envelope` = Codex's --output-schema JSON. */
export type ReplyFormat = "fenced" | "json-envelope";

export interface Usage {
  /** Uncached input tokens. */
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** Codex only: reasoning tokens (part of the output). */
  reasoning_output_tokens?: number;
}

export interface ModelRequest {
  /** Pinned model ID (never an alias), or undefined for the backend's default model. */
  model?: string;
  system: string;
  /** The whole conversation so far, rendered as one prompt (bench/harness/prompt.ts). */
  prompt: string;
}

export interface ModelReply {
  text: string;
  usage: Usage;
  latencyMs: number;
  /** Set by a backend that already converted the reply to the internal type (Codex envelope); the runner then does not parse `text`. */
  parsed?: Reply;
  /** Everything the CLI returned, stored per turn so usage field names can be checked later. */
  raw: unknown;
}

export interface ModelBackend {
  readonly name: string;
  /** Paid backends must refuse to run while a price in bench/prices.json is null. */
  readonly paid: boolean;
  /** Default `fenced`. Decides the reply-format paragraph of the system prompt and the malformed-reply reminder. */
  readonly replyFormat?: ReplyFormat;
  call(req: ModelRequest): Promise<ModelReply>;
}

/** Rate or usage limit: the harness sleeps and retries the same turn. */
export class RateLimitError extends Error {
  override name = "RateLimitError";
}

/** The CLI is not signed in: the harness stops (WAITING-HUMAN, see AGENTS.md). */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

/** Any other CLI failure (non-zero exit, unparsable output). */
export class BackendError extends Error {
  override name = "BackendError";
}

export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}
