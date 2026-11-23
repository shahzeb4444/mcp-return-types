// Tiny stand-in for an MCP server, used by the proxy tests.
//   node fake-child.mjs echo      copy stdin to stdout byte for byte, exit when stdin ends
//   node fake-child.mjs stubborn  same, but ignore the end of stdin and keep running
// If PIDFILE is set, the process writes its pid there on start.
import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "echo";
if (process.env.PIDFILE) writeFileSync(process.env.PIDFILE, String(process.pid));

process.stdin.on("data", (chunk) => process.stdout.write(chunk));
if (mode === "stubborn") {
  process.stdin.on("end", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.on("end", () => process.exit(0));
}
process.stdout.write('{"jsonrpc":"2.0","method":"notifications/ready"}\n');
