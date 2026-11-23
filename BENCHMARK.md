# BENCHMARK: do inferred return types help Code Mode?

## Hypothesis (H1), fixed before running
Arm D (Code Mode + inferred types) against Arm C (Code Mode with `unknown` returns), on the same tasks and models.

**Definitions:**
- **Code errors per task** = (sandbox runs that end in an exception or a timeout) + (code blocks submitted directly after such a failed run, i.e. rewrites).
- **Significant** means the paired bootstrap 95% CI of the D−C difference (see Analysis) excludes 0 (α = 0.05).
- **Weak model:** on `claude-cli` it is `claude-haiku-5-5`. On `codex-cli` it is the smaller model if the plan offers one, otherwise its default model (confirmed in M6 and recorded in NOTES.md).

**Thresholds** (applied to the **full run only**, per backend and model; changed by Amendment 1 below, AFTER the pilot data was seen). All intervals are paired bootstrap 95% CIs (see Analysis); ratios are D/C.
- **PRIMARY:** output tokens per task and turns per task (D/C ratios).
- **NON-INFERIORITY:** success of D minus C, in percentage points: the lower bound of the 95% CI must be ≥ −10 points on every model. The gate uses all pairs; refused runs are reported separately, and the same CI with refused pairs left out is reported next to it (not gating).
- **PASS** requires both:
  - the upper CI bound of the output-token ratio is < 1.0 on at least one model of the backend, and no model of the backend has an upper bound > 1.05 on either the output-token ratio or the turns ratio;
  - non-inferiority holds.
- **KILL:** the output-token ratio CI contains or exceeds 1.0 (upper bound ≥ 1.0) for every model of the backend, *or* success non-inferiority fails.
- **PARTIAL:** anything else. Write down what moved.
- **SECONDARY** (reported, never gating): code errors per task (D−C and D/C), total tokens per task (D/C), and a cache-weighted cost estimate per task from `bench/prices.json` (Cost formula below; always labelled an estimate, and not computed for a model with a missing or `null` price). If D's cache-weighted estimate is higher than C's, the verdict must say so. The original criteria (in Amendment 1) are also evaluated and reported as secondary results.
- A CI that cannot be computed counts against D, never for it.

### Amendment 1 (2026-11-23)
**These criteria were changed after seeing pilot data.** The pilot (12 tasks × 2 reps, directional only) showed that the strong models make about 0 code errors per task in both arms, so the original primary criterion (fewer code errors) cannot register a difference, whatever the types do. What did move was output tokens and turns per task (D/C point estimates: Haiku output 0.57, turns 0.91; Sol output 0.66, turns 0.68; Luna dominated by refusals in both arms). The owner therefore made output tokens and turns the primary metrics, added a success non-inferiority margin, and moved code errors to secondary. Because this was decided after looking at the data, the full-run verdict is less of a pre-registered test than the original plan was, and any report of it must say so.

The original criteria (written before any run) stay listed here and are still computed by `bench/analyze.ts` as **secondary, non-gating results**:
- *Original PASS* required all three: D has ≥30% fewer code errors per task than C and the difference is significant; D's success on the backend's weak model is at least 5 points higher than C's; D's output tokens per task and turns per task have upper 95% CI bounds of the D/C ratio ≤ 1.05 (cache-weighted cost on the paid API backend).
- *Original KILL:* no significant change in code errors on either model, *or* D's output tokens per task or turns per task are more than 10% higher than C's (D/C point estimate > 1.10).
- *Original PARTIAL:* anything else.
- How `bench/analyze.ts` reads them: "≥30% fewer" = code-error D/C point ≤ 0.70 with the D−C CI below 0, on at least one model; the ≤ 1.05 guardrail applies to every model.

### Amendment 2 (2026-11-23)
**This rule was written AFTER seeing the full-run results of gpt-6-luna.** It was not planned before any run, and the v1 verdict is a less strict test because of it.

**Rule:** a model whose arm-C (baseline) refusal rate is above 25% is excluded from its backend's verdict as harness-incompatible. The rate is refused arm-C runs divided by paired arm-C runs (a refusal is a failed run whose final answer says the tools or the data are unavailable, as detected by `bench/analysis/classify.ts`). Exactly 25% is not excluded. The rule applies to full-run data only; pilot and partial data stay "directional only", as before.

**Effect:** gpt-6-luna is excluded from the v1 claims. In the full run it refused in 31 of 100 arm-C runs and 50 of 100 arm-D runs, and its success was 52% in C and 27% in D (McNemar 36/11, p < 0.001). claude-haiku-5-5 and gpt-6.2-sol refused 0 times in either arm and are not affected. The `codex-cli` verdict is therefore computed from gpt-6.2-sol alone, which is the backend's default model and not its weak model, so v1 has no tested weak Codex model.

