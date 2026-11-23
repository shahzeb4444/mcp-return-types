// End to end: record real traffic to @modelcontextprotocol/server-everything through the
// proxy (as in M1), then run `infer` on the sample files it wrote.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInfer, type SchemasFile } from "../src/infer/run.js";
import { EVERYTHING, proxyCommand, tmpDir } from "./helpers.js";

describe("record -> infer against server-everything", () => {
  it("infers schemas, unwrap paths and error shapes from recorded samples", async () => {
    const outDir = tmpDir();
    const { command, args } = proxyCommand(outDir, [process.execPath, EVERYTHING, "stdio"]);
    const client = new Client({ name: "typegen-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command, args, stderr: "ignore" }));
    for (const location of ["Chicago", "New York", "Los Angeles"]) {
      await client.callTool({ name: "get-structured-content", arguments: { location } });
    }
    for (const [a, b] of [[1, 2], [3, 4]]) await client.callTool({ name: "get-sum", arguments: { a, b } });
    await client.callTool({ name: "echo", arguments: { message: "hi" } });
    await client.callTool({ name: "get-sum", arguments: { a: "x" } }).catch(() => undefined);
    await client.close();

    const result = runInfer({ inDir: outDir });
    expect(result.servers).toHaveLength(1);
    const server = result.servers[0]?.server as string;
    expect(readdirSync(path.join(outDir, "schemas"))).toEqual([`${server}.json`]);
    const file = JSON.parse(readFileSync(path.join(outDir, "schemas", `${server}.json`), "utf8")) as SchemasFile;

    const structured = file.tools["get-structured-content"];
    expect(structured).toMatchObject({ unwrap: "structuredContent", samples: 3, distinctArgs: 3, confidence: "medium" });
    expect(structured?.schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { temperature: { type: "integer" }, conditions: { type: "string" }, humidity: { type: "integer" } },
      required: ["temperature", "conditions", "humidity"],
      additionalProperties: false,
    });
    expect(file.tools.echo).toMatchObject({ unwrap: "text", schema: { type: "string" }, confidence: "low" });
    const sum = file.tools["get-sum"];
    expect(sum?.samples).toBe(2);
    expect((sum?.error?.samples ?? 0) + Object.keys(sum?.error?.rpcErrors ?? {}).length).toBeGreaterThan(0);
  }, 60_000);
});
