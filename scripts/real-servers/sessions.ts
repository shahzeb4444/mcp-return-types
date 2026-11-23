// Scripted sessions for the three reference servers (scripts/validate-real-servers.ts).
// Each server has a TRAIN session (recorded through the mcp-return-types proxy, then inferred) and a FRESH session
// (a new server process, different arguments, never seen by infer). Both are plain lists of tool calls.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Call {
  tool: string;
  args: Record<string, unknown>;
  /** The call is expected to come back as an error result (kept out of the success schema, SPEC §3 rule 10). */
  expectError?: boolean;
}

export type Phase = "train" | "fresh";
export type Variant = "latest" | "legacy";

export interface ServerDef {
  /** Name used for `--name` and for the output folders. */
  name: string;
  /** npm package and exact version per variant, run through npx. */
  pkg: Record<Variant, string>;
  /** Server arguments after the package name. `root` is the per-phase data folder. */
  serverArgs: (root: string) => string[];
  env?: (root: string) => Record<string, string>;
  /** Create fixtures (files, folders) before the phase starts. `shared` is the folder both phases may use. */
  setup: (shared: string, phase: Phase) => void;
  session: (shared: string, phase: Phase) => Call[];
}

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// A 1x1 PNG, so read_media_file has something real to return.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ---------------------------------------------------------------------------------------------------------------
export const everything: ServerDef = {
  name: "everything",
  pkg: { latest: "@modelcontextprotocol/server-everything@2.3.1", legacy: "@modelcontextprotocol/server-everything@1.0.0" },
  serverArgs: () => ["stdio"],
  setup: () => {},
  session: (_shared, phase) => {
    if (phase === "train") {
      return [
        ...["hello", "", "unicode: ñ ✓ 日本", "a somewhat longer message, with punctuation; and 12345", "line one\nline two", "x"].map((message) => ({ tool: "echo", args: { message } })),
        ...[[1, 2], [0, 0], [-5, 10], [1.5, 2.25], [1000000, 3], [7, 8]].map(([a, b]) => ({ tool: "get-sum", args: { a, b } })),
        ...["New York", "Chicago", "Los Angeles", "Chicago", "New York", "Los Angeles", "Chicago", "New York", "Los Angeles", "Chicago", "New York", "Los Angeles"].map((location) => ({
          tool: "get-structured-content",
          args: { location },
        })),
        { tool: "get-annotated-message", args: { messageType: "error", includeImage: false } },
        { tool: "get-annotated-message", args: { messageType: "success", includeImage: true } },
        { tool: "get-annotated-message", args: { messageType: "debug" } },
        { tool: "get-annotated-message", args: { messageType: "success", includeImage: false } },
        { tool: "get-env", args: {} },
        { tool: "get-env", args: {} },
        { tool: "get-env", args: {} },
        ...[1, 2, 4, 7].map((count) => ({ tool: "get-resource-links", args: { count } })),
        { tool: "get-resource-reference", args: { resourceType: "Text", resourceId: 1 } },
        { tool: "get-resource-reference", args: { resourceType: "Blob", resourceId: 2 } },
        { tool: "get-resource-reference", args: { resourceType: "Text", resourceId: 5 } },
        { tool: "get-header-params", args: { region: "eu-west" } },
        { tool: "get-header-params", args: { region: "us-east", repeat: 3 } },
        { tool: "get-header-params", args: { region: "ap-south", repeat: 2 } },
        { tool: "get-tiny-image", args: {} },
        { tool: "get-tiny-image", args: {} },
        { tool: "get-tiny-image", args: {} },
        { tool: "trigger-long-running-operation", args: { duration: 1, steps: 2 } },
        { tool: "trigger-long-running-operation", args: { duration: 1, steps: 3 } },
        { tool: "trigger-long-running-operation", args: { duration: 2, steps: 2 } },
        { tool: "trigger-list-changed", args: { list: "tools" } },
        { tool: "trigger-list-changed", args: { list: "prompts" } },
        { tool: "toggle-simulated-logging", args: {} },
        { tool: "toggle-subscriber-updates", args: {} },
        { tool: "get-sum", args: { a: "not a number", b: 1 }, expectError: true },
        { tool: "get-annotated-message", args: { messageType: "nope" }, expectError: true },
      ];
    }
    return [
      ...["fresh message", "another one", "ünïcödé", "", "tabs\tand\nnewlines", "42"].map((message) => ({ tool: "echo", args: { message } })),
      ...[[100, 200], [0.1, 0.2], [-1, -1], [3, 4.5], [99999, 1]].map(([a, b]) => ({ tool: "get-sum", args: { a, b } })),
      ...["Chicago", "Los Angeles", "New York", "Los Angeles", "Chicago", "New York", "Chicago", "Los Angeles"].map((location) => ({
        tool: "get-structured-content",
        args: { location },
      })),
      { tool: "get-annotated-message", args: { messageType: "debug", includeImage: true } },
      { tool: "get-annotated-message", args: { messageType: "error" } },
      { tool: "get-annotated-message", args: { messageType: "success", includeImage: true } },
      { tool: "get-env", args: {} },
      { tool: "get-env", args: {} },
      ...[3, 5, 8].map((count) => ({ tool: "get-resource-links", args: { count } })),
      { tool: "get-resource-reference", args: { resourceType: "Blob", resourceId: 7 } },
      { tool: "get-resource-reference", args: { resourceType: "Text", resourceId: 3 } },
      { tool: "get-resource-reference", args: { resourceType: "Blob", resourceId: 1 } },
      { tool: "get-header-params", args: { region: "sa-east", repeat: 1 } },
      { tool: "get-header-params", args: { region: "eu-north", repeat: 3 } },
      { tool: "get-header-params", args: { region: "ca-central" } },
      { tool: "get-tiny-image", args: {} },
      { tool: "get-tiny-image", args: {} },
      { tool: "trigger-long-running-operation", args: { duration: 1, steps: 4 } },
      { tool: "trigger-long-running-operation", args: { duration: 2, steps: 1 } },
      { tool: "trigger-list-changed", args: { list: "resources" } },
      { tool: "trigger-list-changed", args: { list: "tools" } },
      { tool: "toggle-simulated-logging", args: {} },
      { tool: "toggle-subscriber-updates", args: {} },
    ];
  },
};

