# Redactions and pre-publication scan

This public repository is a clean export of the development repository: one commit, no history, made by
`node scripts/export-clean.mjs`. Before the export, the whole development tree and its full git history were scanned
with `node scripts/scan-sensitive.mjs <dir> --history`. The scan looks for API keys and tokens (`sk-`, `ghp_`, `github_pat_`,
`Bearer`, `AKIA`, private key headers and similar), `.env` files, email addresses, the local OS user name and machine
name, the git user's email, and absolute paths (home folders, temp folders, drive paths). It prints at most the
first 4 characters of any match.

## Redactions

**None.** Nothing in the published files needed redacting, so no file was edited and every raw result file in
`bench/results` is byte-identical to the one in the development repository. Every reported number can still be
recomputed from them (see REPRODUCE.md).

## Hits that were accepted, and why

| Hit | Where | Why it stays |
|---|---|---|
| `C:\dev\mcp-typegen\...` and `C:\Program Files\nodejs\node.exe` | `serverCommand` in raw results under `bench/results/plain-mcp`, and example `cd` lines in docs | The repo checkout path and the Node.js install path. They contain no user, machine or account name. The raw files are kept unedited. |
| `session_id`, `thread_id`, `credential_expires_at`, `total_cost_usd` | model turn records (`*.jsonl`) under `bench/results` | What the `claude -p` and `codex exec` CLIs reported for each turn. The ids are random and only link runs to each other. The credential field is an expiry time, not a credential. The token counts the analysis uses come from these records. |
| Model replies and tool results | model turn records (`*.jsonl`, `*.raw.jsonl`) under `bench/results` | The prompts, the tool data and the users in them are all synthetic (from the local mock server with fixed seeds). The scan found no personal data in them. |
| Fake API keys (`SECRET` placeholders in the `sk-` format) | `test/bench.preflight.test.ts` | Fake keys. The test checks that the preflight never prints keys. |
| One-letter and `example.com` email addresses | tests and mock-server data | Synthetic test data. |
| Made-up Windows paths (the home folder of a user called `someone`, a temp folder, a script path) | tests and test fixtures | Synthetic paths. |
| `noreply@anthropic.com` | commit message trailers | The co-author trailer address, not a person's address. |

## Left out of the export

Besides everything git-ignored (`node_modules`, `dist`, `.typegen`, `bench/.env`, `bench/results/raw`,
`bench/results/dry-run`), these files are internal to the development setup and are not published:
`NOTES.md`, `PROGRESS.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, `run-loop.ps1`, `run-loop.sh`, `prompts/`, `SETUP.md`,
`LAUNCH-POST.md` and `bench/results/plain-mcp-smoke*`. Some code comments and `BENCHMARK.md` still say "see NOTES.md":
that file was the development log and is not part of this repository.
