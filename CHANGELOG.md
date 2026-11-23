# Changelog

## 1.0.0 (2026-11-24)

First release.

### Tool
- `record`: a transparent stdio proxy in front of any MCP server. It logs the shapes of `tools/call` results
  (shapes only by default; raw values only with `--keep-values`).
- `infer`: infers a JSON Schema per tool from the recorded samples (optional vs nullable, array merging, union
  capping, map detection, formats, enum hints, confidence levels, drift and error separation; see SPEC.md §3).
- `emit --ts`: writes TypeScript declarations of the inferred result types.
- `serve`: a stdio proxy that adds `structuredContent` to results that match the inferred schema and passes
  everything else through unchanged. With `--declare-schemas` it also declares `outputSchema` in `tools/list`
  (off by default, because strict clients reject a declared tool's result that lacks `structuredContent`).
- `report`: coverage and confidence per tool.
- `quickstart`: one command that calls a server's read-only tools, then infers and emits the types and Code Mode stubs.
- Windows first: tested on Windows 11 in PowerShell and Git Bash; child processes start through `cross-spawn`.

### Measured (details in README.md, bench/results/VERDICT.md and docs/PLAIN-MCP-RESULT.md)
- Code Mode, inferred return types (D) versus `unknown` (C), mock GitHub workload, 20 tasks x 5 reps:
  - gpt-6.2-sol: output tokens D/C 0.72 [0.63, 0.82], turns D/C 0.74 [0.69, 0.80], success 99% vs 100%. PASS.
  - claude-haiku-5-5: output tokens D/C 0.50 [0.39, 0.62], turns D/C 0.81 [0.74, 0.88], success 100% vs 100%. PASS.
  - Both PASS verdicts use criteria amended after the pilot (BENCHMARK.md, Amendment 1). Under the original
    criteria every backend gave KILL.
  - gpt-6-luna excluded (Amendment 2, written after the full run: arm-C refusal rate 31%, above 25%). Its refusals
    were higher with types (50 vs 31 of 100), for reasons not known. With Luna included, the Codex verdict is KILL.
- Plain MCP (no Code Mode), Codex gpt-6.2-sol only, 12 pairs, `serve` vs a plain proxy: INCONCLUSIVE (12/12 passes
  in both arms, output tokens S/P 0.95 [0.82, 1.11]). The Claude half was not run.
- Real reference servers: schema match rate 99/99 (latest) and 82/82 (older releases), median added proxy latency
  0.03 to 0.17 ms. A match rate and latency check, not a benchmark of model outcomes.

### Known limits
- Mock workload only for every model result; return types only; costs are estimates (subscription runs are not
  billed per token); two models pass-tested.
- Not in v1: claude-sonnet-5-5 and a revisit of gpt-6-luna (both planned for v2).
