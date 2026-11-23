// The one prompt of the plain-MCP test (BENCHMARK.md Amendment 3). It depends only on the task and the MCP
// server's name, never on the arm, and both clients get exactly the same text on stdin (no system prompt
// of our own: each client keeps its default one). The FINAL line is what the existing grader reads.

export function plainPrompt(task: { prompt: string }, serverName: string): string {
  return [
    `Use the tools of the MCP server "${serverName}" to do the task below. Use no other tools, and do not run commands or write files.`,
    "",
    `Task: ${task.prompt}`,
    "",
    "End your reply with one line in this form:",
    "FINAL: <answer>",
    "Give <answer> in the format the task asks for, and put nothing after that line.",
  ].join("\n");
}

const FINAL_RE = /^[ \t>*_`]*FINAL[ \t]*[*_`]*:[*_`]*[ \t]*(.*)$/gm;

/**
 * The answer on the LAST `FINAL:` line of a free-form reply (a chat reply may contain code blocks, unlike the
 * Code Mode protocol). `FINAL:` alone on its line takes the next non-empty line, or the body of a code block
 * that starts there. Markdown emphasis around the answer is removed. Undefined when there is no FINAL line.
 */
export function extractFinal(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(FINAL_RE)) last = m as RegExpExecArray;
  if (!last) return undefined;
  let answer = (last[1] as string).trim();
  if (answer === "") {
    const rest = text.slice((last.index ?? 0) + last[0].length).split(/\r?\n/).map((l) => l.trim());
    const i = rest.findIndex((l) => l !== "");
    if (i === -1) return undefined;
    if ((rest[i] as string).startsWith("```")) {
      const end = rest.findIndex((l, j) => j > i && l.startsWith("```"));
      answer = rest.slice(i + 1, end === -1 ? undefined : end).join("\n").trim();
    } else answer = rest[i] as string;
  }
  answer = answer.replace(/^[*_`]+|[*_`]+$/g, "").trim();
  return answer === "" ? undefined : answer;
}
