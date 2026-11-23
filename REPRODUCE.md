# Reproducing the v1 results

There are two levels. **Verify** recomputes every v1 number from the raw results committed in this repo. It
needs no model, no account and no network after `npm ci`. **Re-run** repeats the benchmark on your own Claude and
ChatGPT subscriptions, with no API keys.

Every command below works in Windows PowerShell and in Git Bash. The benchmark scripts are started with
`node --import tsx ...` instead of `npm run ... -- ...`, because PowerShell can drop the `--` when it goes
through npm's shim.

## 0. Setup

```
git clone https://github.com/shahzeb4444/mcp-return-types.git mcp-return-types
cd mcp-return-types
npm ci
npm run build
npm test
```

You need Node 22 or newer. `npm test` runs about 540 tests with a fake model backend and makes no network or model calls.

## 1. Verify one result without re-running anything (about 1 minute)

The raw results of the full Code Mode run are committed in `bench/results/full`. That is 600 runs (3 models x 20
tasks x 5 reps x arms C and D), with one `<arm>-<model>-<task>-<rep>.json` (the result) and one `.jsonl` (every
model turn, with the token counts the CLI reported) per run. Recompute the report into a gitignored folder:

```
node --import tsx bench/analyze.ts --raw bench/results/full --out .typegen/verify/REPORT.md
```

Expected console lines (the bootstrap is seeded, 10,000 resamples, seed 20261122, so the numbers are exact):

```
VERDICT claude-cli: PASS | without exclusions: PASS
  model claude-haiku-5-5: PASS
VERDICT codex-cli: PASS (excluded: gpt-6-luna, arm-C refusal rate 31% > 25%) | without exclusions: KILL
  model gpt-6-luna: KILL (EXCLUDED: harness-incompatible (Amendment 2, rule written after the full run): arm-C refusal rate 31% (31/100) > 25%)
  model gpt-6.2-sol: PASS
...
codex-cli gpt-6.2-sol paired (100): output D/C 0.72 [0.63, 0.82], turns D/C 0.74 [0.69, 0.80], success D-C 1.0 [0.0, 3.0], ...
analyze: 600 run(s) -> .typegen/verify/REPORT.md
```

Compare with the committed report. The only difference should be the `Generated <timestamp>` line:

```
git diff --no-index bench/results/REPORT.md .typegen/verify/REPORT.md
```

The plain-MCP result (Codex, gpt-6.2-sol, 24 runs) works the same way:

```
node --import tsx bench/plain-mcp/analyze.ts --raw bench/results/plain-mcp --out .typegen/verify/PLAIN-MCP-REPORT.md
git diff --no-index bench/results/plain-mcp/REPORT.md .typegen/verify/PLAIN-MCP-REPORT.md
```

Expected: `VERDICT codex-cli (gpt-6.2-sol): INCONCLUSIVE`, output tokens S/P 0.95 [0.82, 1.11], and again only
the timestamp line differs.

Both of these were checked on 2026-11-24 for the v1 release.

What the analysis does is described in [BENCHMARK.md](BENCHMARK.md) (Analysis, Amendments 1 to 3). The verdict
rules are in `bench/analysis/verdict.ts`, with unit tests in `test/bench.verdict.test.ts`.

### Other checks that need no model

```
npm run bench:reference                                # scripted solver (no LLM): 20/20 tasks pass on seed 2
node --import tsx bench/run.ts --dry-run --out .typegen/dry-run   # harness end to end with the fake backend
npm run validate:real -- --skip-latency                # real-server match rate (downloads 3 servers via npx: needs network)
```

The dry run uses canned answers, so its runs FAIL by design. It shows that the harness, the sandbox, the logging
and resume work: run it twice, and the second run prints `0 run(s) done, 4 already finished (skipped)`.

The arm D types used in v1 are committed in `bench/arm-d/`. They were built from seed-1 traffic by
`npm run bench:warmup` (no model). Running that again overwrites `bench/arm-d/`.

## 2. Re-run the benchmark on your subscriptions (no API keys)

The models are called only through the subscription CLIs: `claude -p` (Claude Code, signed in with a Claude plan)
and `codex exec` (Codex CLI, signed in with a ChatGPT plan). The harness never uses an API key.

