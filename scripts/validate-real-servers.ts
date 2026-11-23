// M9: validate mcp-return-types against three real MCP servers (server-everything, server-filesystem, server-memory).
//
//   npm run build
//   npm run validate:real                       # all three servers, latest published versions (pinned below)
//   npm run validate:real -- --only memory      # one server
//   npm run validate:real -- --variant legacy   # older releases that declare no outputSchema (text results)
//
// Per server it: (1) records a scripted TRAIN session through `mcp-return-types record`, (2) runs `infer` and `emit --ts`,
// (3) compiles the .d.ts with tsc, (4) runs a FRESH session (new server process, other arguments) directly against
// the server and checks every real output against the schema inferred from the TRAIN run, (5) runs `report`,
// and finally measures the proxy latency. Everything is written under .typegen/real-servers (git-ignored).
// No model is called and no key is needed. Servers are started with `npx -y <pkg>@<exact version>`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import spawn from "cross-spawn";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { formatLatency, measureLatency, type LatencyResult } from "../bench/latency.js";
import { readSamples, type SchemasFile } from "../src/infer/run.js";
import { inferTool, isSuccess, type ToolInference } from "../src/infer/tool.js";
import { safeName, unwrap } from "../src/proxy/recorder.js";
import { compileValidators, explain, readingsFor, type EnumMiss, type Reading, type Violation, type ViolationKind } from "./real-servers/check.js";
import { SERVERS, type Call, type Phase, type ServerDef, type Variant } from "./real-servers/sessions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const TSC = path.join(ROOT, "node_modules", "typescript", "lib", "tsc.js");

const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    variant: { type: "string", default: "latest" },
    out: { type: "string", default: path.join(ROOT, ".typegen", "real-servers") },
    "latency-calls": { type: "string", default: "300" },
    "skip-latency": { type: "boolean", default: false },
    "latency-only": { type: "boolean", default: false },
  },
  strict: true,
});
const variant = opts.variant as Variant;
if (variant !== "latest" && variant !== "legacy") throw new Error(`--variant must be latest or legacy, got ${variant}`);
const outRoot = path.resolve(opts.out as string, variant);

// ------------------------------------------------------------------------------------------------ helpers
const log = (msg: string): void => console.log(msg);
const envOf = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
  ...extra,
});

