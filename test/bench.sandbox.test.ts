import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runSandbox, transpile, type ToolCaller } from "../bench/harness/sandbox.js";

const calls: { name: string; args: unknown }[] = [];
const callTool: ToolCaller = async (name, args) => {
  calls.push({ name, args });
  if (name === "fails") return { ok: false, error: "Not Found: issue acme/api#999" };
  return { ok: true, value: { name, args, nested: { list: [1, 2, 3] } } };
};
const run = (code: string, extra: Partial<Parameters<typeof runSandbox>[1]> = {}) =>
  runSandbox(code, { tools: ["get_issue", "fails"], callTool, timeoutMs: 3000, ...extra });

describe("sandbox: running code", () => {
  it("calls tools over IPC, prints console output and the return value", async () => {
    const r = await run('const r = await tools.get_issue({ repo: "acme/api", number: 1 });\nconsole.log("got", r.nested.list.length);\nreturn r.args;');
    expect(r.status).toBe("ok");
    expect(r.toolCalls).toBe(1);
    expect(r.output).toBe('got 3\nReturn value:\n{\n  "repo": "acme/api",\n  "number": 1\n}');
  });
  it("strips TypeScript types", async () => {
    const r = await run("interface X { a: number }\nconst x: X = { a: 2 };\nreturn x.a as number;");
    expect(r).toMatchObject({ status: "ok", output: "Return value:\n2" });
  });
  it("throws tool errors as an Error with the tool's text", async () => {
    const r = await run("await tools.fails({});");
    expect(r.status).toBe("exception");
    expect(r.error).toBe("Error: Not Found: issue acme/api#999");
  });
  it("reports exceptions with the output printed before them", async () => {
    const r = await run('console.log("before");\nconst x: any = undefined;\nreturn x.items.length;');
    expect(r.status).toBe("exception");
    expect(r.error).toMatch(/^TypeError: /);
    expect(r.output).toMatch(/^before\nException: TypeError: /);
  });
  it("reports syntax errors as exceptions without starting a process", async () => {
    const r = await run("return 1 +");
    expect(r.status).toBe("exception");
    expect(r.error).toMatch(/^SyntaxError: /);
    expect(transpile("const = 3")).toHaveProperty("error");
  });
  it("says so when there is nothing to show", async () => {
    expect((await run("const x = 1;")).output).toBe("(no output and no return value)");
  });
  it("does not keep state between blocks", async () => {
    await run("globalThis.kept = 1;");
    expect((await run("return typeof globalThis.kept;")).output).toBe('Return value:\n"undefined"');
  });
});

describe("sandbox: timeout", () => {
  it("stops a synchronous endless loop", async () => {
    const r = await run("while (true) {}", { timeoutMs: 1000 });
    expect(r.status).toBe("timeout");
    expect(r.error).toMatch(/^Timeout: /);
  });
  it("stops an endless loop after an await (parent kills the child)", async () => {
    const r = await run("await tools.get_issue({});\nfor (;;) { await null; }", { timeoutMs: 1000 });
    expect(r.status).toBe("timeout");
    expect(r.durationMs).toBeLessThan(5000);
  });
  it("stops a promise that never settles", async () => {
    const r = await run("await new Promise(() => {});", { timeoutMs: 800 });
    expect(r.status).toBe("timeout");
  });
});

describe("sandbox: output truncation", () => {
  it("cuts stdout plus return value to the limit with a marker", async () => {
    const r = await run('console.log("x".repeat(9000));', { maxOutputChars: 8000 });
    expect(r.status).toBe("ok");
    expect(r.truncatedChars).toBe(1000);
    expect(r.output).toBe(`${"x".repeat(8000)}\n[truncated 1000 chars]`);
  });
  it("counts output the child did not even keep", async () => {
    const r = await run('for (let i = 0; i < 2000; i++) console.log("line " + i);\nreturn "end";', { maxOutputChars: 100 });
    expect(r.output.endsWith("chars]")).toBe(true);
    const full = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n").length + '\nReturn value:\n"end"'.length;
    expect(r.truncatedChars).toBe(full - 100);
  });
  it("does not truncate output at the limit", async () => {
    const r = await run('return "y".repeat(100);', { maxOutputChars: 118 });
    expect(r.truncatedChars).toBe(0);
  });
});

describe("sandbox: no network, no host access", () => {
  it("has no fetch, require, process or WebSocket", async () => {
    for (const name of ["fetch", "require", "process", "WebSocket", "XMLHttpRequest"]) {
      expect((await run(`return typeof ${name};`)).output).toBe('Return value:\n"undefined"');
    }
    expect((await run('await fetch("http://127.0.0.1:1/");')).error).toBe("ReferenceError: fetch is not defined");
  });
  it("refuses dynamic import", async () => {
    const r = await run('const net = await import("node:net"); return typeof net;');
    expect(r.status).toBe("exception");
  });
  it("gives no way to the host realm through the provided objects", async () => {
    for (const code of [
      'return tools.get_issue.constructor.constructor("return typeof process")();',
      'return console.log.constructor.constructor("return typeof process")();',
      'return setTimeout.constructor.constructor("return typeof process")();',
      'const p = tools.get_issue({}); return p.constructor.constructor("return typeof process")();',
    ]) {
      expect((await run(code)).output, code).toBe('Return value:\n"undefined"');
    }
  });
  it("cannot reach a local TCP server by any of the usual routes", async () => {
    let connections = 0;
    const server = createServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const code of [
        `await fetch("http://127.0.0.1:${port}/");`,
        `const net = await import("node:net"); net.connect(${port}, "127.0.0.1");`,
        `require("net").connect(${port}, "127.0.0.1");`,
        `const P = tools.get_issue.constructor.constructor("return typeof process === 'undefined' ? null : process")(); P.getBuiltinModule("node:net").connect(${port}, "127.0.0.1");`,
        `await new Promise((r) => setTimeout(r, 200));`,
      ]) {
        await run(code);
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });
});
