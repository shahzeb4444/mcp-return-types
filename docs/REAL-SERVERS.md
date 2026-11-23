# Real-server validation (M9)

mcp-return-types was run against three real MCP servers from `@modelcontextprotocol`, started with `npx`, no API keys, no model calls: `server-everything`, `server-filesystem` (pointed at a temp folder) and `server-memory` (storage in a temp file). Date: 2026-11-23, Windows 11, Node 22.18. **Updated 2026-11-23 (after the M9 fixes):** the map rule, the text | parsed union and the `report` serving modes (see "Fixes after M9"); both variants re-run with `--skip-latency`, so the latency figures are still the M9 ones.

## Headline

| Check | Result |
|---|---|
| Emitted `.d.ts` compile with `tsc --noEmit --strict` | 6 of 6 files OK (3 servers x 2 variants, see below) |
| Match rate of fresh real outputs against the schema inferred from the training run, latest releases | **99 of 99 (100%)**, strict and serve |
| Same, older releases that declare no `outputSchema` | **82 of 82 (100%)**, strict and serve (was 81 of 82 at M9: the `read_file` text-to-JSON flip now matches through the text | parsed union) |
| Match rate when infer only sees the first 1 to 3 samples of a tool (server-memory, latest) | 82% to 91% strict, 100% by the open schema `serve` uses |
| Added proxy latency, median over 300 calls (target under 5 ms) | **0.03 to 0.17 ms** in the final run; 0.02 to 0.17 ms over three runs |
| Added proxy latency, p95 | 0.22 to 0.40 ms in the final run; up to 2.10 ms in an earlier run |
| Bugs found in `src/` | M9: 1 (fixed with a test): `record` added a redundant line to `.gitignore`. After M9: 1 more, privacy (fixed with a test): value counters stored environment values of `get-env` |

Read the match rates with care. The sessions were scripted by the same author as the tool, each tool got 1 to 12 training calls and 1 to 8 fresh calls, and these servers are small and deterministic. 100% on that is "no surprise found", not an estimate of accuracy on production servers. The list of problems below matters more than the percentages.

## How to run

All commands work in PowerShell and in Git Bash. The first run downloads the servers through `npx`, so it needs network (the unit tests never do).

```powershell
npm run build
npm run validate:real -- --variant legacy --skip-latency   # older releases (text results); also creates the schemas the serve latency run needs
npm run validate:real                                       # latest releases (default), then the latency measurements
npm run validate:real -- --only memory --skip-latency       # one server, no latency
npm run validate:real -- --latency-only --latency-calls 500
```

Options: `--only everything|filesystem|memory`, `--variant latest|legacy`, `--out <dir>` (default `.typegen/real-servers`), `--latency-calls <n>` (default 300), `--skip-latency`, `--latency-only`. Exact versions are pinned in `scripts/real-servers/sessions.ts`:

| Server | latest variant | legacy variant |
|---|---|---|
| server-everything | 2.3.1 | 1.0.0 |
| server-filesystem | 2.4.0 | 2025.3.28 |
| server-memory | 2.2.1 | 2025.4.25 |

For each server and variant the script (`scripts/validate-real-servers.ts`, helpers in `scripts/real-servers/`):

1. **Train.** Runs a scripted session (28 to 53 calls, 9 to 16 tools, several calls each with varied arguments, plus a few deliberately failing calls) through `node dist/cli.js record --name <server> -- npx -y <pkg> ...` using the MCP SDK client.
2. **Infer and emit.** `mcp-return-types infer` and `mcp-return-types emit --ts`.
3. **Compile.** `tsc --noEmit --ignoreConfig --strict` on the emitted `.d.ts`.
4. **Fresh run.** A new server process (memory: a new empty graph; filesystem: same folder plus new files) and a second scripted session with different arguments, called directly, not through the proxy. Every real result is unwrapped with the same `unwrap()` the proxy uses and validated against the inferred schema, two ways: the schema exactly as inferred (closed objects, what drift detection means, called **strict**) and the open schema `serve` sends and validates against (**serve**). Error results (`isError`) and JSON-RPC errors are excluded from the rates, as in SPEC section 3 rule 10.
5. **Sweep.** Repeats the check with infer given only the first k successful training samples of each tool (k = 1, 2, 3, 5, 10, all).
6. **Report.** `mcp-return-types report` on the training folder.
7. **Latency.** Alternating direct and proxied calls on the same machine (`bench/latency.ts`), 300 calls after 30 warm-up calls.