// ---------------------------------------------------------------------------------------------------------------
export const filesystem: ServerDef = {
  name: "filesystem",
  pkg: { latest: "@modelcontextprotocol/server-filesystem@2.4.0", legacy: "@modelcontextprotocol/server-filesystem@2025.3.28" },
  serverArgs: (root) => [root],
  setup: (root, phase) => {
    if (phase === "train") {
      write(path.join(root, "notes.txt"), "Meeting notes\nTODO: ship it\nline 3\nline 4\nlast line\n");
      write(path.join(root, "todo.md"), "# Todo\n- [ ] write tests\n- [x] write code\n");
      write(path.join(root, "data.json"), JSON.stringify({ a: 1, list: [1, 2, 3], nested: { ok: true } }, null, 2));
      write(path.join(root, "big.log"), Array.from({ length: 200 }, (_, i) => `2026-11-23T10:${String(i % 60).padStart(2, "0")}:00Z INFO event ${i}`).join("\n") + "\n");
      write(path.join(root, "src", "a.ts"), "export const a = 1;\n");
      write(path.join(root, "src", "b.ts"), "export const b = 2;\nexport const c = 3;\n");
      write(path.join(root, "src", "util", "c.ts"), "export function c() { return 3; }\n");
      write(path.join(root, "docs", "readme.md"), "# Readme\nHello.\n");
      write(path.join(root, "docs", "guide.md"), "# Guide\n\nSteps.\n");
      mkdirSync(path.join(root, "empty"), { recursive: true });
      writeFileSync(path.join(root, "logo.png"), PNG_1X1);
    } else {
      write(path.join(root, "report.csv"), "id,name,score\n1,ann,10\n2,bo,20\n3,cy,30\n");
      write(path.join(root, "config.yaml"), "name: demo\nversion: 3\nflags:\n  - a\n  - b\n");
      write(path.join(root, "spec.txt"), "SPEC\n".repeat(40));
      write(path.join(root, "lib", "x.js"), "module.exports = 1;\n");
      write(path.join(root, "lib", "y.js"), "module.exports = 2;\n");
      write(path.join(root, "lib", "deep", "z.js"), "module.exports = 3;\n");
      write(path.join(root, "lib", "deep", "notes.md"), "# deep\n");
      mkdirSync(path.join(root, "tmp"), { recursive: true });
    }
  },
  session: (r, phase) => {
    const p = (...s: string[]): string => path.join(r, ...s);
    if (phase === "train") {
      return [
        { tool: "list_allowed_directories", args: {} },
        { tool: "list_allowed_directories", args: {} },
        { tool: "read_text_file", args: { path: p("notes.txt") } },
        { tool: "read_text_file", args: { path: p("data.json") } },
        { tool: "read_text_file", args: { path: p("src", "a.ts") } },
        { tool: "read_text_file", args: { path: p("big.log"), head: 3 } },
        { tool: "read_text_file", args: { path: p("big.log"), tail: 2 } },
        { tool: "read_text_file", args: { path: p("docs", "readme.md") } },
        { tool: "read_file", args: { path: p("todo.md") } },
        { tool: "read_file", args: { path: p("src", "util", "c.ts") } },
        { tool: "read_file", args: { path: p("nope.txt") }, expectError: true },
        { tool: "read_text_file", args: { path: p("..", "outside.txt") }, expectError: true },
        { tool: "list_directory", args: { path: r } },
        { tool: "list_directory", args: { path: p("src") } },
        { tool: "list_directory", args: { path: p("docs") } },
        { tool: "list_directory", args: { path: p("empty") } },
        { tool: "list_directory", args: { path: p("src", "util") } },
        { tool: "list_directory", args: { path: p("missing-dir") }, expectError: true },
        { tool: "list_directory_with_sizes", args: { path: r } },
        { tool: "list_directory_with_sizes", args: { path: p("src"), sortBy: "size" } },
        { tool: "list_directory_with_sizes", args: { path: p("docs"), sortBy: "name" } },
        { tool: "get_file_info", args: { path: p("notes.txt") } },
        { tool: "get_file_info", args: { path: p("src") } },
        { tool: "get_file_info", args: { path: p("empty") } },
        { tool: "get_file_info", args: { path: p("big.log") } },
        { tool: "get_file_info", args: { path: p("data.json") } },
        { tool: "search_files", args: { path: r, pattern: "*.ts" } },
        { tool: "search_files", args: { path: r, pattern: "**/*.md" } },
        { tool: "search_files", args: { path: r, pattern: "notes*" } },
        { tool: "search_files", args: { path: r, pattern: "**/*.ts", excludePatterns: ["util"] } },
        { tool: "search_files", args: { path: r, pattern: "zzz-no-match" } },
        { tool: "directory_tree", args: { path: r } },
        { tool: "directory_tree", args: { path: p("src") } },
        { tool: "directory_tree", args: { path: r, excludePatterns: ["*.log"] } },
        { tool: "directory_tree", args: { path: r, depth: 1 } },
        { tool: "read_multiple_files", args: { paths: [p("notes.txt"), p("todo.md")] } },
        { tool: "read_multiple_files", args: { paths: [p("src", "a.ts"), p("src", "b.ts"), p("src", "util", "c.ts")] } },
        { tool: "read_multiple_files", args: { paths: [p("data.json")] } },
        { tool: "write_file", args: { path: p("new1.txt"), content: "first version\n" } },
        { tool: "write_file", args: { path: p("src", "new2.ts"), content: "export const n = 2;\n" } },
        { tool: "write_file", args: { path: p("new1.txt"), content: "second version, overwritten\n" } },
        { tool: "append_file", args: { path: p("new1.txt"), content: "appended line\n" } },
        { tool: "append_file", args: { path: p("log-new.txt"), content: "created by append\n" } },
        { tool: "edit_file", args: { path: p("notes.txt"), edits: [{ oldText: "TODO: ship it", newText: "DONE: shipped" }], dryRun: true } },
        { tool: "edit_file", args: { path: p("todo.md"), edits: [{ oldText: "write tests", newText: "write more tests" }], dryRun: false } },
        { tool: "create_directory", args: { path: p("made", "a", "b") } },
        { tool: "create_directory", args: { path: p("made2") } },
        { tool: "move_file", args: { source: p("new1.txt"), destination: p("made", "moved.txt") } },
        { tool: "copy_file", args: { source: p("todo.md"), destination: p("made", "todo-copy.md") } },
        { tool: "read_media_file", args: { path: p("logo.png") } },
      ];
    }
    return [
      { tool: "list_allowed_directories", args: {} },
      { tool: "read_text_file", args: { path: p("report.csv") } },
      { tool: "read_text_file", args: { path: p("config.yaml") } },
      { tool: "read_text_file", args: { path: p("spec.txt"), head: 5 } },
      { tool: "read_text_file", args: { path: p("lib", "x.js"), tail: 1 } },
      { tool: "read_text_file", args: { path: p("notes.txt"), head: 1 } },
      { tool: "read_file", args: { path: p("lib", "deep", "z.js") } },
      { tool: "read_file", args: { path: p("data.json") } },
      { tool: "read_file", args: { path: p("does-not-exist.md") }, expectError: true },
      { tool: "list_directory", args: { path: p("lib") } },
      { tool: "list_directory", args: { path: p("lib", "deep") } },
      { tool: "list_directory", args: { path: p("tmp") } },
      { tool: "list_directory", args: { path: r } },
      { tool: "list_directory_with_sizes", args: { path: p("lib"), sortBy: "size" } },
      { tool: "list_directory_with_sizes", args: { path: r, sortBy: "size" } },
      { tool: "get_file_info", args: { path: p("report.csv") } },
      { tool: "get_file_info", args: { path: p("lib", "deep") } },
      { tool: "get_file_info", args: { path: p("logo.png") } },
      { tool: "get_file_info", args: { path: p("tmp") } },
      { tool: "search_files", args: { path: r, pattern: "**/*.js" } },
      { tool: "search_files", args: { path: r, pattern: "*.yaml" } },
      { tool: "search_files", args: { path: p("lib"), pattern: "*" } },
      { tool: "search_files", args: { path: r, pattern: "**/*.md", excludePatterns: ["docs"] } },
      { tool: "directory_tree", args: { path: p("lib") } },
      { tool: "directory_tree", args: { path: r, depth: 2 } },
      { tool: "directory_tree", args: { path: p("tmp") } },
      { tool: "read_multiple_files", args: { paths: [p("report.csv"), p("config.yaml")] } },
      { tool: "read_multiple_files", args: { paths: [p("lib", "x.js"), p("lib", "y.js"), p("lib", "deep", "z.js"), p("spec.txt")] } },
      { tool: "write_file", args: { path: p("tmp", "out.json"), content: JSON.stringify({ x: 1 }) } },
      { tool: "write_file", args: { path: p("tmp", "empty.txt"), content: "" } },
      { tool: "append_file", args: { path: p("tmp", "out.json"), content: "\n" } },
      { tool: "edit_file", args: { path: p("config.yaml"), edits: [{ oldText: "version: 3", newText: "version: 4" }, { oldText: "- b", newText: "- c" }], dryRun: false } },
      { tool: "edit_file", args: { path: p("report.csv"), edits: [{ oldText: "ann", newText: "anna" }], dryRun: true } },
      { tool: "create_directory", args: { path: p("tmp", "x", "y", "z") } },
      { tool: "move_file", args: { source: p("tmp", "empty.txt"), destination: p("tmp", "x", "empty-moved.txt") } },
      { tool: "copy_file", args: { source: p("spec.txt"), destination: p("tmp", "spec-copy.txt") } },
      { tool: "read_media_file", args: { path: p("logo.png") } },
    ];
  },
};

