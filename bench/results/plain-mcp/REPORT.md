# Plain-MCP test report (M11, BENCHMARK.md Amendment 3)

Generated 2026-11-23T19:23:42.764Z from bench/results/plain-mcp and bench/results/plain-mcp-everything: 24 run(s) (24 mock, 0 server-everything). Bootstrap: 10000 resamples over tasks, seed 20261122. Ratios are S/P (sum over pairs / sum over pairs).

## Verdict (per backend, S vs P, mock workload)

Criteria (pre-registered): PASS = output S/P upper < 1 and turns S/P upper <= 1.05 and success S-P lower >= -10 points; KILL = output CI entirely above 1 or non-inferiority fails; INCONCLUSIVE = the output CI contains 1; else PARTIAL. The Code Mode (H1) results do not carry over to this setting.

**codex-cli (gpt-6.2-sol): INCONCLUSIVE**

- output tokens S/P 0.95 [0.82, 1.11]: contains 1.0
- turns S/P 1.00 [1.00, 1.00]: upper bound <= 1.05
- success S-P 0.0 [0.0, 0.0] points: non-inferiority holds (lower bound >= -10)
- with 12 pairs per backend this outcome was expected to be likely (Amendment 3); it is not a failure of the tool

## Paired S vs P (gating)

| backend | model | pairs (tasks) | output ratio | turns ratio | success diff (points) | McNemar b/c, p | total tokens ratio | tool calls ratio | wall time ratio | refused base/test | duplicate writes base/test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| codex-cli | gpt-6.2-sol | 12 (6) | 0.95 [0.82, 1.11] | 1.00 [1.00, 1.00] | 0.0 [0.0, 0.0] | 0/0, 1.000 | 1.01 [0.92, 1.08] | 0.77 [0.73, 0.97] | 0.92 [0.84, 1.02] | 0/0 | 0/0 |

## Paired S2 vs P (exploratory, `serve --declare-schemas`, not gating)

No S2 runs.

## Per arm

| workload | backend | model | arm | runs | success | refused | output median | output mean | turns mean | tool calls mean | total tokens mean | wall median (s) | duplicate writes | tool errors | shell calls | drift events |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mock | codex-cli | gpt-6.2-sol | P | 12 | 12/12 (100%) | 0 | 348 | 353 | 1.00 | 9.50 | 79,608 | 18.1 | 0 | 0 | 0 | 0 |
| mock | codex-cli | gpt-6.2-sol | S | 12 | 12/12 (100%) | 0 | 382 | 337 | 1.00 | 7.33 | 80,073 | 19.1 | 0 | 1 | 0 | 0 |

## No-harm check (server-everything, not gating)

No server-everything runs.

## Per run