**No API keys.** Leave `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` unset: they would switch the CLIs
to paid API billing. The harness removes them from every child process, and the preflight check fails if one is set.
In PowerShell, `Remove-Item Env:ANTHROPIC_API_KEY` clears one for the current window.

### Before the first run

```
claude auth status        # should show loggedIn: true
codex login status        # should say "Logged in using ChatGPT"
```

Copy `bench/.env.example` to `bench/.env` and edit it. It holds settings only, never keys. Use pinned model IDs
(`claude-haiku-5-5`, `gpt-6.2-sol`), never aliases such as `haiku`. Then:

```
npm run bench:preflight   # ends with "preflight: OK"; do not start while it shows an ERROR
```

### Full Code Mode run, one model at a time

Write into a new folder, not into `bench/results/full`. Each command is 20 tasks x 5 reps x arms C and D = 200 runs,
and each run is 1 to 12 model turns (2 to 3 on average in v1).

```
node --import tsx bench/run.ts --set full --backend codex-cli --models "gpt-6.2-sol" --arms "C,D" --out bench/results/rerun
node --import tsx bench/run.ts --set full --backend claude-cli --models "claude-haiku-5-5" --arms "C,D" --out bench/results/rerun
node --import tsx bench/analyze.ts --raw bench/results/rerun --out bench/results/rerun/REPORT.md
```

Quote list arguments (`--arms "C,D"`), because a bare `C,D` is an array in PowerShell. A verdict is computed only
for a backend whose every model in the folder has all 20 tasks with at least 5 paired reps. Anything less is
reported as "directional only".

**Do not expect identical numbers.** The models are nondeterministic, and the CLIs and models change over time.
Compare the intervals and the direction, not the exact values.

### Plain-MCP run (Codex only in v1)

```
node --import tsx bench/plain-mcp/run.ts --dry-run                                   # fake client, real proxies, no model
node --import tsx bench/plain-mcp/run.ts --backend codex-cli --out bench/results/plain-mcp-rerun
node --import tsx bench/plain-mcp/analyze.ts --raw bench/results/plain-mcp-rerun --out bench/results/plain-mcp-rerun/REPORT.md
```

Design, the prompt and the Codex MCP approval setting (applied the same way in every arm) are in [docs/PLAIN-MCP.md](docs/PLAIN-MCP.md).

### Rate limits, stopping and resuming

- **Sequential only.** Never start two benchmark commands at once.
- **Usage limits are normal.** When a CLI reports a rate or usage limit, the harness prints that it is sleeping,
  waits `BENCH_RATE_LIMIT_SLEEP_MIN` minutes (default 30) and retries the same turn, for up to
  `BENCH_MAX_WAIT_HOURS` (default 24) in total per command. Leave the window open.
- **Resume.** Running the same command again skips every finished run. A run that was interrupted halfway is
  redone from scratch, so nothing is counted twice. Arms are interleaved by (task, rep), so a half-finished
  benchmark stays balanced between C and D.
- **Stop cleanly.** Create the file `bench/STOP` (PowerShell: `New-Item -ItemType File bench\STOP`). The harness
  finishes the current run and stops. It checks before every run and after every limit wait. Delete the file to go on.
  Ctrl+C also works and loses only the unfinished run.
- **Cap.** `BENCH_MAX_RUNS` in `bench/.env` caps the finished runs per backend (default 500).

Exit codes (PowerShell: `$LASTEXITCODE`):

| Code | Meaning | What to do |
|---:|---|---|
| 0 | Finished, or stopped by `bench/STOP` | Next command (or delete STOP and rerun) |
| 3 | The whole limit-wait budget was used | Wait for your plan's limit to reset, then rerun the same command |
| 1 | A CLI error the harness did not recognise (retried twice) | Wait, then rerun the same command |
| 4 | A CLI is not signed in | Sign in, then rerun |

Known gap: no real limit message from either CLI was seen during v1, so the limit-detection patterns are
educated guesses (covered by tests with a fake CLI). A real limit may show up as exit code 1 instead of a sleep.
Rerunning is always safe.

## Costs

Subscription runs are not billed per token. The token counts are what each CLI reports. Dollar figures in the
reports are **estimates** from `bench/prices.json` (cache-weighted, Haiku only; no Codex prices are in the file on
purpose), not money spent or saved.
