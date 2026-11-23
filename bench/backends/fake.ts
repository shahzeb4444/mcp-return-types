// `fake` backend for tests and `--dry-run`: no model, no CLI, no subscription use. A policy decides the
// reply from the request; usage is a rough characters/4 estimate so the logs have numbers in them.
import type { ModelBackend, ModelReply, ModelRequest } from "./types.js";

/** Returns the reply text, or throws (e.g. a RateLimitError) to simulate a CLI failure. */
export type FakePolicy = (req: ModelRequest, callIndex: number) => string | Promise<string>;

export interface FakeBackend extends ModelBackend {
  readonly requests: ModelRequest[];
}

const est = (s: string): number => Math.ceil(s.length / 4);

export function fakeBackend(policy: FakePolicy, name = "fake"): FakeBackend {
  const requests: ModelRequest[] = [];
  return {
    name,
    paid: false,
    requests,
    async call(req: ModelRequest): Promise<ModelReply> {
      requests.push(req);
      const text = await policy(req, requests.length - 1);
      return {
        text,
        usage: { input_tokens: est(req.system) + est(req.prompt), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: est(text) },
        latencyMs: 0,
        raw: { fake: true, model: req.model ?? null },
      };
    },
  };
}

/** A fixed list of replies; the n-th call gets the n-th reply (the last one repeats). */
export const scripted = (replies: string[]): FakePolicy => (_req, i) => replies[Math.min(i, replies.length - 1)] ?? "FINAL: none";

/**
 * The `--dry-run` policy. It never solves a task; it walks the protocol paths once per run:
 * a malformed reply, then code that calls a tool and returns a count, then a FINAL line. It keys on the
 * number of turns in the rendered conversation, so every run behaves the same.
 */
export const dryRunPolicy: FakePolicy = (req) => {
  // The rendered conversation ends with an open "### assistant" heading; the others are earlier replies.
  const turns = (req.prompt.match(/^### assistant$/gm) ?? []).length - 1;
  if (turns <= 0) return "Let me think about this first.";
  if (turns === 1) {
    return [
      "```ts",
      'const page = await tools.list_issues({ repo: "acme/api", state: "open" }) as any;',
      'console.log("first page items:", Array.isArray(page?.items) ? page.items.length : typeof page);',
      "return { next_page: page?.next_page ?? null };",
      "```",
    ].join("\n");
  }
  return "FINAL: 0";
};