Outputs go to `.typegen/real-servers/<variant>/<server>/` (git-ignored): `train/` (samples, schemas), `types/<server>.d.ts`, `infer.txt`, `emit.txt`, `report.txt`, `proxy-stderr.log`, `result.json`, plus `summary.md` per variant. The script stores no raw tool outputs (the recorder is shape-only).

The checker has its own negative-control tests (`test/real-servers.check.test.ts`, 11 tests): optional key, missing key, nullable, type drift, format, enum hint and root change are each detected, and the explaining walker agrees with Ajv.

## Results

Per-tool tables are in Appendix A. "strict" = schema as inferred, "serve" = open schema.

| Server | Variant | Train calls | Fresh outputs checked | Strict match | Serve match | tsc |
|---|---|---|---|---|---|---|
| everything 2.3.1 | latest | 53 | 41 | 100% (41/41) | 100% (41/41) | OK |
| filesystem 2.4.0 | latest | 50 | 36 (+1 error excluded) | 100% (36/36) | 100% (36/36) | OK |
| memory 2.2.1 | latest | 28 | 22 | 100% (22/22) | 100% (22/22) | OK |
| everything 1.0.0 | legacy | 48 | 36 | 100% (36/36) | 100% (36/36) | OK |
| filesystem 2025.3.28 | legacy | 50 | 24 (+13 errors excluded) | 100% (24/24), was 96% (23/24) at M9 | 100% (24/24), was 96% | OK |
| memory 2025.4.25 | legacy | 28 | 22 | 100% (22/22) | 100% (22/22) | OK |

How much the match rate depended on how many training samples infer saw (the same fresh outputs, schema inferred from the first k successful samples of each tool):

| k samples per tool | everything (latest) | filesystem (latest) | memory (latest), strict | memory (latest), serve |
|---|---|---|---|---|
| 1 | 100% | 100% | 91% | 100% |
| 2 | 100% | 100% | 82% | 100% |
| 3 | 100% | 100% | 82% | 100% |
| 5 and up | 100% | 100% | 100% | 100% |

### Mismatches (every one, with the reason)

| Where | Reason | Detail |
|---|---|---|
| legacy filesystem `read_file` | **fixed after M9** (was: unwrap path changed) | Training read two plain text files, so the result was typed as plain text. A fresh call read `data.json`, whose text parses as JSON, so SPEC section 3 rule 1 unwraps it as `json-text`. At M9 that was a miss (1 of 2 fresh outputs). With the text | parsed union the JSON-text result also has its plain-text reading, which matches `string`, so it now counts as a match; `infer` would widen the tool to `string | {...}` (unwrap `mixed`) without a drift event. |
| latest memory `open_nodes`, `search_nodes`, `read_graph`, only with k = 1 to 3 | **optional key** | `entities[].observationCount` appears only when the call passes `observationLimit`. With few training samples that never used it, the key is "never seen" and a closed schema rejects it. At k = 5 or more (training had calls with `observationLimit`) it becomes an optional key and everything matches. The open schema `serve` uses accepts it at every k. |
| (none seen) | nullable | No fresh output had a `null` where training had none. The checker detects it (unit test), but these servers rarely return `null`. The only nullable field seen is `regionHeader` in everything 2.3.1 `get-header-params`, and the training run already had it. |
| (none seen) | new enum value | No string field had 8 or fewer values over 20 or more samples, so no `x-observed-values` hint was produced and none could be missed. This path is only unit-tested. |
| (none seen) | type drift, format | None seen on real data (unit-tested). |

## Latency

Median and p95 of (proxied round trip minus direct round trip), 300 sequential calls, direct and proxied calls alternating, server started through `npx` on both sides, final run:

| Measurement | Calls | Median added | p95 added | Direct median | Via proxy median |
|---|---|---|---|---|---|
| record, filesystem read_text_file | 300 | 0.03 ms | 0.40 ms | 1.45 ms | 1.45 ms |
| record, everything echo | 300 | 0.05 ms | 0.28 ms | 0.50 ms | 0.56 ms |
| record, legacy memory read_graph | 300 | 0.03 ms | 0.22 ms | 0.56 ms | 0.58 ms |
| serve, legacy memory read_graph (validates + adds structuredContent) | 300 | 0.17 ms | 0.40 ms | 0.38 ms | 0.54 ms |

Target: median under 5 ms. Met by a wide margin. Across the three runs of the same script, medians ranged from 0.02 to 0.17 ms and p95 from 0.22 to 2.10 ms, so p95 is noisy (a single slow call in a 300-call run moves it) and the median is the stable number. The `serve` measurement is on legacy memory `read_graph` because that is a result `serve` really parses, validates and rewrites (JSON text without `structuredContent`); that `structuredContent` appears was checked by hand once. The latest servers already return `structuredContent`, so `serve` returns early for them. Results here are small (a few hundred bytes), so this says nothing about multi-megabyte results.

