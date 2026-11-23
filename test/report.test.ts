import { appendFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, servingMode } from "../src/report.js";
import { SCHEMA_DIALECT, type JsonSchema } from "../src/infer/schema.js";
import { runInfer } from "../src/infer/run.js";
import { Recorder } from "../src/proxy/recorder.js";
import { CLI, startProcess, tmpDir } from "./helpers.js";
import { recordFixtureSchemas } from "./serve-helpers.js";

describe("report", () => {
  it("prints tools seen, samples, confidence, serve status and age", () => {
    const inDir = recordFixtureSchemas();
    const text = buildReport({ inDir }).join("\n");
    expect(text).toContain("json-fixture: 3 tools seen (1 high, 1 medium, 1 low confidence)");
    expect(text).toContain(
      "get_user: 12 samples, 12 arg sets, high confidence, v1, unwrap json-text, 0d old\n" +
        "    serving: open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)",
    );
    expect(text).toContain("list_items: 4 samples, 4 arg sets, medium confidence");
    const servingOf = (tool: string): string | undefined => {
      const lines = text.split("\n");
      const i = lines.findIndex((l) => l.startsWith(`  ${tool}: `));
      return lines[i + 1];
    };
    // an array root gets no structuredContent and cannot be declared
    expect(servingOf("list_items")).toBe("    serving: strict inference only (the result is not an object; serve passes results through)");
    expect(servingOf("rare")).toBe("    serving: strict inference only (low confidence; serve passes results through)");
    expect(text).not.toContain("served with outputSchema"); // the M9 wording, which was not true by default
    expect(text).toMatch(/rare: 1 samples, .*low confidence/);
    expect(text).toContain("low confidence: fewer than 3 samples; at most 1 distinct argument set");
  });

  it("states the true serving mode for each case (M9 finding: it said 'served with outputSchema' even by default)", () => {
    const obj: JsonSchema = { $schema: SCHEMA_DIALECT, type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    const base = { unwrap: "json-text" as const, confidence: "medium" as const, schema: obj, samples: 5 };
    expect(servingMode({ ...base, declaredOutputSchema: true })).toBe("server's own outputSchema (serve never replaces it)");
    expect(servingMode({ ...base, unwrap: "structuredContent" })).toBe("server's own structuredContent (serve leaves it as is)");
    expect(servingMode(base)).toBe("open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)");
    expect(servingMode({ ...base, declaredOutputSchema: false })).toContain("outputSchema declared only with --declare-schemas");
    expect(servingMode({ ...base, unwrap: "mixed", schema: { ...obj, type: ["object", "string"] } })).toBe(
      "open schema via serve (adds structuredContent to JSON object results; never declared as outputSchema: the result is not always an object)",
    );
    expect(servingMode({ ...base, confidence: "low" })).toBe("strict inference only (low confidence; serve passes results through)");
    expect(servingMode({ ...base, unwrap: "text", schema: { type: "string" } })).toBe(
      "strict inference only (the result is not an object; serve passes results through)",
    );
    expect(servingMode({ ...base, samples: 0, confidence: "low", unwrap: "none", schema: {} })).toBe(
      "strict inference only (no successful samples; serve passes results through)",
    );
  });

  it("reads the server's own outputSchema from the recorded tools/list", () => {
    const inDir = tmpDir();
    const rec = new Recorder({ outDir: inDir, name: "own", fallbackName: "own" });
    rec.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    rec.fromServer({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "declared", inputSchema: { type: "object" }, outputSchema: { type: "object" } }, { name: "plain", inputSchema: { type: "object" } }] },
    });
    for (let i = 0; i < 4; i++) {
      for (const tool of ["declared", "plain"]) {
        rec.fromClient({ jsonrpc: "2.0", id: 10 + i * 2 + (tool === "plain" ? 1 : 0), method: "tools/call", params: { name: tool, arguments: { i } } });
        rec.fromServer({ jsonrpc: "2.0", id: 10 + i * 2 + (tool === "plain" ? 1 : 0), result: { content: [{ type: "text", text: JSON.stringify({ i }) }] } });
      }
    }
    runInfer({ inDir });
    const lines = buildReport({ inDir });
    const servingOf = (tool: string): string | undefined => lines[lines.findIndex((l) => l.startsWith(`  ${tool}: `)) + 1];
    expect(servingOf("declared")).toBe("    serving: server's own outputSchema (serve never replaces it)");
    expect(servingOf("plain")).toBe(
      "    serving: open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)",
    );
  });

  it("warns about drift found by serve", () => {
    const inDir = recordFixtureSchemas();
    appendFileSync(
      path.join(inDir, "drift.jsonl"),
      `${JSON.stringify({ ts: "2026-11-22T10:00:00Z", source: "serve", server: "json-fixture", tool: "get_user", reason: "x" })}\n`,
    );
    const text = buildReport({ inDir }).join("\n");
    expect(text).toContain("drift warning: 1 mismatch(es) seen by serve");
  });

  it("shows how old the newest sample is", () => {
    const inDir = recordFixtureSchemas();
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    expect(buildReport({ inDir, now: later }).join("\n")).toContain("40d old");
  });

  it("is empty when nothing was inferred, and the CLI says what to do", async () => {
    expect(buildReport({ inDir: tmpDir() })).toEqual([]);
    const run = startProcess(process.execPath, ["--import", "tsx", CLI, "report", "--in", tmpDir()]);
    expect(await run.exited).toBe(1);
    const ok = startProcess(process.execPath, ["--import", "tsx", CLI, "report", "--in", recordFixtureSchemas()]);
    expect(await ok.exited).toBe(0);
    expect(ok.stdout().toString()).toContain("get_user");
  }, 60_000);
});
