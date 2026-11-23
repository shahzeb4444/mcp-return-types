// Runs one model CLI call. Every call gets a fresh, EMPTY temporary directory as its working directory
// (never the repo, so the CLI cannot load this repo's AGENTS.md/CLAUDE.md or project settings), plus a
// sibling directory for files the call needs (system prompt file, last-message file). Both are removed
// afterwards. cross-spawn with an args array and no shell (Windows .cmd shims work too).
import spawn from "cross-spawn";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Keys that would switch a CLI to paid API billing. They are removed from the child's environment (never read). */
export const API_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  latencyMs: number;
  timedOut: boolean;
  /** Whether the working directory was still empty when the call ended (it should be). */
  cwdWasEmpty: boolean;
}

export interface CliCall {
  command: string;
  /** Built from the files directory, e.g. to point a flag at the system prompt file. */
  args: (filesDir: string) => string[];
  stdin: string;
  /** Files to write into the files directory before the call. */
  files?: Record<string, string>;
  /** Read after the call (e.g. codex -o <file>), keyed by file name. */
  readBack?: string[];
  timeoutMs: number;
  /** Extra environment (tests only). */
  env?: Record<string, string>;
}

export async function runCli(call: CliCall): Promise<CliResult & { readBack: Record<string, string | undefined> }> {
  const base = mkdtempSync(path.join(tmpdir(), "bench-cli-"));
  const cwd = path.join(base, "cwd");
  const filesDir = path.join(base, "files");
  mkdirSync(cwd);
  mkdirSync(filesDir);
  try {
    for (const [name, content] of Object.entries(call.files ?? {})) writeFileSync(path.join(filesDir, name), content, "utf8");
    const env: NodeJS.ProcessEnv = { ...process.env, ...call.env };
    for (const k of API_KEY_VARS) delete env[k];
    const started = Date.now();
    const result = await new Promise<CliResult>((resolve) => {
      const child = spawn(call.command, call.args(filesDir), { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, call.timeoutMs);
      child.stdout?.on("data", (c: Buffer) => out.push(c));
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      const finish = (code: number | null): void => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          latencyMs: Date.now() - started,
          timedOut,
          cwdWasEmpty: readdirSync(cwd).length === 0,
        });
      };
      child.on("error", (e) => {
        err.push(Buffer.from(String(e.message)));
        finish(null);
      });
      child.on("close", (code) => finish(code));
      child.stdin?.on("error", () => undefined); // EPIPE if the CLI exits early
      child.stdin?.end(call.stdin, "utf8");
    });
    const readBack: Record<string, string | undefined> = {};
    for (const name of call.readBack ?? []) {
      try {
        readBack[name] = readFileSync(path.join(filesDir, name), "utf8");
      } catch {
        readBack[name] = undefined;
      }
    }
    return { ...result, readBack };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