| id | pass | final | turns | tool calls | output | total | wall (s) | reasons |
|---|---|---|---|---|---|---|---|---|
| mock-P-gpt-6.2-sol-ctrl-01-1 | PASS | Memory leak when resizing nested tables behind a proxy | 1 | 1 | 206 | 47,467 | 12.0 |  |
| mock-P-gpt-6.2-sol-ctrl-01-2 | PASS | Memory leak when resizing nested tables behind a proxy | 1 | 1 | 161 | 62,479 | 12.8 |  |
| mock-P-gpt-6.2-sol-nested-03-1 | PASS | [33, 42, 54, 103, 278, 321, 324, 347, 392, 531, 532] | 1 | 1 | 140 | 47,687 | 11.0 |  |
| mock-P-gpt-6.2-sol-nested-03-2 | PASS | [33,42,54,103,278,321,324,347,392,531,532] | 1 | 1 | 130 | 47,201 | 15.5 |  |
| mock-P-gpt-6.2-sol-nested-06-1 | PASS | 42 | 1 | 11 | 456 | 101,820 | 24.4 |  |
| mock-P-gpt-6.2-sol-nested-06-2 | PASS | 42 | 1 | 7 | 441 | 102,691 | 21.5 |  |
| mock-P-gpt-6.2-sol-page-02-1 | PASS | ["brisk-otter79","dusty-marten68","frosty-seal95","frosty-ta | 1 | 3 | 371 | 79,775 | 29.9 |  |
| mock-P-gpt-6.2-sol-page-02-2 | PASS | ["brisk-otter79","dusty-marten68","frosty-seal95","frosty-ta | 1 | 3 | 351 | 64,640 | 16.9 |  |
| mock-P-gpt-6.2-sol-page-04-1 | PASS | 235 | 1 | 6 | 344 | 71,109 | 17.2 |  |
| mock-P-gpt-6.2-sol-page-04-2 | PASS | 235 | 1 | 7 | 338 | 90,567 | 19.0 |  |
| mock-P-gpt-6.2-sol-write-01-1 | PASS | done | 1 | 27 | 711 | 138,884 | 34.7 |  |
| mock-P-gpt-6.2-sol-write-01-2 | PASS | done | 1 | 46 | 592 | 100,971 | 30.1 |  |
| mock-S-gpt-6.2-sol-ctrl-01-1 | PASS | Memory leak when resizing nested tables behind a proxy | 1 | 1 | 157 | 46,214 | 10.9 |  |
| mock-S-gpt-6.2-sol-ctrl-01-2 | PASS | Memory leak when resizing nested tables behind a proxy | 1 | 1 | 102 | 46,460 | 9.9 |  |
| mock-S-gpt-6.2-sol-nested-03-1 | PASS | [33, 42, 54, 103, 278, 321, 324, 347, 392, 531, 532] | 1 | 1 | 160 | 48,988 | 11.7 |  |
| mock-S-gpt-6.2-sol-nested-03-2 | PASS | [33,42,54,103,278,321,324,347,392,531,532] | 1 | 1 | 141 | 49,133 | 11.5 |  |
| mock-S-gpt-6.2-sol-nested-06-1 | PASS | 42 | 1 | 6 | 463 | 116,255 | 23.1 |  |
| mock-S-gpt-6.2-sol-nested-06-2 | PASS | 42 | 1 | 7 | 473 | 116,797 | 24.3 |  |
| mock-S-gpt-6.2-sol-page-02-1 | PASS | ["brisk-otter79","dusty-marten68","frosty-seal95","frosty-ta | 1 | 3 | 377 | 64,694 | 18.7 |  |
| mock-S-gpt-6.2-sol-page-02-2 | PASS | ["brisk-otter79","dusty-marten68","frosty-seal95","frosty-ta | 1 | 3 | 372 | 63,727 | 17.6 |  |
| mock-S-gpt-6.2-sol-page-04-1 | PASS | 235 | 1 | 6 | 390 | 78,141 | 19.5 |  |
| mock-S-gpt-6.2-sol-page-04-2 | PASS | 235 | 1 | 6 | 423 | 77,873 | 20.7 |  |
| mock-S-gpt-6.2-sol-write-01-1 | PASS | done | 1 | 20 | 386 | 135,089 | 27.1 |  |
| mock-S-gpt-6.2-sol-write-01-2 | PASS | done | 1 | 33 | 602 | 117,501 | 31.4 |  |

## Harness checks

- mock server never started (no write log): 0
- claude: MCP server not reported as connected in the init event: 0
- claude: offered tools other than the workload's MCP tools: 0
- no tool call at all: 0
- every tool call errored (harness problem, e.g. Codex MCP approval denied; the run says nothing about the arms): 0
- ended without a FINAL line: 0
- client error (not a normal answer): 0
- 0 output tokens: 0
- codex: shell commands run (prompt says not to): 0
- claude: usage.output_tokens differs from the modelUsage sum: 0
- client working directory not empty after the run: 0
- serve drift events (S/S2): 0
- tasks whose prompt differs between runs (must be 0): 0

