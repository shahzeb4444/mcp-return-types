// Parent side of the code sandbox (BENCHMARK.md "Arms"): one fresh Node child per code block, node:vm
// inside, 20 s wall-clock timeout, no network, output (stdout + return value) truncated to 8,000
// characters with a `[truncated N chars]` marker. Arms C and D use exactly this code; the tool calls go
// back to the parent over IPC, where `callTool` does the MCP call and the shared unwrap.
import spawn from "cross-spawn";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SANDBOX_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_CHARS = 8_000;
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox-child.mjs");

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };
export type ToolCaller = (name: string, args: unknown) => Promise<ToolOutcome>;

export interface SandboxOptions {
  /** Tool names exposed as `tools.<name>(args)`. */
  tools: readonly string[];
  callTool: ToolCaller;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface SandboxResult {
  status: "ok" | "exception" | "timeout";
  /** Exactly what the model is shown next (already truncated). */
  output: string;
  /** `Name: message` for exceptions and timeouts. */
  error?: string;
  toolCalls: number;
  /** Characters cut by the truncation (0 if none). */
  truncatedChars: number;
  durationMs: number;
}

/** TypeScript -> JavaScript, wrapped so the code runs inside an async function (await, return). */
export function transpile(code: string): { js: string } | { error: string } {
  const wrapped = `(async () => {\n${code}\n})()`;
  const out = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false, isolatedModules: true },
  });
  const diags = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length > 0) {
    const d = diags[0] as ts.Diagnostic;
    let where = "";
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      where = ` (line ${line}, column ${character + 1})`; // line - 1 for the wrapper line, + 1 for 1-based
    }
    return { error: `SyntaxError: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}${where}` };
  }
  return { js: out.outputText };
}

interface Done {
  type: "done";
  ok: boolean;
  output: string;
  outputChars: number;
  returned?: string;
  error?: { name: string; message: string; code?: string };
}

function render(stdout: string, stdoutChars: number, tail: string, max: number): { text: string; cut: number } {
  const body = stdout.replace(/\n$/, "");
  const parts = [body, tail].filter((p) => p !== "");
  const full = parts.join("\n");
  // stdout may already be capped by the child; count what it dropped too.
  const fullLength = full.length + Math.max(0, stdoutChars - stdout.length);
  if (fullLength <= max) return { text: full === "" ? "(no output and no return value)" : full, cut: 0 };
  const cut = fullLength - max;
  return { text: `${full.slice(0, max)}\n[truncated ${cut} chars]`, cut };
}

export async function runSandbox(code: string, opts: SandboxOptions): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const max = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const started = Date.now();
  let toolCalls = 0;

  const t = transpile(code);
  if ("error" in t) {
    return { status: "exception", output: `Exception: ${t.error}`, error: t.error, toolCalls, truncatedChars: 0, durationMs: Date.now() - started };
  }

  const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${CHILD}`, CHILD], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    if (stderr.length < 4000) stderr += c.toString("utf8");
  });

  const done = await new Promise<Done | { type: "timeout" } | { type: "exit"; code: number | null }>((resolve) => {
    let settled = false;
    const finish = (v: Done | { type: "timeout" } | { type: "exit"; code: number | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      finish({ type: "timeout" });
      child.kill();
    }, timeoutMs);
    child.on("message", (raw: unknown) => {
      const m = raw as { type: string; id?: number; name?: string; argsJson?: string } & Partial<Done>;
      if (m.type === "done") {
        finish(m as Done);
        return;
      }
      if (m.type !== "call") return;
      toolCalls += 1;
      let args: unknown;
      try {
        args = JSON.parse(m.argsJson ?? "{}");
      } catch {
        args = {};
      }
      opts
        .callTool(String(m.name), args)
        .then(
          (r) => (r.ok ? { ok: true, json: JSON.stringify(r.value ?? null) } : { ok: false, error: r.error }),
          (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        )
        .then((r) => {
          if (!settled && child.connected) child.send({ type: "result", id: m.id, ...r });
        });
    });
    child.on("exit", (code) => finish({ type: "exit", code }));
    child.on("error", () => finish({ type: "exit", code: null }));
    child.send({ type: "run", js: t.js, tools: [...opts.tools], timeoutMs, maxCapture: max + 1 });
  });
  if (child.exitCode === null && !child.killed) child.kill();
  const durationMs = Date.now() - started;

  if (done.type === "timeout") {
    const error = `Timeout: the code did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`;
    return { status: "timeout", output: error, error, toolCalls, truncatedChars: 0, durationMs };
  }
  if (done.type === "exit") {
    const error = `SandboxError: the sandbox process exited (code ${String(done.code)})${stderr ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ""}`;
    return { status: "exception", output: `Exception: ${error}`, error, toolCalls, truncatedChars: 0, durationMs };
  }
  if (!done.ok && done.error) {
    const isTimeout = done.error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    const error = isTimeout
      ? `Timeout: the code did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`
      : `${done.error.name}: ${done.error.message}`;
    const r = render(done.output, done.outputChars, isTimeout ? error : `Exception: ${error}`, max);
    return { status: isTimeout ? "timeout" : "exception", output: r.text, error, toolCalls, truncatedChars: r.cut, durationMs };
  }
  const tail = done.returned === undefined ? "" : `Return value:\n${done.returned}`;
  const r = render(done.output, done.outputChars, tail, max);
  return { status: "ok", output: r.text, toolCalls, truncatedChars: r.cut, durationMs };
}
