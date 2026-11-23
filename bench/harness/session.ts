// One benchmark run's view of the mock GitHub server: a FRESH server process on seed 2 per run (fresh
// state, its own write log), the tool list for the stubs, and the tool caller with the shared unwrap
// (identical in arms C and D). Tests can use `inProcessSession` (the same server logic, no process).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StubTool } from "../../src/codemode/stubs.js";
import { MockGithub } from "../mock-server/server.js";
import { readWriteLog, type WriteEntry } from "../mock-server/writelog.js";
import type { ToolOutcome } from "./sandbox.js";

const MOCK_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mock-server", "server.ts");

export interface Session {
  tools: StubTool[];
  callTool(name: string, args: unknown): Promise<ToolOutcome>;
  writes(): WriteEntry[];
  close(): Promise<void>;
}

export interface SessionOptions {
  seed: number;
  latencyMs: number;
}
export type OpenSession = (opts: SessionOptions) => Promise<Session>;

interface RawResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** The shared unwrap (BENCHMARK.md): structuredContent, else the joined text parsed as JSON, else the raw text. */
export function unwrapResult(r: RawResult): ToolOutcome {
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (r.isError) return { ok: false, error: text || "the tool returned an error" };
  if (r.structuredContent !== undefined) return { ok: true, value: r.structuredContent };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: true, value: text };
  }
}

const isArgs = (a: unknown): a is Record<string, unknown> => typeof a === "object" && a !== null && !Array.isArray(a);
const NOT_OBJECT: ToolOutcome = { ok: false, error: "tool arguments must be an object, e.g. tools.get_issue({ repo, number })" };

export const stdioSession: OpenSession = async ({ seed, latencyMs }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-run-"));
  const logFile = path.join(dir, "writes.jsonl");
  const client = new Client({ name: "mcp-return-types-bench", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", MOCK_SERVER, "--seed", String(seed), "--latency", String(latencyMs), "--write-log", logFile],
      stderr: "inherit",
    }),
  );
  const { tools } = await client.listTools();
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async callTool(name, args) {
      if (args !== undefined && !isArgs(args)) return NOT_OBJECT;
      try {
        return unwrapResult((await client.callTool({ name, arguments: args ?? {} })) as RawResult);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    writes: () => readWriteLog(logFile),
    async close() {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Same server logic in this process, no stdio and no latency (unit tests). */
export const inProcessSession: OpenSession = async ({ seed }) => {
  const mock = new MockGithub({ seed });
  return {
    tools: mock.listTools(),
    async callTool(name, args) {
      if (args !== undefined && !isArgs(args)) return NOT_OBJECT;
      if (!mock.listTools().some((t) => t.name === name)) return { ok: false, error: `MCP error -32602: Tool ${name} not found` };
      return unwrapResult(mock.call(name, args ?? {}));
    },
    writes: () => mock.log.entries,
    async close() {},
  };
};
