import { describe, expect, it } from "vitest";
import { FAKE_CHILD, startProcess, tmpDir, waitFor } from "./helpers.js";
import { recordFixtureSchemas, serveCommand } from "./serve-helpers.js";

const READY = Buffer.from('{"jsonrpc":"2.0","method":"notifications/ready"}\n');
const CALL = Buffer.from('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_user","arguments":{"id":"q"}}}\n');
const RESPONSE = '{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\\"id\\":\\"q\\",\\"name\\":\\"Ada\\",\\"tags\\":[],\\"created\\":\\"2026-11-22T10:00:00Z\\"}"}]}}';

/** Lines the fake child echoes back unchanged, that serve must forward byte for byte. */
const untouched = [
  Buffer.from("this is not json at all\n"),
  Buffer.from('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":1}}\n'),
  Buffer.from('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}\r\n'),
  Buffer.from("\n\n"),
  Buffer.from('{"jsonrpc":"2.0","id":9,"result":{"content":[]}}\n'), // a result nobody asked for
];

async function run(inDir: string, payload: Buffer[]): Promise<Buffer> {
  const { command, args } = serveCommand(inDir, [process.execPath, FAKE_CHILD, "echo"], ["--name", "json-fixture"]);
  const p = startProcess(command, args);
  await waitFor(() => p.stdout().length >= READY.length);
  for (const chunk of payload) {
    p.child.stdin.write(chunk);
    await new Promise((r) => setTimeout(r, 15));
  }
  p.child.stdin.end();
  expect(await p.exited).toBe(0);
  return p.stdout();
}

describe("serve: forwarding", () => {
  it("with nothing to serve, forwards bytes unchanged (CRLF, non-JSON, notifications, errors, no final newline)", async () => {
    const euro = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"s":"€uro ✓"}}}\r\n');
    const split = euro.indexOf(0xe2) + 1; // cut in the middle of a multi-byte character
    const tail = Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"content":[]}}'); // no trailing newline
    const payload = [euro.subarray(0, split), euro.subarray(split), ...untouched, tail];
    const out = await run(tmpDir("typegen-none-"), payload);
    expect(out.equals(Buffer.concat([READY, ...payload]))).toBe(true);
  }, 30_000);

  it("rewrites only the matching result, keeps its CRLF ending, and leaves every other byte alone", async () => {
    const inDir = recordFixtureSchemas();
    const tail = Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"content":[]}}');
    const payload = [CALL, ...untouched, Buffer.from(`${RESPONSE}\r\n`), tail];
    const out = await run(inDir, payload);

    const lines: Buffer[] = [];
    let rest: Buffer = out;
    for (let nl = rest.indexOf(0x0a); nl !== -1; nl = rest.indexOf(0x0a)) {
      lines.push(rest.subarray(0, nl + 1));
      rest = rest.subarray(nl + 1);
    }
    // everything before the rewritten response is byte for byte what was sent
    const before = Buffer.concat([READY, CALL, ...untouched]);
    const rewritten = lines.find((l) => l.toString().includes('"structuredContent"')) as Buffer;
    expect(rewritten).toBeDefined();
    expect(out.subarray(0, before.length).equals(before)).toBe(true);
    expect(rewritten.subarray(-2).toString()).toBe("\r\n");
    const msg = JSON.parse(rewritten.toString()) as { result: { structuredContent: unknown; content: unknown[] } };
    expect(msg.result.structuredContent).toEqual({ id: "q", name: "Ada", tags: [], created: "2026-11-22T10:00:00Z" });
    expect(msg.result.content).toHaveLength(1); // the text stays
    expect(rest.equals(tail)).toBe(true); // the unterminated last line is forwarded as is
  }, 30_000);
});
