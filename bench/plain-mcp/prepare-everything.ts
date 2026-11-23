// Builds the inferred schemas that arm S uses in the plain-MCP "no harm" check on server-everything
// (bench/plain-mcp/everything/schemas/everything.json, committed so the check is reproducible). No model:
// a scripted session through `mcp-return-types record`, then `infer`.
//
//   npm run bench:plain:prepare
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInfer } from "../../src/infer/run.js";
import { CLI_SOURCE, EVERYTHING_SERVER, ROOT, SCHEMA_NAME, SCHEMAS_FILE } from "./config.js";

/** Varied arguments, enough for high confidence (>= 10 samples, >= 3 distinct argument sets). */
export const PREPARE_CALLS: { name: string; arguments: Record<string, unknown> }[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ name: "echo", arguments: { message: `warm-up message ${i}` } })),
  ...Array.from({ length: 10 }, (_, i) => ({ name: "get-sum", arguments: { a: i * 3, b: i + 0.5 } })),
  ...["New York", "Chicago", "Los Angeles", "New York", "Chicago", "Los Angeles", "Chicago", "New York", "Los Angeles", "Chicago"].map((location) => ({
    name: "get-structured-content",
    arguments: { location },
  })),
];

export async function prepareEverything(opts: { out?: string; log?: (s: string) => void } = {}): Promise<string> {
  const name = SCHEMA_NAME.everything;
  const out = opts.out ?? SCHEMAS_FILE.everything;
  const log = opts.log ?? ((s: string) => console.log(s));
  const rec = mkdtempSync(path.join(tmpdir(), "plain-mcp-prepare-"));
  try {
    const client = new Client({ name: "plain-mcp-prepare", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", CLI_SOURCE, "record", "--out", rec, "--name", name, "--kill-timeout", "500", "--", process.execPath, EVERYTHING_SERVER, "stdio"],
        cwd: ROOT,
        stderr: "inherit",
      }),
    );
    for (const c of PREPARE_CALLS) await client.callTool(c);
    await client.close();
    await new Promise((r) => setTimeout(r, 300)); // let the recorder finish writing
    const inferred = runInfer({ inDir: rec, servers: [name] });
    const server = inferred.servers.find((s) => s.server === name);
    if (!server) throw new Error(`infer produced no schemas for ${name}`);
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(path.join(rec, "schemas", `${name}.json`), out);
    log(`prepare: ${PREPARE_CALLS.length} calls recorded; wrote ${path.relative(process.cwd(), out) || out}`);
    return out;
  } finally {
    rmSync(rec, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareEverything().then(
    () => undefined,
    (e: unknown) => {
      process.stderr.write(`prepare: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
