# Plain-MCP test (M11)

Does `mcp-return-types serve` help **ordinary** MCP clients, the ones that call tools natively with no Code Mode? This page holds the design, the commands, and (after M11b) the results and the conclusion. The pass criteria were pre-registered in BENCHMARK.md "Amendment 3" (commit `40b76f2`), before any plain-MCP run.

**Status: M11a (design and harness) done. M11b (the runs) is next. No gating result exists yet. The first real smoke run (1 Codex run, 2026-11-23, `bench/results/plain-mcp-smoke`) failed at the harness level (every MCP tool call was denied for approval); the fix is in "Codex approval setting" below and needs a clean re-run of the smoke before the gating runs.**

**Scope for v1 (BENCHMARK.md Amendment 3, note of 2026-11-24): only the Codex (gpt-6.2-sol) half is run. The Claude Code (claude-haiku-5-5) half is NOT run and is reported as "not run".** The Claude client code and its tests stay in the repo, untested against a real model. So the plan below is 6 tasks x 2 reps x 2 arms = **24 gating runs** (12 pairs), not 48.

## Question
Do Claude Code and Codex use fewer output tokens or fewer turns when the server is wrapped with `mcp-return-types serve` (adds `structuredContent`; with `--declare-schemas` also `outputSchema`) than with a plain pass-through proxy?

The Code Mode results (VERDICT.md: claude-haiku-5-5 and gpt-6.2-sol) **do not carry over**. There, the inferred types were shown to a model writing code. Here the model sees whatever its client shows it of a tool result, and whether a client passes `structuredContent` to the model, instead of or next to the text, is the client's choice. "No benefit" is a plausible and acceptable outcome.

## Design
| Item | Choice |
|---|---|
| Arms | **P** plain pass-through proxy (`bench/plain-mcp/passthrough.ts`: the same `src/proxy/proxy.ts` core as `serve`, no observer, no rewriter). **S** `mcp-return-types serve` (default mode) with the seed-1 inferred schemas `bench/arm-d/mock-github.json`. **S2** `serve --declare-schemas` (exploratory, not gating). |
| Only difference | The proxy part of the MCP server command. The upstream server command, the client flags and the prompt are the same (tested in `test/plain-mcp.config.test.ts`; every result also stores its normalized server command and prompt hash). Both proxies run from source through the same tsx loader. |
| Workload | The mock GitHub server, seed 2, 150 ms latency, a fresh process and write log per run, **only its 8 real tools** (`--tools real`, no distractors). |
| Why the mock | The newest reference servers (server-filesystem, server-memory) already declare their own `outputSchema` and return `structuredContent`, and `serve` never replaces a server's own schema, so they cannot show a difference (docs/REAL-SERVERS.md). The mock returns JSON in `content[0].text` with no schema, the common style of real servers. |
| No-harm check | server-everything 1.0.0 (pinned devDependency), 3 tasks (`ev-echo`, `ev-sum`, `ev-weather`, in `bench/plain-mcp/everything-tasks.ts`), arms P and S, 1 rep. Only to show nothing breaks. Its S schemas: `bench/plain-mcp/everything/schemas/everything.json` (`npm run bench:plain:prepare`, a scripted session, no model). On this server `serve` changes nothing visible: echo and get-sum are plain text, get-structured-content has its own schema. |
| Tasks | ctrl-01, nested-03, nested-06, page-02, page-04, write-01 with the existing grader (`bench/grade.ts`), 2 reps. |
| Backends | Codex with `gpt-6.2-sol` (effort `BENCH_CODEX_EFFORT`, default medium). Claude Code with `claude-haiku-5-5` was in the pre-registered design and is **not run in v1** ("not run"). |
| Size | v1: 6 tasks x 2 reps x 2 arms x 1 backend = **24 gating runs** (12 pairs). The pre-registered full size was 48 (both backends). S2: +12 optional. No-harm: +6 (Codex). |
| Verdict | Per backend, S vs P: see BENCHMARK.md Amendment 3 and `bench/plain-mcp/verdict.ts`. With 12 pairs, INCONCLUSIVE is a likely outcome and is not a failure of the tool. |

### The prompt (identical for both arms and both clients)
Sent on stdin; no system prompt of our own (each client keeps its default one). `<server>` is `github` for the mock and `everything` for the no-harm check; `<task prompt>` is the task file's `prompt`.

```
Use the tools of the MCP server "<server>" to do the task below. Use no other tools, and do not run commands or write files.

Task: <task prompt>

End your reply with one line in this form:
FINAL: <answer>
Give <answer> in the format the task asks for, and put nothing after that line.
```
The grader reads the text after the LAST `FINAL:` line (`extractFinal` in `bench/plain-mcp/prompt.ts`).

