// M11 plain-MCP test: the config generators (no model, no CLI). The arms must differ ONLY in the proxy part of
// the MCP server command; both clients must get the same server and the same prompt.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockGithub } from "../bench/mock-server/server.js";
import { CLAUDE_PLAIN, CODEX_PLAIN, claudePlainArgs, codexPlainArgs, type ClientRequest } from "../bench/plain-mcp/clients.js";
import {
  claudeMcpConfig,
  claudeToolNames,
  CODEX_MCP_APPROVAL_MODE,
  codexMcpOverrides,
  makeRunPaths,
  MOCK_TASK_IDS,
  PASSTHROUGH,
  PLAIN_ARMS,
  PLAIN_MODELS,
  proxyArgs,
  serverSpec,
  tomlString,
  upstreamCommand,
  WORKLOADS,
  type RunPaths,
} from "../bench/plain-mcp/config.js";
import { plainPrompt } from "../bench/plain-mcp/prompt.js";
import { planPlain } from "../bench/plain-mcp/runner.js";
import { tasksFor } from "../bench/plain-mcp/run.js";

const made: RunPaths[] = [];
const paths = (w: "mock" | "everything" = "mock"): RunPaths => {
  const p = makeRunPaths(w);
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p.dir, { recursive: true, force: true });
});

describe("arms differ only in the proxy command", () => {
  for (const w of WORKLOADS) {
    it(`${w}: every arm = <proxy args> + the same upstream command`, () => {
      const p = paths(w);
      const upstream = upstreamCommand(w, p, 150);
      for (const arm of PLAIN_ARMS) {
        const s = serverSpec(arm, w, p, 150);
        expect(s.command).toBe(process.execPath);
        const proxy = proxyArgs(arm, w, p);
        expect(s.args).toEqual([...proxy, ...upstream]);
        expect(proxy.at(-1)).toBe("--");
      }
    });
  }

  it("P is the pass-through script, S is `serve` (default mode), S2 is `serve --declare-schemas`", () => {
    const p = paths();
    const P = proxyArgs("P", "mock", p);
    const S = proxyArgs("S", "mock", p);
    const S2 = proxyArgs("S2", "mock", p);
    expect(P.slice(2)).toEqual([PASSTHROUGH, "--"]);
    expect(S.slice(3)).toEqual(["serve", "--in", p.typegenDir, "--name", "mock-github", "--"]);
    expect(S2.slice(3)).toEqual(["serve", "--in", p.typegenDir, "--name", "mock-github", "--declare-schemas", "--"]);
    expect(S).not.toContain("--declare-schemas");
    // same loader for both proxies, so their start-up path is the same
    expect(P.slice(0, 2)).toEqual(S.slice(0, 2));
    expect(P[1]).toMatch(/^file:\/\/.*tsx\/dist\/loader\.mjs$/);
  });

  it("the mock upstream is seed 2, the given latency, the per-run write log and only the real tools", () => {
    const p = paths();
    const up = upstreamCommand("mock", p, 150);
    expect(up.slice(-8)).toEqual(["--seed", "2", "--latency", "150", "--write-log", p.writeLog, "--tools", "real"]);
    expect(path.dirname(p.writeLog)).toBe(p.dir);
  });

  it("each run folder holds a copy of the seed-1 schemas where `serve --in --name` looks for them", () => {
    const p = paths();
    const copy = path.join(p.typegenDir, "schemas", "mock-github.json");
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(path.join("bench", "arm-d", "mock-github.json"), "utf8"));
    const e = paths("everything");
    expect(existsSync(path.join(e.typegenDir, "schemas", "everything.json"))).toBe(true);
  });
});

describe("mock server --tools real", () => {
  it("lists only the 8 real tools and refuses a distractor", () => {
    const m = new MockGithub({ seed: 2, toolSet: "real" });
    expect(m.listTools().map((t) => t.name).sort()).toEqual(["add_label", "assign", "get_issue", "list_comments", "list_issues", "list_prs", "post_comment", "search_issues"]);
    expect(m.call("ci_list_pipelines", {}).isError).toBe(true);
    expect(m.call("get_issue", { repo: "acme/api", number: 42 }).isError).toBeUndefined();
  });

  it("the default still has all 38 tools", () => {
    expect(new MockGithub({ seed: 2 }).listTools()).toHaveLength(38);
  });
});