## Fixes after M9 (2026-11-23)

Three of the problems below were fixed on the owner's instruction (SPEC section 3 rules 1 and 11 updated), with tests; both variants were re-run (`--skip-latency`).

1. **Map-like objects** (problem 2). An object position with more than 30 keys in any value, or more than 30 keys in the union across samples, is a map: `{ type: "object", additionalProperties: <merged value schema> }`, emitted as `{ [key: string]: T }`. The recorder stores such a value as `{t:"map", n, values}`, without key names, and keeps no value counters inside it. Result: legacy and latest `get-env` (111 keys) is now `export type GetEnvResult = { [key: string]: string };`, and no variable name is in the samples, the schemas or the `.d.ts`. While fixing this, a second privacy bug was found: the value counters (`<tool>.values.json`) had stored the **values** of every environment variable of 40 characters or less (one distinct value per "field"); map-like objects now get no counters. Trade-off: any record with more than 30 fixed keys is also a map now.
2. **Text | parsed union** (problem 1). See Mismatches: legacy filesystem went from 23/24 to 24/24.
3. **`report` serving modes** (problem 5). `record` now notes from `tools/list` which tools declare their own `outputSchema` (`samples/<server>/_tools.json`, names and booleans only), and `report` prints one `serving:` line per tool: `server's own outputSchema`, `server's own structuredContent`, `open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)`, or `strict inference only (<reason>)`. Appendix B shows the new output.

Known gap of the validation script (not `src/`): the legacy run never exits on Windows, because server-everything 1.0.0 started through `npx` ignores stdin EOF and the SDK client's kill only reaches the `npx` shim. All results are written first; the leftover `node.exe` has to be killed by hand.

## Bugs found and fixed in `src/`

1. **`record` appended a redundant line to the tracked `.gitignore`.** `ensureGitignore` (`src/proxy/recorder.ts`) only recognised the exact out-dir entry. With `--out .typegen/real-servers/latest/memory/train` and `.typegen` already ignored, it added `.typegen/real-servers/latest/memory/train/` to the repo's `.gitignore` for every new out dir. Fix: an already-ignored parent folder counts as present. Test added in `test/recorder.test.ts` ("adds nothing when a parent folder of the out dir is already ignored"). The suite is now 446 tests (434 before, plus 1 here and 11 for the checker), all passing.

