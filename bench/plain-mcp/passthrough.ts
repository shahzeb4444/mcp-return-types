// Arm P of the plain-MCP test: a plain pass-through stdio proxy. It is the same proxy core as `mcp-return-types
// serve` (src/proxy/proxy.ts), with no observer and no rewriter, so every byte is forwarded unchanged.
//
//   node --import tsx bench/plain-mcp/passthrough.ts -- <server command...>
import { runProxy } from "../../src/proxy/proxy.js";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const [command, ...args] = sep === -1 ? [] : argv.slice(sep + 1);
if (!command) {
  process.stderr.write("usage: passthrough.ts -- <server command...>\n");
  process.exit(2);
}
process.exitCode = await runProxy({ command, args });
