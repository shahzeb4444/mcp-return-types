// 30 distractor tools from a fake CI server and a fake chat server (BENCHMARK.md workload). No task
// needs them; they make the tool list realistic. Their data is seeded too, and their writes are logged
// like real writes (a task never asks for one, so the grader counts any as an unexpected write).
import type { World } from "./data.js";
import type { ToolDef, ToolOutcome } from "./github.js";
import { createRng } from "./rng.js";

const s = (description: string) => ({ type: "string", description });
const i = (description: string) => ({ type: "integer", description });
const obj = (properties: Record<string, unknown>, required: string[] = []): ToolDef["inputSchema"] =>
  required.length ? { type: "object", properties, required } : { type: "object", properties };

export const DISTRACTOR_TOOLS: ToolDef[] = [
  { name: "ci_list_pipelines", description: "CI: list pipelines of a project.", inputSchema: obj({ project: s("Project"), status: s("running|success|failed") }, ["project"]) },
  { name: "ci_get_pipeline", description: "CI: get one pipeline.", inputSchema: obj({ id: i("Pipeline id") }, ["id"]) },
  { name: "ci_list_jobs", description: "CI: list the jobs of a pipeline.", inputSchema: obj({ pipeline_id: i("Pipeline id") }, ["pipeline_id"]) },
  { name: "ci_get_job", description: "CI: get one job.", inputSchema: obj({ id: i("Job id") }, ["id"]) },
  { name: "ci_get_job_log", description: "CI: get the log of a job (plain text).", inputSchema: obj({ id: i("Job id"), tail: i("Last N lines") }, ["id"]) },
  { name: "ci_retry_job", description: "CI: retry a job.", inputSchema: obj({ id: i("Job id") }, ["id"]), write: true },
  { name: "ci_cancel_pipeline", description: "CI: cancel a running pipeline.", inputSchema: obj({ id: i("Pipeline id") }, ["id"]), write: true },
  { name: "ci_trigger_pipeline", description: "CI: start a pipeline on a branch.", inputSchema: obj({ project: s("Project"), ref: s("Branch") }, ["project", "ref"]), write: true },
  { name: "ci_list_artifacts", description: "CI: list the artifacts of a job.", inputSchema: obj({ job_id: i("Job id") }, ["job_id"]) },
  { name: "ci_get_artifact", description: "CI: get artifact metadata.", inputSchema: obj({ id: i("Artifact id") }, ["id"]) },
  { name: "ci_list_runners", description: "CI: list runners.", inputSchema: obj({ online: { type: "boolean" } }) },
  { name: "ci_get_runner", description: "CI: get one runner.", inputSchema: obj({ id: i("Runner id") }, ["id"]) },
  { name: "ci_list_environments", description: "CI: list deployment environments of a project.", inputSchema: obj({ project: s("Project") }, ["project"]) },
  { name: "ci_list_deployments", description: "CI: list deployments to an environment.", inputSchema: obj({ project: s("Project"), environment: s("Environment") }, ["project", "environment"]) },
  { name: "ci_list_schedules", description: "CI: list pipeline schedules of a project.", inputSchema: obj({ project: s("Project") }, ["project"]) },
  { name: "chat_list_channels", description: "Chat: list channels.", inputSchema: obj({ include_archived: { type: "boolean" } }) },
  { name: "chat_get_channel", description: "Chat: get one channel.", inputSchema: obj({ channel: s("Channel id") }, ["channel"]) },
  { name: "chat_list_messages", description: "Chat: list recent messages in a channel.", inputSchema: obj({ channel: s("Channel id"), cursor: s("Cursor") }, ["channel"]) },
  { name: "chat_get_message", description: "Chat: get one message.", inputSchema: obj({ channel: s("Channel id"), ts: s("Message timestamp") }, ["channel", "ts"]) },
  { name: "chat_post_message", description: "Chat: post a message.", inputSchema: obj({ channel: s("Channel id"), text: s("Text") }, ["channel", "text"]), write: true },
  { name: "chat_add_reaction", description: "Chat: add an emoji reaction to a message.", inputSchema: obj({ channel: s("Channel id"), ts: s("Message timestamp"), emoji: s("Emoji name") }, ["channel", "ts", "emoji"]), write: true },
  { name: "chat_set_topic", description: "Chat: set the topic of a channel.", inputSchema: obj({ channel: s("Channel id"), topic: s("Topic") }, ["channel", "topic"]), write: true },
  { name: "chat_list_users", description: "Chat: list workspace users.", inputSchema: obj({ cursor: s("Cursor") }) },
  { name: "chat_get_user", description: "Chat: get one user.", inputSchema: obj({ user: s("User id") }, ["user"]) },
  { name: "chat_get_presence", description: "Chat: get the presence of a user.", inputSchema: obj({ user: s("User id") }, ["user"]) },
  { name: "chat_list_threads", description: "Chat: list threads in a channel.", inputSchema: obj({ channel: s("Channel id") }, ["channel"]) },
  { name: "chat_get_thread", description: "Chat: get the replies of a thread.", inputSchema: obj({ channel: s("Channel id"), ts: s("Thread timestamp") }, ["channel", "ts"]) },
  { name: "chat_search_messages", description: "Chat: search messages.", inputSchema: obj({ query: s("Query") }, ["query"]) },
  { name: "chat_list_files", description: "Chat: list files shared in a channel.", inputSchema: obj({ channel: s("Channel id") }, ["channel"]) },
  { name: "chat_list_pins", description: "Chat: list pinned messages of a channel.", inputSchema: obj({ channel: s("Channel id") }, ["channel"]) },
];

