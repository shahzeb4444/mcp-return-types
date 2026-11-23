import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Recorder } from "./recorder.js";

export interface ProxyOptions {
  command: string;
  args: string[];
  /** Optional observer. It only ever sees copies; the bytes are forwarded untouched. */
  recorder?: Recorder;
  /** Optional observer of client -> server messages (copies; the bytes are forwarded untouched). */
  onClientMessage?: (msg: unknown) => void;
  /**
   * Rewrites server -> client messages (used by `serve`). Return the replacement message, or
   * undefined to forward the original bytes untouched. Throwing also forwards the original bytes,
   * so a bug in a rewriter can never break the connection (fail-open).
   */
  rewriteServerMessage?: (msg: unknown) => unknown;
  /** After stdin closes, how long the child gets to exit before it is terminated. Default 2000 ms. */
  killTimeoutMs?: number;
  onWarn?: (msg: string) => void;
}

/** Splits a byte stream on "\n" and hands each non-empty line (without "\r") to `onMessage` as parsed JSON. */
class LineObserver {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onMessage: (msg: unknown) => void) {}

  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) !== -1) {
      const line = this.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.buf = this.buf.subarray(nl + 1);
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // not JSON: still forwarded, just not observed
      }
      this.onMessage(parsed);
    }
  }
}

/** Forward `src` to `dst` unchanged, with backpressure, calling `observe` on a copy of each chunk. */
function pump(src: Readable, dst: Writable, observe: (chunk: Buffer) => void): void {
  src.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (!dst.write(buf)) {
      src.pause();
      dst.once("drain", () => src.resume());
    }
    try {
      observe(buf);
    } catch {
      // observing must never disturb forwarding
    }
  });
}

/** Forward `src` to `dst` line by line, offering each JSON line to `rewrite`. Lines that are not rewritten keep their exact bytes. */
function pumpRewriting(src: Readable, dst: Writable, rewrite: (msg: unknown) => unknown): void {
  let buf: Buffer = Buffer.alloc(0);
  const send = (out: Buffer): void => {
    if (!dst.write(out)) {
      src.pause();
      dst.once("drain", () => src.resume());
    }
  };
  const convert = (raw: Buffer): Buffer => {
    try {
      const eol = raw.length >= 2 && raw[raw.length - 2] === 0x0d ? "\r\n" : "\n";
      const text = raw.toString("utf8").replace(/\r?\n$/, "");
      if (!text.includes('"result"')) return raw; // only results are ever rewritten: skip parsing everything else
      const replacement = rewrite(JSON.parse(text));
      return replacement === undefined ? raw : Buffer.from(JSON.stringify(replacement) + eol);
    } catch {
      return raw;
    }
  };
  src.on("data", (chunk: Buffer | string) => {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buf = buf.length === 0 ? incoming : Buffer.concat([buf, incoming]);
    const out: Buffer[] = [];
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      out.push(convert(buf.subarray(0, nl + 1)));
      buf = buf.subarray(nl + 1);
    }
    if (out.length > 0) send(out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out));
  });
  src.on("end", () => {
    if (buf.length > 0) dst.write(buf); // a last line without a newline goes out unchanged
    buf = Buffer.alloc(0);
  });
}

/** Stop a child and everything it started. On Windows that needs `taskkill /T`, because a .cmd shim leaves a cmd.exe in between. */
function terminate(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn.sync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

/** Run the transparent stdio proxy until the child exits. Resolves with the exit code for this process. */
export function runProxy(opts: ProxyOptions): Promise<number> {
  const grace = opts.killTimeoutMs ?? 2000;
  const warn = opts.onWarn ?? ((m: string) => process.stderr.write(`${m}\n`));

  return new Promise<number>((resolve) => {
    const child = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    const childIn = child.stdin;
    const childOut = child.stdout;
    if (!childIn || !childOut) {
      warn("mcp-return-types: could not open the server's stdio");
      resolve(1);
      return;
    }

    let shuttingDown = false;
    let finished = false;
    let timers: NodeJS.Timeout[] = [];

    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      timers = [];
      for (const sig of signals) process.off(sig, onSignal);
      process.stdin.pause();
      process.stdin.destroy();
      resolve(code);
    };

    // MCP stdio shutdown: close the child's stdin, wait, terminate, then kill.
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      childIn.end();
      timers.push(
        setTimeout(() => {
          terminate(child, false);
          timers.push(setTimeout(() => terminate(child, true), grace));
        }, grace),
      );
    };

    const onSignal = (): void => shutdown();
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
    for (const sig of signals) process.on(sig, onSignal);

    const clientObserver = new LineObserver((m) => {
      opts.recorder?.fromClient(m);
      opts.onClientMessage?.(m);
    });
    const serverObserver = new LineObserver((m) => opts.recorder?.fromServer(m));

    pump(process.stdin, childIn, (c) => clientObserver.feed(c));
    if (opts.rewriteServerMessage) pumpRewriting(childOut, process.stdout, opts.rewriteServerMessage);
    else pump(childOut, process.stdout, (c) => serverObserver.feed(c));

    process.stdin.on("end", shutdown);
    process.stdin.on("error", shutdown);
    // The client went away mid-write, or the child closed its stdin early: neither is fatal by itself.
    process.stdout.on("error", shutdown);
    childIn.on("error", () => undefined);

    child.on("error", (err) => {
      warn(`mcp-return-types: failed to start "${opts.command}": ${err.message}`);
      finish(127);
    });

    child.on("close", (code, signal) => {
      // 'close' fires after the child's stdout is fully drained into ours.
      if (shuttingDown) return finish(0);
      finish(code ?? (signal ? 1 : 0));
    });
  });
}
