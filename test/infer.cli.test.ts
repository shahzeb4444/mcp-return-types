// `mcp-return-types infer`: reads sample files (CRLF-safe), writes .typegen/schemas/<server>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { readSamples, type SchemasFile } from "../src/infer/run.js";
import { tmpDir } from "./helpers.js";
import { sample } from "./infer-helpers.js";

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return fn().finally(() => {
    out.mockRestore();
    err.mockRestore();
  });
}

describe("infer command", () => {
  it("reads CRLF sample files, skips broken lines, and writes one schemas file per server", async () => {
    const inDir = tmpDir();
    for (const server of ["alpha", "beta"]) {
      const dir = path.join(inDir, "samples", server);
      mkdirSync(dir, { recursive: true });
      const lines = [sample({ id: 1 }, { tool: "get" }), sample({ id: 2, name: "x" }, { tool: "get" })].map((s) =>
        JSON.stringify(s),
      );
      writeFileSync(path.join(dir, "get.jsonl"), `${lines.join("\r\n")}\r\n{"v":1,"tool":"get","trunc\r\n\r\n`);
    }
    expect(readSamples(path.join(inDir, "samples", "alpha", "get.jsonl"))).toMatchObject({ skipped: 1 });

    const code = await quiet(() => main(["infer", "--in", inDir]));
    expect(code).toBe(0);
    for (const server of ["alpha", "beta"]) {
      const out = JSON.parse(readFileSync(path.join(inDir, "schemas", `${server}.json`), "utf8")) as SchemasFile;
      expect(out).toMatchObject({ v: 1, server });
      expect(out.tools.get).toMatchObject({
        tool: "get",
        version: 1,
        samples: 2,
        unwrap: "json-text",
        confidence: "low",
        schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["id"] },
      });
    }
  });

  it("exits 1 with a hint when there are no samples", async () => {
    expect(await quiet(() => main(["infer", "--in", tmpDir()]))).toBe(1);
  });

  it("rejects unknown flags with exit code 2", async () => {
    expect(await quiet(() => main(["infer", "--bogus"]))).toBe(2);
  });
});
