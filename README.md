# mcp-return-types

mcp-return-types records what your MCP tools actually return and writes TypeScript types (and a JSON Schema
`outputSchema`) for those results, so Code Mode stubs and MCP clients can see a real return type instead of `unknown`.

v1.0.0 · MIT · Node 22 or newer · local only, no telemetry, no model calls, no API keys.
Developed and tested on Windows 11 (PowerShell and Git Bash). Other platforms should work but were not tested.

## 5-minute quickstart

In an empty folder, in PowerShell or any other shell:

```
npm init -y
npm install mcp-return-types
npx mcp-return-types quickstart -- npx -y @modelcontextprotocol/server-everything stdio
```

Until the package is on npm, install it from a tarball instead: in a clone of this repo run `npm ci` and
`npm pack`, then in your empty folder run `npm install <path to>/mcp-return-types-1.0.0.tgz`.

The quickstart starts the server, calls its safe tools 3 times each, infers the result types and writes them.
On the reference server it takes under a minute (31 to 43 seconds when checked for this release), most of it
spent in the server's own 10-second demo tool (`trigger-long-running-operation`). It needs network the first time, because `npx -y` downloads the server.
To see the plan without calling anything, add `--dry-run`:

```
npx mcp-return-types quickstart --dry-run -- node path/to/your-server.js
```

**What it calls.** Only tools marked `annotations.readOnlyHint: true`, or exactly the tools you list with
`--tools a,b`. A tool with no annotations is treated as having side effects and is never called by default.
A tool is called only if every required argument has a value in its input schema (default, const, enum,
examples, minimum, or a boolean). Anything else is skipped, and the reason is listed.

**What you get** (in `.typegen/`):
- `types/<server>.d.ts`: the inferred result types.
- `types/<server>.codemode.d.ts`: Code Mode stubs for every tool, with the inferred return types.
- A coverage report, a before/after Code Mode snippet (`Promise<unknown>` versus `Promise<GetStructuredContentResult>`),
  and the commands to type the skipped tools by recording them through your real MCP client.

Options: `--calls <n>` (per tool, default 3), `--tools a,b`, `--dry-run`, `--out <dir>` (default `.typegen`),
`--types <dir>` (default `<out>/types`), `--name <server>`, `--timeout <ms>` (per call, default 15000).

Read the emitted types before you commit them. They hold shapes only, no values, but object keys are part of
a type. Objects with more than 30 keys (counted over all calls) whose values all have the same type are typed
as maps (`{ [key: string]: T }`), and their key names are never recorded.

## Using it with your own client

1. **Record** real traffic: put `mcp-return-types record` in front of the server command in your client's config,
   then use the tools as usual. `record` is a transparent stdio proxy. By default it stores result shapes, not
   values. The one exception is a count of short string values per field, kept only while a field has at most
   8 distinct values (for enum hints; `--no-observed-values` turns it off). Raw values are stored only with `--keep-values`.
2. **Infer and emit:** `mcp-return-types infer --in .typegen`, then `mcp-return-types emit --ts --in .typegen --out .typegen/types`.
3. Use the types in your Code Mode stubs, or **serve** them: replace `record` with `serve` in the config.

