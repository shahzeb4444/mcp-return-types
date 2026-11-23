// `mcp-return-types infer`: read `.typegen/samples/<server>/<tool>.jsonl`, write
// `.typegen/schemas/<server>.json`, and handle drift (SPEC §3 rule 9).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Sample } from "../proxy/recorder.js";
import { readToolList, TOOL_LIST_FILE } from "../proxy/recorder.js";
import { canonicalSchemaJson, sampleFits } from "./schema.js";
import { inferTool, isSuccess, type ToolInference, type ValuesFile } from "./tool.js";

export const SCHEMAS_FILE_VERSION = 1;
/** Drift events kept per tool in the schemas file (all of them also go to drift.jsonl). */
const MAX_DRIFT_KEPT = 20;

export interface DriftEvent {
  at: string;
  fromVersion: number;
  toVersion: number;
  /** New success samples that did not validate against the previous schema. */
  brokenSamples: number;
}

export interface ToolEntry extends ToolInference {
  /** From the recorded tools/list: true when the server declares its own outputSchema. Absent = not known. */
  declaredOutputSchema?: boolean;
  /** Bumped whenever the success schema changes. */
  version: number;
  /** Samples (all kinds) read from the tool's file; the next run treats later lines as new. */
  seen: number;
  drift: DriftEvent[];
}

export interface SchemasFile {
  v: typeof SCHEMAS_FILE_VERSION;
  server: string;
  generatedAt: string;
  tools: Record<string, ToolEntry>;
}

export interface InferRunResult {
  servers: { server: string; file: string; tools: ToolEntry[]; drift: { tool: string; event: DriftEvent }[] }[];
  skippedLines: number;
}

function isSample(x: unknown): x is Sample {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Partial<Sample>;
  return s.v === 1 && typeof s.tool === "string" && typeof s.isError === "boolean" && typeof s.args === "string";
}

/** Parse a samples file. CRLF and blank lines are fine; bad lines are counted and skipped. */
export function readSamples(file: string): { samples: Sample[]; skipped: number } {
  const samples: Sample[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSample(parsed)) samples.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1; // e.g. a line cut short by a crash mid-write
    }
  }
  return { samples, skipped };
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Turn a fresh inference into a stored entry, comparing it with the previous entry:
 * new samples that break the old schema are a drift event, and any schema change bumps the version.
 */
export function updateEntry(
  prev: ToolEntry | undefined,
  fresh: ToolInference,
  samples: readonly Sample[],
  now: Date,
): { entry: ToolEntry; drift?: DriftEvent } {
  if (!prev) return { entry: { ...fresh, version: 1, seen: samples.length, drift: [] } };
  // The samples file is append-only; if it shrank, it was reset, so every sample is new.
  const added = samples.length >= prev.seen ? samples.slice(prev.seen) : samples;
  // A JSON-text result of a text tool is not a break: its text is still a string (text | parsed union).
  const broken = added.filter((s) => isSuccess(s) && s.shape !== undefined && !sampleFits(s, prev.schema)).length;
  const changed = canonicalSchemaJson(prev.schema) !== canonicalSchemaJson(fresh.schema);
  const version = changed || broken > 0 ? prev.version + 1 : prev.version;
  let drift: DriftEvent | undefined;
  let events = prev.drift ?? [];
  if (broken > 0) {
    drift = { at: now.toISOString(), fromVersion: prev.version, toVersion: version, brokenSamples: broken };
    events = [...events, drift].slice(-MAX_DRIFT_KEPT);
  }
  return { entry: { ...fresh, version, seen: samples.length, drift: events }, drift };
}

export function runInfer(opts: { inDir: string; now?: Date; servers?: readonly string[] }): InferRunResult {
  const now = opts.now ?? new Date();
  const samplesDir = path.join(opts.inDir, "samples");
  const result: InferRunResult = { servers: [], skippedLines: 0 };
  if (!existsSync(samplesDir)) return result;
  const schemasDir = path.join(opts.inDir, "schemas");

  const servers = readdirSync(samplesDir)
    .filter((d) => statSync(path.join(samplesDir, d)).isDirectory())
    .filter((d) => opts.servers === undefined || opts.servers.includes(d))
    .sort();
  for (const server of servers) {
    const dir = path.join(samplesDir, server);
    const outFile = path.join(schemasDir, `${server}.json`);
    const previous = readJson<SchemasFile>(outFile);
    const prevTools = previous?.v === SCHEMAS_FILE_VERSION ? previous.tools : {};

    const byTool = new Map<string, { samples: Sample[]; values?: ValuesFile }>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const { samples, skipped } = readSamples(path.join(dir, file));
      result.skippedLines += skipped;
      const values = readJson<ValuesFile>(path.join(dir, file.replace(/\.jsonl$/, ".values.json")));
      for (const s of samples) {
        const t = byTool.get(s.tool) ?? { samples: [], values };
        t.samples.push(s);
        byTool.set(s.tool, t);
      }
    }
    if (byTool.size === 0) continue;
    const listed = readToolList(path.join(dir, TOOL_LIST_FILE))?.tools;

    const tools: Record<string, ToolEntry> = {};
    const drift: { tool: string; event: DriftEvent }[] = [];
    for (const tool of [...byTool.keys()].sort()) {
      const { samples, values } = byTool.get(tool) as { samples: Sample[]; values?: ValuesFile };
      const fresh: ToolInference & { declaredOutputSchema?: boolean } = inferTool(tool, samples, { now, values });
      if (listed && Object.hasOwn(listed, tool)) fresh.declaredOutputSchema = listed[tool]?.outputSchema === true;
      const prev = Object.hasOwn(prevTools, tool) ? prevTools[tool] : undefined;
      const { entry, drift: event } = updateEntry(prev, fresh, samples, now);
      Object.defineProperty(tools, tool, { value: entry, enumerable: true, writable: true, configurable: true });
      if (event) drift.push({ tool, event });
    }

    const out: SchemasFile = { v: SCHEMAS_FILE_VERSION, server, generatedAt: now.toISOString(), tools };
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
    for (const d of drift) {
      appendFileSync(
        path.join(opts.inDir, "drift.jsonl"),
        `${JSON.stringify({ ts: d.event.at, source: "infer", server, tool: d.tool, ...d.event })}\n`,
      );
    }
    result.servers.push({ server, file: outFile, tools: Object.values(tools), drift });
  }
  return result;
}

/** One summary line per tool, printed by the CLI. */
export function describeEntry(e: ToolEntry): string {
  const errors = e.error ? `, ${e.error.samples + Object.values(e.error.rpcErrors).reduce((a, b) => a + b, 0)} errors` : "";
  return `${e.tool}: v${e.version} ${e.confidence}, ${e.samples} samples, ${e.distinctArgs} arg sets, unwrap ${e.unwrap}${errors}`;
}
