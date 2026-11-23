// The reply protocol (BENCHMARK.md "Backends"): every model reply is exactly one of
//   - one fenced ```ts block (the code to run), or
//   - a final answer line `FINAL: ...`.
// Anything else is malformed; the harness then answers with a fixed reminder (same text in both arms).

export type Reply =
  | { kind: "code"; code: string }
  | { kind: "final"; answer: string }
  | { kind: "malformed"; reason: string };

/** Language tags accepted on the fence. The protocol asks for `ts`; the others are harmless to run. */
const CODE_LANGS = new Set(["ts", "typescript", "js", "javascript"]);

interface Fence {
  lang: string;
  body: string;
  start: number;
  end: number;
}

/** Fenced blocks (``` or longer). An opening fence with no closing fence is reported as `unclosed`. */
function fences(text: string): { blocks: Fence[]; unclosed: boolean } {
  const blocks: Fence[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let open: { ticks: number; lang: string; start: number; bodyStart: number } | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const lineEnd = offset + raw.length + 1;
    if (!open) {
      const m = /^\s*(`{3,})\s*([A-Za-z0-9_+-]*)[^`]*$/.exec(line);
      if (m) open = { ticks: (m[1] as string).length, lang: (m[2] as string).toLowerCase(), start: offset, bodyStart: lineEnd };
    } else {
      const m = /^\s*(`{3,})\s*$/.exec(line);
      if (m && (m[1] as string).length >= open.ticks) {
        blocks.push({ lang: open.lang, body: text.slice(open.bodyStart, offset).replace(/\r?\n$/, ""), start: open.start, end: lineEnd });
        open = undefined;
      }
    }
    offset = lineEnd;
  }
  return { blocks, unclosed: open !== undefined };
}

const FINAL_RE = /^[ \t>*_`]*FINAL[ \t]*[*_`]*:[*_`]*[ \t]*(.*)$/m;

export function parseReply(text: string): Reply {
  const { blocks, unclosed } = fences(text);
  if (unclosed) return { kind: "malformed", reason: "a code block was opened but never closed" };

  // Look for FINAL only outside code blocks (a console.log("FINAL: ...") inside code does not count).
  let outside = text;
  for (const b of [...blocks].reverse()) outside = outside.slice(0, b.start) + outside.slice(b.end);
  const fm = FINAL_RE.exec(outside);

  const code = blocks.filter((b) => CODE_LANGS.has(b.lang));
  if (blocks.length > 1) return { kind: "malformed", reason: `the reply has ${blocks.length} code blocks; send exactly one` };
  if (blocks.length === 1 && code.length === 0) {
    return { kind: "malformed", reason: `the code block is tagged "${blocks[0]?.lang || "(none)"}"; tag it ts` };
  }
  if (code.length === 1 && fm) return { kind: "malformed", reason: "the reply has both a code block and a FINAL line; send one of them" };
  if (code.length === 1) {
    const body = (code[0] as Fence).body;
    if (body.trim() === "") return { kind: "malformed", reason: "the code block is empty" };
    return { kind: "code", code: body };
  }
  if (fm) {
    let answer = (fm[1] as string).trim();
    if (answer === "") {
      // `FINAL:` alone on its line: the answer is the next non-empty line.
      const after = outside.slice(fm.index + fm[0].length).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
      answer = after ?? "";
    }
    answer = answer.replace(/^[*_`]+|[*_`]+$/g, "").trim();
    if (answer === "") return { kind: "malformed", reason: "the FINAL line is empty" };
    return { kind: "final", answer };
  }
  return { kind: "malformed", reason: "the reply has neither a ```ts code block nor a FINAL: line" };
}

/** The user turn the harness sends after a malformed reply. */
export function malformedFeedback(reason: string): string {
  return `Your reply did not follow the protocol: ${reason}. Reply with exactly one \`\`\`ts code block to run code, or with one line \`FINAL: <answer>\` when you are done.`;
}

/**
 * Codex-only reply envelope (bench/harness/codex-envelope.schema.json): {action, code, answer}.
 * run_code -> a code reply, final -> a final reply; anything else (not JSON, wrong shape, empty field)
 * is a protocol-invalid (malformed) turn, same as a bad fenced reply.
 */
export function parseEnvelope(text: string): Reply {
  let v: unknown;
  try {
    v = JSON.parse(text.trim());
  } catch {
    return { kind: "malformed", reason: "the reply is not valid JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { kind: "malformed", reason: "the reply is not a JSON object" };
  const o = v as Record<string, unknown>;
  if (o.action === "run_code") {
    if (typeof o.code !== "string" || o.code.trim() === "") return { kind: "malformed", reason: "action run_code needs non-empty code" };
    return { kind: "code", code: o.code };
  }
  if (o.action === "final") {
    if (typeof o.answer !== "string" || o.answer.trim() === "") return { kind: "malformed", reason: "action final needs a non-empty answer" };
    return { kind: "final", answer: o.answer.trim() };
  }
  return { kind: "malformed", reason: 'action must be "run_code" or "final"' };
}

export function malformedFeedbackEnvelope(reason: string): string {
  return `Your reply did not follow the protocol: ${reason}. Reply in the required JSON format: action run_code with your TypeScript in code (and an empty answer), or action final with your answer in answer (and empty code).`;
}
