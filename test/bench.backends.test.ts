// Backend tests WITHOUT any model call: the CLI is test/fixtures/fake-cli.mjs run by node, with the
// backend's real argument building, temp-dir handling and output parsing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ask } from "../bench/ask.js";
import { CLAUDE_CLI, claudeArgs, claudeCliBackend, type ClaudeCliConfig } from "../bench/backends/claude-cli.js";
import { CODEX_CLI, codexArgs, codexCliBackend, parseCodexOutput, type CodexCliConfig } from "../bench/backends/codex-cli.js";
import { fakeBackend, scripted } from "../bench/backends/fake.js";
import { BackendError, NotLoggedInError, RateLimitError } from "../bench/backends/types.js";
import { benchConfig, loadEnv, nullPrices, parseEnvFile, weakModel } from "../bench/harness/config.js";
import { ROOT } from "./helpers.js";

const FAKE_CLI = path.join(ROOT, "test", "fixtures", "fake-cli.mjs");
const claudeWith = (mode: string): ClaudeCliConfig => ({ ...CLAUDE_CLI, command: process.execPath, prefixArgs: [FAKE_CLI, mode], timeoutMs: 20_000 });
const codexWith = (mode: string): CodexCliConfig => ({ ...CODEX_CLI, command: process.execPath, prefixArgs: [FAKE_CLI, mode], timeoutMs: 20_000 });
const req = { model: "claude-haiku-5-5", system: "SYSTEM TEXT\nline 2", prompt: "### user\nhello\n\n### assistant\n" };

describe("claude-cli backend", () => {
  it("builds the verified command: short system prompt, isolation flags, never --bare", () => {
    expect(claudeArgs(CLAUDE_CLI, req)).toEqual([
      "-p", "--model", "claude-haiku-5-5", "--tools", "", "--system-prompt", CLAUDE_CLI.shortSystemPrompt,
      "--no-session-persistence", "--output-format", "json", "--safe-mode", "--disable-slash-commands", "--strict-mcp-config",
    ]);
    expect(claudeArgs(CLAUDE_CLI, req)).not.toContain("--bare");
    expect(claudeArgs(CLAUDE_CLI, req)).not.toContain("--system-prompt-file");
    expect(claudeArgs(CLAUDE_CLI, req).join(" ")).not.toContain("SYSTEM TEXT");
  });

  it("runs in an empty temp dir, sends instructions + conversation on stdin, parses result and usage", async () => {
    const reply = await claudeCliBackend(claudeWith("claude-ok")).call(req);
    const seen = JSON.parse(reply.text) as { args: string[]; cwdEntries: string[]; stdin: string };
    expect(seen.cwdEntries).toEqual([]);
    expect(seen.stdin).toBe(`${req.system}${CLAUDE_CLI.systemSeparator}${req.prompt}`);
    expect(seen.args).toContain("--tools");
    expect(seen.args[seen.args.indexOf("--tools") + 1]).toBe("");
    expect(seen.args).toContain("claude-haiku-5-5");
    expect(reply.usage).toEqual({ input_tokens: 11, cache_creation_input_tokens: 22, cache_read_input_tokens: 33, output_tokens: 44 });
    expect((reply.raw as { cwdWasEmpty: boolean }).cwdWasEmpty).toBe(true);
  });

  it("classifies a usage limit, a missing login and garbage output", async () => {
    await expect(claudeCliBackend(claudeWith("claude-limit")).call(req)).rejects.toBeInstanceOf(RateLimitError);
    await expect(claudeCliBackend(claudeWith("claude-login")).call(req)).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(claudeCliBackend(claudeWith("claude-garbage")).call(req)).rejects.toBeInstanceOf(BackendError);
  });
});

