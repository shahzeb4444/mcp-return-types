// M11 plain-MCP test: parsing the clients' output. No model call was allowed while building this, so the
// fixtures in test/fixtures/plain-mcp/ are assembled in the documented formats: the claude `result` event uses
// the field names of a real recorded result (bench/results/full, `usage` and `modelUsage`), and the codex
// events use the real event names seen in M6 (thread.started, item.completed, turn.completed). The tool-call
// items (claude tool_use / tool_result, codex mcp_tool_call, command_execution) are written by hand from the
// formats' documentation and must be checked against the M11b smoke run (docs/PLAIN-MCP.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BackendError, NotLoggedInError, RateLimitError } from "../bench/backends/types.js";
import { parseClaudeStream, parseClientOutput, parseCodexEvents } from "../bench/plain-mcp/clients.js";
import { extractFinal } from "../bench/plain-mcp/prompt.js";

const FIX = path.join("test", "fixtures", "plain-mcp");
const claudeOut = readFileSync(path.join(FIX, "claude-stream.jsonl"), "utf8");
const codexOut = readFileSync(path.join(FIX, "codex-events.jsonl"), "utf8");
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", latencyMs: 1, timedOut: false, cwdWasEmpty: true });

describe("claude stream-json", () => {
  const r = parseClaudeStream(ok(claudeOut));

  it("counts tool-call rounds by assistant message id, and calls by tool_use id", () => {
    expect(r.rounds).toBe(2); // msg_01A (streamed as two events) and msg_01B (two parallel calls)
    expect(r.toolCalls).toBe(3);
    expect(r.toolErrors).toBe(1);
    expect(r.toolsCalled).toEqual({ "mcp__github__get_issue": 2, "mcp__github__list_comments": 1 });
    expect(r.numTurns).toBe(3);
  });

  it("reads usage from the result event and cross-checks it with modelUsage", () => {
    expect(r.usage).toEqual({ input_tokens: 9, cache_creation_input_tokens: 3200, cache_read_input_tokens: 14000, output_tokens: 310, reasoning_output_tokens: 0 });
    expect(r.usageCrossCheck).toEqual({ modelUsageOutput: 310, matches: true });
  });

  it("keeps the init event's MCP status and offered tools, and the final text", () => {
    expect(r.mcpServers).toEqual([{ name: "github", status: "connected" }]);
    expect(r.offeredTools).toHaveLength(8);
    expect(extractFinal(r.text)).toBe("Memory leak when resizing nested tables behind a proxy");
    expect(r.clientError).toBeUndefined();
  });

  const withResult = (result: Record<string, unknown>): string =>
    claudeOut
      .trim()
      .split("\n")
      .filter((l) => !l.includes('"type":"result"'))
      .concat(JSON.stringify(result))
      .join("\n");

  it("a usage limit throws RateLimitError, a missing login NotLoggedInError", () => {
    expect(() => parseClaudeStream(ok(withResult({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1790000000" })))).toThrow(RateLimitError);
    expect(() => parseClaudeStream(ok(withResult({ type: "result", is_error: true, result: "Invalid API key · Please run /login" })))).toThrow(NotLoggedInError);
  });

  it("any other error result is kept as a graded run with clientError", () => {
    const e = parseClaudeStream(ok(withResult({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 30, usage: { output_tokens: 5 } })));
    expect(e.clientError).toMatch(/^error_max_turns/);
    expect(e.rounds).toBe(2);
    expect(e.usage.output_tokens).toBe(5);
  });

  it("no result event at all is a BackendError (the harness retries it)", () => {
    expect(() => parseClaudeStream({ code: 1, stdout: "garbage", stderr: "boom" })).toThrow(BackendError);
  });
});

describe("codex --json events", () => {
  const r = parseCodexEvents({ ...ok(codexOut), lastMessage: "Labelled the issues.\nFINAL: done\n" });

  it("groups consecutive mcp_tool_call items into rounds, and counts shell commands apart", () => {
    expect(r.rounds).toBe(2); // [list_issues, list_issues] then [add_label]
    expect(r.toolCalls).toBe(3);
    expect(r.toolErrors).toBe(1);
    expect(r.shellCalls).toBe(1);
    expect(r.toolsCalled).toEqual({ "github/list_issues": 2, "github/add_label": 1 });
  });

  it("reads usage like the Code Mode backend (uncached = input - cached; reasoning is part of output)", () => {
    expect(r.usage).toEqual({ input_tokens: 11000, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000, output_tokens: 900, reasoning_output_tokens: 600 });
    expect(extractFinal(r.text)).toBe("done");
  });

  it("falls back to the last agent_message without the -o file; limit errors throw", () => {
    expect(extractFinal(parseClientOutput("codex-json", ok(codexOut)).text)).toBe("done");
    const limited = `${codexOut}${JSON.stringify({ type: "error", message: "You've hit your usage limit." })}\n`;
    expect(() => parseCodexEvents(ok(limited))).toThrow(RateLimitError);
  });
});

describe("extractFinal", () => {
  it("takes the LAST FINAL line, strips emphasis, reads a following line or code block", () => {
    expect(extractFinal("FINAL: draft\nmore thinking\nFINAL: 42")).toBe("42");
    expect(extractFinal("**FINAL:** `7`")).toBe("7");
    expect(extractFinal("Answer:\nFINAL:\n\n```json\n[\"a\", \"b\"]\n```\n")).toBe('["a", "b"]');
    expect(extractFinal("FINAL:\nacme")).toBe("acme");
    expect(extractFinal("no final here")).toBeUndefined();
    expect(extractFinal(undefined)).toBeUndefined();
    expect(extractFinal("FINAL:   ")).toBeUndefined();
  });
});
