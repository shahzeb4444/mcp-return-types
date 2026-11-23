// Backend registry. `fake` is for tests and --dry-run only; `ollama` (optional) is not built yet.
import { claudeCliBackend } from "./claude-cli.js";
import { CODEX_CLI, codexCliBackend } from "./codex-cli.js";
import { dryRunPolicy, fakeBackend } from "./fake.js";
import type { ModelBackend } from "./types.js";

export const BACKEND_NAMES = ["claude-cli", "codex-cli", "fake"] as const;

export interface BackendOptions {
  /** BENCH_CODEX_EFFORT (low|medium|high); default medium. */
  codexEffort?: string;
}

export function makeBackend(name: string, opts: BackendOptions = {}): ModelBackend {
  switch (name) {
    case "claude-cli":
      return claudeCliBackend();
    case "codex-cli":
      return codexCliBackend({ ...CODEX_CLI, effort: opts.codexEffort ?? CODEX_CLI.effort });
    case "fake":
      return fakeBackend(dryRunPolicy);
    default:
      throw new Error(`unknown backend "${name}" (known: ${BACKEND_NAMES.join(", ")})`);
  }
}