**Why:** arm C has no return types at all, so a refusal in arm C cannot be caused by the inferred types. It means the model does not accept the harness (a single `run_code` tool described in the prompt, with the reply format described there) and answers that the tools are unavailable instead of writing code. On such a model, a large share of the runs measures harness failure, not the effect of return types.

**What this does not explain:** Luna refused MORE often in arm D than in arm C (50 vs 31). We do not know why yet. This is exactly the result that made Luna fail non-inferiority, so excluding it removes the one model on which D looked worse. Readers should weigh the v1 Codex claim with that in mind.

**What stays on record:** all Luna data in `bench/results/full` is kept unchanged. The automatic `codex-cli` verdict computed before this amendment is **KILL** (caused entirely by Luna), and it stays on record: `bench/analyze.ts` prints every model's own verdict (Luna on its own: KILL), lists excluded models with the reason and their own numbers, and prints the backend verdict without the exclusion on the same line as the amended one. Luna is revisited in v2 (M14): the refusals are analyzed from the existing results first, and any wording fix is applied identically to both arms and piloted before any new full run.

## Workload: mock GitHub MCP server (`bench/mock-server`)
- stdio MCP server built with the official TS SDK, with **no outputSchema declared**. Results are returned as a JSON string in `content[0].text`, because that is what real servers commonly do.
- Real tools: `list_issues(repo,state,label,page)`, `get_issue(repo,number)`, `list_comments(repo,number,page)`, `search_issues(q)`, `add_label`, `assign`, `post_comment`, `list_prs(repo,state)`. The shapes are realistic and nested: `user{login,id}`, `labels[{name,color}]`, an optional `assignee`, a nullable `closed_at` and `milestone`, and pagination `{items,next_page|null}`.
- 30 distractor tools from fake CI and chat servers.
- Seeded data: seed 1 is for **type inference warm-up only**, and seed 2 is for **evaluation**. The two never mix. 3 repos, about 1,500 issues, about 12,000 comments, pages of 50.
- 150 ms injected latency per call. Writes are idempotent in state, and every write is logged so duplicates can be counted.
- **State reset:** every run starts a fresh mock server process on seed 2, so no run sees another run's writes. The write log is per run.
- **Seed-1 warm-up traffic (builds the arm D types):** a script, `bench/warmup.ts`, with no model involved, calls every tool (real and distractor) at least 10 times on seed 1 through `mcp-return-types record`. It varies the arguments (each `state`, several labels, first, middle and last pages, issues with and without assignee, milestone and `closed_at`), and triggers at least one error result per real tool where possible. It then runs `infer` and `emit`, writing to `bench/arm-d/` (not `.typegen/`, which is gitignored). That folder is committed so arm D is reproducible.

## Tasks (`bench/tasks/*.json`): 20 tasks, each with a code-checkable answer
- 8 need **nested or optional fields**, e.g. "open bugs in api assigned to nobody with >5 comments" or "users who commented on ≥3 issues labeled perf".
- 6 need **pagination**, using `next_page` null handling.
- 4 involve **writes**: label, assign or comment on a computed set. The grader checks final state and counts duplicates.
- 2 are **single-call controls**, e.g. "title of issue 42".
- Each task has `answer` (a set, number or string) and/or `expected_state`. The grader is pure code.

## Arms
| Arm | Setup |
|---|---|
| A | Plain MCP: all 38 tools as native tools (reference; not run for now, see Models and reps) |
| C | Code Mode: one `run_code` tool. Its description holds TS stubs from the input schemas, every return is `Promise<unknown>`, and it carries the shared unwrap note |
| D | Same as C, including the same unwrap note, except the returns are the inferred types from mcp-return-types (built from seed-1 traffic) |

The **shared unwrap note**, word for word the same in C and D, says that results arrive already unwrapped: `structuredContent` if present, otherwise the joined text parsed as JSON, otherwise the raw string.

C and D share the same sandbox (a Node child process with `node:vm`, 20 s timeout, no network), the same system prompt, the same unwrap note and the same max of 12 turns. The sandbox output fed back to the model (stdout plus the return value) is truncated to 8,000 characters with a `[truncated N chars]` marker, the same in both arms. In C and D the sandbox unwraps exactly the same way, so the **only** difference is the type information in the description. (Optional Arm B, tool search, can come later.)

