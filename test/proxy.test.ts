import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_CHILD, isAlive, proxyCommand, startProcess, tmpDir, waitFor } from "./helpers.js";

const pidOf = (file: string): number => Number(readFileSync(file, "utf8"));

describe("proxy: transparent forwarding", () => {
  it("forwards bytes unchanged in both directions (CRLF, non-JSON, split UTF-8, notifications, errors)", async () => {
    const out = tmpDir();
    const { command, args } = proxyCommand(out, [process.execPath, FAKE_CHILD, "echo"]);
    const p = startProcess(command, args);
    const ready = Buffer.from('{"jsonrpc":"2.0","method":"notifications/ready"}\n');
    await waitFor(() => p.stdout().length >= ready.length);

    const euro = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"s":"€uro ✓"}}}\r\n');
    const split = euro.indexOf(0xe2) + 1; // cut in the middle of a multi-byte character
    const payload = [
      euro.subarray(0, split),
      euro.subarray(split),
      Buffer.from("this is not json at all\n"),
      Buffer.from('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":1}}\n'),
      Buffer.from('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}\r\n'),
      Buffer.from("\n\n"), // empty lines
      Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"content":[]}}'), // no trailing newline
    ];
    for (const chunk of payload) {
      p.child.stdin.write(chunk);
      await new Promise((r) => setTimeout(r, 15));
    }
    p.child.stdin.end();
    expect(await p.exited).toBe(0);
    expect(p.stdout().equals(Buffer.concat([ready, ...payload]))).toBe(true);
  }, 30_000);

  it("exits with the child's exit code", async () => {
    const out = tmpDir();
    const { command, args } = proxyCommand(out, [process.execPath, "-e", "process.exit(7)"]);
    const p = startProcess(command, args);
    expect(await p.exited).toBe(7);
  }, 30_000);

  it("reports a missing server command and exits non-zero", async () => {
    const out = tmpDir();
    const { command, args } = proxyCommand(out, ["definitely-not-a-real-command-xyz"]);
    const p = startProcess(command, args);
    expect(await p.exited).not.toBe(0);
  }, 30_000);
});

describe("proxy: shutdown", () => {
  it("child that exits on stdin EOF: proxy exits 0 and no process is left", async () => {
    const pidFile = path.join(tmpDir(), "pid");
    const { command, args } = proxyCommand(tmpDir(), [process.execPath, FAKE_CHILD, "echo"]);
    const p = startProcess(command, args, { PIDFILE: pidFile });
    await waitFor(() => existsSync(pidFile) && p.stdout().length > 0);
    const pid = pidOf(pidFile);
    p.child.stdin.end();
    expect(await p.exited).toBe(0);
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  it("child that ignores stdin EOF and SIGTERM: proxy force-kills it", async () => {
    const pidFile = path.join(tmpDir(), "pid");
    const { command, args } = proxyCommand(
      tmpDir(),
      [process.execPath, FAKE_CHILD, "stubborn"],
      ["--kill-timeout", "300"],
    );
    const p = startProcess(command, args, { PIDFILE: pidFile });
    await waitFor(() => existsSync(pidFile) && p.stdout().length > 0);
    const pid = pidOf(pidFile);
    p.child.stdin.end();
    expect(await p.exited).toBe(0);
    await waitFor(() => !isAlive(pid));
  }, 30_000);

  it.runIf(process.platform === "win32")(
    "Windows .cmd shim: the whole tree (cmd.exe + node) is gone after shutdown",
    async () => {
      const dir = tmpDir();
      const pidFile = path.join(dir, "pid");
      const shim = path.join(dir, "shim.cmd");
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE_CHILD}" stubborn\r\n`);
      const { command, args } = proxyCommand(tmpDir(), [shim], ["--kill-timeout", "300"]);
      const p = startProcess(command, args, { PIDFILE: pidFile });
      await waitFor(() => existsSync(pidFile) && p.stdout().length > 0);
      const pid = pidOf(pidFile);
      expect(isAlive(pid)).toBe(true);
      p.child.stdin.end();
      expect(await p.exited).toBe(0);
      await waitFor(() => !isAlive(pid));
    },
    30_000,
  );
});
