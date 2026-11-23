// A stand-in for the `claude` / `codex` CLIs in backend tests (no model, no network).
//   node fake-cli.mjs <mode> <...the args the backend built>
// It reads the prompt from stdin and reports what it saw: argv, cwd contents, and stdin.
import { readdirSync, writeFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const after = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const seen = {
    args,
    cwdEntries: readdirSync(process.cwd()),
    stdin,
  };
  if (mode === "claude-ok") {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(seen),
        usage: { input_tokens: 11, cache_creation_input_tokens: 22, cache_read_input_tokens: 33, output_tokens: 44 },
      }),
    );
  } else if (mode === "claude-limit") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1790000000" }));
    process.exitCode = 1;
  } else if (mode === "claude-login") {
    process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }));
    process.exitCode = 1;
  } else if (mode === "claude-garbage") {
    process.stdout.write("this is not json");
    process.exitCode = 1;
  } else if (mode === "codex-ok") {
    const out = after("-o");
    writeFileSync(out, JSON.stringify(seen));
    const ev = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
    ev({ type: "thread.started", thread_id: "t1" });
    ev({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "from the stream" } });
    ev({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 } });
  } else if (mode.startsWith("codex-env-")) {
    // Envelope modes: the last message is what the (fake) model answered under --output-schema.
    const msgs = {
      "codex-env-code": JSON.stringify({ action: "run_code", code: "return 1;", answer: "" }),
      "codex-env-final": JSON.stringify({ action: "final", code: "", answer: "42" }),
      "codex-env-notjson": "FINAL: 42",
      "codex-env-badaction": JSON.stringify({ action: "think", code: "", answer: "" }),
      "codex-env-emptycode": JSON.stringify({ action: "run_code", code: "  ", answer: "" }),
    };
    writeFileSync(after("-o"), msgs[mode]);
    const ev = (e) => process.stdout.write(`${JSON.stringify(e)}
`);
    ev({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  } else if (mode === "codex-limit") {
    process.stdout.write(`${JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again later." })}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exitCode = 2;
  }
});