### The clients (one invocation per run, fresh empty temp cwd, API key variables removed)
- **claude:** `claude -p --model claude-haiku-5-5 --tools "" --mcp-config <run>/mcp-config.json --allowedTools mcp__github__list_issues,... (the 8 tools) --strict-mcp-config --permission-prompts none --disable-slash-commands --setting-sources project,local --no-session-persistence --output-format stream-json --verbose`, env `MCP_TIMEOUT=60000`. Not `--safe-mode` (its help says it disables MCP servers), never `--bare`. stream-json is the only output that shows which assistant message made which tool call; its last event is the same `result` object as `--output-format json`.
- **codex:** `codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only -m gpt-6.2-sol -c model_reasoning_effort=medium --ignore-user-config --disable apps --disable plugins --disable browser_use --disable computer_use --disable image_generation --disable multi_agent -c approval_policy="never" -c mcp_servers.github.command='<node>' -c mcp_servers.github.args=[...] -c mcp_servers.github.startup_timeout_sec=60 -c mcp_servers.github.tool_timeout_sec=120 -c mcp_servers.github.default_tools_approval_mode="approve" -o <run>/last-message.txt -`. No `--output-schema` (no JSON envelope). Checked without a model call: `codex mcp get github --json` with these overrides prints exactly the arm's command and args and accepts the approval key (see below).

### Codex approval setting (added 2026-11-24 after the first smoke run)
**What happened.** In the first real smoke run Codex made 3 MCP tool calls and every one failed with `MCP tool call requires approval, but approval policy is never` (the model then said "the github MCP server requires approval, which is disabled in this session"). In `codex exec` there is nobody to approve, and `approval_policy="never"` auto-denies what needs approval. The run is a harness failure, not a result for any arm.

**The setting.** `-c mcp_servers.github.default_tools_approval_mode="approve"`, one more override next to the server's command and args, in `codexMcpOverrides` (`bench/plain-mcp/config.ts`, constant `CODEX_MCP_APPROVAL_MODE`), so **the same line is generated for every arm** (P, S, S2) and for the no-harm workload (`mcp_servers.everything...`). It is documented in the Codex MCP docs (developers.openai.com/codex/mcp, "Other configuration options": `default_tools_approval_mode`, values `auto`, `prompt`, `writes`, `approve`; a per-tool form `mcp_servers.<name>.tools.<tool>.approval_mode` also exists). Why this one: it is scoped to this one server's tools (the server exposes only the 8 mock tools), it is a documented key, and it needs no bypass flag.

**What it is not.** No `--dangerously-bypass-approvals-and-sandbox`, no `--approve-for-me`, no `--trust`, no global approval change (`approval_policy="never"` stays), and the sandbox is unchanged: **`--sandbox read-only`** (the first smoke already showed the mock server starts under it: its write log was created at start). If a real re-run shows the mock cannot write its log under read-only, use `--codex-sandbox workspace-write` on the empty temp cwd and record it in NOTES.md.

**Checked without a model call** (codex-cli 0.171.0): `codex mcp get github --json` with the generated overrides of all three arms exits 0 and prints the arm's command and args; the same call with `default_tools_approval_mode="bogus"` fails with `unknown variant bogus, expected one of auto, prompt, writes, approve in mcp_servers.github.default_tools_approval_mode`, which proves the CLI parses this exact key and its values. `get --json` does not echo the mode back, and a misspelled key would be silently ignored, so **only a real run can show that tool calls now go through**. An open GitHub issue (openai/codex #24135, codex 0.130.0) reports that no key helped there, but it tried `default_tools_approval_mode="never"`, which is not a valid value (valid: `approve`), so it does not settle this. If the re-run still shows approval errors, write `BLOCKED:` (do not bypass).

**New harness check.** The report now lists runs where every tool call errored ("every tool call errored"), because the failed smoke run passed all earlier checks silently.

### Metrics per run (`bench/results/plain-mcp/<workload>-<arm>-<model>-<task>-<rep>.json`, raw client stream in `.raw.jsonl`)
Output tokens and turns (PRIMARY); total tokens, tool calls, wall time (secondary); pass/fail, refusals (`isRefusal`), duplicate writes. **Turns = tool-call rounds**: claude = assistant messages (by message id) with at least one tool call; codex = groups of consecutive `mcp_tool_call` items (Codex does not mark which calls share one model request, so this is an approximation, the same for both arms). Harness checks in the report: server never started, MCP server not connected, extra tools offered, no tool call, no FINAL, client error, 0 output tokens, Codex shell commands, claude usage vs modelUsage mismatch, non-empty cwd, serve drift events, differing prompts.

## How to run
All commands work in PowerShell and Git Bash (the `node --import tsx` form avoids npm dropping `--` in PowerShell). Sequential only; finished runs are skipped on a restart; create `bench/STOP` to stop before the next run; `BENCH_MAX_RUNS` (per backend, per results folder) and the rate-limit settings come from `bench/.env`.