describe("codex-cli backend", () => {
  it("builds the verified command: isolation, effort, model, prompt on stdin with '-'", () => {
    const iso = CODEX_CLI.isolationArgs;
    expect(iso).toContain("--ignore-user-config");
    expect(codexArgs(CODEX_CLI, { ...req, model: undefined }, "F")).toEqual([
      "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "model_reasoning_effort=medium",
      ...iso, "--output-schema", CODEX_CLI.outputSchemaPath, "-o", path.join("F", "last-message.txt"), "-",
    ]);
    expect(codexArgs(CODEX_CLI, { ...req, model: "m1" }, "F").slice(6, 8)).toEqual(["-m", "m1"]);
    expect(codexArgs({ ...CODEX_CLI, effort: "high" }, req, "F")).toContain("model_reasoning_effort=high");
  });

  it("reads the -o last message, the stream usage, and sends system + prompt on stdin", async () => {
    const reply = await codexCliBackend(codexWith("codex-ok")).call({ ...req, model: undefined });
    const seen = JSON.parse(reply.text) as { cwdEntries: string[]; stdin: string };
    expect(seen.cwdEntries).toEqual([]);
    expect(seen.stdin).toBe(`${req.system}${CODEX_CLI.systemSeparator}${req.prompt}`);
    expect(reply.usage).toEqual({ input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 });
  });

  it("passes the committed envelope schema, exactly as the owner specified", () => {
    expect(path.isAbsolute(CODEX_CLI.outputSchemaPath)).toBe(true);
    expect(path.basename(CODEX_CLI.outputSchemaPath)).toBe("codex-envelope.schema.json");
    expect(JSON.parse(readFileSync(CODEX_CLI.outputSchemaPath, "utf8"))).toEqual({
      type: "object",
      properties: { action: { type: "string", enum: ["run_code", "final"] }, code: { type: "string" }, answer: { type: "string" } },
      required: ["action", "code", "answer"],
      additionalProperties: false,
    });
    expect(codexCliBackend().replyFormat).toBe("json-envelope");
    expect(claudeCliBackend().replyFormat ?? "fenced").toBe("fenced");
  });

  it("converts the JSON envelope to the internal reply type", async () => {
    const b = (m: string) => codexCliBackend(codexWith(m)).call({ ...req, model: undefined });
    expect((await b("codex-env-code")).parsed).toEqual({ kind: "code", code: "return 1;" });
    expect((await b("codex-env-final")).parsed).toEqual({ kind: "final", answer: "42" });
  });

  it("a non-JSON, wrong-action or empty-code reply is a protocol-invalid (malformed) turn", async () => {
    const b = (m: string) => codexCliBackend(codexWith(m)).call({ ...req, model: undefined });
    for (const m of ["codex-env-notjson", "codex-env-badaction", "codex-env-emptycode"]) {
      expect((await b(m)).parsed?.kind, m).toBe("malformed");
    }
  });

  it("falls back to the last agent_message in the stream and classifies limits", async () => {
    const stream = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } })}\n`;
    expect(parseCodexOutput(CODEX_CLI, { code: 0, stdout: stream, stderr: "" }, undefined).text).toBe("hi");
    await expect(codexCliBackend(codexWith("codex-limit")).call(req)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("fake backend and the ask helper", () => {
  it("replays scripted replies and estimates usage", async () => {
    const b = fakeBackend(scripted(["one", "two"]));
    expect((await b.call(req)).text).toBe("one");
    expect((await b.call(req)).text).toBe("two");
    expect((await b.call(req)).text).toBe("two");
    expect(b.requests).toHaveLength(3);
  });
  it("npm run ask works end to end on the fake backend (no model)", async () => {
    let out = "";
    const code = await ask(["--backend", "fake", "hello", "there"], (s) => {
      out += s;
    });
    expect(code).toBe(0);
    expect(out).toContain("--- fake fake:");
  });
  it("ask refuses aliases and unknown backends", async () => {
    expect(await ask(["--backend", "claude-cli", "--model", "sonnet", "hi"], () => undefined)).toBe(2);
    expect(await ask(["--backend", "nope", "hi"], () => undefined)).toBe(2);
  });
});

describe("bench config", () => {
  it("parses bench/.env.example, inline comments included", () => {
    const env = loadEnv(path.join(ROOT, "bench", ".env.example"), {});
    expect(env.BENCH_CODEX_MODELS).toBe("gpt-6.2-sol,gpt-6-luna");
    expect(env.BENCH_MAX_RUNS).toBe("500");
    const cfg = benchConfig(env);
    expect(cfg).toMatchObject({ backends: ["claude-cli", "codex-cli"], maxRuns: 500, rateLimitSleepMs: 30 * 60_000, maxWaitMs: 24 * 3_600_000 });
    expect(cfg.models["claude-cli"]).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(cfg.models["codex-cli"]).toEqual(["gpt-6.2-sol", "gpt-6-luna"]);
    expect(cfg.codexEffort).toBe("medium");
    expect(weakModel("claude-cli", cfg.models["claude-cli"] ?? [])).toBe("claude-haiku-5-5");
    expect(weakModel("codex-cli", cfg.models["codex-cli"] ?? [])).toBe("gpt-6-luna");
    expect(weakModel("codex-cli", [undefined])).toBeUndefined();
  });
  it("lets the environment win and refuses aliases", () => {
    expect(benchConfig(loadEnv(undefined, { BENCH_MAX_RUNS: "7" })).maxRuns).toBe(7);
    expect(() => benchConfig({ BENCH_CLAUDE_MODELS: "haiku" })).toThrow(/alias/);
    expect(parseEnvFile('A="x y" # c\n# full comment\nB=2')).toEqual({ A: "x y", B: "2" });
  });
  it("finds null prices for the paid-run guard", () => {
    expect(nullPrices({ _note: "x", m: { input: 1, output: null } })).toEqual(["m.output"]);
  });
});