describe("client configs", () => {
  const req = (p: RunPaths, arm: "P" | "S" = "S"): ClientRequest => ({
    model: PLAIN_MODELS["claude-cli"],
    prompt: "x",
    server: serverSpec(arm, "mock", p),
    allowedTools: claudeToolNames("mock"),
    runDir: p.dir,
  });

  it("claude --mcp-config: one stdio server with exactly the arm's command", () => {
    const p = paths();
    const s = serverSpec("S", "mock", p);
    expect(claudeMcpConfig(s)).toEqual({ mcpServers: { github: { type: "stdio", command: s.command, args: s.args, env: {} } } });
  });

  it("claude args: MCP only, the 8 tools allowed, stream-json, no --bare, no --safe-mode, no system prompt", () => {
    const p = paths();
    const a = claudePlainArgs(CLAUDE_PLAIN, req(p));
    const after = (f: string): string | undefined => a[a.indexOf(f) + 1];
    expect(a[0]).toBe("-p");
    expect(after("--model")).toBe("claude-haiku-5-5");
    expect(after("--tools")).toBe("");
    expect(after("--mcp-config")).toBe(path.join(p.dir, "mcp-config.json"));
    expect(a).toContain("--strict-mcp-config");
    expect(after("--allowedTools")?.split(",")).toEqual(MOCK_TOOLS.map((t) => `mcp__github__${t}`));
    expect(after("--output-format")).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(a).toContain("--no-session-persistence");
    for (const banned of ["--bare", "--safe-mode", "--system-prompt", "--dangerously-skip-permissions"]) expect(a).not.toContain(banned);
  });

  it("claude args are identical for P and S (the arm lives only in the MCP config file)", () => {
    const p = paths();
    expect(claudePlainArgs(CLAUDE_PLAIN, req(p, "P"))).toEqual(claudePlainArgs(CLAUDE_PLAIN, req(p, "S")));
  });

  it("codex args: isolation flags, the server via -c overrides, no JSON envelope, prompt on stdin", () => {
    const p = paths();
    const r = { ...req(p), model: "gpt-6.2-sol", allowedTools: [] };
    const a = codexPlainArgs(CODEX_PLAIN, r);
    for (const f of ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config"]) expect(a).toContain(f);
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a[a.indexOf("-m") + 1]).toBe("gpt-6.2-sol");
    expect(a).not.toContain("--output-schema");
    expect(a.at(-1)).toBe("-");
    expect(a[a.indexOf("-o") + 1]).toBe(path.join(p.dir, "last-message.txt"));
    const ov = codexMcpOverrides(r.server);
    expect(a.join("\u0000")).toContain(ov.join("\u0000"));
    expect(codexPlainArgs({ ...CODEX_PLAIN, sandbox: "workspace-write" }, r)[a.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("codex -c overrides are TOML that reads back as the exact command and args", () => {
    const p = paths();
    const s = serverSpec("S2", "mock", p);
    const ov = codexMcpOverrides(s);
    const value = (k: string): string => (ov.find((x) => x.startsWith(`mcp_servers.github.${k}=`)) as string).split("=").slice(1).join("=");
    const literal = (t: string): string => {
      expect(t).toMatch(/^'[^']*'$/);
      return t.slice(1, -1);
    };
    expect(literal(value("command"))).toBe(s.command);
    const arr = value("args");
    expect(arr.startsWith("[") && arr.endsWith("]")).toBe(true);
    expect([...arr.matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual(s.args);
    expect(value("startup_timeout_sec")).toBe("60");
  });

  it("codex: this server's tools run without approval via a per-server override, identical in every arm", () => {
    const p = paths();
    const lines = (arm: "P" | "S" | "S2"): string[] => {
      const ov = codexMcpOverrides(serverSpec(arm, "mock", p));
      return ov.filter((x) => x.startsWith("mcp_servers.github.default_tools_approval_mode="));
    };
    expect(CODEX_MCP_APPROVAL_MODE).toBe("approve");
    for (const arm of PLAIN_ARMS) expect(lines(arm)).toEqual(['mcp_servers.github.default_tools_approval_mode="approve"']);
    // the full args differ between arms only in the proxy part of the server command (and nothing about approval)
    const rq = (arm: "P" | "S" | "S2"): ClientRequest => ({ model: "gpt-6.2-sol", prompt: "x", server: serverSpec(arm, "mock", p), allowedTools: [], runDir: p.dir });
    const strip = (a: string[]): string[] => a.filter((x) => !x.startsWith("mcp_servers.github.args="));
    expect(strip(codexPlainArgs(CODEX_PLAIN, rq("P")))).toEqual(strip(codexPlainArgs(CODEX_PLAIN, rq("S")).slice()));
    expect(strip(codexPlainArgs(CODEX_PLAIN, rq("S")))).toEqual(strip(codexPlainArgs(CODEX_PLAIN, rq("S2"))));
  });

  it("codex: no global approval or sandbox bypass, sandbox stays read-only, scoped to the one server key", () => {
    const p = paths();
    const a = codexPlainArgs(CODEX_PLAIN, { model: "gpt-6.2-sol", prompt: "x", server: serverSpec("S", "mock", p), allowedTools: [], runDir: p.dir });
    expect(a).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(a).not.toContain("--approve-for-me");
    expect(a).not.toContain("--trust");
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a.filter((x) => x.includes("approval"))).toEqual(['approval_policy="never"', 'mcp_servers.github.default_tools_approval_mode="approve"']);
  });

  it("tomlString falls back to a basic string when a literal one cannot hold the text", () => {
    expect(tomlString("C:\\Program Files\\node.exe")).toBe("'C:\\Program Files\\node.exe'");
    expect(tomlString("it's")).toBe('"it\'s"');
    expect(tomlString('a\\b"c\'')).toBe(JSON.stringify('a\\b"c\''));
  });
});

const MOCK_TOOLS = ["list_issues", "get_issue", "list_comments", "search_issues", "add_label", "assign", "post_comment", "list_prs"];

describe("prompt and plan", () => {
  it("the prompt depends only on the task and the server name, and asks for a FINAL line", () => {
    const [t] = tasksFor("mock", ["ctrl-01"]);
    const text = plainPrompt(t as never, "github");
    expect(text).toContain('MCP server "github"');
    expect(text).toContain(`Task: ${(t as { prompt: string }).prompt}`);
    expect(text).toMatch(/^FINAL: <answer>$/m);
    expect(plainPrompt.length).toBe(2); // no arm parameter
  });

  it("the full plan is 6 tasks x 2 reps x 2 arms x 2 backends = 48 runs, interleaved and seeded", () => {
    const tasks = tasksFor("mock");
    expect(tasks.map((t) => t.id)).toEqual([...MOCK_TASK_IDS]);
    const backends = [
      { name: "claude-cli", model: "claude-haiku-5-5" },
      { name: "codex-cli", model: "gpt-6.2-sol" },
    ];
    const plan = planPlain({ workload: "mock", tasks, reps: 2, backends, arms: ["P", "S"] });
    expect(plan).toHaveLength(48);
    // every consecutive pair of runs is one (task, rep, backend) with both arms
    for (let i = 0; i < plan.length; i += 2) {
      const [a, b] = [plan[i], plan[i + 1]] as [(typeof plan)[0], (typeof plan)[0]];
      expect([a.task.id, a.rep, a.backend]).toEqual([b.task.id, b.rep, b.backend]);
      expect([a.arm, b.arm].sort()).toEqual(["P", "S"]);
    }
    expect(new Set(plan.map((s) => `${s.backend}/${s.arm}/${s.task.id}/${s.rep}`)).size).toBe(48);
    expect(planPlain({ workload: "mock", tasks, reps: 2, backends, arms: ["P", "S"] }).map((s) => s.arm)).toEqual(plan.map((s) => s.arm));
    // both orders occur (not always P first)
    expect(new Set(plan.filter((_, i) => i % 2 === 0).map((s) => s.arm)).size).toBe(2);
  });

  it("the no-harm workload has its 3 tasks", () => {
    expect(tasksFor("everything").map((t) => t.id)).toEqual(["ev-echo", "ev-sum", "ev-weather"]);
    expect(() => tasksFor("mock", ["nope"])).toThrow(/unknown task/);
  });
});
