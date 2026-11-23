// Dev helper for real-model checks on the subscriptions, with no API keys (AGENTS.md "Testing with a
// real model"). It reuses the benchmark backends, so the call runs exactly as in the benchmark: one CLI
// call in a fresh empty temp directory, pinned model ID.
//
//   npm run ask -- --backend codex-cli|claude-cli [--model <pinned id>] [--system <text>] "<prompt>"
//
// Log every real call in NOTES.md under "Model calls used". `--backend fake` makes no model call (tests).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBackend } from "./backends/index.js";
import { loadEnv } from "./harness/config.js";
import { NotLoggedInError, RateLimitError } from "./backends/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASK_DEFAULT_SYSTEM = "You are a helpful assistant. Answer briefly.";
const DEFAULT_MODEL: Record<string, string | undefined> = { "claude-cli": "claude-haiku-5-5", "codex-cli": undefined, fake: "fake" };

export async function ask(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { backend: { type: "string" }, model: { type: "string" }, system: { type: "string" }, raw: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const name = values.backend;
  const prompt = positionals.join(" ").trim();
  if (!name || !["claude-cli", "codex-cli", "fake"].includes(name) || prompt === "") {
    process.stderr.write('usage: npm run ask -- --backend claude-cli|codex-cli [--model <id>] [--system <text>] [--raw] "<prompt>"\n');
    return 2;
  }
  const model = values.model ?? DEFAULT_MODEL[name];
  if (model && ["haiku", "sonnet", "opus", "fable"].includes(model.toLowerCase())) {
    process.stderr.write(`ask: "${model}" is an alias; pass a pinned model ID\n`);
    return 2;
  }
  try {
    const reply = await makeBackend(name, { codexEffort: loadEnv(path.join(HERE, ".env")).BENCH_CODEX_EFFORT?.trim() || undefined }).call({ model, system: values.system ?? ASK_DEFAULT_SYSTEM, prompt });
    out(`${reply.text}\n`);
    out(`--- ${name} ${model ?? "(default model)"}: ${reply.latencyMs} ms, usage ${JSON.stringify(reply.usage)}\n`);
    if (values.raw) out(`${JSON.stringify(reply.raw, null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof NotLoggedInError) process.stderr.write(`ask: WAITING-HUMAN: ${e.message}\n`);
    else if (e instanceof RateLimitError) process.stderr.write(`ask: rate/usage limit, try later: ${e.message}\n`);
    else process.stderr.write(`ask: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ask(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
