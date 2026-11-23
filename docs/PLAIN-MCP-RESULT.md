# Plain-MCP result (Codex, gpt-6.2-sol)

Test design and criteria: BENCHMARK.md, Amendment 3 (pre-registered). Harness: [PLAIN-MCP.md](PLAIN-MCP.md). Raw data and generated report: `bench/results/plain-mcp/` (24 runs, `REPORT.md`). Runs were made on 2026-11-23, 19:15 to 19:23 UTC.

## What was tested, and what was not

Tested: Codex CLI with `gpt-6.2-sol`, ordinary MCP tool calling (no Code Mode), the local mock GitHub server (seed 2, 8 real tools), 6 tasks x 2 reps, two arms:
- **P**: plain pass-through proxy.
- **S**: `mcp-return-types serve` (adds `structuredContent`, declares no `outputSchema`).

Not tested: the Claude Code backend (not run, so no verdict of any kind for it), Luna, Sonnet, arm S2 (`--declare-schemas`), and real servers in the benchmark (the server-everything no-harm check was not run either). The Code Mode results (H1) do not carry over to this setting.

## Verdict: INCONCLUSIVE

In plain words: **no harm and no measurable gain at this sample size.**

| Measure (S vs P, 12 pairs, 6 tasks) | Result |
|---|---|
| Success | 12/12 in both arms (difference 0.0 points; non-inferiority holds) |
| Output tokens S/P | 0.95 [0.82, 1.11] (interval contains 1.0) |
| Turns S/P | 1.00 [1.00, 1.00] (every run was one tool-call round) |
| Tool calls S/P | 0.77 [0.73, 0.97] (secondary, not gating) |
| Total tokens S/P | 1.01 [0.92, 1.08] (secondary) |

Arm means: output tokens 353 (P) vs 337 (S) per run; sums 4,241 vs 4,046; tool calls 9.50 vs 7.33 per run. No refusals, no duplicate writes, no shell calls, no harness-check failures. One tool error occurred in arm S (`mock-S-gpt-6.2-sol-nested-06-1`); the run still passed.

## Per task (anecdotal)

Two reps per task, summed (output tokens) or averaged (tool calls).

| Task | Tool calls P | Tool calls S | Output tokens P | Output tokens S |
|---|---|---|---|---|
| ctrl-01 | 1.0 | 1.0 | 367 | 259 |
| nested-03 | 1.0 | 1.0 | 270 | 301 |
| nested-06 | 9.0 | 6.5 | 897 | 936 |
| page-02 | 3.0 | 3.0 | 722 | 749 |
| page-04 | 6.5 | 6.0 | 682 | 813 |
| write-01 | 36.5 | 26.5 | 1,303 | 988 |

**These per-task differences are anecdotal, not a claim.** Each cell is two runs of a nondeterministic model; the direction goes both ways (S lower on 2 tasks, higher on 4 for output tokens). The tool-call count falls mostly on write-01 and nested-06, where the number of calls varies a lot between reps in both arms (write-01 P: 27 and 46). We did not test why.

## Why this is not a negative finding about the tool

The pre-registered criteria said INCONCLUSIVE was likely at 12 pairs per backend. The point estimate (0.95) is slightly in S's favour, but the interval is wide enough that it also includes a 11% increase. A KILL would have needed the interval entirely above 1.0; it was not close. The result says "too little data to tell", not "no effect".

**Rough power note (an estimate, not a computed guarantee).** The task-level spread of the output ratio here is about 0.19 on the log scale (taken from the six per-task ratios). With that spread, a paired comparison over independent tasks would need roughly 7 tasks to resolve a 20% reduction, about 28 for a 10% reduction, and over 100 for a 5% reduction (80% power, two-sided 5%, normal approximation). Tasks, not reps, are what count, because the bootstrap resamples tasks. A useful design would be more distinct tasks (30 or more, with 1 to 2 reps), more than one server style, and both backends. Whether `structuredContent` helps at all depends on how each client presents it to the model, which this test cannot see.

## Limits

- Mock workload only: one server, JSON text results with no schema, 150 ms latency.
- A single model (`gpt-6.2-sol`) and a single client (Codex CLI).
- All 24 runs were made in one 8-minute window on one day; no check for time-of-day or rate-limit effects.
- The Codex turn count is an approximation (groups of consecutive MCP calls), and all runs came out as exactly 1 turn, so the turns ratio carries no information.
- Costs and cache-weighted figures are estimates; this report does not compute any.
- The Code Mode criteria were amended after the pilot data was seen (BENCHMARK.md, Amendment 1). Amendment 3 was written before any plain-MCP run and its criteria were not changed; only a harness setting (Codex MCP approval, applied to every arm) was added after the smoke run.
