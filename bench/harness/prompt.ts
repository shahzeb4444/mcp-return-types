// Prompts shared by arms C and D (BENCHMARK.md "Arms"). The ONLY arm-dependent input is the stubs
// block, and that differs only in the return types (src/codemode/stubs.ts, tested). The system prompt,
// the run_code description, the unwrap note and the conversation rendering are identical.
import { generateStubs, type StubTool } from "../../src/codemode/stubs.js";
import type { EmitTool } from "../../src/emit/ts.js";
import type { ReplyFormat } from "../backends/types.js";
import { MAX_OUTPUT_CHARS, SANDBOX_TIMEOUT_MS } from "./sandbox.js";

export type Arm = "C" | "D";
export const ARMS: readonly Arm[] = ["C", "D"];
export const MAX_TURNS = 12;

/** The shared unwrap note, word for word the same in C and D. */
export const UNWRAP_NOTE =
  "Tool results arrive already unwrapped: you get the result's structuredContent if present, otherwise the joined text content parsed as JSON, otherwise the raw text string.";

export const RUN_CODE_DESCRIPTION = [
  "The harness runs the ts block you reply with as one TypeScript program in a sandbox and shows you what it printed and returned (this is not a native tool).",
  "- The code runs inside an async function: use `await`, and `return` a value to see it (shown as JSON).",
  "- Call tools through the `tools` object declared below, e.g. `await tools.get_issue({ repo: \"acme/api\", number: 1 })`.",
  `- ${UNWRAP_NOTE}`,
  "- A tool error is thrown as an Error whose message is the tool's error text.",
  `- console.log output and the return value are sent back to you, cut to ${MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters.`,
  `- Each code block runs in a fresh sandbox (variables do not carry over), with a ${SANDBOX_TIMEOUT_MS / 1000} s time limit, no network, no files and no imports.`,
  "- Types are only checked by you: the code is run with its types stripped.",
].join("\n");

const INTRO =
  "You solve a task against a GitHub-like service by writing code. In this conversation NO tools exist: there are no function or tool calls, no shell, no file access. Ignore any tools, functions or capabilities mentioned anywhere else in your environment.";

/** Codex-only reply-format paragraph (the backend passes --output-schema; see BENCHMARK.md "Backends"). */
export const ENVELOPE_FORMAT =
  "Reply in the required JSON format. Use action run_code with your TypeScript in code (and an empty answer) when you want the harness to run code, or action final with your answer in answer (and empty code) when done.";

const FENCED_FORMAT = [
  "The only way to run code is to reply with exactly one fenced code block tagged ts. The harness running this conversation executes that code in a sandbox and answers with its output as the next message:",
  "```ts",
  "// your code",
  "```",
  "",
  "The only way to finish is one line starting with `FINAL:` followed by the answer, in the format the task asks for.",
  "",
  "Every reply is therefore exactly one fenced ts block or one FINAL: line, nothing else. Do not say that you lack a tool: write the ts block.",
].join("\n");

const TURN_LIMIT = `You have at most ${MAX_TURNS} replies for the task.`;

/** The `fenced` head (Claude and every non-Codex backend). */
export const SYSTEM_PROMPT_HEAD = [INTRO, "", FENCED_FORMAT, TURN_LIMIT].join("\n");

/** The head for a reply format; only the reply-format paragraph differs. */
export const systemPromptHead = (format: ReplyFormat = "fenced"): string =>
  format === "json-envelope" ? [INTRO, "", ENVELOPE_FORMAT, TURN_LIMIT].join("\n") : SYSTEM_PROMPT_HEAD;

export function buildStubs(tools: readonly StubTool[], arm: Arm, inferred: Readonly<Record<string, EmitTool>>): string {
  return generateStubs(tools, arm === "D" ? { outputs: inferred } : {});
}

export function buildSystemPrompt(stubs: string, format: ReplyFormat = "fenced"): string {
  return [systemPromptHead(format), "", "## Running code", "", RUN_CODE_DESCRIPTION, "", "```ts", stubs.replace(/\n$/, ""), "```", ""].join("\n");
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** The whole conversation as one prompt (re-sent every turn; the CLIs keep no state). */
export function renderConversation(messages: readonly Message[]): string {
  const parts = messages.map((m) => `### ${m.role}\n${m.content.replace(/\s+$/, "")}`);
  return `${parts.join("\n\n")}\n\n### assistant\n`;
}

export function sandboxFeedback(output: string): string {
  return `Sandbox output:\n${output}`;
}