const iso = (ms: number): string => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;

/**
 * Answers a distractor call. Data is derived from the seed and the arguments, so the same call always
 * gives the same answer within a seed.
 */
export function callDistractor(world: World, name: string, args: Record<string, unknown>): ToolOutcome {
  const rng = createRng(`${world.seed}:${name}:${JSON.stringify(args)}`);
  const t = (): string => iso(Date.parse("2026-10-01T00:00:00Z") + rng.int(0, 40 * 86_400_000));
  const who = (): { id: string; name: string } => {
    const u = rng.pick(world.users);
    return { id: `U${u.id}`, name: u.login };
  };
  const status = (): string => rng.pick(["running", "success", "failed", "canceled"]);
  const id = (): number => rng.int(10_000, 99_999);
  const need = (key: string): string | undefined => (args[key] === undefined ? `missing required argument "${key}"` : undefined);
  const def = DISTRACTOR_TOOLS.find((d) => d.name === name);
  if (!def) return { ok: false, error: `unknown tool "${name}"` };
  for (const key of def.inputSchema.required ?? []) {
    const e = need(key);
    if (e) return { ok: false, error: e };
  }
  const pipeline = () => ({ id: id(), project: String(args.project ?? "acme/api"), ref: rng.pick(["main", "release"]), status: status(), created_at: t(), duration_s: rng.chance(0.2) ? null : rng.int(30, 900) });
  const job = () => ({ id: id(), name: rng.pick(["build", "test", "lint", "deploy"]), stage: rng.pick(["build", "test", "deploy"]), status: status(), runner: rng.chance(0.3) ? null : { id: rng.int(1, 20), description: `runner-${rng.int(1, 20)}` }, started_at: t() });
  const message = () => ({ ts: `${rng.int(1_700_000_000, 1_800_000_000)}.${rng.int(100000, 999999)}`, user: who(), text: rng.pick(["deploy done", "who broke main?", "lgtm", "standup in 5", "ci is red again"]), reactions: rng.chance(0.5) ? [{ name: rng.pick(["+1", "eyes", "tada"]), count: rng.int(1, 9) }] : [], thread_ts: rng.chance(0.3) ? `${rng.int(1_700_000_000, 1_800_000_000)}.000100` : undefined });
  const many = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);
  const value = ((): unknown => {
    switch (name) {
      case "ci_list_pipelines": return { pipelines: many(rng.int(3, 12), pipeline) };
      case "ci_get_pipeline": return { ...pipeline(), id: args.id, jobs_count: rng.int(2, 9) };
      case "ci_list_jobs": return { jobs: many(rng.int(2, 8), job) };
      case "ci_get_job": return { ...job(), id: args.id };
      case "ci_get_job_log": return undefined; // plain text, see below
      case "ci_retry_job": return { ...job(), id: id(), status: "pending", retried_from: args.id };
      case "ci_cancel_pipeline": return { id: args.id, status: "canceled" };
      case "ci_trigger_pipeline": return { ...pipeline(), status: "pending" };
      case "ci_list_artifacts": return { artifacts: many(rng.int(0, 4), () => ({ id: id(), file_name: rng.pick(["coverage.xml", "dist.zip", "report.html"]), size: rng.int(1000, 9_000_000), expire_at: rng.chance(0.5) ? t() : null })) };
      case "ci_get_artifact": return { id: args.id, file_name: "dist.zip", size: rng.int(1000, 9_000_000), expire_at: null };
      case "ci_list_runners": return many(rng.int(2, 6), () => ({ id: rng.int(1, 20), description: `runner-${rng.int(1, 20)}`, online: rng.chance(0.7), tags: rng.shuffle(["linux", "windows", "gpu", "arm"]).slice(0, rng.int(0, 3)) }));
      case "ci_get_runner": return { id: args.id, description: `runner-${args.id}`, online: rng.chance(0.7), version: `16.${rng.int(0, 9)}.0`, contacted_at: t() };
      case "ci_list_environments": return { environments: many(rng.int(1, 4), () => ({ name: rng.pick(["staging", "production", "review"]), state: rng.pick(["available", "stopped"]), last_deployment: rng.chance(0.3) ? null : { id: id(), sha: rng.int(0, 0xfffffff).toString(16) } })) };
      case "ci_list_deployments": return { deployments: many(rng.int(0, 6), () => ({ id: id(), status: status(), created_at: t(), user: who() })) };
      case "ci_list_schedules": return { schedules: many(rng.int(0, 3), () => ({ id: id(), cron: rng.pick(["0 3 * * *", "*/30 * * * *"]), active: rng.chance(0.8), next_run_at: t() })) };
      case "chat_list_channels": return { channels: many(rng.int(4, 10), () => ({ id: `C${id()}`, name: rng.pick(["general", "dev", "ops", "random", "releases"]), is_archived: rng.chance(0.1), num_members: rng.int(2, 80) })), response_metadata: { next_cursor: rng.chance(0.3) ? `dXNlcjo${id()}` : "" } };
      case "chat_get_channel": return { id: args.channel, name: "dev", topic: { value: "ship it", creator: who().id }, purpose: null, created: rng.int(1_600_000_000, 1_700_000_000) };
      case "chat_list_messages": return { messages: many(rng.int(1, 15), message), has_more: rng.chance(0.4) };
      case "chat_get_message": return message();
      case "chat_post_message": return { ok: true, channel: args.channel, ts: `${rng.int(1_700_000_000, 1_800_000_000)}.000200` };
      case "chat_add_reaction": return { ok: true };
      case "chat_set_topic": return { ok: true, topic: args.topic };
      case "chat_list_users": return { members: many(rng.int(5, 20), () => ({ ...who(), is_bot: rng.chance(0.1), tz: rng.chance(0.2) ? null : "Europe/Berlin" })) };
      case "chat_get_user": return { id: args.user, name: who().name, profile: { title: rng.chance(0.5) ? "Engineer" : "", email: rng.chance(0.5) ? "someone@example.com" : undefined } };
      case "chat_get_presence": return { presence: rng.pick(["active", "away"]), last_activity: rng.chance(0.4) ? null : rng.int(1_700_000_000, 1_800_000_000) };
      case "chat_list_threads": return { threads: many(rng.int(0, 6), () => ({ ts: `${rng.int(1_700_000_000, 1_800_000_000)}.000100`, reply_count: rng.int(1, 30), latest_reply: t() })) };
      case "chat_get_thread": return { messages: many(rng.int(1, 8), message) };
      case "chat_search_messages": return { total: rng.int(0, 200), matches: many(rng.int(0, 10), message) };
      case "chat_list_files": return { files: many(rng.int(0, 5), () => ({ id: `F${id()}`, name: rng.pick(["log.txt", "screenshot.png", "notes.md"]), size: rng.int(100, 900_000), user: who() })) };
      case "chat_list_pins": return { items: many(rng.int(0, 4), () => ({ type: "message", message: message() })) };
      default: return null;
    }
  })();
  if (name === "ci_get_job_log") {
    const lines = many(Math.min(Number(args.tail ?? 20), 200), () => `[${t()}] ${rng.pick(["Running tests", "Compiling", "OK", "WARN deprecated", "Uploading artifacts"])}`);
    return { ok: true, value: lines.join("\n") };
  }
  return { ok: true, value };
}