At M9 no bug was found in inference, emit or the proxy bytes path: every real session round-tripped, no proxy warnings were written (`proxy-stderr.log` holds only the servers' own startup lines), and `serve` added `structuredContent` correctly on legacy memory. (The later value-counter privacy bug is under "Fixes after M9".)

## Problems found at M9 (1, 2 and 5 fixed afterwards, see "Fixes after M9")

1. **FIXED. A tool that returns text can flip between `text` and `json-text` by content** (the mismatch above): a file tool reading `.json` files, an echo of a number, and similar. `infer` records `mixed` only if both were seen in training. Possible fixes are SPEC changes, so none were made.
2. **FIXED. Environment-like output becomes a closed object with every key required.** server-everything `get-env` returns the process environment: 111 keys on this machine, all present in all 3 samples, so SPEC section 3 rule 11 map detection (no key may appear in more than half of the samples) does not trigger. The emitted type lists all 111 variable names as required, which would be wrong on any other machine. It also writes the variable **names** (not values) into `.typegen/schemas/` and into the `.d.ts`. Values are never recorded, but key names are part of any schema, so do not commit emitted types for tools that return environment, header or user-keyed data without reading them.
3. **Non-text content is invisible in the types.** `get-tiny-image` (an image block), `get-resource-links` (resource_link blocks) and `get-annotated-message` with `includeImage` are typed `string` from their text part only. The comment `result is the text content as a plain string` is accurate, but a Code Mode model would not learn that an image or links are also returned.
4. **Optional keys that depend on arguments are not knowable from a few samples.** `observationCount` (above). Confidence is `medium` at 3 to 5 samples with 3 or more argument sets, yet at 1 to 3 samples 9% to 18% of fresh memory outputs failed the strict schema. `serve` is not hurt (its open schema ignores extra keys), but a strict reader of the emitted `.d.ts` would be. More distinct argument shapes help; the confidence level does not measure that.
5. **FIXED. `report` said "served with outputSchema" even when the server declares its own, and even by default.** For the latest filesystem and memory servers, which already declare an `outputSchema` for every tool, `report` still prints "served with outputSchema". By default (without `--declare-schemas`) `serve` adds `structuredContent` and declares nothing, and it never overrides a declared schema. `report` does not see `tools/list`, so the wording is misleading. Not changed (the output format is covered by snapshot tests).
6. **The newest releases of the servers already declare outputs.** Latest filesystem and memory declare an `outputSchema` and return `structuredContent` for all tools (everything: 2 of 16). The filesystem one is just `{ content: string }` for every tool. So on these latest releases mcp-return-types adds little: the case it is built for is servers without declarations, which here means the older releases. The inferred schemas were not compared field by field with the declared ones.
7. **No filesystem release without `outputSchema` lists its tools to the current SDK client.** Releases up to 2025.8.21 list a tool whose `inputSchema` the SDK 1.32.2 client rejects (ZodError, `type` must be `object`); 2025.11.25 and later declare outputSchemas. The legacy filesystem run therefore uses 2025.3.28 and tolerates the failed `tools/list`. That release has an older tool set (no `read_text_file`, `append_file`, `copy_file`, `read_media_file`, `list_directory_with_sizes`), so 18 of 50 training calls returned errors, and 6 tools have no successful training sample. Five of those tools do not exist in that release; the sixth, `move_file`, failed (as did one `create_directory`) because that release's `create_directory` is not recursive and my session assumed it was, a mistake in the session and not in mcp-return-types. I left it in rather than re-running with a tuned session. The legacy filesystem figures cover the 9 tools that have both training and fresh successful outputs.
8. **Latest 2.x servers declare `engines.node >= 24`.** They ran on Node 22.18 with `npm warn EBADENGINE` and worked, but a stricter setup could refuse them.
9. **Limits of this test.** Small and scripted by the tool's author (1 to 12 training and 1 to 8 fresh calls per tool, 22 to 41 fresh outputs per server). Servers are deterministic and from one author. Fresh calls bypass the proxy, and the script (Ajv on the full real values) does the validation, not `serve`, except for the single manual `serve` check. Arrays longer than 50 items are sampled by the recorder, and the script validates full values, which is the stricter reading. Nothing here measures how much the types help a model: that is the benchmark's question.

## Done-when for M9

- Emitted types compile with `tsc --noEmit`: yes, 6 of 6.
- Inferred schemas checked against fresh real outputs, match rate reported: yes (above).
- Median proxy latency under 5 ms measured: yes, 0.03 to 0.17 ms.
- `mcp-return-types report` output saved here: yes (Appendix B).

## Appendix A: per-tool results

### Latest releases

### everything  (@modelcontextprotocol/server-everything@2.3.1, server reports version 2.3.1; 2/16 tools declare their own outputSchema)

train: 53 calls, fresh: 41 calls. tsc: everything.d.ts OK

| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |
|---|---|---|---|---|---|---|---|
| echo | 6/0 | medium | text | 6 | 100% (6/6) | 100% (6/6) |  |
| get-annotated-message | 4/1 | medium | text | 3 | 100% (3/3) | 100% (3/3) |  |
| get-env | 3/0 | low | json-text | 2 | 100% (2/2) | 100% (2/2) |  |
| get-header-params | 3/0 | medium | structuredContent | 3 | 100% (3/3) | 100% (3/3) |  |
| get-resource-links | 4/0 | medium | text | 3 | 100% (3/3) | 100% (3/3) |  |
| get-resource-reference | 3/0 | medium | text | 3 | 100% (3/3) | 100% (3/3) |  |
| get-structured-content | 12/0 | high | structuredContent | 8 | 100% (8/8) | 100% (8/8) |  |
| get-sum | 6/1 | medium | text | 5 | 100% (5/5) | 100% (5/5) |  |
| get-tiny-image | 3/0 | low | text | 2 | 100% (2/2) | 100% (2/2) |  |
| toggle-simulated-logging | 1/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| toggle-subscriber-updates | 1/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| trigger-list-changed | 2/0 | low | text | 2 | 100% (2/2) | 100% (2/2) |  |
| trigger-long-running-operation | 3/0 | medium | text | 2 | 100% (2/2) | 100% (2/2) |  |
| **all tools** | | | | 41 | 100% (41/41) | 100% (41/41) | |

Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):

| k | tools | fresh checked | strict match | serve match |
|---|---|---|---|---|
| 1 | 13 | 41 | 100% (41/41) | 100% (41/41) |
| 2 | 13 | 41 | 100% (41/41) | 100% (41/41) |
| 3 | 13 | 41 | 100% (41/41) | 100% (41/41) |
| 5 | 13 | 41 | 100% (41/41) | 100% (41/41) |
| 10 | 13 | 41 | 100% (41/41) | 100% (41/41) |
| all | 13 | 41 | 100% (41/41) | 100% (41/41) |

