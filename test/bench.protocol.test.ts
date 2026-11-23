import { describe, expect, it } from "vitest";
import { malformedFeedback, malformedFeedbackEnvelope, parseEnvelope, parseReply } from "../bench/harness/protocol.js";

describe("reply parser: code block", () => {
  it("takes the body of one ```ts block", () => {
    expect(parseReply("```ts\nconst x = 1;\nreturn x;\n```")).toEqual({ kind: "code", code: "const x = 1;\nreturn x;" });
  });
  it("allows prose around the block", () => {
    const r = parseReply("I will list the issues.\n\n```ts\nreturn 1;\n```\nThen I will count.");
    expect(r).toEqual({ kind: "code", code: "return 1;" });
  });
  it("accepts typescript/js tags and CRLF line ends", () => {
    expect(parseReply("```typescript\r\nreturn 2;\r\n```\r\n")).toEqual({ kind: "code", code: "return 2;" });
    expect(parseReply("```js\nreturn 3;\n```")).toEqual({ kind: "code", code: "return 3;" });
  });
  it("keeps inner ``` inside a longer fence", () => {
    const r = parseReply("````ts\nconst s = `a`;\nconsole.log('```');\n````");
    expect(r.kind).toBe("code");
  });
  it("ignores a FINAL inside the code block", () => {
    expect(parseReply('```ts\nconsole.log("FINAL: 3");\n```')).toEqual({ kind: "code", code: 'console.log("FINAL: 3");' });
  });
});

describe("reply parser: FINAL line", () => {
  it("takes the rest of the line", () => {
    expect(parseReply("FINAL: 42")).toEqual({ kind: "final", answer: "42" });
  });
  it("finds the line after reasoning and ignores text after it", () => {
    expect(parseReply("The count is done.\nFINAL: [\"alice\",\"bob\"]\nThanks!")).toEqual({ kind: "final", answer: '["alice","bob"]' });
  });
  it("tolerates markdown emphasis and leading spaces", () => {
    expect(parseReply("**FINAL:** 7")).toEqual({ kind: "final", answer: "7" });
    expect(parseReply("  **FINAL**: done")).toEqual({ kind: "final", answer: "done" });
    expect(parseReply("FINAL: `Crash when parsing`")).toEqual({ kind: "final", answer: "Crash when parsing" });
  });
  it("takes the next line when FINAL: stands alone", () => {
    expect(parseReply("FINAL:\n\n12")).toEqual({ kind: "final", answer: "12" });
  });
});

describe("reply parser: malformed", () => {
  const malformed = (text: string): string => {
    const r = parseReply(text);
    if (r.kind !== "malformed") throw new Error(`expected malformed, got ${r.kind}`);
    return r.reason;
  };
  it("plain prose", () => expect(malformed("Let me think about it.")).toMatch(/neither/));
  it("empty reply", () => expect(malformed("")).toMatch(/neither/));
  it("two code blocks", () => expect(malformed("```ts\na()\n```\n```ts\nb()\n```")).toMatch(/2 code blocks/));
  it("code block and FINAL", () => expect(malformed("```ts\nreturn 1\n```\nFINAL: 1")).toMatch(/both/));
  it("unclosed fence", () => expect(malformed("```ts\nreturn 1;")).toMatch(/never closed/));
  it("wrong language tag", () => expect(malformed("```python\nprint(1)\n```")).toMatch(/tagged "python"/));
  it("untagged block", () => expect(malformed("```\nreturn 1\n```")).toMatch(/tagged "\(none\)"/));
  it("empty code block", () => expect(malformed("```ts\n\n```")).toMatch(/empty/));
  it("empty FINAL", () => expect(malformed("FINAL:")).toMatch(/FINAL line is empty/));
  it("lowercase final is not a FINAL line", () => expect(malformed("final: 3")).toMatch(/neither/));
  it("the feedback names the reason and the protocol", () => {
    const f = malformedFeedback("the reply has neither a ```ts code block nor a FINAL: line");
    expect(f).toContain("neither");
    expect(f).toContain("FINAL: <answer>");
  });
});

describe("Codex JSON envelope", () => {
  const env = (o: unknown): string => JSON.stringify(o);
  it("run_code becomes a code reply, final becomes a final reply", () => {
    expect(parseEnvelope(env({ action: "run_code", code: "return 1;", answer: "" }))).toEqual({ kind: "code", code: "return 1;" });
    expect(parseEnvelope(env({ action: "final", code: "", answer: " 7 " }))).toEqual({ kind: "final", answer: "7" });
  });
  it("tolerates surrounding whitespace", () => {
    expect(parseEnvelope(`
${env({ action: "final", code: "", answer: "x" })}
`).kind).toBe("final");
  });
  it.each([
    ["not JSON", "FINAL: 42"],
    ["a fenced block instead of JSON", "```ts\nreturn 1;\n```"],
    ["empty text", ""],
    ["a JSON array", "[1]"],
    ["a JSON string", '"hi"'],
    ["null", "null"],
    ["an unknown action", env({ action: "think", code: "", answer: "" })],
    ["no action", env({ code: "x", answer: "" })],
    ["run_code with empty code", env({ action: "run_code", code: "   ", answer: "" })],
    ["run_code with code missing", env({ action: "run_code", answer: "" })],
    ["final with empty answer", env({ action: "final", code: "", answer: "" })],
    ["final with a non-string answer", env({ action: "final", code: "", answer: 5 })],
  ])("%s is malformed", (_n, text) => {
    expect(parseEnvelope(text).kind).toBe("malformed");
  });
  it("the envelope reminder names the JSON format, not a ts block", () => {
    expect(malformedFeedbackEnvelope("x")).toContain("JSON format");
    expect(malformedFeedbackEnvelope("x")).not.toContain("FINAL:");
  });
});