function run(args: string[], cwd: string = ROOT): { code: number; stdout: string; stderr: string } {
  const r = spawn.sync(process.execPath, args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

interface CallRecord {
  call: Call;
  ok: boolean; // false = JSON-RPC error (the SDK threw)
  isError: boolean;
  result?: Record<string, unknown>;
  rpcMessage?: string;
  ms: number;
}

/** Run a list of calls with the SDK client. `transport` is either npx directly or the record proxy around it. */
async function runSession(def: ServerDef, phase: Phase, calls: Call[], command: string, args: string[], env: Record<string, string>): Promise<{ records: CallRecord[]; skipped: string[]; stderr: string; version: string; listError?: string }> {
  const transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const client = new Client({ name: `typegen-m9-${def.name}-${phase}`, version: "0.0.0" });
  await client.connect(transport);
  const version = client.getServerVersion()?.version ?? "?";
  const records: CallRecord[] = [];
  const skipped: string[] = [];
  let listError: string | undefined;
  try {
    // Old releases (filesystem <= 2025.8.21) list a tool whose inputSchema the current SDK client rejects
    // (not an mcp-return-types problem): then every scripted call is simply tried.
    let have: Set<string> | undefined;
    try {
      have = new Set((await client.listTools()).tools.map((t) => t.name));
    } catch (e) {
      listError = e instanceof Error ? e.message.slice(0, 120).replace(/\s+/g, " ") : String(e);
    }
    for (const call of calls) {
      if (have && !have.has(call.tool)) {
        skipped.push(call.tool);
        continue;
      }
      const t0 = performance.now();
      try {
        const result = (await client.callTool({ name: call.tool, arguments: call.args }, undefined, { timeout: 90_000 })) as Record<string, unknown>;
        records.push({ call, ok: true, isError: result.isError === true, result, ms: performance.now() - t0 });
      } catch (e) {
        records.push({ call, ok: false, isError: false, rpcMessage: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 });
      }
    }
  } finally {
    await client.close();
  }
  return { records, skipped: [...new Set(skipped)], stderr, version, listError };
}

// ------------------------------------------------------------------------------------------------ per-server
interface FreshStats {
  calls: number;
  errorResults: number;
  rpcErrors: number;
  checked: number;
  strictMatch: number;
  serveMatch: number;
  hintChecked: boolean;
  violations: Record<string, { kind: ViolationKind; path: string; detail: string; outputs: number }>;
  enumMisses: Record<string, { path: string; value: string; outputs: number }>;
  validatorDisagreements: number;
}

interface ToolRow {
  tool: string;
  trainCalls: number;
  trainSamples: number;
  trainErrors: number;
  distinctArgs: number;
  confidence?: string;
  unwrap?: string;
  schemaVersion?: number;
  fresh: FreshStats;
  notTrained: boolean;
}

interface ServerResult {
  server: string;
  pkg: string;
  serverVersion: string;
  trainCalls: number;
  freshCalls: number;
  skippedTools: string[];
  inferOutput: string;
  emitOutput: string;
  tsc: { file: string; ok: boolean; output: string }[];
  rows: ToolRow[];
  /** Match rate of the fresh outputs when infer only gets the first k successful training samples of each tool. */
  sweep: { k: number | "all"; tools: number; checked: number; strictMatch: number; serveMatch: number; reasons: string[] }[];
  report: string;
  proxyStderr: string;
  /** Set when the SDK client could not parse the server's tools/list. */
  listError?: string;
  /** Tools the server itself declared an outputSchema for (from tools/list). */
  declaredOutputSchemas: number;
  toolCount: number;
}

const emptyFresh = (): FreshStats => ({ calls: 0, errorResults: 0, rpcErrors: 0, checked: 0, strictMatch: 0, serveMatch: 0, hintChecked: false, violations: {}, enumMisses: {}, validatorDisagreements: 0 });

function checkFresh(rec: CallRecord, entry: Pick<ToolInference, "unwrap" | "schema"> | undefined, validators: ReturnType<typeof compileValidators> | undefined, stats: FreshStats): void {
  stats.calls += 1;
  if (!rec.ok) return void (stats.rpcErrors += 1);
  if (rec.isError) return void (stats.errorResults += 1);
  if (!entry || !validators || !rec.result) return;
  stats.checked += 1;
  const un = unwrap(rec.result);
  let violations: Violation[] = [];
  let enums: EnumMiss[] = [];
  // SPEC §3 rule 1 with the text | parsed union: a JSON-text result of a text tool may match as text.
  const readings = readingsFor(entry.unwrap, rec.result).filter((r) => r.path !== "none");
  let chosen: Reading | undefined;
  if (readings.length === 0 && un.path !== "none") {
    violations.push({ kind: "unwrap", path: "$", detail: `result unwrapped as ${un.path}, training saw ${entry.unwrap}` });
  } else {
    for (const r of readings) {
      const v: Violation[] = [];
      const e: EnumMiss[] = [];
      explain(r.value, entry.schema, "$", v, e);
      if (chosen === undefined || (v.length === 0 && violations.length > 0)) {
        chosen = r;
        violations = v;
        enums = e;
      }
    }
  }
  let closedOk = violations.length === 0;
  let openOk = closedOk;
  if (chosen !== undefined) {
    const c = validators.closed(chosen.value);
    // serve's open schema accepts the result if any reading matches it
    const o = readings.some((r) => validators.open(r.value));
    // The two validators must agree on closed-schema validity; a disagreement is a bug in one of them.
    if (c !== (violations.length === 0)) stats.validatorDisagreements += 1;
    closedOk = violations.length === 0;
    openOk = o;
  } else if (violations.length > 0) {
    openOk = false;
  }
  if (closedOk) stats.strictMatch += 1;
  if (openOk) stats.serveMatch += 1;
  const seen = new Set<string>();
  for (const v of violations) {
    const key = `${v.kind}|${v.path}|${v.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = stats.violations[key] ?? { ...v, outputs: 0 };
    cur.outputs += 1;
    stats.violations[key] = cur;
  }
  const seenEnum = new Set<string>();
  for (const e of enums) {
    const key = `${e.path}|${e.value}`;
    if (seenEnum.has(key)) continue;
    seenEnum.add(key);
    const cur = stats.enumMisses[key] ?? { ...e, outputs: 0 };
    cur.outputs += 1;
    stats.enumMisses[key] = cur;
  }
}

async function validateServer(def: ServerDef): Promise<ServerResult> {
  const base = path.join(outRoot, def.name);
  rmSync(base, { recursive: true, force: true });
  const trainDir = path.join(base, "train"); // the .typegen folder of the training run
  const typesDir = path.join(base, "types");
  mkdirSync(trainDir, { recursive: true });
  const pkg = def.pkg[variant];
  const shared = realpathSync.native(mkdtempSync(path.join(tmpdir(), `typegen-m9-${def.name}-`)));
  const dataDirs: Record<Phase, string> = { train: path.join(shared, "train-data"), fresh: path.join(shared, "fresh-data") };
  for (const d of Object.values(dataDirs)) mkdirSync(d, { recursive: true });
  // Filesystem: one shared fixture folder for both phases (the fresh run adds other files). Others: one folder per phase.
  const rootFor = (phase: Phase): string => (def.name === "filesystem" ? path.join(shared, "fs-root") : dataDirs[phase]);
  const npxArgs = (phase: Phase): string[] => ["-y", pkg, ...def.serverArgs(rootFor(phase))];
  const env = (phase: Phase): Record<string, string> => envOf(def.env?.(rootFor(phase)));

  // 1. TRAIN session through the recording proxy
  log(`\n=== ${def.name} (${pkg}) ===`);
  def.setup(rootFor("train"), "train");
  const trainCalls = def.session(rootFor("train"), "train");
  log(`train: ${trainCalls.length} scripted calls through "mcp-return-types record"`);
  const train = await runSession(def, "train", trainCalls, process.execPath, [CLI, "record", "--out", trainDir, "--name", def.name, "--", "npx", ...npxArgs("train")], env("train"));
  writeFileSync(path.join(base, "proxy-stderr.log"), train.stderr);
  log(`  done: ${train.records.length} calls, ${train.records.filter((r) => r.isError || !r.ok).length} error results, server version ${train.version}${train.skipped.length ? `, skipped (tool not offered): ${train.skipped.join(", ")}` : ""}`);

  // 2. infer + emit
  const inferRun = run([CLI, "infer", "--in", trainDir]);
  writeFileSync(path.join(base, "infer.txt"), inferRun.stdout + inferRun.stderr);
  if (inferRun.code !== 0) throw new Error(`infer failed for ${def.name}: ${inferRun.stderr}`);
  const emitRun = run([CLI, "emit", "--ts", "--in", trainDir, "--out", typesDir]);
  writeFileSync(path.join(base, "emit.txt"), emitRun.stdout + emitRun.stderr);
  if (emitRun.code !== 0) throw new Error(`emit failed for ${def.name}: ${emitRun.stderr}`);

  // 3. tsc --noEmit on the emitted .d.ts
  const tsc: ServerResult["tsc"] = [];
  for (const f of readdirSync(typesDir).filter((n) => n.endsWith(".d.ts"))) {
    const r = run([TSC, "--noEmit", "--ignoreConfig", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", f], typesDir);
    tsc.push({ file: f, ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
  }
  log(`tsc --noEmit: ${tsc.map((t) => `${t.file} ${t.ok ? "OK" : "FAILED"}`).join(", ")}`);

  // 4. FRESH session straight against the server (not through the proxy)
  def.setup(rootFor("fresh"), "fresh");
  const freshCalls = def.session(rootFor("fresh"), "fresh");
  log(`fresh: ${freshCalls.length} scripted calls, new server process, other arguments`);
  const fresh = await runSession(def, "fresh", freshCalls, "npx", npxArgs("fresh"), env("fresh"));
  log(`  done: ${fresh.records.length} calls`);

  const schemasFile = JSON.parse(readFileSync(path.join(trainDir, "schemas", `${def.name}.json`), "utf8")) as SchemasFile;
  const validators = new Map<string, ReturnType<typeof compileValidators>>();
  for (const [name, e] of Object.entries(schemasFile.tools)) validators.set(name, compileValidators(e.schema));

  const rows = new Map<string, ToolRow>();
  const rowOf = (tool: string): ToolRow => {
    let r = rows.get(tool);
    if (!r) {
      const e = Object.hasOwn(schemasFile.tools, tool) ? schemasFile.tools[tool] : undefined;
      r = {
        tool,
        trainCalls: 0,
        trainSamples: e?.samples ?? 0,
        trainErrors: e?.error ? e.error.samples + Object.values(e.error.rpcErrors).reduce((a, b) => a + b, 0) : 0,
        distinctArgs: e?.distinctArgs ?? 0,
        confidence: e?.confidence,
        unwrap: e?.unwrap,
        schemaVersion: e?.version,
        fresh: emptyFresh(),
        notTrained: e === undefined,
      };
      rows.set(tool, r);
    }
    return r;
  };
  for (const rec of train.records) rowOf(rec.call.tool).trainCalls += 1;
  for (const rec of fresh.records) {
    const entry = Object.hasOwn(schemasFile.tools, rec.call.tool) ? schemasFile.tools[rec.call.tool] : undefined;
    checkFresh(rec, entry, validators.get(rec.call.tool), rowOf(rec.call.tool).fresh);
  }

  // 4b. How many training samples does a tool need? Infer from only the first k successful samples of each tool.
  const sweep: ServerResult["sweep"] = [];
  const samplesDir = path.join(trainDir, "samples", def.name);
  const byTool = new Map<string, ReturnType<typeof readSamples>["samples"]>();
  for (const f of readdirSync(samplesDir).filter((n) => n.endsWith(".jsonl"))) {
    for (const smp of readSamples(path.join(samplesDir, f)).samples) byTool.set(smp.tool, [...(byTool.get(smp.tool) ?? []), smp]);
  }
  for (const k of [1, 2, 3, 5, 10, "all"] as const) {
    const total = { k, tools: 0, checked: 0, strictMatch: 0, serveMatch: 0, reasons: [] as string[] };
    for (const [tool, samples] of byTool) {
      const ok = samples.filter(isSuccess);
      const used = k === "all" ? ok : ok.slice(0, k);
      if (used.length === 0) continue;
      const inferred = inferTool(tool, used, { now: new Date() });
      const v = compileValidators(inferred.schema);
      const stats = emptyFresh();
      for (const rec of fresh.records.filter((r) => r.call.tool === tool)) checkFresh(rec, inferred, v, stats);
      if (stats.checked === 0) continue;
      for (const v of Object.values(stats.violations)) total.reasons.push(`${tool} ${v.kind} ${v.path}: ${v.detail} (${v.outputs} of ${stats.checked} outputs)`);
      total.tools += 1;
      total.checked += stats.checked;
      total.strictMatch += stats.strictMatch;
      total.serveMatch += stats.serveMatch;
    }
    sweep.push(total);
  }

  // 5. report
  const rep = run([CLI, "report", "--in", trainDir]);
  writeFileSync(path.join(base, "report.txt"), rep.stdout + rep.stderr);

  // How many tools does this server declare an outputSchema for itself? (one extra tools/list, direct)
  let declared = 0;
  let toolCount = 0;
  try {
    const c = new Client({ name: "typegen-m9-list", version: "0.0.0" });
    await c.connect(new StdioClientTransport({ command: "npx", args: npxArgs("fresh"), env: env("fresh"), stderr: "ignore" }));
    try {
      const { tools } = await c.listTools();
      toolCount = tools.length;
      declared = tools.filter((t) => t.outputSchema !== undefined).length;
    } finally {
      await c.close();
    }
  } catch {
    toolCount = -1; // the SDK client rejected this old server's tools/list (see listError)
  }

  const result: ServerResult = {
    server: def.name,
    pkg,
    serverVersion: train.version,
    trainCalls: train.records.length,
    freshCalls: fresh.records.length,
    skippedTools: [...new Set([...train.skipped, ...fresh.skipped])],
    inferOutput: inferRun.stdout.trim(),
    emitOutput: emitRun.stdout.trim(),
    tsc,
    rows: [...rows.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
    sweep,
    report: rep.stdout.trim(),
    proxyStderr: train.stderr.trim(),
    listError: train.listError ?? fresh.listError,
    declaredOutputSchemas: declared,
    toolCount,
  };
  writeFileSync(path.join(base, "result.json"), JSON.stringify(result, null, 2));
  rmSync(shared, { recursive: true, force: true });
  return result;
}

// ------------------------------------------------------------------------------------------------ latency
async function latency(calls: number): Promise<{ label: string; r: LatencyResult }[]> {
  const out: { label: string; r: LatencyResult }[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "typegen-m9-latency-"));
  const fsRoot = realpathSync.native(mkdtempSync(path.join(tmpdir(), "typegen-m9-latency-fs-")));
  writeFileSync(path.join(fsRoot, "hello.txt"), "hello world\n".repeat(20));
  const fsServer = { command: "npx", args: ["-y", SERVERS.find((s) => s.name === "filesystem")!.pkg[variant], fsRoot] };
  const evServer = { command: "npx", args: ["-y", SERVERS.find((s) => s.name === "everything")!.pkg[variant], "stdio"] };
  const runOne = async (label: string, mode: "record" | "serve", server: { command: string; args: string[] }, tool: { name: string; args: Record<string, unknown> }, d: string): Promise<void> => {
    log(`latency: ${label} ...`);
    const r = await measureLatency({ mode, calls, warmup: 30, server, tool, dir: d });
    log(`  ${formatLatency(r, label)}`);
    out.push({ label, r });
  };
  // Filesystem: read_text_file on a 240-byte file, through `record`, and through `serve` with the inferred schemas of the train run.
  await runOne("record, filesystem read_text_file", "record", fsServer, { name: variant === "latest" ? "read_text_file" : "read_file", args: { path: path.join(fsRoot, "hello.txt") } }, path.join(dir, "fs-record"));
  await runOne("record, everything echo", "record", evServer, { name: "echo", args: { message: "latency" } }, path.join(dir, "ev-record"));
  // serve: legacy server-memory (its results are JSON text with no structuredContent), so serve really validates the
  // result and adds structuredContent. Needs the schemas of the legacy memory train run, filed under the name the server reports.
  const legacyMemory = SERVERS.find((x) => x.name === "memory")!.pkg.legacy;
  const trainMem = path.join(path.resolve(opts.out as string), "legacy", "memory", "train", "schemas", "memory.json");
  if (existsSync(trainMem)) {
    const memServer = { command: "npx", args: ["-y", legacyMemory] };
    const probe = new Client({ name: "typegen-m9-probe", version: "0.0.0" });
    await probe.connect(new StdioClientTransport({ command: memServer.command, args: memServer.args, stderr: "ignore" }));
    const serverName = probe.getServerVersion()?.name ?? "memory";
    await probe.close();
    const serveDir = path.join(dir, "mem-serve");
    mkdirSync(path.join(serveDir, "schemas"), { recursive: true });
    const file = JSON.parse(readFileSync(trainMem, "utf8")) as SchemasFile;
    file.server = safeName(serverName);
    writeFileSync(path.join(serveDir, "schemas", `${safeName(serverName)}.json`), JSON.stringify(file));
    await runOne("record, legacy memory read_graph", "record", memServer, { name: "read_graph", args: {} }, path.join(dir, "mem-record"));
    await runOne("serve, legacy memory read_graph (validates + adds structuredContent)", "serve", memServer, { name: "read_graph", args: {} }, serveDir);
  } else {
    log("latency: skipped the serve measurement (run the legacy variant first so the memory schemas exist)");
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(fsRoot, { recursive: true, force: true });
  return out;
}

// ------------------------------------------------------------------------------------------------ markdown summary
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`);

function summarize(results: ServerResult[], lat: { label: string; r: LatencyResult }[]): string {
  const L: string[] = [];
  L.push(`# Real-server validation (variant: ${variant}), generated ${new Date().toISOString()}`, "");
  for (const s of results) {
    L.push(`## ${s.server}  (${s.pkg}, server reports version ${s.serverVersion}; ${s.toolCount < 0 ? "tools/list rejected by the SDK client" : `${s.declaredOutputSchemas}/${s.toolCount} tools declare their own outputSchema`})`, "");
    L.push(`train: ${s.trainCalls} calls, fresh: ${s.freshCalls} calls. tsc: ${s.tsc.map((t) => `${t.file} ${t.ok ? "OK" : "FAILED"}`).join(", ")}`, "");
    L.push("| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |", "|---|---|---|---|---|---|---|---|");
    let checked = 0;
    let strict = 0;
    let serve = 0;
    for (const r of s.rows) {
      const f = r.fresh;
      checked += f.checked;
      strict += f.strictMatch;
      serve += f.serveMatch;
      const notes: string[] = [];
      if (r.notTrained) notes.push("not in training");
      if (f.errorResults) notes.push(`${f.errorResults} error result(s) excluded`);
      if (f.rpcErrors) notes.push(`${f.rpcErrors} rpc error(s) excluded`);
      if (f.validatorDisagreements) notes.push(`VALIDATOR DISAGREEMENT x${f.validatorDisagreements}`);
      L.push(`| ${r.tool} | ${r.trainSamples}/${r.trainErrors} | ${r.confidence ?? "-"} | ${r.unwrap ?? "-"} | ${f.checked} | ${pct(f.strictMatch, f.checked)} | ${pct(f.serveMatch, f.checked)} | ${notes.join("; ")} |`);
    }
    L.push(`| **all tools** | | | | ${checked} | ${pct(strict, checked)} | ${pct(serve, checked)} | |`, "");
    const mism = s.rows.flatMap((r) => Object.values(r.fresh.violations).map((v) => ({ tool: r.tool, ...v })));
    const enums = s.rows.flatMap((r) => Object.values(r.fresh.enumMisses).map((v) => ({ tool: r.tool, ...v })));
    if (mism.length || enums.length) {
      L.push("Mismatches:", "");
      for (const m of mism) L.push(`- ${m.tool} \`${m.path}\`: **${m.kind}**, ${m.detail} (${m.outputs} output(s))`);
      for (const m of enums) L.push(`- ${m.tool} \`${m.path}\`: **new enum value** (hint only, not a schema failure) \`${m.value}\` (${m.outputs} output(s))`);
      L.push("");
    }
    L.push("Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):", "", "| k | tools | fresh checked | strict match | serve match |", "|---|---|---|---|---|");
    for (const w of s.sweep) L.push(`| ${w.k} | ${w.tools} | ${w.checked} | ${pct(w.strictMatch, w.checked)} | ${pct(w.serveMatch, w.checked)} |`);
    for (const w of s.sweep) if (w.k !== "all" && w.reasons.length > 0) L.push("", `Mismatches at k=${w.k}:`, ...w.reasons.map((r) => `- ${r}`));
    L.push("", "```", s.report, "```", "");
  }
  L.push("## Latency", "");
  for (const l of lat) L.push(`- ${formatLatency(l.r, l.label)}`);
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ main
async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run `npm run build` first");
  mkdirSync(outRoot, { recursive: true });
  const defs = opts["latency-only"] ? [] : SERVERS.filter((s) => !opts.only || s.name === opts.only);
  if (defs.length === 0 && !opts["latency-only"]) throw new Error(`--only ${opts.only} matches no server (everything, filesystem, memory)`);
  const results: ServerResult[] = [];
  for (const def of defs) results.push(await validateServer(def));
  const lat = opts["skip-latency"] ? [] : await latency(Number(opts["latency-calls"]));
  if (opts["latency-only"]) {
    writeFileSync(path.join(outRoot, "latency.json"), JSON.stringify(lat, null, 2));
    return;
  }
  const md = summarize(results, lat);
  writeFileSync(path.join(outRoot, "summary.md"), md);
  writeFileSync(path.join(outRoot, "latency.json"), JSON.stringify(lat, null, 2));
  log(`\nWrote ${path.join(outRoot, "summary.md")}`);
  const bad = results.flatMap((r) => r.tsc.filter((t) => !t.ok).map((t) => `${r.server}/${t.file}`));
  if (bad.length) {
    log(`tsc FAILED for: ${bad.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
