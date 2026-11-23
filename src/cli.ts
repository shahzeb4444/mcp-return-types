#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runEmitTs } from "./emit/ts.js";
import { describeEntry, runInfer } from "./infer/run.js";
import { runProxy } from "./proxy/proxy.js";
import { ensureGitignore, Recorder } from "./proxy/recorder.js";
import { ServeRewriter } from "./proxy/serve.js";
import { runQuickstart } from "./quickstart/run.js";
import { buildReport } from "./report.js";

export const VERSION = "1.0.0";

const USAGE = `Usage:
  mcp-return-types record [--out <dir>] [--name <server>] [--keep-values] [--no-observed-values]
                     [--kill-timeout <ms>] -- <server command...>
  mcp-return-types infer [--in <dir>]
  mcp-return-types emit --ts [--in <dir>] [--out <dir>]
  mcp-return-types serve [--in <dir>] [--name <server>] [--declare-schemas | --no-output-schema]
                    [--kill-timeout <ms>] -- <server command...>
  mcp-return-types report [--in <dir>]
  mcp-return-types quickstart [--out <dir>] [--types <dir>] [--calls <n>] [--tools <a,b>] [--dry-run]
                         [--name <server>] [--timeout <ms>] -- <server command...>
  mcp-return-types --version

quickstart calls only tools marked annotations.readOnlyHint: true (or exactly the tools given with
--tools), and only when every required argument has a value in its schema (default, enum, minimum...).
--out defaults to .typegen, --types to <out>/types, --calls to 3, --timeout to 15000.`;

const err = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

async function record(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const server = sep === -1 ? [] : argv.slice(sep + 1);
  let values;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        out: { type: "string", default: ".typegen" },
        name: { type: "string" },
        "keep-values": { type: "boolean", default: false },
        "no-observed-values": { type: "boolean", default: false },
        "kill-timeout": { type: "string" },
      },
      strict: true,
    }));
  } catch (e) {
    err(`mcp-return-types: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, ...args] = server;
  if (!command) {
    err(`mcp-return-types: missing server command after "--"\n${USAGE}`);
    return 2;
  }
  const killTimeoutMs = values["kill-timeout"] === undefined ? undefined : Number(values["kill-timeout"]);
  if (killTimeoutMs !== undefined && !(killTimeoutMs >= 0)) {
    err("mcp-return-types: --kill-timeout must be a number of milliseconds");
    return 2;
  }

  const outDir = path.resolve(values.out);
  try {
    const added = ensureGitignore(process.cwd(), outDir);
    if (added) err(`mcp-return-types: added "${added}" to .gitignore`);
  } catch (e) {
    err(`mcp-return-types: could not update .gitignore: ${(e as Error).message}`);
  }

  const recorder = new Recorder({
    outDir,
    name: values.name,
    fallbackName: path.basename(command).replace(/\.(cmd|exe|bat|js|mjs|cjs)$/i, ""),
    keepValues: values["keep-values"],
    observedValues: !values["no-observed-values"],
    onWarn: err,
  });
  return runProxy({ command, args, recorder, killTimeoutMs, onWarn: err });
}

function infer(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { in: { type: "string", default: ".typegen" } }, strict: true }));
  } catch (e) {
    err(`mcp-return-types: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const inDir = path.resolve(values.in);
  const result = runInfer({ inDir });
  if (result.servers.length === 0) {
    err(`mcp-return-types: no samples found in ${path.join(inDir, "samples")} (run "mcp-return-types record" first)`);
    return 1;
  }
  if (result.skippedLines > 0) err(`mcp-return-types: skipped ${result.skippedLines} unreadable sample line(s)`);
  for (const s of result.servers) {
    console.log(`${s.server}: wrote ${path.relative(process.cwd(), s.file) || s.file} (${s.tools.length} tools)`);
    for (const t of s.tools) console.log(`  ${describeEntry(t)}`);
    for (const d of s.drift) {
      console.log(
        `  drift: ${d.tool} v${d.event.fromVersion} -> v${d.event.toVersion} (${d.event.brokenSamples} new sample(s) broke the schema)`,
      );
    }
  }
  return 0;
}

async function serve(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const server = sep === -1 ? [] : argv.slice(sep + 1);
  let values;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        in: { type: "string", default: ".typegen" },
        name: { type: "string" },
        "declare-schemas": { type: "boolean", default: false },
        "no-output-schema": { type: "boolean", default: false },
        "kill-timeout": { type: "string" },
      },
      strict: true,
    }));
  } catch (e) {
    err(`mcp-return-types: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values["declare-schemas"] && values["no-output-schema"]) {
    err(`mcp-return-types: --declare-schemas and --no-output-schema contradict each other\n${USAGE}`);
    return 2;
  }
  const [command, ...args] = server;
  if (!command) {
    err(`mcp-return-types: missing server command after "--"\n${USAGE}`);
    return 2;
  }
  const killTimeoutMs = values["kill-timeout"] === undefined ? undefined : Number(values["kill-timeout"]);
  if (killTimeoutMs !== undefined && !(killTimeoutMs >= 0)) {
    err("mcp-return-types: --kill-timeout must be a number of milliseconds");
    return 2;
  }
  const rewriter = new ServeRewriter({
    inDir: path.resolve(values.in),
    name: values.name,
    fallbackName: path.basename(command).replace(/\.(cmd|exe|bat|js|mjs|cjs)$/i, ""),
    declareSchemas: values["declare-schemas"], // --no-output-schema = the default (kept as an alias)
    onWarn: err,
  });
  return runProxy({
    command,
    args,
    onClientMessage: (m) => rewriter.fromClient(m),
    rewriteServerMessage: (m) => rewriter.rewrite(m),
    killTimeoutMs,
    onWarn: err,
  });
}

function emit(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { ts: { type: "boolean", default: false }, in: { type: "string", default: ".typegen" }, out: { type: "string", default: "types" } },
      strict: true,
    }));
  } catch (e) {
    err(`mcp-return-types: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!values.ts) {
    err(`mcp-return-types: emit needs a target; use --ts\n${USAGE}`);
    return 2;
  }
  const result = runEmitTs({ inDir: path.resolve(values.in), outDir: path.resolve(values.out), version: VERSION });
  if (result.files.length === 0) {
    err(`mcp-return-types: no inferred schemas found in ${path.join(values.in, "schemas")} (run "mcp-return-types infer" first)`);
    return 1;
  }
  for (const f of result.files) console.log(`${f.server}: wrote ${path.relative(process.cwd(), f.file) || f.file} (${f.tools} tools)`);
  return 0;
}

