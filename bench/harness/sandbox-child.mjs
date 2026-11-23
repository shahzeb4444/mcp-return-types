// Sandbox child (BENCHMARK.md: a Node child process with node:vm, 20 s timeout, no network).
// Started by bench/harness/sandbox.ts as
//   node --permission --allow-fs-read=<this file> sandbox-child.mjs
// so it cannot write files, spawn processes or start workers. It talks to the parent over IPC only:
//   parent -> child  {type:"run", js, tools:[names], timeoutMs, maxCapture}
//   child  -> parent {type:"call", id, name, argsJson}
//   parent -> child  {type:"result", id, ok, json?, error?}
//   child  -> parent {type:"done", ok, output, outputChars, returned?, error?:{name,message}}
// Plain JavaScript on purpose: no loader is needed under the permission model.
import { inspect } from "node:util";
import vm from "node:vm";

// ---- no network, belt and braces (the vm context below has no fetch/require/process anyway) ----
const denied = (what) => () => {
  throw new Error(`network access is not allowed in the sandbox (${what})`);
};
for (const key of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Request", "Response", "Headers"]) {
  try {
    delete globalThis[key];
  } catch {
    /* ignore */
  }
}
for (const mod of ["net", "tls", "http", "https", "http2", "dgram", "dns"]) {
  const m = process.getBuiltinModule?.(`node:${mod}`);
  if (!m) continue;
  for (const fn of ["connect", "createConnection", "request", "get", "createSocket", "lookup", "resolve", "resolve4", "resolve6"]) {
    if (typeof m[fn] === "function") {
      try {
        m[fn] = denied(`${mod}.${fn}`);
      } catch {
        /* ignore */
      }
    }
  }
  if (m.Socket?.prototype?.connect) m.Socket.prototype.connect = denied(`${mod}.Socket.connect`);
  if (m.promises) for (const fn of Object.keys(m.promises)) if (typeof m.promises[fn] === "function") m.promises[fn] = denied(`${mod}.promises.${fn}`);
}

let nextId = 1;
const pending = new Map();

function format(args) {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 6, breakLength: 120, maxArrayLength: 200 }))).join(" ");
}

function stringifyReturn(value) {
  if (value === undefined) return undefined;
  try {
    const s = JSON.stringify(value, null, 2);
    if (s !== undefined) return s;
  } catch {
    /* circular or BigInt: fall through */
  }
  return inspect(value, { depth: 6 });
}

process.on("message", (msg) => {
  if (msg?.type === "result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p(msg);
    return;
  }
  if (msg?.type !== "run") return;
  run(msg).then(
    (done) => process.send(done, () => process.exit(0)),
    (e) => process.send({ type: "done", ok: false, output: "", outputChars: 0, error: { name: "HarnessError", message: String(e?.message ?? e) } }, () => process.exit(0)),
  );
});

async function run({ js, tools, timeoutMs, maxCapture }) {
  let output = "";
  let outputChars = 0;
  const write = (line) => {
    outputChars += line.length + 1;
    if (output.length < maxCapture) output += `${line}\n`;
  };

  // Host bridges. They only ever pass primitives (strings) across, and the in-context wrappers below
  // rebuild values with the context's own JSON, so user code never holds a host-realm object.
  const bridge = {
    call: (name, argsJson) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, (m) => resolve(m.ok ? `1${m.json ?? "null"}` : `0${m.error ?? "tool error"}`));
        process.send({ type: "call", id, name, argsJson });
      }),
    log: (...args) => write(format(args)),
    setTimeout: (fn, ms) => Number(setTimeout(fn, Math.min(Number(ms) || 0, timeoutMs))),
    clearTimeout: (id) => clearTimeout(id),
  };

  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } });
  const bootstrap = new vm.Script(`(function (bridge, names) {
    const call = bridge.call, log = bridge.log, st = bridge.setTimeout, ct = bridge.clearTimeout;
    const tools = {};
    for (const name of names) {
      tools[name] = async function (args) {
        const json = args === undefined ? "{}" : JSON.stringify(args);
        const r = await call(name, json);
        if (r[0] === "0") throw new Error(r.slice(1));
        return JSON.parse(r.slice(1));
      };
    }
    Object.freeze(tools);
    const out = (...a) => { log(...a); };
    globalThis.tools = tools;
    globalThis.console = Object.freeze({ log: out, info: out, warn: out, error: out, debug: out });
    globalThis.setTimeout = (fn, ms) => st(() => fn(), ms);
    globalThis.clearTimeout = (id) => ct(id);
  })`);
  bootstrap.runInContext(context)(bridge, tools);

  try {
    const value = await new vm.Script(js, { filename: "run_code.ts" }).runInContext(context, { timeout: timeoutMs });
    return { type: "done", ok: true, output, outputChars, returned: stringifyReturn(value) };
  } catch (e) {
    const name = e && typeof e === "object" && typeof e.name === "string" ? e.name : "Error";
    const message = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    const code = e && typeof e === "object" && typeof e.code === "string" ? e.code : undefined;
    return { type: "done", ok: false, output, outputChars, error: { name, message, code } };
  }
}
