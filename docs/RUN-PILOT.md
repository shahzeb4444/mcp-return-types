# Running the M7 pilot (for the human)

The pilot is run by you, in a plain **PowerShell** window, not inside a Claude or Codex session (an agent session would sit and burn its own usage while it waits). The agent has prepared everything; it analyses the results afterwards.

**The pilot is directional only.** It checks that the harness works: every run finishes, tokens are logged, nothing crashes and the arms are comparable. The PASS/KILL/PARTIAL thresholds of BENCHMARK.md apply to the full run (M8) only.

## What you will run

Four blocks, one model each, in this order. Each block is the fixed pilot task list (`bench/tasks/pilot.json`, 12 tasks) x 2 reps x arms C and D = **48 runs**. A run is 1 to 12 model turns.

| # | Backend | Model | Runs | Model turns (expected / maximum) |
|---|---|---|---:|---|
| 1 | codex-cli | gpt-6-luna | 48 | about 100-200 / 576 |
| 2 | codex-cli | gpt-6.2-sol | 48 | about 100-200 / 576 |
| 3 | claude-cli | claude-haiku-5-5 | 48 | about 100-200 / 576 |
| 4 (optional, later) | claude-cli | claude-sonnet-5-5 | 48 | about 100-200 / 576 |

The turn estimate comes from the smoke test (1.5 to 2.5 turns per run on 3 easy tasks) and BENCHMARK.md (about 4 turns per run on the pilot); the pilot has harder pagination and write tasks, so expect more turns than in the smoke test. A turn takes roughly 5 to 25 seconds, so a block takes on the order of 30 to 90 minutes when no usage limit is hit.

All results go to `bench/results/pilot\` (one `.json` and one `.jsonl` per run). Every block is **resumable**: running the same command again skips finished runs. A run that was interrupted halfway starts again from scratch.

The commands call `node --import tsx ...` directly instead of `npm run bench -- ...`, because Windows PowerShell can drop the `--` when it goes through npm's PowerShell shim. The two are otherwise the same.

## 0. Once, before the first block

```powershell
cd C:\dev\mcp-return-types
git status
claude auth status
codex login status
```

`git status` should say the tree is clean. `claude auth status` should show `loggedIn: true`; `codex login status` should say "Logged in using ChatGPT". If either is not signed in, sign in first (`codex login`, choose "Sign in with ChatGPT"; for Claude, run `claude` once and sign in).

## Block 1: Codex, gpt-6-luna

```powershell
cd C:\dev\mcp-return-types
npm run bench:preflight
node --import tsx bench/run.ts --set pilot --backend codex-cli --models "gpt-6-luna" --reps 2 --arms "C,D" --out bench/results/pilot
```

## Block 2: Codex, gpt-6.2-sol

```powershell
cd C:\dev\mcp-return-types
npm run bench:preflight
node --import tsx bench/run.ts --set pilot --backend codex-cli --models "gpt-6.2-sol" --reps 2 --arms "C,D" --out bench/results/pilot
```

## Block 3: Claude, claude-haiku-5-5

```powershell
cd C:\dev\mcp-return-types
npm run bench:preflight
node --import tsx bench/run.ts --set pilot --backend claude-cli --models "claude-haiku-5-5" --reps 2 --arms "C,D" --out bench/results/pilot
```

## Block 4 (optional, later): Claude, claude-sonnet-5-5

Run this only if you want the strong Claude model in the pilot and have the usage to spare. It can wait until after you have looked at blocks 1 to 3.

```powershell
cd C:\dev\mcp-return-types
npm run bench:preflight
node --import tsx bench/run.ts --set pilot --backend claude-cli --models "claude-sonnet-5-5" --reps 2 --arms "C,D" --out bench/results/pilot
```

## The preflight check

`npm run bench:preflight` prints one line per check, with key names and OK / WARN / ERROR only (never a value), and ends with `preflight: OK` or a count of errors. Do not start a block while it shows an ERROR. It checks:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` are unset (they would switch a CLI to paid API billing). To clear one for this window: `Remove-Item Env:ANTHROPIC_API_KEY`.
- `bench/.env` exists and parses, both model lists hold pinned IDs only (no alias such as `haiku` or `sonnet`), and `BENCH_MAX_RUNS` is set. Fix the file using `bench/.env.example` as the model.
- There is no `bench\STOP` file.
- The git working tree is clean. Result files under `bench/results/` are ignored, so a half-finished pilot does not block the next block.

## Pausing

To stop cleanly, open a second PowerShell window and create the stop file:

```powershell
cd C:\dev\mcp-return-types
New-Item -ItemType File bench\STOP
```

The harness finishes the run it is on, then stops (it checks before every run and after every limit wait). To go on later, delete the file and run the same block command again:

```powershell
Remove-Item bench\STOP
```

Ctrl+C also works. You lose only the unfinished run, which is redone from scratch next time.

## Usage limits (normal)

**A limit message is normal, and the run just resumes.** When a CLI reports a rate or usage limit, the harness prints something like `codex-cli: ... sleeping 30 min, then retrying the same turn`, waits (`BENCH_RATE_LIMIT_SLEEP_MIN`, default 30 minutes) and retries the same turn, for up to `BENCH_MAX_WAIT_HOURS` (default 24 hours) in total. Leave the window open.

If the command ends instead (check with `$LASTEXITCODE`):

| Exit code | Meaning | What to do |
|---:|---|---|
| 0 | Block finished, or stopped by `bench\STOP` | Go to the next block (or delete STOP and rerun) |
| 3 | Waited the whole limit budget | Wait until your plan's limit resets, then rerun the same command |
| 1 | A CLI error the harness did not recognise (retried twice) | Wait a while and rerun the same command. Copy the error lines for the agent: the exact limit messages of both CLIs are not known yet, so the harness may not recognise a limit message as one |
| 4 | Not signed in | Sign in (see step 0), then rerun the same command |

Rerunning is always safe: finished runs are skipped and nothing is counted twice.

## After the blocks: analyse

```powershell
cd C:\dev\mcp-return-types
node --import tsx bench/analyze.ts --raw bench/results/pilot --out bench/results/REPORT.md
```

This writes `bench/results/REPORT.md` (overwriting the M6 smoke draft, which stays in git history) and prints a short summary. You can run it after any block; it uses whatever runs have finished.

## What to paste back to the assistant

Start a new session and paste:

1. Which blocks you ran, and whether any of them is unfinished.
2. The last two lines each block printed (`bench: N run(s) done, ...` and the `stopped:` part, if any).
3. Any line with `error`, `limit`, `sleeping`, `WAITING-HUMAN` or `BLOCKED`, exactly as printed (these tell the agent the real limit and error texts).
4. The summary that `bench/analyze.ts` printed (from `Directional only` to the `analyze: ... ->` line).

The agent can read `bench/results/REPORT.md` and the files in `bench/results/pilot\` itself, so you do not need to paste the report.
