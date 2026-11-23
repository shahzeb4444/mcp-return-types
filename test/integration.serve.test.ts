import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasClosedObject } from "../src/emit/open.js";
import { CLI, EVERYTHING, tmpDir } from "./helpers.js";
import { respond } from "./fixtures/json-logic.js";
import { connectThrough, FIXTURE_COMMAND, recordFixtureSchemas, serveCommand } from "./serve-helpers.js";

const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;
const structured = (r: unknown): unknown => (r as { structuredContent?: unknown }).structuredContent;
const errorMessage = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "";
  } catch (e) {
    return String((e as Error).message);
  }
};

describe("serve against the fixture server, with the real SDK client (strict: it validates outputSchema)", () => {
  const inDir = recordFixtureSchemas();

  it("--declare-schemas declares an open outputSchema; matching results carry structuredContent that the client validates", async () => {
    const { command, args } = serveCommand(inDir, FIXTURE_COMMAND, ["--declare-schemas"]);
    const client = await connectThrough(command, args);
    try {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.get_user?.outputSchema).toMatchObject({ type: "object" });
      expect(hasClosedObject(byName.get_user?.outputSchema)).toBe(false);
      expect(byName.rare?.outputSchema).toBeUndefined();
      expect(byName.list_items?.outputSchema).toBeUndefined();

      const ok = await client.callTool({ name: "get_user", arguments: { id: "a1" } });
      expect(structured(ok)).toEqual(JSON.parse(text(ok)));
      expect(structured(ok)).toMatchObject({ id: "a1", name: "Ada" });

      // A harmless new field must not break a strict client: the schema is open.
      const extra = await client.callTool({ name: "get_user", arguments: { id: "extra" } });
      expect(structured(extra)).toMatchObject({ brandNew: { nested: true } });

      // Tools that were not declared behave exactly as without serve.
      const rare = await client.callTool({ name: "rare", arguments: {} });
      expect(structured(rare)).toBeUndefined();
      expect(JSON.parse(text(rare))).toEqual({ v: 1 });
      const items = await client.callTool({ name: "list_items", arguments: { page: 1 } });
      expect(JSON.parse(text(items))).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("FINDING (why declaring is opt-in): a strict client rejects a declared tool whose result had to be passed through; isError is exempt", async () => {
    const { command, args } = serveCommand(inDir, FIXTURE_COMMAND, ["--declare-schemas"]);
    const client = await connectThrough(command, args);
    try {
      await client.listTools(); // the SDK client caches an output validator per declared outputSchema
      // Mismatch (wrong type): serve fails open, passes the result through without structuredContent ...
      const bad = await errorMessage(client.callTool({ name: "get_user", arguments: { id: "bad" } }));
      // ... and the SDK client throws, because the tool declared an outputSchema.
      expect(bad).toContain("has an output schema but did not return structured content");
      // Same for text that is no longer JSON.
      expect(await errorMessage(client.callTool({ name: "get_user", arguments: { id: "plain" } }))).toContain(
        "has an output schema but did not return structured content",
      );
      // isError results are exempt in the client, so errors still reach the model.
      const err = await client.callTool({ name: "get_user", arguments: { id: "err" } });
      expect((err as { isError?: boolean }).isError).toBe(true);
      expect(structured(err)).toBeUndefined();
      // The mismatch was logged as drift.
      const lines = readFileSync(path.join(inDir, "drift.jsonl"), "utf8").trim().split("\n");
      expect(lines.some((l) => (JSON.parse(l) as { source: string; tool: string }).source === "serve")).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  for (const extra of [[], ["--no-output-schema"]]) {
    const label = extra.length ? "--no-output-schema (alias of the default)" : "the default";
    it(`${label} keeps structuredContent but declares nothing, so the same mismatch is harmless`, async () => {
      const { command, args } = serveCommand(inDir, FIXTURE_COMMAND, extra);
      const client = await connectThrough(command, args);
      try {
        const { tools } = await client.listTools();
        expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
        const ok = await client.callTool({ name: "get_user", arguments: { id: "a1" } });
        expect(structured(ok)).toMatchObject({ id: "a1" });
        const bad = await client.callTool({ name: "get_user", arguments: { id: "bad" } });
        expect(structured(bad)).toBeUndefined();
        expect(JSON.parse(text(bad))).toMatchObject({ id: "bad", name: 123 });
        // Text that is no longer JSON also reaches the client unchanged.
        const plain = await client.callTool({ name: "get_user", arguments: { id: "plain" } });
        expect(text(plain)).toBe(respond("get_user", { id: "plain" }).content[0]?.text);
      } finally {
        await client.close();
      }
    }, 60_000);
  }

  it("rejects --declare-schemas together with --no-output-schema", async () => {
    const { main } = await import("../src/cli.js");
    const write = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((c: string) => ((stderr += c), true)) as typeof process.stderr.write;
    try {
      expect(await main(["serve", "--declare-schemas", "--no-output-schema", "--", "node"])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(stderr).toContain("contradict");
  });

  it("with no schemas at all it is a transparent proxy", async () => {
    const { command, args } = serveCommand(tmpDir("typegen-none-"), FIXTURE_COMMAND);
    const proxied = await connectThrough(command, args);
    const direct = await connectThrough(FIXTURE_COMMAND[0] as string, FIXTURE_COMMAND.slice(1));
    try {
      expect(await proxied.listTools()).toEqual(await direct.listTools());
      for (const id of ["a1", "bad", "plain", "err", "array"]) {
        expect(await proxied.callTool({ name: "get_user", arguments: { id } })).toEqual(
          await direct.callTool({ name: "get_user", arguments: { id } }),
        );
      }
    } finally {
      await proxied.close();
      await direct.close();
    }
  }, 60_000);
});

describe("serve against @modelcontextprotocol/server-everything", () => {
  it("forwards a normal session unchanged, and `report` reads what record and infer produced", async () => {
    const out = tmpDir("typegen-everything-");
    // Record some traffic first, with the real record proxy.
    const rec = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", CLI, "record", "--out", out, "--", process.execPath, EVERYTHING, "stdio"],
      stderr: "ignore",
    });
    const recClient = new Client({ name: "t", version: "0" });
    await recClient.connect(rec);
    for (const m of ["a", "bb", "ccc", "dddd"]) await recClient.callTool({ name: "echo", arguments: { message: m } });
    await recClient.close();
    expect(existsSync(path.join(out, "samples"))).toBe(true);

    const { runInfer } = await import("../src/infer/run.js");
    expect(runInfer({ inDir: out }).servers).toHaveLength(1);

    const { command, args } = serveCommand(out, [process.execPath, EVERYTHING, "stdio"]);
    const client = await connectThrough(command, args);
    try {
      // echo is plain text (not JSON): nothing is declared, nothing is added.
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "echo")?.outputSchema).toBeUndefined();
      const r = await client.callTool({ name: "echo", arguments: { message: "hi" } });
      expect(text(r)).toBe("Echo: hi");
      expect(structured(r)).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 90_000);
});
