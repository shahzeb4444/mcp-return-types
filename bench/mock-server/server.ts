// Mock GitHub MCP server for the benchmark (BENCHMARK.md workload). stdio, official SDK, NO outputSchema:
// every result is a JSON string in content[0].text, as many real servers do.
//
//   tsx bench/mock-server/server.ts --seed 2 [--latency 150] [--write-log <file>] [--tools all|real]
//
// `--tools real` (M11 plain-MCP test) lists and serves only the 8 real GitHub tools; the default `all` adds the
// 30 distractors, as in the Code Mode benchmark.
//
// Every process starts from the fresh seeded state, so no run sees another run's writes. The write log
// file (if given) is truncated at start and gets one JSON line per write call.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildWorld, type World } from "./data.js";
import { callDistractor, DISTRACTOR_TOOLS } from "./distractors.js";
import { callGithubTool, GITHUB_TOOLS, type ToolDef } from "./github.js";
import { WriteLog } from "./writelog.js";

export const DEFAULT_LATENCY_MS = 150;
export const ALL_TOOLS: ToolDef[] = [...GITHUB_TOOLS, ...DISTRACTOR_TOOLS];
const REAL = new Set(GITHUB_TOOLS.map((t) => t.name));
const WRITES = new Set(ALL_TOOLS.filter((t) => t.write).map((t) => t.name));
/** Tools whose result is plain text, not JSON. */
const TEXT_TOOLS = new Set(["ci_get_job_log"]);

export type ToolSet = "all" | "real";

export interface MockOptions {
  seed: number;
  latencyMs?: number;
  writeLogFile?: string;
  /** Default `all` (real + distractors); `real` = only the 8 real tools (a distractor name is then unknown). */
  toolSet?: ToolSet;
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** The server logic without transport (used by the stdio server and by tests). */
export class MockGithub {
  readonly world: World;
  readonly log: WriteLog;

  constructor(readonly opts: MockOptions) {
    this.world = buildWorld(opts.seed);
    this.log = new WriteLog(opts.writeLogFile);
  }

  listTools(): { name: string; description: string; inputSchema: ToolDef["inputSchema"] }[] {
    const tools = this.opts.toolSet === "real" ? GITHUB_TOOLS : ALL_TOOLS;
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  call(name: string, rawArgs: unknown): CallResult {
    if (this.opts.toolSet === "real" && !REAL.has(name)) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    const out = REAL.has(name) ? callGithubTool(this.world, name, args) : callDistractor(this.world, name, args);
    if (WRITES.has(name)) {
      this.log.add(out.ok ? { tool: name, args, ok: true, changed: "changed" in out ? out.changed !== false : true } : { tool: name, args, ok: false, error: out.error });
    }
    if (!out.ok) return { isError: true, content: [{ type: "text", text: out.error }] };
    const text = TEXT_TOOLS.has(name) && typeof out.value === "string" ? out.value : JSON.stringify(out.value);
    return { content: [{ type: "text", text }] };
  }
}

export async function startStdio(opts: MockOptions): Promise<void> {
  const mock = new MockGithub(opts);
  const latency = opts.latencyMs ?? DEFAULT_LATENCY_MS;
  const server = new Server({ name: "mock-github", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mock.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    return mock.call(req.params.name, req.params.arguments) as never;
  });
  const transport = new StdioServerTransport();
  // Exit when the client goes away (stdin EOF), so no process is left behind.
  process.stdin.on("end", () => process.exit(0));
  await server.connect(transport);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const { values } = parseArgs({
    options: { seed: { type: "string", default: "2" }, latency: { type: "string" }, "write-log": { type: "string" }, tools: { type: "string", default: "all" } },
    strict: true,
  });
  const seed = Number(values.seed);
  const latencyMs = values.latency === undefined ? DEFAULT_LATENCY_MS : Number(values.latency);
  if (!Number.isInteger(seed) || !(latencyMs >= 0) || (values.tools !== "all" && values.tools !== "real")) {
    process.stderr.write("usage: server.ts --seed <int> [--latency <ms>] [--write-log <file>] [--tools all|real]\n");
    process.exit(2);
  }
  await startStdio({ seed, latencyMs, writeLogFile: values["write-log"], toolSet: values.tools as ToolSet });
}