function report(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { in: { type: "string", default: ".typegen" } }, strict: true }));
  } catch (e) {
    err(`mcp-return-types: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const lines = buildReport({ inDir: path.resolve(values.in) });
  if (lines.length === 0) {
    err(`mcp-return-types: nothing to report in ${values.in} (run "mcp-return-types record" and "infer" first)`);
    return 1;
  }
  for (const l of lines) console.log(l);
  return 0;
}

async function quickstart(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const server = sep === -1 ? [] : argv.slice(sep + 1);
  let values;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        out: { type: "string", default: ".typegen" },
        types: { type: "string" },
        calls: { type: "string", default: "3" },
        tools: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        name: { type: "string" },
        timeout: { type: "string", default: "15000" },
      },
      strict: true,
    }));
  } catch (e) {
    err(`mcp-return-types: ${(e as Error).message}
${USAGE}`);
    return 2;
  }
  const [command, ...args] = server;
  if (!command) {
    err(`mcp-return-types: missing server command after "--"
${USAGE}`);
    return 2;
  }
  const calls = Number(values.calls);
  if (!Number.isInteger(calls) || calls < 1 || calls > 100) {
    err("mcp-return-types: --calls must be a whole number from 1 to 100");
    return 2;
  }
  const timeoutMs = Number(values.timeout);
  if (!(timeoutMs > 0)) {
    err("mcp-return-types: --timeout must be a number of milliseconds");
    return 2;
  }
  const only = values.tools === undefined ? undefined : values.tools.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (only !== undefined && only.length === 0) {
    err("mcp-return-types: --tools needs at least one tool name");
    return 2;
  }
  const outDir = path.resolve(values.out);
  const script = process.argv[1];
  if (!script) {
    err("mcp-return-types: cannot tell how this CLI was started");
    return 1;
  }
  return runQuickstart({
    command,
    args,
    outDir,
    typesDir: path.resolve(values.types ?? path.join(values.out, "types")),
    calls,
    only,
    dryRun: values["dry-run"],
    name: values.name,
    timeoutMs,
    // The record proxy is this same CLI, started the way this process was (node, its flags, the script).
    self: { command: process.execPath, args: [...process.execArgv, script] },
    version: VERSION,
    out: (l) => console.log(l),
    err,
  });
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "record") return record(rest);
  if (cmd === "infer") return infer(rest);
  if (cmd === "emit") return emit(rest);
  if (cmd === "serve") return serve(rest);
  if (cmd === "report") return report(rest);
  if (cmd === "quickstart") return quickstart(rest);
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd === undefined ? 2 : 0;
  }
  err(`mcp-return-types: unknown command "${cmd}"\n${USAGE}`);
  return 2;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      err(`mcp-return-types: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