### filesystem  (@modelcontextprotocol/server-filesystem@2.4.0, server reports version 2.4.0; 16/16 tools declare their own outputSchema)

train: 50 calls, fresh: 37 calls. tsc: filesystem.d.ts OK

| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |
|---|---|---|---|---|---|---|---|
| append_file | 2/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| copy_file | 1/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| create_directory | 2/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| directory_tree | 4/0 | medium | structuredContent | 3 | 100% (3/3) | 100% (3/3) |  |
| edit_file | 2/0 | low | structuredContent | 2 | 100% (2/2) | 100% (2/2) |  |
| get_file_info | 5/0 | medium | structuredContent | 4 | 100% (4/4) | 100% (4/4) |  |
| list_allowed_directories | 2/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| list_directory | 5/1 | medium | structuredContent | 4 | 100% (4/4) | 100% (4/4) |  |
| list_directory_with_sizes | 3/0 | medium | structuredContent | 2 | 100% (2/2) | 100% (2/2) |  |
| move_file | 1/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| read_file | 2/1 | low | structuredContent | 2 | 100% (2/2) | 100% (2/2) | 1 error result(s) excluded |
| read_media_file | 1/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| read_multiple_files | 3/0 | medium | structuredContent | 2 | 100% (2/2) | 100% (2/2) |  |
| read_text_file | 6/1 | medium | structuredContent | 5 | 100% (5/5) | 100% (5/5) |  |
| search_files | 5/0 | medium | structuredContent | 4 | 100% (4/4) | 100% (4/4) |  |
| write_file | 3/0 | medium | structuredContent | 2 | 100% (2/2) | 100% (2/2) |  |
| **all tools** | | | | 36 | 100% (36/36) | 100% (36/36) | |

Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):

| k | tools | fresh checked | strict match | serve match |
|---|---|---|---|---|
| 1 | 16 | 36 | 100% (36/36) | 100% (36/36) |
| 2 | 16 | 36 | 100% (36/36) | 100% (36/36) |
| 3 | 16 | 36 | 100% (36/36) | 100% (36/36) |
| 5 | 16 | 36 | 100% (36/36) | 100% (36/36) |
| 10 | 16 | 36 | 100% (36/36) | 100% (36/36) |
| all | 16 | 36 | 100% (36/36) | 100% (36/36) |

### memory  (@modelcontextprotocol/server-memory@2.2.1, server reports version 2.2.1; 9/9 tools declare their own outputSchema)

train: 28 calls, fresh: 22 calls. tsc: memory.d.ts OK

| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |
|---|---|---|---|---|---|---|---|
| add_observations | 2/1 | low | structuredContent | 2 | 100% (2/2) | 100% (2/2) |  |
| create_entities | 4/0 | medium | structuredContent | 3 | 100% (3/3) | 100% (3/3) |  |
| create_relations | 3/0 | medium | structuredContent | 2 | 100% (2/2) | 100% (2/2) |  |
| delete_entities | 2/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| delete_observations | 1/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| delete_relations | 1/0 | low | structuredContent | 1 | 100% (1/1) | 100% (1/1) |  |
| open_nodes | 4/0 | medium | structuredContent | 3 | 100% (3/3) | 100% (3/3) |  |
| read_graph | 5/0 | medium | structuredContent | 5 | 100% (5/5) | 100% (5/5) |  |
| search_nodes | 5/0 | medium | structuredContent | 4 | 100% (4/4) | 100% (4/4) |  |
| **all tools** | | | | 22 | 100% (22/22) | 100% (22/22) | |

Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):

| k | tools | fresh checked | strict match | serve match |
|---|---|---|---|---|
| 1 | 9 | 22 | 91% (20/22) | 100% (22/22) |
| 2 | 9 | 22 | 82% (18/22) | 100% (22/22) |
| 3 | 9 | 22 | 82% (18/22) | 100% (22/22) |
| 5 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| 10 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| all | 9 | 22 | 100% (22/22) | 100% (22/22) |

Mismatches at k=1:
- open_nodes optional-key $.entities[].observationCount: key never seen in training (1 of 3 outputs)
- search_nodes optional-key $.entities[].observationCount: key never seen in training (1 of 4 outputs)

Mismatches at k=2:
- open_nodes optional-key $.entities[].observationCount: key never seen in training (1 of 3 outputs)
- read_graph optional-key $.entities[].observationCount: key never seen in training (2 of 5 outputs)
- search_nodes optional-key $.entities[].observationCount: key never seen in training (1 of 4 outputs)

