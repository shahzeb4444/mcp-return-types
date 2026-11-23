import { describe, expect, it } from "vitest";
import { formatLatency, measureLatency, MOCK_SERVER_COMMAND, MOCK_TOOL } from "../bench/latency.js";
import { runInfer } from "../src/infer/run.js";
import { tmpDir } from "./helpers.js";
import { FIXTURE_COMMAND, recordFixtureSchemas } from "./serve-helpers.js";

// SPEC §7 / PROGRESS M3: median added latency under 5 ms over 200 sequential calls.
const LIMIT_MS = 5;

describe("proxy latency (SPEC §7)", () => {
  it("record adds under 5 ms median over 200 calls (server-everything, echo)", async () => {
    const r = await measureLatency({ mode: "record", dir: tmpDir("typegen-lat-"), calls: 200, source: true });
    console.log(formatLatency(r, "record  (server-everything, echo)"));
    expect(r.calls).toBe(200);
    expect(r.medianAddedMs).toBeLessThan(LIMIT_MS);
  }, 120_000);

  it("serve adds under 5 ms median over 200 calls (server-everything, echo)", async () => {
    const r = await measureLatency({ mode: "serve", dir: tmpDir("typegen-lat-"), calls: 200, source: true });
    console.log(formatLatency(r, "serve   (server-everything, echo)"));
    expect(r.medianAddedMs).toBeLessThan(LIMIT_MS);
  }, 120_000);

  it("serve with schemas (parse, validate, add structuredContent) also stays under 5 ms", async () => {
    const r = await measureLatency({
      mode: "serve",
      dir: recordFixtureSchemas(),
      calls: 200,
      source: true,
      server: { command: FIXTURE_COMMAND[0] as string, args: FIXTURE_COMMAND.slice(1) },
      tool: { name: "get_user", args: { id: "u1" } },
    });
    console.log(formatLatency(r, "serve   (json fixture, get_user, validating)"));
    expect(r.medianAddedMs).toBeLessThan(LIMIT_MS);
  }, 120_000);

  it("record and serve on the mock GitHub server (latency 0) add under 5 ms median over 200 calls", async () => {
    const dir = tmpDir("typegen-lat-mock-");
    const rec = await measureLatency({ mode: "record", dir, calls: 200, source: true, server: MOCK_SERVER_COMMAND, tool: MOCK_TOOL });
    console.log(formatLatency(rec, "record  (mock github, list_issues page of 50)"));
    expect(rec.medianAddedMs).toBeLessThan(LIMIT_MS);
    expect(runInfer({ inDir: dir }).servers).toHaveLength(1);
    const srv = await measureLatency({ mode: "serve", dir, calls: 200, source: true, server: MOCK_SERVER_COMMAND, tool: MOCK_TOOL });
    console.log(formatLatency(srv, "serve   (mock github, list_issues page of 50, validating)"));
    expect(srv.medianAddedMs).toBeLessThan(LIMIT_MS);
  }, 180_000);
});
