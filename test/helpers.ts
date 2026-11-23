import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli.ts");
export const FAKE_CHILD = path.join(ROOT, "test", "fixtures", "fake-child.mjs");
export const EVERYTHING = path.join(
  ROOT,
  "node_modules",
  "@modelcontextprotocol",
  "server-everything",
  "dist",
  "index.js",
);

export function tmpDir(prefix = "typegen-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Command + args that run `mcp-return-types record` from source (tsx) in front of the given server command. */
export function proxyCommand(
  outDir: string,
  server: string[],
  extra: string[] = [],
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["--import", "tsx", CLI, "record", "--out", outDir, ...extra, "--", ...server],
  };
}

export function startProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcessWithoutNullStreams; exited: Promise<number | null>; stdout: () => Buffer } {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, exited, stdout: () => Buffer.concat(chunks) };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
