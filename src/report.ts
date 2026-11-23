// `mcp-return-types report`: coverage of what was recorded and inferred.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeclarable, isServable } from "./proxy/serve.js";
import { SCHEMAS_FILE_VERSION, type SchemasFile, type ToolEntry } from "./infer/run.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportInput {
  inDir: string;
  now?: Date;
  /** Only these servers (schema file names without .json). Default: all. */
  servers?: readonly string[];
}

/**
 * How a tool is really served. `report` cannot see how `serve` will be started, so the
 * `--declare-schemas` case is stated as a condition, never as a fact.
 */
export function servingMode(t: Pick<ToolEntry, "declaredOutputSchema" | "unwrap" | "confidence" | "schema" | "samples">): string {
  if (t.declaredOutputSchema === true) return "server's own outputSchema (serve never replaces it)";
  if (t.unwrap === "structuredContent") return "server's own structuredContent (serve leaves it as is)";
  if (isDeclarable(t)) return "open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)";
  if (isServable(t)) return "open schema via serve (adds structuredContent to JSON object results; never declared as outputSchema: the result is not always an object)";
  const why = t.samples === 0 ? "no successful samples" : t.confidence === "low" ? "low confidence" : "the result is not an object";
  return `strict inference only (${why}; serve passes results through)`;
}

interface DriftLine {
  source?: string;
  server?: string;
  tool?: string;
}

function readDriftLines(inDir: string): DriftLine[] {
  const file = path.join(inDir, "drift.jsonl");
  if (!existsSync(file)) return [];
  const out: DriftLine[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as DriftLine);
    } catch {
      // a half-written line is ignored
    }
  }
  return out;
}

/** The report as text lines. Returns an empty list when nothing has been inferred yet. */
export function buildReport(opts: ReportInput): string[] {
  const now = opts.now ?? new Date();
  const dir = path.join(opts.inDir, "schemas");
  if (!existsSync(dir)) return [];
  const drift = readDriftLines(opts.inDir);
  const lines: string[] = [];
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => opts.servers === undefined || opts.servers.includes(f.slice(0, -".json".length)))
    .sort();
  for (const name of names) {
    let file: SchemasFile;
    try {
      file = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as SchemasFile;
    } catch {
      continue;
    }
    if (file.v !== SCHEMAS_FILE_VERSION || typeof file.tools !== "object" || file.tools === null) continue;
    const tools = Object.values(file.tools).sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
    const byLevel = { high: 0, medium: 0, low: 0 };
    for (const t of tools) byLevel[t.confidence] += 1;
    lines.push(
      `${file.server}: ${tools.length} tools seen (${byLevel.high} high, ${byLevel.medium} medium, ${byLevel.low} low confidence), inferred ${file.generatedAt}`,
    );
    for (const t of tools) {
      const errors = t.error ? t.error.samples + Object.values(t.error.rpcErrors).reduce((a, b) => a + b, 0) : 0;
      const age = t.newest ? `${Math.max(0, Math.floor((now.getTime() - Date.parse(t.newest)) / DAY_MS))}d old` : "no samples";
      const serveDrift = drift.filter((d) => d.source === "serve" && d.server === file.server && d.tool === t.tool).length;
      const inferDrift = t.drift.length;
      const parts = [
        `${t.samples} samples`,
        `${t.distinctArgs} arg sets`,
        `${t.confidence} confidence`,
        `v${t.version}`,
        `unwrap ${t.unwrap}`,
        age,
      ];
      if (errors > 0) parts.push(`${errors} errors`);
      lines.push(`  ${t.tool}: ${parts.join(", ")}`);
      lines.push(`    serving: ${servingMode(t)}`);
      if (t.confidence === "low" && t.confidenceReasons.length > 0) lines.push(`    low confidence: ${t.confidenceReasons.join("; ")}`);
      if (inferDrift > 0) lines.push(`    drift warning: ${inferDrift} event(s) found by infer (schema is now v${t.version})`);
      if (serveDrift > 0) lines.push(`    drift warning: ${serveDrift} mismatch(es) seen by serve; run record and infer again`);
    }
  }
  return lines;
}