Mismatches at k=3:
- open_nodes optional-key $.entities[].observationCount: key never seen in training (1 of 3 outputs)
- read_graph optional-key $.entities[].observationCount: key never seen in training (2 of 5 outputs)
- search_nodes optional-key $.entities[].observationCount: key never seen in training (1 of 4 outputs)

### Older releases (no `outputSchema`)

### everything  (@modelcontextprotocol/server-everything@1.0.0, server reports version 1.0.0; 1/13 tools declare their own outputSchema)

train: 48 calls, fresh: 36 calls. tsc: everything.d.ts OK

| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |
|---|---|---|---|---|---|---|---|
| echo | 6/0 | medium | text | 6 | 100% (6/6) | 100% (6/6) |  |
| get-annotated-message | 4/1 | medium | text | 3 | 100% (3/3) | 100% (3/3) |  |
| get-env | 3/0 | low | json-text | 2 | 100% (2/2) | 100% (2/2) |  |
| get-resource-links | 4/0 | medium | text | 3 | 100% (3/3) | 100% (3/3) |  |
| get-resource-reference | 3/0 | medium | text | 3 | 100% (3/3) | 100% (3/3) |  |
| get-structured-content | 12/0 | high | structuredContent | 8 | 100% (8/8) | 100% (8/8) |  |
| get-sum | 6/1 | medium | text | 5 | 100% (5/5) | 100% (5/5) |  |
| get-tiny-image | 3/0 | low | text | 2 | 100% (2/2) | 100% (2/2) |  |
| toggle-simulated-logging | 1/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| toggle-subscriber-updates | 1/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| trigger-long-running-operation | 3/0 | medium | text | 2 | 100% (2/2) | 100% (2/2) |  |
| **all tools** | | | | 36 | 100% (36/36) | 100% (36/36) | |

Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):

| k | tools | fresh checked | strict match | serve match |
|---|---|---|---|---|
| 1 | 11 | 36 | 100% (36/36) | 100% (36/36) |
| 2 | 11 | 36 | 100% (36/36) | 100% (36/36) |
| 3 | 11 | 36 | 100% (36/36) | 100% (36/36) |
| 5 | 11 | 36 | 100% (36/36) | 100% (36/36) |
| 10 | 11 | 36 | 100% (36/36) | 100% (36/36) |
| all | 11 | 36 | 100% (36/36) | 100% (36/36) |

### filesystem  (@modelcontextprotocol/server-filesystem@2025.3.28, server reports version 0.2.0; tools/list rejected by the SDK client)

train: 50 calls, fresh: 37 calls. tsc: filesystem.d.ts OK

| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |
|---|---|---|---|---|---|---|---|
| append_file | 0/2 | low | none | 0 | n/a | n/a | 1 error result(s) excluded |
| copy_file | 0/1 | low | none | 0 | n/a | n/a | 1 error result(s) excluded |
| create_directory | 1/1 | low | text | 0 | n/a | n/a | 1 error result(s) excluded |
| directory_tree | 4/0 | medium | json-text | 3 | 100% (3/3) | 100% (3/3) |  |
| edit_file | 2/0 | low | text | 2 | 100% (2/2) | 100% (2/2) |  |
| get_file_info | 5/0 | medium | text | 4 | 100% (4/4) | 100% (4/4) |  |
| list_allowed_directories | 2/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| list_directory | 5/1 | medium | text | 4 | 100% (4/4) | 100% (4/4) |  |
| list_directory_with_sizes | 0/3 | low | none | 0 | n/a | n/a | 2 error result(s) excluded |
| move_file | 0/1 | low | none | 0 | n/a | n/a | 1 error result(s) excluded |
| read_file | 2/1 | low | text | 2 | 100% (2/2) | 100% (2/2) | 1 error result(s) excluded |
| read_media_file | 0/1 | low | none | 0 | n/a | n/a | 1 error result(s) excluded |
| read_multiple_files | 3/0 | medium | text | 2 | 100% (2/2) | 100% (2/2) |  |
| read_text_file | 0/7 | low | none | 0 | n/a | n/a | 5 error result(s) excluded |
| search_files | 5/0 | medium | text | 4 | 100% (4/4) | 100% (4/4) |  |
| write_file | 3/0 | medium | text | 2 | 100% (2/2) | 100% (2/2) |  |
| **all tools** | | | | 24 | 100% (24/24) | 100% (24/24) | |

Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):

