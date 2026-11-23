# SPEC: mcp-return-types (Idea A, return-type inference for MCP)

## 1. Problem
Most MCP servers declare no `outputSchema`. Code Mode stubs therefore type every result as `unknown`, and the model has to guess the shape (`.content[0].text`? a JSON string? an array?). Wrong guesses cause exceptions, retries, extra turns and extra output tokens. A pre-registered study (arXiv 2611.19123, abstract) found that return-shape hints swing success by up to 39.5 points for weaker agents. As of 22 Nov 2026 we found no tool that *infers* these shapes automatically from real traffic. SDK work on output schemas (TS SDK PR #670, github-mcp-server PR #2468, vercel/ai #11441) is about developer-declared schemas.

## 2. Product
`mcp-return-types` is a free, MIT, cross-platform (Windows first) Node CLI and stdio proxy. It has six commands:

| Command | What it does |
|---|---|
| `mcp-return-types record --out .typegen -- <server command...>` | Transparent stdio MCP proxy. It forwards everything unchanged and logs each `tools/call` request and response **shape** to `.typegen/samples/<server>/<tool>.jsonl` |
| `mcp-return-types infer --in .typegen` | Merges the samples into one JSON Schema 2020-12 per tool, plus a confidence score, and writes `.typegen/schemas/<server>.json` |
| `mcp-return-types emit --ts --in .typegen --out types/` | Writes TypeScript declarations (`Promise<ListIssuesResult>`), ready for Code Mode stubs |
| `mcp-return-types serve -- <server command...>` | Proxy that adds `structuredContent` when a text result parses as JSON matching the inferred schema. With `--declare-schemas` it also injects the inferred `outputSchema` into `tools/list`. Fail-open rules are in §3 rule 12 |
| `mcp-return-types quickstart` | One-shot setup: starts the server through `record`, calls its read-only tools (`annotations.readOnlyHint: true`, or exactly those named with `--tools`) with arguments derived from the input schemas (default, const, enum, examples, bounds, booleans), then infers and emits `<types>/<server>.d.ts` and `<server>.codemode.d.ts`. `--dry-run` prints the plan and calls nothing. Exit 1 when no tool returned a success |
| `mcp-return-types report` | Prints coverage: tools seen, samples per tool, confidence, drift warnings |

## 3. Inference rules (must be implemented and unit-tested)
1. **Unwrap first.** Read `structuredContent` if present. Otherwise join the `content[].text` parts and try `JSON.parse`. If parsing fails, the type is `{kind:"text"}` (string). Record which unwrap path was used, because the stub must say so. **Text | parsed union** (added 2026-11-23 after M9): a text tool whose result sometimes parses as JSON and sometimes does not is typed as the union `string | <parsed shape>` (unwrap `mixed`), never as a validation failure. A JSON-text result also has its plain-text reading, so it still matches a tool whose schema accepts a string: for drift (rule 9) it is not a break, and `serve` passes it through without a drift event. Plain text from a tool that was only ever JSON is still a break, and widens the schema to the same union.
2. **Primitive types:** string, number (integer if every sample is an integer), boolean, null.
3. **Objects:** take the union of keys across samples. A key missing in some samples is **optional** (`required` lists only keys present in 100% of samples). A key present but `null` makes the type **nullable** (`type: ["string","null"]`). Optional and nullable are different things and must stay separate.
4. **Arrays:** merge the item schemas of all elements across all samples. If every array seen is empty, the items are `{}` and confidence is low.
5. **Unions:** mixed primitive types become `type: [..]`. Objects with different shapes are merged into one object with optional keys when they share at least 50% of their keys, measured against the smaller key set (`|A ∩ B| / min(|A|, |B|) ≥ 0.5`). Otherwise they become `anyOf`, capped at 4 branches, and anything beyond that is `{}`.
6. **Enums:** a string field with ≤8 distinct values over ≥20 samples gets `"x-observed-values"` (a hint, **not** a hard enum). The values come from the per-field value counters described in §4, never from stored samples.
7. **Formats:** detect `date-time`, `uri` and `email` only when 100% of observed values match. The recorder classifies each string's format at record time and stores only the class (see §4).
8. **Confidence** per tool is one of three levels, using sample count, argument diversity (distinct argument hashes, see §4) and age (days since the newest sample):
   - `low`: fewer than 3 samples, or every array seen was empty, or only 1 distinct argument set. The stub adds a `// low confidence` comment.
   - `high`: at least 10 samples and at least 3 distinct argument sets.
   - `medium`: everything else.
   - If the newest sample is older than 30 days, drop one level.
9. **Drift:** a new sample that breaks the current schema widens the schema, logs a drift event and bumps the schema version.
10. **Error results** (`isError: true`) are kept in a separate error shape and never merged into the success schema.
11. **Depth cap** of 6. Anything deeper becomes `{}`. **Map-like objects** (changed 2026-11-23 after M9, refined the same day; replaces the old key cap of 200 and the ">50 keys, no key in more than half the samples" map rule): an object position is a map only when it has **more than 30 keys (or the union of its keys across samples exceeds 30) AND all its value schemas are homogeneous**: the same type (integer and number count as one; nulls only make a value nullable), and for objects the same merged shape (every key they share has the same type). Objects with mixed value types stay normal objects with required/optional keys, however many keys they have (a real GitHub repo object has ~80 keys of mixed types and stays typed; `get-env` with 111 string values is a map). A map gets `{type:"object", additionalProperties:<merged value schema>}` with no `properties`, and is emitted as `{ [key: string]: T }`. Privacy: the key names of a map are data (environment variables, headers, user ids), so they are never stored in the schema or the emitted types. An object with more than 30 keys and homogeneous values is recorded as `{t:"map", n, values}` (key count and up to 50 value shapes, no key names) and gets no value counters (§4). Limit: when every single value has at most 30 keys and only the union exceeds 30, the recorder cannot know at record time, so those samples hold the key names as any object's keys do; the schema and types still do not. A mixed object with more than 30 keys is recorded with its key names (they are field names, not data).
12. **Serve fail-open.** By default `serve` declares no `outputSchema`; it adds `structuredContent` only when the parsed result validates against the inferred schema. On a mismatch, it passes the result through unchanged without `structuredContent` and logs a drift event. `serve` never changes the schema itself; widening (rule 9) happens in `record`/`infer`. It never applies the success schema to `isError` results. `serve --declare-schemas` also injects `outputSchema` into `tools/list`, only for tools at `medium` or `high` confidence whose root is an object, and never over a schema the server declared itself. It is opt-in because strict clients (the MCP SDK client, see NOTES.md) reject a declared-schema tool result that has no `structuredContent` or does not match, so a mismatch would no longer fail open. `--no-output-schema` is accepted as an alias of the default.

## 4. Privacy (default on)
- By default record **shapes only**: strings are replaced by their length class and format class (`date-time`, `uri`, `email` or none), and numbers by their kind (integer or number). Raw values are stored only with `--keep-values`.
- **Aggregated value counters (the one exception).** For enum hints (§3 rule 6), the recorder keeps one counter per string field in `.typegen/samples/<server>/<tool>.values.json`, mapping each value to its count. It does this only while the field has ≤8 distinct values, each ≤40 characters. When a 9th distinct value appears, the counter is deleted and the field is marked high-cardinality for good. Values never appear in the per-sample files. `--no-observed-values` turns the counters off.
- **Argument diversity** (§3 rule 8) is counted from a SHA-256 hash of the canonical JSON of each call's arguments. The hash is salted with a random salt stored in `.typegen/salt`. Argument values themselves are not stored.
- No network calls and no telemetry. Everything goes to the local `.typegen/` folder. There is no `init` command: the first `record` run adds `.typegen/` to `.gitignore` if the current folder is a git repo and the line is missing, and prints that it did so.

## 5. Non-goals for v0.1
HTTP/Streamable transport (stdio only), inferring input schemas, a GUI.

## 6. Code Mode integration (needed for the benchmark)
`src/codemode/stubs.ts` generates a TS declaration block for a tool set from the input schemas and, optionally, the inferred output types. The benchmark compares "unknown returns" against "inferred returns" with everything else identical.

## 7. Acceptance for v0.1
- `npm test` passes with ≥40 unit tests covering every rule in §3.
- `record` → `infer` → `emit` works end to end against `@modelcontextprotocol/server-everything` and the mock GitHub server, on Windows PowerShell and Git Bash. `server-everything` is pinned as a devDependency and started from `node_modules`, so tests need no network.
- The proxy adds under 5 ms median latency per call. Measure it as the median of (round-trip through the proxy − direct round-trip) over 200 sequential `tools/call` requests to a local server: `server-everything` until the mock exists (M3 comes before M4), then the mock GitHub server with its injected latency set to 0.
- The benchmark in BENCHMARK.md has run, and the verdict is written to `bench/results/VERDICT.md`.