Example Claude Code `.mcp.json` for step 3 (with `mcp-return-types` installed globally, `npm install -g mcp-return-types`):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "mcp-return-types",
      "args": ["serve", "--in", ".typegen", "--", "node", "path/to/your-server.js"]
    }
  }
}
```

**What is and is not measured for this setup.** `serve` with Claude Code was **not measured**: the Claude
half of the plain-MCP test was not run in v1. `serve` was measured only with the Codex CLI (gpt-6.2-sol) on the
mock server, and the result was inconclusive (see Results). The Code Mode results below come from a separate
harness that puts the types in the stubs. They do not use `serve`.

`serve` adds `structuredContent` to a tool result when the result is JSON text that matches the inferred
schema. Results that do not match pass through unchanged and are logged as drift. By default it does **not**
declare `outputSchema` in `tools/list`, because strict clients (for example the official TypeScript SDK client)
reject a result of a declared tool that arrives without `structuredContent`. With `--declare-schemas` it also
injects the inferred `outputSchema` (medium or high confidence, object results only, never over a schema the
server declares itself). `--no-output-schema` is accepted as an alias of the default.

All commands:

```
mcp-return-types record [--out <dir>] [--name <server>] [--keep-values] [--no-observed-values] [--kill-timeout <ms>] -- <server command...>
mcp-return-types infer [--in <dir>]
mcp-return-types emit --ts [--in <dir>] [--out <dir>]
mcp-return-types serve [--in <dir>] [--name <server>] [--declare-schemas | --no-output-schema] [--kill-timeout <ms>] -- <server command...>
mcp-return-types report [--in <dir>]
mcp-return-types quickstart [options] -- <server command...>
mcp-return-types --version
```

## Results (v1)

The question: in Code Mode (the model writes TypeScript against tool stubs and runs it through one `run_code`
tool), what changes when the stubs show the inferred return types instead of `unknown`? Arm C = `unknown`,
arm D = inferred types; everything else is identical. 20 tasks x 5 reps per arm and model, on a local mock
GitHub MCP server. The models ran through the owner's subscriptions (`codex exec` and `claude -p`), not the paid API.
Ratios are D/C with paired bootstrap 95% intervals over tasks. Full numbers: [bench/results/VERDICT.md](bench/results/VERDICT.md).

**gpt-6.2-sol (Codex CLI), the most detailed result.** Output tokens per task D/C **0.72 [0.63, 0.82]**, turns
per task D/C **0.74 [0.69, 0.80]**, success 99% (C) vs 100% (D), difference +1.0 points [0.0, 3.0].
Mean output tokens per task fell from 324 to 235, and turns from 2.92 to 2.16. Sandbox code errors: none in either arm.
Verdict under the amended criteria: **PASS**.

**claude-haiku-5-5 (Claude Code CLI), a second model that also passed.** Output tokens D/C **0.50 [0.39, 0.62]**,
turns D/C **0.81 [0.74, 0.88]**, success 100% in both arms. Verdict under the amended criteria: **PASS**.

| Model | Output tokens/task D/C | Turns/task D/C | Success C / D | Amended verdict | Original verdict |
|---|---|---|---|---|---|
| gpt-6.2-sol | 0.72 [0.63, 0.82] | 0.74 [0.69, 0.80] | 99% / 100% | PASS | KILL |
| claude-haiku-5-5 | 0.50 [0.39, 0.62] | 0.81 [0.74, 0.88] | 100% / 100% | PASS | KILL |
| gpt-6-luna | excluded in v1 (see below) | | 52% / 27% | excluded (KILL on its own) | KILL |

**Read these verdicts with the following in mind:**
- **The criteria were amended after the pilot** ([BENCHMARK.md](BENCHMARK.md), Amendment 1). The pre-registered
  hypothesis was that types cut code errors by at least 30%. The pilot showed almost no code errors in either arm, so
  the owner made output tokens and turns the primary metrics, with a success non-inferiority margin.
  **Under the original criteria, every backend gave KILL.** This is weaker evidence than a pre-registered test.
- **Luna is excluded in v1** (Amendment 2, also written after seeing the results): gpt-6-luna refused the harness
  ("the tools are unavailable") in 31% of baseline (arm C) runs, above the 25% limit. It also refused more often
  with types (50 of 100 D runs vs 31 of 100 C runs). **The cause of that asymmetry is unknown.** Including Luna,
  the automatic Codex verdict is KILL. That stays on record, and all Luna data is kept in `bench/results/full`.
- Luna will be revisited in v2, together with claude-sonnet-5-5 (not run in v1). v1 has no tested weak Codex model.
- Success is at or near 100% for Sol and Haiku in both arms, so these runs cannot show a success gain.
- No money was measured. The only cost estimate (Haiku, from `bench/prices.json`) is D/C 0.84 [0.69, 1.03], which
  includes no change. On Haiku, total tokens per task are higher in D as a point estimate (1.15 [0.99, 1.35]),
  because the typed stubs are longer.

## Plain MCP (no Code Mode)

With Codex (gpt-6.2-sol) on the mock GitHub server, `serve` versus a plain proxy gave 12/12 passes in both arms and
output tokens S/P 0.95 [0.82, 1.11]: **inconclusive**, meaning no harm and no measurable gain at 12 pairs. The
criteria were pre-registered (BENCHMARK.md, Amendment 3). The Claude half was not run. Details and limits:
[docs/PLAIN-MCP-RESULT.md](docs/PLAIN-MCP-RESULT.md).

## Real-server check (no model involved)

On three real reference servers (`server-everything`, `server-filesystem`, `server-memory`), the inferred schemas
matched 99 of 99 fresh real outputs on the latest releases and 82 of 82 on older ones, and the proxy added
0.03 to 0.17 ms median latency per call. This is a match rate and latency check, not a benchmark of model outcomes.
Details: [docs/REAL-SERVERS.md](docs/REAL-SERVERS.md).

## Known limits

- **Mock workload.** Every model result comes from one local mock GitHub server (seed 2 for evaluation). The arm D
  types were inferred from seed-1 traffic on the same mock, so they fit it almost perfectly.
- **Return types only.** Arms C and D differ only in the result types. Input types and descriptions are the same in both.
- **Costs are estimates.** Subscription runs are not billed per token. Token counts are what the CLIs report, and any
  dollar figure is an estimate from `bench/prices.json`.
- **Real-server validation is a match rate and latency check**, not a benchmark of model outcomes.
- Two models pass-tested (Sol, Haiku), one task set, one laptop. Claude and Codex use different reply formats in
  the harness, so compare C and D within one model, never Claude against Codex.

## Related work

The npm package [mcp-typegen](https://github.com/pontusab/mcp-typegen) by Pontus Abrahamsson generates typed TypeScript from MCP tool schemas. mcp-return-types is a different approach: it infers return types from observed tool results (shape-only, privacy-preserving) and can run as a proxy in front of a server. We are not the first to type MCP tools, and the two projects can be used side by side.

## Reproduce

Check the v1 numbers from the committed raw results in about a minute, with no model calls:

```
npm ci
node --import tsx bench/analyze.ts --raw bench/results/full --out .typegen/verify/REPORT.md
```

It prints the same `VERDICT` lines as above. [REPRODUCE.md](REPRODUCE.md) explains how to compare it with the
committed report, and how to re-run the benchmark on your own Claude and ChatGPT subscriptions (no API keys),
including the rate-limit and resume behaviour.

## Project files

[SPEC.md](SPEC.md) (what the tool does), [BENCHMARK.md](BENCHMARK.md) (how it was measured, with all amendments),
[CHANGELOG.md](CHANGELOG.md). The npm package contains only `dist/`, this README, the CHANGELOG and the LICENSE.

License: MIT
