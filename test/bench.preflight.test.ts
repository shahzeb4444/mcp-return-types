import { describe, expect, it } from "vitest";
import { checkApiKeys, checkEnvSyntax, checkGitStatus, isPinnedModelId, preflight, renderChecks, type PreflightInput } from "../bench/preflight.js";

const GOOD_ENV = [
  "# comment",
  "BENCH_BACKENDS=claude-cli,codex-cli",
  "BENCH_CLAUDE_MODELS=claude-sonnet-5-5,claude-haiku-5-5   # trailing comment",
  "BENCH_CODEX_MODELS=gpt-6.2-sol,gpt-6-luna",
  "BENCH_CODEX_EFFORT=medium",
  "BENCH_MAX_RUNS=4321",
  "",
].join("\r\n");

const input = (o: Partial<PreflightInput> = {}): PreflightInput => ({ env: {}, envFileText: GOOD_ENV, stopFileExists: false, gitPorcelain: "", ...o });
const errors = (o: Partial<PreflightInput>): string[] => preflight(input(o)).filter((c) => c.level === "ERROR").map((c) => c.name);

describe("preflight", () => {
  it("passes on a good setup and prints OK", () => {
    const checks = preflight(input());
    expect(checks.filter((c) => c.level !== "OK")).toEqual([]);
    expect(renderChecks(checks)).toMatch(/preflight: OK \(0 warning\(s\)\)\n$/);
  });
  it("requires the API key variables to be unset, and never prints their values", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-SECRET-111", OPENAI_API_KEY: "sk-SECRET-222", CODEX_API_KEY: "" };
    expect(checkApiKeys(env).map((c) => `${c.name}:${c.level}`)).toEqual(["ANTHROPIC_API_KEY:ERROR", "OPENAI_API_KEY:ERROR", "CODEX_API_KEY:OK"]);
    const text = renderChecks(preflight(input({ env })));
    expect(text).not.toContain("SECRET");
    expect(text).toContain("Remove-Item Env:ANTHROPIC_API_KEY");
  });
  it("refuses API keys inside bench/.env without printing them", () => {
    const text = renderChecks(preflight(input({ envFileText: `${GOOD_ENV}OPENAI_API_KEY=sk-SECRET-333\n` })));
    expect(text).toContain("ERROR OPENAI_API_KEY: is set in bench/.env");
    expect(text).not.toContain("SECRET");
  });
  it("needs bench/.env to exist and parse (line numbers only)", () => {
    expect(errors({ envFileText: undefined })).toEqual(["bench/.env"]);
    const text = renderChecks(preflight(input({ envFileText: `${GOOD_ENV}this line is broken secret-value\n` })));
    expect(text).toContain("ERROR bench/.env: line 7 is not KEY=VALUE");
    expect(text).not.toContain("secret-value");
  });
  it("rejects aliases and unpinned model IDs, naming only the entry position", () => {
    const env = GOOD_ENV.replace("claude-sonnet-5-5,claude-haiku-5-5", "claude-sonnet-5-5,haiku").replace("gpt-6.2-sol,gpt-6-luna", "gpt-latest");
    const checks = preflight(input({ envFileText: env }));
    const text = renderChecks(checks);
    expect(text).toContain("ERROR BENCH_CLAUDE_MODELS: entry 2 is an alias or not a pinned model ID");
    expect(text).toContain("ERROR BENCH_CODEX_MODELS: entry 1 is an alias or not a pinned model ID");
    expect(text).toContain("ERROR harness config: rejected");
    expect(text).not.toMatch(/\bhaiku\b(?!-5-5)/);
    expect(text).not.toContain("gpt-latest");
  });
  it("needs the model lists and BENCH_MAX_RUNS to be set, without printing the value", () => {
    const env = GOOD_ENV.replace(/BENCH_CODEX_MODELS=.*\r\n/, "").replace(/BENCH_MAX_RUNS=.*\r\n/, "");
    expect(errors({ envFileText: env })).toEqual(["BENCH_CODEX_MODELS", "BENCH_MAX_RUNS"]);
    expect(renderChecks(preflight(input()))).not.toContain("4321");
    expect(errors({ envFileText: GOOD_ENV.replace("4321", "lots") })).toContain("BENCH_MAX_RUNS");
    expect(preflight(input({ envFileText: GOOD_ENV.replace("4321", "50") })).find((c) => c.name === "BENCH_MAX_RUNS")?.level).toBe("WARN");
  });
  it("uses BENCH_* from the process environment on top of the file, like the harness", () => {
    const checks = preflight(input({ env: { BENCH_CLAUDE_MODELS: "sonnet" } }));
    const c = checks.find((x) => x.name === "BENCH_CLAUDE_MODELS");
    expect(c?.level).toBe("ERROR");
    expect(c?.detail).toContain("from the process environment");
  });
  it("fails on bench/STOP", () => {
    expect(errors({ stopFileExists: true })).toEqual(["bench/STOP"]);
  });
  it("needs a clean working tree outside bench/results/", () => {
    expect(checkGitStatus("").level).toBe("OK");
    expect(checkGitStatus("?? bench/results/pilot/C-x-1.json\n?? bench/results/pilot/C-x-1.jsonl\n").level).toBe("OK");
    const dirty = checkGitStatus(" M PROGRESS.md\n?? bench/results/pilot/a.json\n?? notes.txt\n");
    expect(dirty.level).toBe("ERROR");
    expect(dirty.detail).toContain("PROGRESS.md, notes.txt");
    expect(dirty.detail).not.toContain("bench/results");
    expect(checkGitStatus(undefined).level).toBe("ERROR");
  });
  it("warns on unknown keys", () => {
    expect(checkEnvSyntax("BENCH_TYPO=1\n")).toEqual([{ level: "WARN", name: "BENCH_TYPO", detail: "unknown key in bench/.env (ignored by the harness)" }]);
  });
  it("tells pinned IDs from aliases", () => {
    for (const ok of ["claude-haiku-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6.2-sol"]) expect(isPinnedModelId(ok), ok).toBe(true);
    for (const bad of ["haiku", "sonnet", "opus", "luna", "claude-haiku", "claude-latest-5", "default", "", "gpt 6"]) expect(isPinnedModelId(bad), bad).toBe(false);
  });
});