```
node --import tsx bench/plain-mcp/run.ts --dry-run                       # fake client, real proxies, no model
node --import tsx bench/plain-mcp/run.ts [--backend claude-cli|codex-cli] [--workload mock|everything] [--arms "P,S"]
     [--tasks "ctrl-01,page-02"] [--reps 2] [--model <id>] [--limit <n>] [--out <dir>] [--latency 150] [--codex-sandbox read-only]
node --import tsx bench/plain-mcp/analyze.ts [--raw bench/results/plain-mcp] [--everything bench/results/plain-mcp-everything] [--out <file>]
```
Exit codes as in `bench/run.ts`: 0 done or stopped by STOP, 1 CLI failure after 2 retries, 3 rate-limit wait budget used up, 4 not signed in (WAITING-HUMAN).

## M11b command list (the owner runs these, one at a time, in a plain PowerShell window)
1. Check the setup (no model call): `npm run bench:preflight`, then `node --import tsx bench/plain-mcp/run.ts --dry-run`.
2. **Smoke, 1 Codex run** (arm S, ctrl-01; its own folder so the gating data starts clean). The first attempt (`bench/results/plain-mcp-smoke`) hit the approval blocker and is kept as evidence; **re-run into a NEW folder**:
   - `node --import tsx bench/plain-mcp/run.ts --backend codex-cli --tasks "ctrl-01" --arms "S" --reps 1 --out bench/results/plain-mcp-smoke2`
   - `node --import tsx bench/plain-mcp/analyze.ts --raw bench/results/plain-mcp-smoke2 --everything bench/results/plain-mcp-smoke2 --out bench/results/plain-mcp-smoke2/REPORT.md`
   - Then an agent checks the `.raw.jsonl` against the checklist below before step 3. (No Claude smoke: the Claude half is not run in v1.)
3. **The 48 gating runs** (Codex only in v1): `node --import tsx bench/plain-mcp/run.ts --backend codex-cli`
4. Optional, exploratory: `node --import tsx bench/plain-mcp/run.ts --backend codex-cli --arms "S2"` (12 runs) and the no-harm check `node --import tsx bench/plain-mcp/run.ts --backend codex-cli --workload everything` (6 runs).
5. Analysis: `node --import tsx bench/plain-mcp/analyze.ts` (writes `bench/results/plain-mcp/REPORT.md` and prints one `VERDICT` line per backend).

### Smoke checklist (written before any run; status after the first Codex smoke, 2026-11-24)
PASS = confirmed by a real run, FAIL = a real run showed a problem, OPEN = needs the re-run (smoke2). The Claude item is **not run** (the Claude half is out of v1 scope).

| # | Item | Status |
|---|---|---|
| 1 | codex: the MCP server starts under `--sandbox read-only` (`serverStarted: true`; the mock creates its write log at start) | **PASS** in smoke 1 (`serverStarted: true`, `cwdWasEmpty: true`); smoke2 confirms again |
| 2 | codex: tool calls appear as `item.started` / `item.completed` items of type `mcp_tool_call` with `server`, `tool`, `arguments`, `status`, `error` | **PASS** in smoke 1 (3 calls seen, shape as parsed) |
| 3 | codex: tool calls are NOT cancelled for approval | **FAIL in smoke 1** (all 3 denied). Fix applied 2026-11-24 (`default_tools_approval_mode="approve"`). **OPEN: mark PASS only after smoke2 shows `status: completed` calls with a `result`.** |
| 4 | codex usage field names: `turn.completed.usage` has `input_tokens` (includes cached), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` | **PASS** for the names in smoke 1: parsed as uncached input 2,974 = 63,390 - 60,416 cached, cache read 60,416, output 178. `reasoning_output_tokens` was 0 in this short run, so whether `output_tokens` already contains reasoning is **OPEN** (Amendment 3 says "as reported"; look at smoke2) |
| 5 | codex turn counting: consecutive `mcp_tool_call` items form one round | **PASS** as far as smoke 1 allows (3 consecutive calls gave `turns: 1`, `toolCalls: 3`, `toolErrors: 3`). A split (calls, then text, then more calls) has not been seen: **OPEN** |
| 6 | a FINAL line is found and the run is graded | **PASS** in smoke 1 (the text was extracted and graded; it failed on the answer, not on parsing) |
| 7 | no harness check fires | **FAIL in smoke 1, silently**: the failed run passed every check. The new "every tool call errored" check now catches it. Re-check after smoke2 |
| 8 | the answer is right and the run passes (ctrl-01 expects the title of issue 42) | **OPEN** (smoke 1 could not get the data) |
| 9 | claude: init event lists `github` as `connected` and offers only the 8 `mcp__github__*` tools; `tool_use` blocks with message ids; `usage.output_tokens` equals the `modelUsage` sum; `--setting-sources project,local` untested | **not run** |

If a parser assumption turns out wrong in smoke2, fix the parser (not the criteria) and rerun the smoke.

## Results
_Empty until M11b._

## Conclusion
_Empty until M11b. It will state the verdict per backend as pre-registered, including "no benefit" or INCONCLUSIVE if that is the outcome._
