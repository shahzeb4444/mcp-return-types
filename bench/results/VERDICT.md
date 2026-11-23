**Verdict per model (full run, BENCHMARK.md thresholds with Amendments 1 and 2): claude-haiku-5-5 PASS · gpt-6.2-sol PASS · gpt-6-luna EXCLUDED as harness-incompatible (on its own the automatic verdict is KILL, and the automatic codex-cli verdict with Luna included is KILL).**

Per backend: **claude-cli PASS** (claude-haiku-5-5 only; claude-sonnet-5-5 was not run). **codex-cli PASS** from gpt-6.2-sol alone; without the Amendment 2 exclusion it is **KILL**.

This is not a pre-registered test: the criteria were changed after the pilot (Amendment 1) and Luna was excluded after the full run (Amendment 2). Under the original criteria written before any run, every backend is KILL, because code errors did not drop significantly on any model.

# VERDICT: do inferred return types help Code Mode? (v1)

Written 2026-11-23 by claude (M8), from `bench/results/full` (600 runs: 3 models x 20 tasks x 5 reps x arms C and D) and `bench/results/REPORT.md`, regenerated the same day with `node --import tsx bench/analyze.ts --raw bench/results/full --out bench/results/REPORT.md`. No model was called to write this file.

- **Arm C:** Code Mode, one `run_code` tool, every tool result typed `Promise<unknown>`.
- **Arm D:** the same, except that the result types are inferred by mcp-typegen from seed-1 warm-up traffic.
- All intervals are paired bootstrap 95% CIs (10,000 resamples over tasks, seed 20261122). Ratios are D/C (below 1 = D lower), differences are D − C.
- Compare C and D **within one model**. Claude and Codex use different reply formats (fenced code block versus a JSON envelope, BENCHMARK.md M6b), so the two backends are not interchangeable and no pooled number is used. Both backends point the same way (D lower on output tokens and turns), but a pooled result would be exploratory only and is not computed here.

## Thresholds (amended H1), every model

| Threshold (BENCHMARK.md) | Rule | claude-haiku-5-5 | gpt-6.2-sol | gpt-6-luna (excluded) |
|---|---|---|---|---|
| PRIMARY: output tokens/task D/C | upper bound < 1.00 on at least one model of the backend | 0.50 [0.39, 0.62]: **yes** | 0.72 [0.63, 0.82]: **yes** | 0.91 [0.77, 1.06]: **no** |
| PRIMARY guardrail: output tokens/task D/C | upper bound ≤ 1.05 on every model | 0.62: **yes** | 0.82: **yes** | 1.06: **no** |
| PRIMARY guardrail: turns/task D/C | upper bound ≤ 1.05 on every model | 0.81 [0.74, 0.88]: **yes** | 0.74 [0.69, 0.80]: **yes** | 0.74 [0.64, 0.84]: **yes** |
| NON-INFERIORITY: success D − C (points, all pairs, gating) | lower bound ≥ −10 on every model | 0.0 [0.0, 0.0]: **yes** | +1.0 [0.0, 3.0]: **yes** | −25.0 [−33.0, −17.0]: **no** |
| Success D − C without refused pairs (reported, not gating) | lower bound ≥ −10 | 0.0 [0.0, 0.0] (100 pairs) | +1.0 [0.0, 3.0] (100 pairs) | −27.8 [−42.5, −11.1] (36 pairs) |
| Success per arm, C / D | (context) | 100% / 100% | 99% / 100% | 52% / 27% |
| McNemar exact (b = C pass & D fail, c = C fail & D pass) | (context) | 0 / 0, p 1.000 | 0 / 1, p 1.000 | 36 / 11, p < 0.001 |
| Amendment 2: arm-C refusal rate | excluded if > 25% | 0% (0/100): kept | 0% (0/100): kept | 31% (31/100): **excluded** |
| **Model verdict (judged alone)** | PASS / KILL / PARTIAL | **PASS** | **PASS** | **KILL** (excluded from the backend verdict) |

Backend verdicts: claude-cli = Haiku = **PASS**. codex-cli with Luna excluded = Sol = **PASS**; codex-cli with both models (the automatic verdict before Amendment 2, kept on record) = **KILL**, because Luna fails non-inferiority (and its output-token upper bound of 1.06 also breaks the guardrail).

Notes on these numbers:
- Haiku succeeded in 100% of runs in both arms, so its non-inferiority result is a ceiling: it shows D did not lose tasks, not that D wins tasks.
- Sol's single disagreeing pair is a C failure that D solved (C 99/100, D 100/100); that is not significant.

## Secondary results (reported, never gating)

| Metric | claude-haiku-5-5 | gpt-6.2-sol | gpt-6-luna (excluded) |
|---|---|---|---|
| Code errors per task, C / D | 0.08 / 0.00 | 0.00 / 0.00 | 0.08 / 0.02 |
| Code errors D − C | −0.08 [−0.18, 0.00] (not significant: the CI reaches 0) | 0.00 [0.00, 0.00] | −0.06 [−0.14, 0.02] |
| Code errors D/C | 0.00 [0.00, 0.00] (346 of 10,000 resamples undefined: C had no errors in them) | n/a (no code errors in either arm) | 0.25 [0.00, 1.50] |
| Total tokens per task, C / D | 15,274 / 17,592 | 52,809 / 42,917 | 96,385 / 106,969 |
| Total tokens D/C | 1.15 [0.99, 1.35] (D higher as a point estimate; the CI just includes 1) | 0.81 [0.75, 0.89] (D lower) | 1.11 [0.98, 1.25] |
| Cache-weighted cost **ESTIMATE** per task, C / D (USD) | 0.00285 / 0.00238 | no estimate (no price in `bench/prices.json`) | no estimate (no price in `bench/prices.json`) |
| Cost **ESTIMATE** D/C | 0.84 [0.69, 1.03] | no estimate | no estimate |
| Output tokens per task, mean C / D | 1,740 / 871 | 324 / 235 | 690 / 630 |
| Turns per task, C / D | 2.52 / 2.03 | 2.92 / 2.16 | 2.05 / 1.51 |
| Median model latency per turn (ms), C / D | 13,640 / 10,859 | 23,241 / 15,521 | 24,670 / 23,360 |
| Original H1 criteria (before Amendment 1) | KILL | KILL | KILL |