// ---------------------------------------------------------------------------------------------------------------
export const memory: ServerDef = {
  name: "memory",
  pkg: { latest: "@modelcontextprotocol/server-memory@2.2.1", legacy: "@modelcontextprotocol/server-memory@2025.4.25" },
  serverArgs: () => [],
  // The graph file lives in the per-phase folder, so the fresh run starts from an empty graph.
  env: (root) => ({ MEMORY_FILE_PATH: path.join(root, "memory.jsonl") }),
  setup: () => {},
  session: (_r, phase) => {
    if (phase === "train") {
      return [
        { tool: "read_graph", args: {} },
        { tool: "create_entities", args: { entities: [{ name: "Alice", entityType: "person", observations: ["engineer", "likes tea"] }, { name: "Bob", entityType: "person", observations: ["designer"] }] } },
        { tool: "create_entities", args: { entities: [{ name: "Acme", entityType: "company", observations: ["founded 1999"] }] } },
        { tool: "create_entities", args: { entities: [{ name: "ProjectX", entityType: "project", observations: [] }, { name: "Paris", entityType: "city", observations: ["capital of France", "population 2M"] }, { name: "Rust", entityType: "language", observations: ["systems"] }] } },
        { tool: "create_entities", args: { entities: [{ name: "Alice", entityType: "person", observations: ["duplicate"] }] } },
        { tool: "create_relations", args: { relations: [{ from: "Alice", to: "Acme", relationType: "works_at" }, { from: "Bob", to: "Acme", relationType: "works_at" }] } },
        { tool: "create_relations", args: { relations: [{ from: "Alice", to: "ProjectX", relationType: "manages" }] } },
        { tool: "create_relations", args: { relations: [{ from: "Acme", to: "Paris", relationType: "located_in" }] } },
        { tool: "add_observations", args: { observations: [{ entityName: "Alice", contents: ["lives in Paris", "speaks French"] }] } },
        { tool: "add_observations", args: { observations: [{ entityName: "Bob", contents: ["likes coffee"] }, { entityName: "Acme", contents: ["HQ in Paris"] }] } },
        { tool: "add_observations", args: { observations: [{ entityName: "Nobody", contents: ["x"] }] }, expectError: true },
        { tool: "read_graph", args: {} },
        { tool: "read_graph", args: { entityTypes: ["person"] } },
        { tool: "read_graph", args: { observationLimit: 1 } },
        { tool: "search_nodes", args: { query: "Alice" } },
        { tool: "search_nodes", args: { query: "Acme" } },
        { tool: "search_nodes", args: { query: "Paris", limit: 1 } },
        { tool: "search_nodes", args: { query: "coffee", observationLimit: 1 } },
        { tool: "search_nodes", args: { query: "no-such-thing-xyz" } },
        { tool: "open_nodes", args: { names: ["Alice"] } },
        { tool: "open_nodes", args: { names: ["Bob", "Acme"] } },
        { tool: "open_nodes", args: { names: ["Nobody"] } },
        { tool: "open_nodes", args: { names: ["Paris"], observationLimit: 0 } },
        { tool: "delete_observations", args: { deletions: [{ entityName: "Alice", observations: ["likes tea"] }] } },
        { tool: "delete_relations", args: { relations: [{ from: "Acme", to: "Paris", relationType: "located_in" }] } },
        { tool: "delete_entities", args: { entityNames: ["Rust"] } },
        { tool: "delete_entities", args: { entityNames: ["ProjectX", "NeverExisted"] } },
        { tool: "read_graph", args: {} },
      ];
    }
    return [
      { tool: "create_entities", args: { entities: [{ name: "Carol", entityType: "person", observations: ["manager", "runs marathons", "has a dog"] }, { name: "Dave", entityType: "person", observations: [] }] } },
      { tool: "create_entities", args: { entities: [{ name: "Globex", entityType: "company", observations: ["founded 2010", "audio hardware"] }, { name: "Lisbon", entityType: "city", observations: ["capital of Portugal"] }] } },
      { tool: "create_entities", args: { entities: [{ name: "Python", entityType: "language", observations: ["dynamic", "popular"] }] } },
      { tool: "create_relations", args: { relations: [{ from: "Carol", to: "Globex", relationType: "founded" }, { from: "Dave", to: "Globex", relationType: "reports_to" }, { from: "Globex", to: "Lisbon", relationType: "based_in" }] } },
      { tool: "create_relations", args: { relations: [{ from: "Carol", to: "Python", relationType: "writes" }] } },
      { tool: "add_observations", args: { observations: [{ entityName: "Dave", contents: ["joined 2021", "remote"] }] } },
      { tool: "add_observations", args: { observations: [{ entityName: "Lisbon", contents: ["sunny"] }, { entityName: "Python", contents: ["3.14"] }] } },
      { tool: "read_graph", args: {} },
      { tool: "read_graph", args: { entityTypes: ["company", "city"] } },
      { tool: "read_graph", args: { observationLimit: 0 } },
      { tool: "read_graph", args: { entityTypes: ["person"], observationLimit: 2 } },
      { tool: "search_nodes", args: { query: "Globex" } },
      { tool: "search_nodes", args: { query: "capital", limit: 2 } },
      { tool: "search_nodes", args: { query: "person", observationLimit: 0 } },
      { tool: "search_nodes", args: { query: "zzz-nothing" } },
      { tool: "open_nodes", args: { names: ["Carol", "Dave"] } },
      { tool: "open_nodes", args: { names: ["Python"], observationLimit: 1 } },
      { tool: "open_nodes", args: { names: ["Ghost"] } },
      { tool: "delete_observations", args: { deletions: [{ entityName: "Carol", observations: ["has a dog"] }] } },
      { tool: "delete_relations", args: { relations: [{ from: "Carol", to: "Python", relationType: "writes" }] } },
      { tool: "delete_entities", args: { entityNames: ["Dave"] } },
      { tool: "read_graph", args: {} },
    ];
  },
};

export const SERVERS: ServerDef[] = [everything, filesystem, memory];
