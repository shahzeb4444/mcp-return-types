// M10: `mcp-return-types quickstart` end to end, run as a real CLI process (as from PowerShell or Git Bash).
// Servers: a fixture that logs every call it receives, @modelcontextprotocol/server-everything (pinned,
// from node_modules) and the local mock GitHub server (its write log proves nothing was written).
import spawn from "cross-spawn";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, EVERYTHING, ROOT, tmpDir } from "./helpers.js";
import { compileTs } from "./tsc-helper.js";

const FIXTURE = path.join(ROOT, "test", "fixtures", "quickstart-server.ts");
const MOCK = path.join(ROOT, "bench", "mock-server", "server.ts");

function quickstart(own: string[], server: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "quickstart", ...own, "--", ...server], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const calledTools = (log: string): string[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => (JSON.parse(l) as { tool: string }).tool)
    : [];

describe("quickstart against a fixture server that logs every call", () => {
  const server = [process.execPath, "--import", "tsx", FIXTURE];

  it("--dry-run prints the plan, calls nothing and writes nothing", async () => {
    const dir = tmpDir("typegen-qs-");
    const out = path.join(dir, "tg");
    const log = path.join(dir, "calls.jsonl");
    const r = await quickstart(["--out", out, "--dry-run"], server, { QS_CALL_LOG: log });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Plan: call 2 tool(s) 3 time(s) each, skip 4.");
    expect(r.stdout).toContain('  call  get_thing (readOnlyHint) x3: {"kind":"a"} {"kind":"b"} {"kind":"a","page":1}');
    expect(r.stdout).toContain("  skip  delete_everything: not marked read-only");
    expect(r.stdout).toContain("Dry run: nothing was called and nothing was written.");
    expect(existsSync(log)).toBe(false);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("by default calls only the read-only tools, then writes types that compile and explains the skipped ones", async () => {
    const dir = tmpDir("typegen-qs-");
    const out = path.join(dir, "tg");
    const log = path.join(dir, "calls.jsonl");
    const r = await quickstart(["--out", out], server, { QS_CALL_LOG: log });
    expect(r.code, r.stderr).toBe(0);
    const called = calledTools(log);
    expect(new Set(called)).toEqual(new Set(["list_things", "get_thing"]));
    expect(called).toHaveLength(6); // --calls defaults to 3
    const types = path.join(out, "types");
    expect(readdirSync(types).sort()).toEqual(["qs-fixture.codemode.d.ts", "qs-fixture.d.ts"]);
    const dts = readFileSync(path.join(types, "qs-fixture.d.ts"), "utf8");
    expect(dts).toContain("export type GetThingResult = {");
    const tsc = compileTs(types, ["qs-fixture.d.ts", "qs-fixture.codemode.d.ts"]);
    expect(tsc.ok, tsc.output).toBe(true);
    expect(r.stdout).toMatch(/Types: +.*qs-fixture\.d\.ts \(2 tool\(s\) with inferred result types\)/);
    expect(r.stdout).toContain("Coverage:");
    expect(r.stdout).toContain("get_thing: 3 samples, 3 arg sets, medium confidence");
    expect(r.stdout).toContain("Code Mode snippet");
    expect(r.stdout).toContain("): Promise<GetThingResult>;");
    expect(r.stdout).toContain("Not typed (4):");
    expect(r.stdout).toContain('  - find_thing: required argument "q" (string) has no default');
    expect(r.stdout).toContain("  - wipe: marked destructive");
    expect(r.stdout).toMatch(/mcp-return-types record --out \S+ -- /);
    expect(r.stdout).toContain('"command": "mcp-return-types"');
  }, 60_000);

  it("--tools calls exactly the listed tools, even one without annotations, with --calls N", async () => {
    const dir = tmpDir("typegen-qs-");
    const log = path.join(dir, "calls.jsonl");
    const r = await quickstart(["--out", path.join(dir, "tg"), "--tools", "delete_everything", "--calls", "1"], server, { QS_CALL_LOG: log });
    expect(r.code, r.stderr).toBe(0);
    expect(calledTools(log)).toEqual(["delete_everything"]);
    expect(r.stdout).toContain("  - list_things: not listed in --tools");
  }, 60_000);

  it("rejects bad options with exit code 2", async () => {
    expect((await quickstart(["--calls", "0"], server)).code).toBe(2);
    expect((await quickstart(["--tools", ","], server)).code).toBe(2);
    const noServer = await quickstart([], []);
    expect(noServer.code).toBe(2);
    expect(noServer.stderr).toContain('missing server command after "--"');
  }, 60_000);
});

describe("quickstart against @modelcontextprotocol/server-everything", () => {
  it("calls only the read-only tools it can give arguments to, and types get-env as a map with no names", async () => {
    const out = path.join(tmpDir("typegen-qs-"), "tg");
    const r = await quickstart(["--out", out, "--calls", "1"], [process.execPath, EVERYTHING, "stdio"]);
    expect(r.code, r.stderr).toBe(0);
    const [serverDir] = readdirSync(path.join(out, "samples"));
    const recorded = readdirSync(path.join(out, "samples", serverDir as string))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();
    // server-everything 1.0.0: read-only tools with no required argument, or a required enum
    expect(recorded).toEqual([
      "get-annotated-message",
      "get-env",
      "get-resource-links",
      "get-resource-reference",
      "get-structured-content",
      "get-tiny-image",
      "trigger-long-running-operation",
    ]);
    expect(r.stdout).toContain('  - echo: required argument "message" (string)');
    expect(r.stdout).toContain("  - toggle-simulated-logging: may have side effects (annotations.readOnlyHint is false)");
    const types = path.join(out, "types");
    const dtsFile = readdirSync(types).find((f) => f.endsWith(".d.ts") && !f.endsWith(".codemode.d.ts")) as string;
    const dts = readFileSync(path.join(types, dtsFile), "utf8");
    expect(dts).toContain("export type GetEnvResult = { [key: string]: string };");
    for (const name of ["PATH", "Path", "USERPROFILE", "HOME", "SystemRoot"].filter((n) => process.env[n] !== undefined)) {
      expect(dts).not.toContain(name);
      expect(readFileSync(path.join(out, "samples", serverDir as string, "get-env.jsonl"), "utf8")).not.toContain(name);
    }
    expect(compileTs(types, readdirSync(types)).ok).toBe(true);
    expect(r.stdout).toContain("Promise<GetStructuredContentResult>");
    expect(r.stdout).toContain("serving: server's own outputSchema (serve never replaces it)"); // get-structured-content
  }, 90_000);
});

describe("quickstart against the local mock GitHub server (no annotations)", () => {
  const mock = (writeLog: string) => [process.execPath, "--import", "tsx", MOCK, "--seed", "1", "--latency", "0", "--write-log", writeLog];

  it("calls nothing by default (no tool is marked read-only), writes nothing, and says how to record", async () => {
    const dir = tmpDir("typegen-qs-");
    const writes = path.join(dir, "writes.jsonl");
    const out = path.join(dir, "tg");
    const r = await quickstart(["--out", out], mock(writes));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Plan: call 0 tool(s) 3 time(s) each, skip 38.");
    expect(r.stdout).toContain("No tool returned a successful result, so no types were written.");
    expect(r.stdout).toContain("Not typed (38):");
    expect(r.stdout).toContain("To type these, record them through your real MCP client");
    expect(readFileSync(writes, "utf8")).toBe("");
    expect(existsSync(path.join(out, "types"))).toBe(false);
  }, 60_000);

  it("with --tools, calls the listed tools that need no free-form arguments; a listed write tool without derivable arguments is skipped", async () => {
    const dir = tmpDir("typegen-qs-");
    const writes = path.join(dir, "writes.jsonl");
    const out = path.join(dir, "tg");
    const r = await quickstart(["--out", out, "--tools", "ci_list_runners,chat_list_channels,list_issues,ci_retry_job"], mock(writes));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  called ci_list_runners: 3 ok");
    expect(r.stdout).toContain("  called chat_list_channels: 3 ok");
    expect(r.stdout).toContain('  - list_issues: required argument "repo" (string)');
    expect(r.stdout).toContain('  - ci_retry_job: required argument "id" (integer)');
    expect(readFileSync(writes, "utf8")).toBe(""); // no write tool ran
    const dts = readFileSync(path.join(out, "types", "mock-github.d.ts"), "utf8");
    expect(dts).toContain("export type CiListRunnersResult =");
    expect(compileTs(path.join(out, "types"), ["mock-github.d.ts", "mock-github.codemode.d.ts"]).ok).toBe(true);
  }, 60_000);
});
