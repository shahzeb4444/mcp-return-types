// SPEC §7: the proxy adds under 5 ms median latency per call. Measured as the median of
// (round trip through the proxy - direct round trip) over N sequential `tools/call` requests to a local
// server. Direct and proxied calls alternate, so slow drift of the machine hits both the same.
//
//   npm run latency                 (record and serve on server-everything and on the mock GitHub server, 200 calls each)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVERYTHING = path.join(ROOT, "node_modules", "@modelcontextprotocol", "server-everything", "dist", "index.js");

export type LatencyMode = "record" | "serve";

export interface LatencyOptions {
  mode: LatencyMode;
  calls?: number;
  warmup?: number;
  /** Server to run behind the proxy and directly. Default: server-everything with its `echo` tool. */
  server?: { command: string; args: string[] };
  tool?: { name: string; args: Record<string, unknown> };
  /** Run the CLI from source through tsx instead of the built dist/cli.js (tests do, so they never measure a stale build). */
  source?: boolean;
  /** `.typegen` folder for the proxy (record writes there, serve reads there). */
  dir: string;
}

export interface LatencyResult {
  mode: LatencyMode;
  calls: number;
  medianAddedMs: number;
  p95AddedMs: number;
  directMedianMs: number;
  proxiedMedianMs: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] as number;
};

/** The CLI to measure: the built one when it exists (what users run), else the source through tsx. */
function cliCommand(source: boolean): { command: string; args: string[] } {
  const dist = path.join(ROOT, "dist", "cli.js");
  return existsSync(dist) && !source
    ? { command: process.execPath, args: [dist] }
    : { command: process.execPath, args: ["--import", "tsx", path.join(ROOT, "src", "cli.ts")] };
}

async function connect(command: string, args: string[]): Promise<Client> {
  const client = new Client({ name: "typegen-latency", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args, stderr: "ignore" }));
  return client;
}

export async function measureLatency(opts: LatencyOptions): Promise<LatencyResult> {
  const calls = opts.calls ?? 200;
  const warmup = opts.warmup ?? 20;
  const server = opts.server ?? { command: process.execPath, args: [EVERYTHING, "stdio"] };
  const tool = opts.tool ?? { name: "echo", args: { message: "latency" } };
  const cli = cliCommand(opts.source === true);
  const proxyArgs = [...cli.args, opts.mode, opts.mode === "record" ? "--out" : "--in", opts.dir, "--", server.command, ...server.args];

  const direct = await connect(server.command, server.args);
  const proxied = await connect(cli.command, proxyArgs);
  try {
    const timed = async (client: Client): Promise<number> => {
      const t0 = performance.now();
      await client.callTool({ name: tool.name, arguments: tool.args });
      return performance.now() - t0;
    };
    // The proxied client also lists tools first, like a real session (this makes serve load its schemas).
    await proxied.listTools();
    for (let i = 0; i < warmup; i++) {
      await timed(direct);
      await timed(proxied);
    }
    const added: number[] = [];
    const d: number[] = [];
    const p: number[] = [];
    for (let i = 0; i < calls; i++) {
      const a = await timed(direct);
      const b = await timed(proxied);
      d.push(a);
      p.push(b);
      added.push(b - a);
    }
    return {
      mode: opts.mode,
      calls,
      medianAddedMs: median(added),
      p95AddedMs: percentile(added, 0.95),
      directMedianMs: median(d),
      proxiedMedianMs: median(p),
    };
  } finally {
    await proxied.close();
    await direct.close();
  }
}

export const formatLatency = (r: LatencyResult, label: string = r.mode): string =>
  `${label}: median added latency ${r.medianAddedMs.toFixed(2)} ms over ${r.calls} calls ` +
  `(p95 ${r.p95AddedMs.toFixed(2)} ms; direct median ${r.directMedianMs.toFixed(2)} ms, via proxy ${r.proxiedMedianMs.toFixed(2)} ms)`;

/** The mock GitHub server (M4) with its injected latency set to 0, as SPEC §7 asks for once it exists. */
export const MOCK_SERVER_COMMAND = {
  command: process.execPath,
  args: ["--import", "tsx", path.join(ROOT, "bench", "mock-server", "server.ts"), "--seed", "2", "--latency", "0"],
};
export const MOCK_TOOL = { name: "list_issues", args: { repo: "acme/api", state: "all", page: 2 } };

async function main(): Promise<void> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { runInfer } = await import("../src/infer/run.js");
  for (const mode of ["record", "serve"] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), "typegen-latency-"));
    console.log(formatLatency(await measureLatency({ mode, dir }), `${mode} (server-everything, echo)`));
  }
  // Mock GitHub server, latency 0: record, then infer, then serve the same folder (parse + validate + structuredContent).
  const dir = mkdtempSync(path.join(tmpdir(), "typegen-latency-mock-"));
  const label = "(mock github, list_issues page of 50)";
  console.log(formatLatency(await measureLatency({ mode: "record", dir, server: MOCK_SERVER_COMMAND, tool: MOCK_TOOL }), `record ${label}`));
  runInfer({ inDir: dir });
  console.log(formatLatency(await measureLatency({ mode: "serve", dir, server: MOCK_SERVER_COMMAND, tool: MOCK_TOOL }), `serve  ${label}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