| k | tools | fresh checked | strict match | serve match |
|---|---|---|---|---|
| 1 | 9 | 24 | 100% (24/24) | 100% (24/24) |
| 2 | 9 | 24 | 100% (24/24) | 100% (24/24) |
| 3 | 9 | 24 | 100% (24/24) | 100% (24/24) |
| 5 | 9 | 24 | 100% (24/24) | 100% (24/24) |
| 10 | 9 | 24 | 100% (24/24) | 100% (24/24) |
| all | 9 | 24 | 100% (24/24) | 100% (24/24) |

### memory  (@modelcontextprotocol/server-memory@2025.4.25, server reports version 0.6.3; 0/9 tools declare their own outputSchema)

train: 28 calls, fresh: 22 calls. tsc: memory.d.ts OK

| tool | train calls (ok/err) | confidence | unwrap | fresh checked | strict match | serve match | notes |
|---|---|---|---|---|---|---|---|
| add_observations | 2/1 | low | json-text | 2 | 100% (2/2) | 100% (2/2) |  |
| create_entities | 4/0 | medium | json-text | 3 | 100% (3/3) | 100% (3/3) |  |
| create_relations | 3/0 | medium | json-text | 2 | 100% (2/2) | 100% (2/2) |  |
| delete_entities | 2/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| delete_observations | 1/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| delete_relations | 1/0 | low | text | 1 | 100% (1/1) | 100% (1/1) |  |
| open_nodes | 4/0 | medium | json-text | 3 | 100% (3/3) | 100% (3/3) |  |
| read_graph | 5/0 | medium | json-text | 5 | 100% (5/5) | 100% (5/5) |  |
| search_nodes | 5/0 | medium | json-text | 4 | 100% (4/4) | 100% (4/4) |  |
| **all tools** | | | | 22 | 100% (22/22) | 100% (22/22) | |

Match rate when infer only sees the first k successful training samples of each tool (fresh outputs checked against it):

| k | tools | fresh checked | strict match | serve match |
|---|---|---|---|---|
| 1 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| 2 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| 3 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| 5 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| 10 | 9 | 22 | 100% (22/22) | 100% (22/22) |
| all | 9 | 22 | 100% (22/22) | 100% (22/22) |

## Appendix B: `mcp-return-types report` output

### Latest releases

**everything** (latest)

```
everything: 13 tools seen (1 high, 7 medium, 5 low confidence), inferred 2026-11-23T17:57:26.390Z
  echo: 6 samples, 6 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  get-annotated-message: 4 samples, 4 arg sets, medium confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (the result is not an object; serve passes results through)
  get-env: 3 samples, 1 arg sets, low confidence, v1, unwrap json-text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: at most 1 distinct argument set
  get-header-params: 3 samples, 3 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  get-resource-links: 4 samples, 4 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  get-resource-reference: 3 samples, 3 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  get-structured-content: 12 samples, 3 arg sets, high confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  get-sum: 6 samples, 6 arg sets, medium confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (the result is not an object; serve passes results through)
  get-tiny-image: 3 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: at most 1 distinct argument set
  toggle-simulated-logging: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  toggle-subscriber-updates: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  trigger-list-changed: 2 samples, 2 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples
  trigger-long-running-operation: 3 samples, 3 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
```

**filesystem** (latest)

```
filesystem: 16 tools seen (0 high, 8 medium, 8 low confidence), inferred 2026-11-23T17:57:37.221Z
  append_file: 2 samples, 2 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples
  copy_file: 1 samples, 1 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  create_directory: 2 samples, 2 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples
  directory_tree: 4 samples, 4 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  edit_file: 2 samples, 2 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples
  get_file_info: 5 samples, 5 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  list_allowed_directories: 2 samples, 1 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  list_directory: 5 samples, 5 arg sets, medium confidence, v1, unwrap structuredContent, 0d old, 1 errors
    serving: server's own outputSchema (serve never replaces it)
  list_directory_with_sizes: 3 samples, 3 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  move_file: 1 samples, 1 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  read_file: 2 samples, 2 arg sets, low confidence, v1, unwrap structuredContent, 0d old, 1 errors
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples
  read_media_file: 1 samples, 1 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  read_multiple_files: 3 samples, 3 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  read_text_file: 6 samples, 6 arg sets, medium confidence, v1, unwrap structuredContent, 0d old, 1 errors
    serving: server's own outputSchema (serve never replaces it)
  search_files: 5 samples, 5 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  write_file: 3 samples, 3 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
```

**memory** (latest)

