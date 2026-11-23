import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Sample } from "../src/proxy/recorder.js";
import { EVERYTHING, proxyCommand, tmpDir } from "./helpers.js";

type Outcome = { ok: unknown } | { error: { code?: number; message: string } };
type Progress = { progress: number; total?: number; message?: string };

async function connect(command: string, args: string[]): Promise<Client> {
  const client = new Client({ name: "typegen-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args, stderr: "ignore" }));
  return client;
}

async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (e) {
    const err = e as { code?: number; message?: string };
    return { error: { code: err.code, message: String(err.message) } };
  }
}

/** Everything the scenario does, against whichever endpoint the client is connected to. */
async function scenario(client: Client): Promise<Record<string, Outcome | Progress[]>> {
  const progress: Progress[] = [];
  const results: Record<string, Outcome | Progress[]> = {};
  results.tools = await attempt(() => client.listTools());
  results.echo = await attempt(() => client.callTool({ name: "echo", arguments: { message: "hello proxy" } }));
  results.sum = await attempt(() => client.callTool({ name: "get-sum", arguments: { a: 40, b: 2 } }));
  results.structured = await attempt(() =>
    client.callTool({ name: "get-structured-content", arguments: { location: "Chicago" } }),
  );
  results.invalidArgs = await attempt(() => client.callTool({ name: "get-sum", arguments: { a: "x" } }));
  results.unknownTool = await attempt(() => client.callTool({ name: "no-such-tool", arguments: {} }));
  results.longRunning = await attempt(() =>
    client.callTool(
      { name: "trigger-long-running-operation", arguments: { duration: 0.4, steps: 2 } },
      undefined,
      { onprogress: (p) => progress.push({ progress: p.progress, total: p.total, message: p.message }) },
    ),
  );
  results.progress = progress;
  return results;
}

describe("record proxy against @modelcontextprotocol/server-everything", () => {
  it("returns the same results, errors and notifications as a direct connection, and writes shape-only samples", async () => {
    const direct = await connect(process.execPath, [EVERYTHING, "stdio"]);
    const directResults = await scenario(direct);
    await direct.close();

    const outDir = tmpDir();
    const { command, args } = proxyCommand(outDir, [process.execPath, EVERYTHING, "stdio"]);
    const proxied = await connect(command, args);
    const proxiedResults = await scenario(proxied);
    await proxied.close();

    // Sanity: the scenario really exercised successes, errors and notifications.
    expect(directResults.echo).toHaveProperty("ok");
    expect((directResults.progress as Progress[]).length).toBeGreaterThan(0);
    const failed = (o: unknown): boolean =>
      "error" in (o as object) || (o as { ok: { isError?: boolean } }).ok.isError === true;
    expect(failed(directResults.invalidArgs)).toBe(true);
    expect(directResults.unknownTool).toSatisfy(failed);

    // The point of the milestone: identical to a direct call.
    // Progress events are compared separately: server-everything sometimes sends its last progress
    // notification after the result, and the SDK client then drops it (see NOTES.md). Everything
    // else must still be exactly equal.
    const { progress: directProgress, ...directRest } = directResults;
    const { progress: proxiedProgress, ...proxiedRest } = proxiedResults;
    expect(proxiedRest).toEqual(directRest);
    const dp = directProgress as Progress[];
    const pp = proxiedProgress as Progress[];
    expect(pp.length).toBeGreaterThanOrEqual(1);
    const common = Math.min(dp.length, pp.length);
    expect(pp.slice(0, common)).toEqual(dp.slice(0, common));

    // Sample files exist, one folder for the one server.
    const servers = readdirSync(path.join(outDir, "samples"));
    expect(servers).toHaveLength(1);
    const dir = path.join(outDir, "samples", servers[0] as string);
    const read = (tool: string): Sample[] =>
      readFileSync(path.join(dir, `${tool}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Sample);

    const [echo] = read("echo");
    expect(echo).toMatchObject({ unwrap: "text", isError: false, blocks: ["text"] });
    const [structured] = read("get-structured-content");
    expect(structured).toMatchObject({ unwrap: "structuredContent", isError: false });
    expect(structured?.shape).toEqual({
      t: "object",
      keys: {
        temperature: { t: "integer" },
        conditions: { t: "string", len: "medium" },
        humidity: { t: "integer" },
      },
    });
    expect(read("get-sum").length).toBeGreaterThanOrEqual(2); // success and invalid-args error
    expect(readdirSync(dir)).toContain("trigger-long-running-operation.jsonl");

    // Shape-only: no raw result or argument values in any sample file.
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      const text = readFileSync(path.join(dir, f), "utf8");
      for (const secret of ["hello proxy", "Echo:", "Chicago", "drizzle"]) expect(text).not.toContain(secret);
    }
  }, 60_000);
});