## Backends: the two subscription CLIs are the plan
Primary backends (no API key, no per-token cost). **Every CLI call runs with a fresh empty temporary directory as its working directory**, never the repo, so the CLI does not load this repo's `AGENTS.md`/`CLAUDE.md` or project settings. Further isolation flags (for example, ones that skip user settings, MCP servers or slash commands) are **not named here on purpose**: confirm them with `claude -p --help` in M6 and record them in NOTES.md before using them.
- **`claude-cli`**, using your Claude subscription. Per model turn: `claude -p --model <claude-haiku-5-5|claude-sonnet-5-5> --tools "" --system-prompt-file <file> --no-session-persistence --output-format json`, prompt on stdin. Do NOT use `--bare` (it ignores the subscription login). Keep `ANTHROPIC_API_KEY` unset. Parse `result`, and store the whole JSON of every call so usage fields can be found (M6 must print one real response and write the real field names to NOTES.md). Confirm every flag in this command with `claude -p --help` in M6 too.
- **`codex-cli`**, using your ChatGPT login (`codex login`). Per model turn: `codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only -` with the prompt on stdin. Read the final message from the JSONL stream and tokens from `turn.completed` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`). The model flag must be confirmed with `codex exec --help` (M6, write it in NOTES.md).

Both CLIs are agents with their own prompts, so the harness does not use native tool calling. **The model is asked to reply with one fenced ```ts block (the code to run), or a final answer line `FINAL: ...`.** The harness runs the code in the sandbox, feeds the output or error back as the next user turn, and keeps the whole conversation itself (re-sent each turn). This is identical across backends, which keeps arms C and D comparable. Each backend gets a model-quality note in the verdict, because Claude and Codex runs are not interchangeable.

**Backend adaptation (M6b, owner decision 2026-11-22).** The plain-text protocol failed on Codex (11 of 12 protocol-invalid replies), so the `codex-cli` backend alone passes `--output-schema bench/harness/codex-envelope.schema.json` and the model replies with a JSON envelope `{action: run_code|final, code, answer}`. The harness converts it to the same internal reply (run_code = a code block, final = a FINAL answer); a non-JSON or malformed envelope is a protocol-invalid turn. Only the reply-format paragraph of the shared prompt differs for Codex; everything else, including the "no tools exist" wording, is identical. Claude keeps the fenced-block protocol. Because of this, **the comparison that matters is C vs D within each backend**, not Claude vs Codex.

Optional extra backends (not required): `ollama` (free local, unlimited), `openai-compat` (free tiers), `anthropic-api` (paid).

**What changes without the paid API:** no usage-based dollar cost is measured, and cache fields may be missing. The cost criterion in H1 therefore uses output tokens per task and turns per task, as written in the thresholds above. Total tokens are reported as context. Dollar costs, if shown, are *estimates* from `prices.json` and labelled so.

**Subscription limits are the real constraint.** Both CLIs are metered by plan usage, and a model turn re-sends the whole conversation. Therefore:
- Runs are **resumable and idempotent**: results go to `bench/results/raw/<arm>-<model>-<task>-<rep>.json`, and finished runs are skipped on restart.
- On a rate-limit or usage-limit error, the harness sleeps (default 30 min, configurable), then retries, up to `BENCH_MAX_WAIT_HOURS` in total.
- Arms run **interleaved** by (task, rep), so a half-finished benchmark is still balanced.
- A kill switch: create a file `bench/STOP` to stop cleanly after the current run.
- Never run the benchmark in parallel. Sequential only.

## Models and reps
Two backends × two model strengths where available: `claude-cli` with `claude-haiku-5-5` (weak) and `claude-sonnet-5-5` (strong), always passed as these exact IDs, never as aliases. `codex-cli` uses its default model, and one smaller model if the plan offers it (confirm in M6). Arms: **C and D only** (arm A, plain MCP, is dropped because it needs native tool calling that this setup avoids; it can be added later on the paid API).
- **Smoke:** 1 rep × 3 tasks × 2 arms × each backend's weak model.
- **Pilot:** 2 reps × 12 tasks × 2 arms × 2 models per backend ≈ 96 runs per backend (roughly 400 model turns). The 12 pilot tasks are a fixed stratified subset chosen in M4 and listed in `bench/tasks/pilot.json`: 5 nested/optional, 4 pagination, 2 writes and 1 control.
  - **The pilot is a directional check only.** The PASS/KILL/PARTIAL thresholds apply to the full run only, never to the pilot.
  - The M7 pilot gate only checks that the harness works and nothing is broken: every run completes, tokens are logged, there are no crashes or 0-token runs, and the arms are comparable. It does not check whether D is ahead.
