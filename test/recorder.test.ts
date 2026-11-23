import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitignore, Recorder, safeName, unwrap, type Sample } from "../src/proxy/recorder.js";
import { canonicalJson, formatClass, shapeOf } from "../src/proxy/shape.js";
import { tmpDir } from "./helpers.js";

function setup(opts: { keepValues?: boolean; observedValues?: boolean } = {}) {
  const outDir = tmpDir();
  const rec = new Recorder({ outDir, fallbackName: "srv", ...opts });
  let id = 0;
  const call = (tool: string, args: unknown, response: Record<string, unknown>): void => {
    id += 1;
    rec.fromClient({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
    rec.fromServer({ jsonrpc: "2.0", id, ...response });
  };
  const samples = (tool: string, server = "srv"): Sample[] =>
    readFileSync(path.join(outDir, "samples", server, `${tool}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Sample);
  return { outDir, rec, call, samples };
}

describe("shape", () => {
  it("describes primitives, nested objects and arrays without raw values", () => {
    const s = shapeOf({ a: "secret-value-longer-than-sixteen", n: 1, f: 1.5, b: true, z: null, l: [1, 2], o: { k: "x" } });
    expect(JSON.stringify(s)).not.toContain("secret-value");
    expect(shapeOf("")).toEqual({ t: "string", len: "empty" });
    expect(shapeOf("x".repeat(16))).toEqual({ t: "string", len: "short" });
    expect(shapeOf("x".repeat(257))).toEqual({ t: "string", len: "long" });
    expect(s).toEqual({
      t: "object",
      keys: {
        a: { t: "string", len: "medium" },
        n: { t: "integer" },
        f: { t: "number" },
        b: { t: "boolean" },
        z: { t: "null" },
        l: { t: "array", n: 2, items: [{ t: "integer" }, { t: "integer" }] },
        o: { t: "object", keys: { k: { t: "string", len: "short" } } },
      },
    });
  });

  it("classifies string formats", () => {
    expect(formatClass("2026-11-22T10:00:00Z")).toBe("date-time");
    expect(formatClass("2026-11-22")).toBeUndefined();
    expect(formatClass("a@b.co")).toBe("email");
    expect(formatClass("https://example.com/x")).toBe("uri");
    expect(formatClass("hello world")).toBeUndefined();
  });

  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  });
});

describe("unwrap (SPEC §3 rule 1)", () => {
  it("prefers structuredContent, then JSON text, then plain text", () => {
    expect(unwrap({ structuredContent: { a: 1 }, content: [{ type: "text", text: "x" }] }).path).toBe("structuredContent");
    expect(unwrap({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ path: "json-text", value: { a: 1 } });
    expect(unwrap({ content: [{ type: "text", text: "hello" }] })).toEqual({ path: "text", value: "hello" });
    expect(unwrap({ content: [{ type: "image", data: "", mimeType: "image/png" }] }).path).toBe("none");
  });
});

describe("recorder", () => {
  it("records shape only, with a salted argument hash and no raw values", () => {
    const { call, samples, outDir } = setup();
    call("echo", { message: "top-secret" }, { result: { content: [{ type: "text", text: "Echo: top-secret" }] } });
    const [s] = samples("echo");
    expect(s).toMatchObject({ v: 1, tool: "echo", isError: false, unwrap: "text", blocks: ["text"] });
    expect(s?.shape).toEqual({ t: "string", len: "short" }); // "Echo: top-secret" is 16 chars
    expect(s?.args).toMatch(/^[0-9a-f]{32}$/);
    const all = [
      readFileSync(path.join(outDir, "samples", "srv", "echo.jsonl"), "utf8"),
      readFileSync(path.join(outDir, "salt"), "utf8"),
    ].join("\n");
    expect(all).not.toContain("top-secret");
  });

  it("same arguments give the same hash regardless of key order; different arguments differ", () => {
    const { call, samples } = setup();
    const res = { result: { content: [{ type: "text", text: "1" }] } };
    call("t", { a: 1, b: 2 }, res);
    call("t", { b: 2, a: 1 }, res);
    call("t", { a: 1, b: 3 }, res);
    const [x, y, z] = samples("t");
    expect(x?.args).toBe(y?.args);
    expect(x?.args).not.toBe(z?.args);
  });

  it("keeps raw values only with keepValues", () => {
    const { call, samples } = setup({ keepValues: true });
    call("t", {}, { result: { content: [{ type: "text", text: '{"name":"bob"}' }] } });
    expect(samples("t")[0]?.value).toEqual({ name: "bob" });
  });

  it("marks isError results and keeps them as separate samples", () => {
    const { call, samples } = setup();
    call("t", {}, { result: { isError: true, content: [{ type: "text", text: "boom" }] } });
    expect(samples("t")[0]).toMatchObject({ isError: true, unwrap: "text" });
  });

  it("records JSON-RPC errors by code only", () => {
    const { call, samples, outDir } = setup();
    call("t", {}, { error: { code: -32602, message: "secret detail" } });
    expect(samples("t")[0]?.rpcError).toEqual({ code: -32602 });
    expect(readFileSync(path.join(outDir, "samples", "srv", "t.jsonl"), "utf8")).not.toContain("secret detail");
  });

  it("names the server from serverInfo.name in the initialize response", () => {
    const { rec, outDir } = setup();
    rec.fromClient({ jsonrpc: "2.0", id: "i", method: "initialize", params: {} });
    rec.fromServer({ jsonrpc: "2.0", id: "i", result: { serverInfo: { name: "my/server", version: "1" } } });
    rec.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t", arguments: {} } });
    rec.fromServer({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "1" }] } });
    expect(readdirSync(path.join(outDir, "samples"))).toEqual([safeName("my/server")]);
  });

  it("does not mistake a server-to-client request for a response", () => {
    const { rec, outDir } = setup();
    rec.fromClient({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "t", arguments: {} } });
    rec.fromServer({ jsonrpc: "2.0", id: 5, method: "sampling/createMessage", params: {} });
    expect(() => readdirSync(path.join(outDir, "samples"))).toThrow();
  });

  it("ignores cancelled calls", () => {
    const { rec, outDir } = setup();
    rec.fromClient({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "t", arguments: {} } });
    rec.fromClient({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });
    rec.fromServer({ jsonrpc: "2.0", id: 5, result: { content: [] } });
    expect(() => readdirSync(path.join(outDir, "samples"))).toThrow();
  });

  it("never writes outside the samples folder for hostile tool names", () => {
    const { call, outDir } = setup();
    call("../../evil", {}, { result: { content: [{ type: "text", text: "1" }] } });
    const files = readdirSync(path.join(outDir, "samples", "srv")).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[\\/]/);
    expect(files[0]?.startsWith(".")).toBe(false);
  });

  it("counts string values per field and gives up for good at the 9th distinct value", () => {
    const { call, outDir } = setup();
    const file = path.join(outDir, "samples", "srv", "t.values.json");
    const send = (status: string): void =>
      call("t", {}, { result: { content: [{ type: "text", text: JSON.stringify({ status, items: [{ k: "a" }] }) }] } });
    for (const s of ["open", "open", "closed"]) send(s);
    let vf = JSON.parse(readFileSync(file, "utf8")) as { fields: Record<string, Record<string, number>>; highCardinality: string[] };
    expect(vf.fields["$.status"]).toEqual({ open: 2, closed: 1 });
    expect(vf.fields["$.items[].k"]).toEqual({ a: 3 });
    for (const s of ["s3", "s4", "s5", "s6", "s7", "s8", "s9"]) send(s); // distinct: 9 in total
    vf = JSON.parse(readFileSync(file, "utf8")) as typeof vf;
    expect(vf.fields["$.status"]).toBeUndefined();
    expect(vf.highCardinality).toContain("$.status");
    send("open"); // stays high-cardinality
    vf = JSON.parse(readFileSync(file, "utf8")) as typeof vf;
    expect(vf.fields["$.status"]).toBeUndefined();
  });

  it("treats values longer than 40 characters as high-cardinality and never counts plain text", () => {
    const { call, outDir } = setup();
    call("t", {}, { result: { content: [{ type: "text", text: JSON.stringify({ d: "x".repeat(41) }) }] } });
    const vf = JSON.parse(readFileSync(path.join(outDir, "samples", "srv", "t.values.json"), "utf8")) as { highCardinality: string[] };
    expect(vf.highCardinality).toEqual(["$.d"]);
    call("plain", {}, { result: { content: [{ type: "text", text: "just text" }] } });
    expect(() => readFileSync(path.join(outDir, "samples", "srv", "plain.values.json"))).toThrow();
  });

  it("handles value strings like __proto__ and constructor", () => {
    const { call, outDir } = setup();
    call("t", {}, { result: { content: [{ type: "text", text: JSON.stringify({ a: "constructor" }) }] } });
    call("t", {}, { result: { content: [{ type: "text", text: JSON.stringify({ a: "__proto__" }) }] } });
    const raw = readFileSync(path.join(outDir, "samples", "srv", "t.values.json"), "utf8");
    expect(raw).toContain('"constructor":1');
    expect(raw).toContain('"__proto__":1');
  });

  it("a map-like result (111 environment variables) writes no key names and no values to any file", () => {
    const { call, outDir } = setup();
    const env = Object.fromEntries(Array.from({ length: 111 }, (_, i) => [`PRIVATE_NAME_${i}`, `v${i % 4}`]));
    for (let i = 0; i < 3; i++) call("get-env", {}, { result: { content: [{ type: "text", text: JSON.stringify({ env, count: 111 }) }] } });
    const dir = path.join(outDir, "samples", "srv");
    const written = readdirSync(dir)
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    expect(written).not.toContain("PRIVATE_NAME_");
    expect(written).not.toMatch(/"v[0-3]"/);
    expect(written).toContain('"t":"map","n":111');
    const vf = JSON.parse(readFileSync(path.join(dir, "get-env.values.json"), "utf8")) as { fields: Record<string, unknown> };
    expect(Object.keys(vf.fields)).toEqual([]); // `count` is a number; the map gets no counters
  });

  it("remembers from tools/list which tools declare their own outputSchema (names and booleans only)", () => {
    const { rec, outDir } = setup();
    rec.fromClient({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    rec.fromServer({
      jsonrpc: "2.0",
      id: 7,
      result: {
        tools: [
          { name: "a", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { secret: {} } } },
          { name: "b", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        ],
      },
    });
    const raw = readFileSync(path.join(outDir, "samples", "srv", "_tools.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 1, tools: { a: { outputSchema: true }, b: { outputSchema: false, readOnlyHint: true } } });
    expect(raw).not.toContain("secret");
  });

  it("--no-observed-values writes no counters", () => {
    const { call, outDir } = setup({ observedValues: false });
    call("t", {}, { result: { content: [{ type: "text", text: '{"a":"x"}' }] } });
    expect(readdirSync(path.join(outDir, "samples", "srv"))).toEqual(["t.jsonl"]);
  });
});

describe("ensureGitignore", () => {
  it("adds the out dir when inside a git repo, once", () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, ".gitignore"), "node_modules");
    expect(ensureGitignore(dir, path.join(dir, ".typegen"))).toBe(".typegen/");
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.typegen/\n");
    expect(ensureGitignore(dir, path.join(dir, ".typegen"))).toBeUndefined();
  });

  it("does nothing outside a git repo, or when the line is already there", () => {
    const plain = tmpDir();
    expect(ensureGitignore(plain, path.join(plain, ".typegen"))).toBeUndefined();
    const repo = tmpDir();
    mkdirSync(path.join(repo, ".git"));
    writeFileSync(path.join(repo, ".gitignore"), ".typegen\r\n");
    expect(ensureGitignore(repo, path.join(repo, ".typegen"))).toBeUndefined();
  });

  it("adds nothing when a parent folder of the out dir is already ignored (found by M9 on real servers)", () => {
    const repo = tmpDir();
    mkdirSync(path.join(repo, ".git"));
    writeFileSync(path.join(repo, ".gitignore"), "node_modules\n.typegen\n");
    expect(ensureGitignore(repo, path.join(repo, ".typegen", "real-servers", "latest", "memory", "train"))).toBeUndefined();
    expect(readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.typegen\n");
    // an unrelated nested folder is still added
    expect(ensureGitignore(repo, path.join(repo, "out", "typegen"))).toBe("out/typegen/");
  });
});