```
memory: 9 tools seen (0 high, 5 medium, 4 low confidence), inferred 2026-11-23T17:57:45.304Z
  add_observations: 2 samples, 2 arg sets, low confidence, v1, unwrap structuredContent, 0d old, 1 errors
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples
  create_entities: 4 samples, 4 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  create_relations: 3 samples, 3 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  delete_entities: 2 samples, 2 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples
  delete_observations: 1 samples, 1 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  delete_relations: 1 samples, 1 arg sets, low confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  open_nodes: 4 samples, 4 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  read_graph: 5 samples, 3 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  search_nodes: 5 samples, 5 arg sets, medium confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
```

### Older releases

**everything** (legacy)

```
everything: 11 tools seen (1 high, 6 medium, 4 low confidence), inferred 2026-11-23T17:45:12.555Z
  echo: 6 samples, 6 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  get-annotated-message: 4 samples, 4 arg sets, medium confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (the result is not an object; serve passes results through)
  get-env: 3 samples, 1 arg sets, low confidence, v1, unwrap json-text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: at most 1 distinct argument set
  get-resource-links: 4 samples, 4 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  get-resource-reference: 3 samples, 3 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  get-structured-content: 12 samples, 3 arg sets, high confidence, v1, unwrap structuredContent, 0d old
    serving: server's own outputSchema (serve never replaces it)
  get-sum: 6 samples, 6 arg sets, medium confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (the result is not an object; serve passes results through)
  get-tiny-image: 3 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: at most 1 distinct argument set
  toggle-simulated-logging: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  toggle-subscriber-updates: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  trigger-long-running-operation: 3 samples, 3 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
```

**filesystem** (legacy)

```
filesystem: 16 tools seen (0 high, 6 medium, 10 low confidence), inferred 2026-11-23T17:45:26.376Z
  append_file: 0 samples, 0 arg sets, low confidence, v1, unwrap none, no samples, 2 errors
    serving: strict inference only (no successful samples; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  copy_file: 0 samples, 0 arg sets, low confidence, v1, unwrap none, no samples, 1 errors
    serving: strict inference only (no successful samples; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  create_directory: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  directory_tree: 4 samples, 4 arg sets, medium confidence, v1, unwrap json-text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  edit_file: 2 samples, 2 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples
  get_file_info: 5 samples, 5 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  list_allowed_directories: 2 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  list_directory: 5 samples, 5 arg sets, medium confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (the result is not an object; serve passes results through)
  list_directory_with_sizes: 0 samples, 0 arg sets, low confidence, v1, unwrap none, no samples, 3 errors
    serving: strict inference only (no successful samples; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  move_file: 0 samples, 0 arg sets, low confidence, v1, unwrap none, no samples, 1 errors
    serving: strict inference only (no successful samples; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  read_file: 2 samples, 2 arg sets, low confidence, v1, unwrap text, 0d old, 1 errors
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples
  read_media_file: 0 samples, 0 arg sets, low confidence, v1, unwrap none, no samples, 1 errors
    serving: strict inference only (no successful samples; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  read_multiple_files: 3 samples, 3 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  read_text_file: 0 samples, 0 arg sets, low confidence, v1, unwrap none, no samples, 7 errors
    serving: strict inference only (no successful samples; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  search_files: 5 samples, 5 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  write_file: 3 samples, 3 arg sets, medium confidence, v1, unwrap text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
```

**memory** (legacy)

```
memory: 9 tools seen (0 high, 5 medium, 4 low confidence), inferred 2026-11-23T17:45:34.448Z
  add_observations: 2 samples, 2 arg sets, low confidence, v1, unwrap json-text, 0d old, 1 errors
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples
  create_entities: 4 samples, 4 arg sets, medium confidence, v1, unwrap json-text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  create_relations: 3 samples, 3 arg sets, medium confidence, v1, unwrap json-text, 0d old
    serving: strict inference only (the result is not an object; serve passes results through)
  delete_entities: 2 samples, 2 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples
  delete_observations: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  delete_relations: 1 samples, 1 arg sets, low confidence, v1, unwrap text, 0d old
    serving: strict inference only (low confidence; serve passes results through)
    low confidence: fewer than 3 samples; at most 1 distinct argument set
  open_nodes: 4 samples, 4 arg sets, medium confidence, v1, unwrap json-text, 0d old
    serving: open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)
  read_graph: 5 samples, 3 arg sets, medium confidence, v1, unwrap json-text, 0d old
    serving: open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)
  search_nodes: 5 samples, 5 arg sets, medium confidence, v1, unwrap json-text, 0d old
    serving: open schema via serve (adds structuredContent; outputSchema declared only with --declare-schemas)
```
