import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { runInfer } from "../src/infer/run.js";
import { Recorder } from "../src/proxy/recorder.js";
import { CLI, ROOT, tmpDir } from "./helpers.js";
import { respond } from "./fixtures/json-logic.js";

export const JSON_SERVER = path.join(ROOT, "test", "fixtures", "json-server.ts");

/** Command + args that run `mcp-return-types serve` from source in front of the given server command. */
export function serveCommand(inDir: string, server: string[], extra: string[] = []): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["--import", "tsx", CLI, "serve", "--in", inDir, ...extra, "--", ...server],
  };
}

export const FIXTURE_COMMAND = [process.execPath, "--import", "tsx", JSON_SERVER];

/**
 * Record realistic traffic of the fixture server in-process (the same Recorder `record` uses) and run
 * `infer`. Result: get_user = high confidence with an optional `email`, list_items = medium with an
 * array root, rare = low. Returns the `.typegen` folder.
 */
export function recordFixtureSchemas(): string {
  const inDir = tmpDir("typegen-serve-");
  const rec = new Recorder({ outDir: inDir, name: "json-fixture", fallbackName: "json-fixture" });
  let id = 0;
  const call = (tool: string, args: Record<string, unknown>): void => {
    id += 1;
    rec.fromClient({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
    rec.fromServer({ jsonrpc: "2.0", id, result: respond(tool, args) });
  };
  for (const user of ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9m", "u10m", "u11", "u12"]) call("get_user", { id: user });
  for (const page of [1, 2, 3, 4]) call("list_items", { page });
  call("rare", {});
  const result = runInfer({ inDir });
  if (result.servers.length !== 1) throw new Error("expected one server");
  return inDir;
}

export async function connectThrough(command: string, args: string[]): Promise<Client> {
  const client = new Client({ name: "typegen-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args, stderr: "ignore" }));
  return client;
}