- **Full:** 5 reps × 20 tasks × 2 arms × 2 models per backend ≈ 400 runs per backend (roughly 1,600 turns), spread over as many days as the limits need.
- The verdict is per backend. A pooled result is **exploratory only**: report it only if both backends agree in direction, and never use it for PASS/KILL.
- Randomize arm order within each (task, rep) pair and interleave runs over time.

## Logged per model turn (`bench/results/raw/*.jsonl`)
arm, model, task, rep, turn, `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, latency_ms, tool calls, sandbox exceptions (with message), script rewrites, final answer, pass/fail, duplicate writes.

## Cost formula
cost = uncached_in × p_in + cache_write × p_write + cache_read × p_read + output × p_out

Prices (used for the paid backend and for labelled estimates) live in `bench/prices.json`, which a human checks against https://platform.claude.com/docs/en/about-claude/pricing on run day. Never hard-code prices anywhere else. The harness must refuse any paid run while a price in the file is `null`.

## Analysis (`bench/analyze.ts`, which writes `bench/results/REPORT.md` and `VERDICT.md`)
- Per arm and model: success rate, median and mean output tokens per task, total tokens per task (context only), median latency, code errors per task, turns per task. Show cost (median and mean) only for the paid backend, or as labelled estimates.
- Pair runs by (task, rep, model). Bootstrap 95% CI (10,000 resamples over tasks) for the D/C ratios of output tokens per task and of turns per task (cost on the paid backend), for the D−C difference in success points (with and without refused pairs), and, as secondary results, for the D−C difference in code errors per task and the D/C ratios of total tokens and of the cache-weighted cost estimate. McNemar exact test on paired pass/fail.
- The verdict (Thresholds, Amendment 1) is computed per backend only when every model of that backend has full-run data (20 tasks, at least 5 paired reps per task); for anything less the report says "directional only" and checks no threshold.
- Where the backend reports them, break tokens down into cache write, cache read, uncached input and output.
- VERDICT.md opens with PASS, KILL or PARTIAL in one line per backend, followed by the numbers checked against each threshold above. Thresholds are checked on full-run data only.

## Amendment 3 (2026-11-23): plain-MCP test (M11), pre-registered
**Written BEFORE any plain-MCP run. No plain-MCP results of any kind (not even a smoke run) had been seen when this section was written and committed; its commit is the pre-registration.** The harness for this test did not exist yet either. This is a separate test with its own arms and criteria; it does not change H1 or Amendments 1 and 2.

**Question.** Do ordinary MCP clients (Claude Code and Codex with their native MCP tool calling, NO Code Mode) use fewer output tokens or fewer turns when the server is wrapped with `mcp-return-types serve` than with a plain pass-through proxy?

**The Code Mode results do not carry over.** The H1 results for claude-haiku-5-5 and gpt-6.2-sol (VERDICT.md) measure types shown to a model that writes code against `unknown` or typed stubs. Here the model sees tool results the way its client presents them, and `serve` only adds `structuredContent` (and, in S2, `outputSchema`). Whether a client shows `structuredContent` to the model, instead of or next to the text, is up to the client. So no direction is assumed, and a null result is a plausible outcome.

**Arms** (everything else identical; the arms differ only in the proxy command that the client starts as its MCP server):
- **P**: a plain pass-through stdio proxy (the same `src/proxy/proxy.ts` core as `serve`, with no observer and no rewriter), in front of the server.
- **S**: `mcp-return-types serve` (default mode: adds `structuredContent` where the result validates, declares no `outputSchema`), reading the seed-1 inferred schemas of `bench/arm-d/mock-github.json` (the arm D schemas, built from seed-1 warm-up traffic only).
- **S2** (exploratory, NOT gating): `serve --declare-schemas`. Reported next to S, never used for the verdict.

**Workload.** The mock GitHub server (`bench/mock-server`), seed 2, 150 ms latency, a fresh server process and write log per run, exposing **only its 8 real tools** (no distractors). Why the mock and not the M9 reference servers: the newest reference servers (server-filesystem, server-memory) already declare their own `outputSchema` and return `structuredContent`, and `serve` never replaces a server's own schema, so they cannot show a difference; the mock returns JSON in `content[0].text` with no schema, which is the common style of real servers. A **"no harm" check** also runs on `@modelcontextprotocol/server-everything` (the pinned devDependency): 3 simple tasks (echo, get-sum, get-structured-content), arms P and S, only to show that nothing breaks; it is not gating.

**Tasks and reps.** 6 existing tasks with the existing grader (`bench/grade.ts`): ctrl-01, nested-03, nested-06, page-02, page-04, write-01. 2 reps. Both backends: Claude Code with `claude-haiku-5-5`, Codex with `gpt-6.2-sol` (effort from `BENCH_CODEX_EFFORT`, default medium). 6 tasks x 2 reps x 2 arms (P, S) x 2 backends = **48 gating runs** (12 pairs per backend); S2 and the no-harm check are extra.

**Prompt.** One prompt text per task, identical across arms and across both clients (no system prompt of our own; each client keeps its default one). The model must end with a line `FINAL: <answer>` so the existing grader works. The exact text is in `docs/PLAIN-MCP.md` and `bench/plain-mcp/prompt.ts`.

**Clients.** Each run is ONE client invocation in a fresh empty temp directory, with the MCP server configured for that run only: `claude -p` with `--mcp-config <file> --strict-mcp-config`, the allowed tools limited to that server's tools, no built-in tools, no session persistence, no `--bare`, `ANTHROPIC_API_KEY` unset; `codex exec` with the server set through `-c mcp_servers.<name>...` overrides, `--ephemeral --skip-git-repo-check --ignore-user-config` and the existing isolation flags of `bench/backends/codex-cli.ts` (no JSON envelope: plain final message). Sequential only, resumable, rate-limit sleep and retry, `bench/STOP`, `BENCH_MAX_RUNS`.

**Metrics per run.** Output tokens (PRIMARY; Codex output includes reasoning tokens, as reported), turns (PRIMARY) = tool-call rounds: for Claude, assistant messages that contain at least one tool call (counted from `--output-format stream-json`); for Codex, groups of consecutive `mcp_tool_call` items in the `--json` stream (Codex does not mark which calls share one model request, so this is an approximation, applied the same way to both arms). Also: total tokens, tool calls, wall time, pass/fail (existing grader), refusals (existing classifier `isRefusal`), duplicate writes. Secondary only, never gating: total tokens, tool calls, wall time.

**Analysis.** Pairs = (backend, model, task, rep), S vs P. Paired bootstrap 95% CIs over TASKS (all reps of a drawn task kept together), 10,000 resamples, seed 20261122, as in `bench/analysis/stats.ts`: ratio S/P of output tokens (sum over pairs / sum over pairs), ratio S/P of turns, difference S−P in success points; exact McNemar on paired pass/fail. Per backend, never pooled for the verdict.

**Criteria (per backend, S versus P):**
- **KILL**: the output-token ratio CI lies entirely above 1.0 (lower bound > 1.0), *or* success non-inferiority fails (lower bound of S−P < −10 points).
- **PASS**: upper CI bound of the output-token ratio < 1.0, *and* upper CI bound of the turns ratio ≤ 1.05, *and* success non-inferiority holds (lower bound of S−P ≥ −10 points).
- **INCONCLUSIVE**: not KILL, and the output-token ratio CI contains 1.0. **With 12 pairs per backend this outcome is expected to be likely; it is not a failure of the tool**, only too little data to tell.
- **PARTIAL**: anything else (for example output tokens clearly lower but the turns upper bound above 1.05). Write down what moved.
- Order of checks: KILL, then PASS, then INCONCLUSIVE, then PARTIAL. A CI that cannot be computed never counts for S (it cannot give PASS; a missing success CI fails non-inferiority). The verdict is computed only when a backend has all 12 pairs (6 tasks x 2 reps); with fewer it is NOT CHECKED (directional only). S2 and the no-harm check get no verdict.

### Amendment 3, note of 2026-11-24 (scope and harness setting; criteria unchanged)
- **Scope for v1.** Only the **Codex (gpt-6.2-sol) half** of the plain-MCP test is run. The **Claude Code (claude-haiku-5-5) half is not run** and is reported as "not run" (not as a pass, a fail or inconclusive). The Amendment 3 verdict is therefore computed for `codex-cli` only.
- **Smoke finding.** The first real smoke run (1 Codex run, arm S, task ctrl-01, folder `bench/results/plain-mcp-smoke`) hit an approval blocker: Codex made 3 MCP tool calls and all were denied with "the github MCP server requires approval, which is disabled in this session". In `codex exec` an MCP tool call needs approval and nobody can give it, so no arm could have worked.
- **Fix.** A harness setting (a per-server Codex config override that lets only this MCP server's tools run without approval), applied **identically to every arm** (P, S, S2). It is not an arm difference. The criteria, the arms, the tasks, the reps and the analysis are unchanged. No plain-MCP result has been seen: the only run so far failed at the harness level (every tool call denied), and its data is not part of any verdict.
- 2026-11-24: the plain-MCP Codex result is recorded in docs/PLAIN-MCP-RESULT.md.