- **Code errors:** almost none in either arm. Haiku had 4 sandbox timeouts and 4 rewrites in C and none in D; Sol had none in either arm. The original hypothesis, that types cut code errors by at least 30% with a significant difference, is **not supported** on any model, so the original pre-registered verdict is KILL everywhere.
- **Total tokens and cost:** on Haiku, D's longer stubs make total tokens per task higher as a point estimate (1.15), while the cache-weighted cost estimate is lower as a point estimate (0.84), because cache reads are cheap and D writes far fewer output tokens. The cost CI includes 1.0 (upper bound 1.03), so **D is not shown to be cheaper**; it is also not shown to cost more. This is an **estimate** from `bench/prices.json` (Haiku prices checked 2026-11-23 against the Anthropic pricing page, prompts up to 100,000 tokens, cache writes priced at the 1-hour rate `cache_write_1h`), not a measured bill. There is no estimate for the Codex models, because their prices are absent from `bench/prices.json` on purpose.
- **Latency:** shown for context only, measured through the subscription CLIs on one laptop; it is not part of any threshold.

## Refusals

A refusal is a failed run whose final answer says the tools or the data are unavailable instead of answering (regexes in `bench/analysis/classify.ts`).

| Model | Refused runs C / D | Arm-C refusal rate | Success without refused runs, C / D |
|---|---|---|---|
| claude-haiku-5-5 | 0 / 0 | 0% | 100% / 100% |
| gpt-6.2-sol | 0 / 0 | 0% | 99% / 100% |
| gpt-6-luna | 31 / 50 | 31% | 75% (52/69) / 54% (27/50) |

Luna refused in about a third of baseline runs, where there are no types at all, which is why Amendment 2 treats it as harness-incompatible. It also refused **more** in D than in C (50 vs 31). **That difference is not explained yet**, and it is the result that made Luna fail non-inferiority. Excluding Luna therefore removes the one model on which D looked worse. Even among runs without a refusal, Luna's D arm did worse (success D − C −27.8 points over 36 clean pairs, McNemar p 0.013). All Luna data stays in `bench/results/full`, and Luna is revisited in v2 (M14: analyze the refusals first, then at most two wording fixes applied identically to both arms, piloted before any new run).

## Limits

- **Mock workload.** Every task runs against the local mock GitHub MCP server (`bench/mock-server`, seed 2, 20 tasks), not a real server. The arm D types were inferred from seed-1 traffic on the same mock, so they match the evaluation results almost perfectly. Real servers have more varied and drifting shapes (real-server checks are M9).
- **Return types only.** Arms C and D differ only in the inferred result types in the `run_code` description. Nothing else that mcp-typegen does (for example `serve` adding `structuredContent`) was tested.
- **Code Mode harness, not plain MCP.** The model writes TypeScript against stubs and one `run_code` tool, with the conversation kept by our harness. That is not how a normal MCP client calls tools. Whether types help with ordinary MCP tool calling is untested (M11).
- **Claude and Codex reply formats differ.** Claude replies with a fenced code block and Codex with a JSON envelope (`--output-schema`). Results compare C and D within one model, never Claude against Codex.
- **Only 2 models are pass-tested.** claude-haiku-5-5 and gpt-6.2-sol. claude-sonnet-5-5 was not run (v2, M14). On codex-cli the weak model (Luna) is excluded, so v1 has no tested weak Codex model and the codex-cli PASS rests on one model.
- **Criteria amended after seeing data, twice.** Amendment 1 changed the primary metrics to output tokens and turns after the pilot showed that code errors did not move. Amendment 2 excluded Luna after the full run. Both choices were made with results in view, so this is weaker evidence than a pre-registered test. The pre-registered criteria give KILL.
- **Subscription runs are not billed per token.** All runs went through the `claude -p` and `codex exec` subscriptions. Tokens are what the CLIs report, and any dollar figure is a labelled estimate, not money spent or saved.
- **Small, fixed task set.** 20 tasks x 5 reps per arm and model. CIs resample over tasks, so they speak to tasks like these, not to all tasks.
- **Ceiling on success.** Haiku and Sol solve nearly every task in both arms, so these runs cannot show a success gain.

## What these results do NOT show

- They do **not** show that inferred types reduce code errors or exceptions; the original hypothesis failed on every model.
- They do **not** show that D solves more tasks. Success is at the ceiling for Haiku and Sol, and lower in D for Luna.
- They do **not** show any benefit on real MCP servers, in plain MCP clients, or with tools other than the mock GitHub set.
- They do **not** show lower dollar cost. The only estimate (Haiku) has a CI that includes no change, total tokens on Haiku are higher in D as a point estimate, and there is no estimate for Codex.
- They say nothing about claude-sonnet-5-5, about other Claude or Codex models, or about the effect of types on a model that refuses the harness.
- They do **not** compare Claude with Codex.

What they do show, within these limits: on claude-haiku-5-5 and gpt-6.2-sol, adding the inferred return types to the Code Mode stubs cut output tokens per task (D/C 0.50 and 0.72) and turns per task (D/C 0.81 and 0.74), with CIs clear of 1.0, and no loss of success.
