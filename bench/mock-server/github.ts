// The 8 real tools of the mock GitHub server. Pure functions over a World, so the server and the
// grader's replay (bench/grade.ts) share exactly one implementation of every write.
import { newestFirst, REPOS, type Comment, type Issue, type RepoName, type User, type World } from "./data.js";

export const PAGE_SIZE = 50;
/** search_issues returns at most this many items, with `incomplete_results: true` when there are more. */
export const SEARCH_LIMIT = 30;

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** True for tools that change state (logged in the write log). */
  write?: boolean;
}

const repoProp = { type: "string", description: `Repository, one of: ${REPOS.join(", ")}` };
const numberProp = { type: "integer", description: "Issue number" };

export const GITHUB_TOOLS: ToolDef[] = [
  {
    name: "list_issues",
    description: `List issues of a repository, newest first, ${PAGE_SIZE} per page.`,
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        state: { type: "string", enum: ["open", "closed", "all"], description: "Default: open" },
        label: { type: "string", description: "Only issues that have this label" },
        page: { type: "integer", minimum: 1, description: "Default: 1" },
      },
      required: ["repo"],
    },
  },
  {
    name: "get_issue",
    description: "Get one issue, including its body.",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp }, required: ["repo", "number"] },
  },
  {
    name: "list_comments",
    description: `List the comments of an issue, oldest first, ${PAGE_SIZE} per page.`,
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, number: numberProp, page: { type: "integer", minimum: 1, description: "Default: 1" } },
      required: ["repo", "number"],
    },
  },
  {
    name: "search_issues",
    description:
      "Search issues in all repositories. Qualifiers: repo:<owner/name>, is:open, is:closed, label:<name> (repeat for AND; quote names with spaces), author:<login>, assignee:<login>, no:assignee, no:milestone. Other words must all appear in the title. Newest first.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "add_label",
    description: "Add a label to an issue. Adding a label the issue already has changes nothing.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, number: numberProp, label: { type: "string" } },
      required: ["repo", "number", "label"],
    },
    write: true,
  },
  {
    name: "assign",
    description: "Set the assignee of an issue (replaces any current assignee).",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, number: numberProp, assignee: { type: "string", description: "Login" } },
      required: ["repo", "number", "assignee"],
    },
    write: true,
  },
  {
    name: "post_comment",
    description: "Post a comment on an issue as the bot user.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, number: numberProp, body: { type: "string" } },
      required: ["repo", "number", "body"],
    },
    write: true,
  },
  {
    name: "list_prs",
    description: "List pull requests of a repository, newest first.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, state: { type: "string", enum: ["open", "closed", "all"], description: "Default: open" } },
      required: ["repo"],
    },
  },
];

export const WRITE_TOOLS = new Set(GITHUB_TOOLS.filter((t) => t.write).map((t) => t.name));

const fail = (error: string): ToolOutcome => ({ ok: false, error });
const ok = (value: unknown): ToolOutcome => ({ ok: true, value });

type Args = Record<string, unknown>;

function str(args: Args, key: string, required: boolean): string | undefined | Error {
  const v = args[key];
  if (v === undefined || v === null) return required ? new Error(`missing required argument "${key}"`) : undefined;
  if (typeof v !== "string") return new Error(`argument "${key}" must be a string`);
  return v;
}
function int(args: Args, key: string, required: boolean): number | undefined | Error {
  const v = args[key];
  if (v === undefined || v === null) return required ? new Error(`missing required argument "${key}"`) : undefined;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) return new Error(`argument "${key}" must be an integer`);
  return n;
}

function repoOf(world: World, args: Args): ReturnType<World["repos"]["get"]> | Error {
  const name = str(args, "repo", true);
  if (name instanceof Error) return name;
  const repo = world.repos.get(name as RepoName);
  return repo ?? new Error(`Not Found: repository "${name}" does not exist`);
}
function issueOf(world: World, args: Args): { repo: NonNullable<ReturnType<World["repos"]["get"]>>; issue: Issue } | Error {
  const repo = repoOf(world, args);
  if (repo instanceof Error) return repo;
  const number = int(args, "number", true);
  if (number instanceof Error) return number;
  const issue = repo?.issues[(number as number) - 1];
  if (!repo || !issue) return new Error(`Not Found: issue #${number} does not exist in ${repo?.name}`);
  return { repo, issue };
}

const user = (u: User): User => ({ login: u.login, id: u.id });
/** The list form of an issue: everything but the body. `assignee` is left out when nobody is assigned. */
function summary(i: Issue): Record<string, unknown> {
  const out: Record<string, unknown> = {
    number: i.number,
    title: i.title,
    state: i.state,
    user: user(i.user),
    labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
  };
  if (i.assignee) out.assignee = user(i.assignee);
  Object.assign(out, {
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    milestone: i.milestone ? { ...i.milestone } : null,
  });
  return out;
}
const full = (i: Issue): Record<string, unknown> => ({ ...summary(i), body: i.body });
const comment = (c: Comment): Record<string, unknown> => ({ ...c, user: user(c.user) });

function page<T>(xs: T[], p: number): { items: T[]; next_page: number | null } {
  const start = (p - 1) * PAGE_SIZE;
  return { items: xs.slice(start, start + PAGE_SIZE), next_page: start + PAGE_SIZE < xs.length ? p + 1 : null };
}

function stateFilter(args: Args): "open" | "closed" | "all" | Error {
  const s = str(args, "state", false);
  if (s instanceof Error) return s;
  if (s === undefined) return "open";
  if (s !== "open" && s !== "closed" && s !== "all") return new Error(`argument "state" must be open, closed or all`);
  return s;
}

/** Tokenize a search query; double quotes group words (label:"good first issue"). */
function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /(\S+?:"[^"]*"|"[^"]*"|\S+)/g;
  for (const m of q.matchAll(re)) out.push((m[1] as string).replace(/"/g, ""));
  return out;
}

function search(world: World, q: string): ToolOutcome {
  const filters: ((repo: RepoName, i: Issue) => boolean)[] = [];
  for (const tok of tokens(q)) {
    const colon = tok.indexOf(":");
    const key = colon > 0 ? tok.slice(0, colon).toLowerCase() : "";
    const val = colon > 0 ? tok.slice(colon + 1) : tok;
    if (key === "repo") filters.push((r) => r === val);
    else if (key === "is" && (val === "open" || val === "closed")) filters.push((_, i) => i.state === val);
    else if (key === "is" && val === "issue") continue;
    else if (key === "label") filters.push((_, i) => i.labels.some((l) => l.name === val));
    else if (key === "author") filters.push((_, i) => i.user.login === val);
    else if (key === "assignee") filters.push((_, i) => i.assignee?.login === val);
    else if (key === "no" && val === "assignee") filters.push((_, i) => i.assignee === undefined);
    else if (key === "no" && val === "milestone") filters.push((_, i) => i.milestone === null);
    else if (key !== "") return fail(`Validation Failed: unknown qualifier "${key}:"`);
    else filters.push((_, i) => i.title.toLowerCase().includes(val.toLowerCase()));
  }
  const hits: { repo: RepoName; issue: Issue }[] = [];
  for (const [name, repo] of world.repos) {
    for (const issue of repo.issues) if (filters.every((f) => f(name, issue))) hits.push({ repo: name, issue });
  }
  hits.sort((a, b) => b.issue.created_at.localeCompare(a.issue.created_at) || b.issue.number - a.issue.number);
  return ok({
    incomplete_results: hits.length > SEARCH_LIMIT,
    items: hits.slice(0, SEARCH_LIMIT).map((h) => ({ repository: h.repo, ...summary(h.issue) })),
  });
}

/** Run one real tool. Writes mutate `world`; `changed` says whether the state really changed (writes are idempotent). */
export function callGithubTool(world: World, name: string, args: Args): ToolOutcome & { changed?: boolean } {
  switch (name) {
    case "list_issues": {
      const repo = repoOf(world, args);
      if (repo instanceof Error || !repo) return fail(String((repo as Error).message));
      const state = stateFilter(args);
      if (state instanceof Error) return fail(state.message);
      const label = str(args, "label", false);
      if (label instanceof Error) return fail(label.message);
      const p = int(args, "page", false) ?? 1;
      if (p instanceof Error) return fail(p.message);
      if (p < 1) return fail(`argument "page" must be at least 1`);
      const xs = repo.issues
        .filter((i) => (state === "all" || i.state === state) && (label === undefined || i.labels.some((l) => l.name === label)))
        .sort(newestFirst);
      const res = page(xs, p);
      return ok({ items: res.items.map(summary), next_page: res.next_page });
    }
    case "get_issue": {
      const found = issueOf(world, args);
      return found instanceof Error ? fail(found.message) : ok(full(found.issue));
    }
    case "list_comments": {
      const found = issueOf(world, args);
      if (found instanceof Error) return fail(found.message);
      const p = int(args, "page", false) ?? 1;
      if (p instanceof Error) return fail(p.message);
      if (p < 1) return fail(`argument "page" must be at least 1`);
      const res = page(found.repo.comments.get(found.issue.number) ?? [], p);
      return ok({ items: res.items.map(comment), next_page: res.next_page });
    }
    case "search_issues": {
      const q = str(args, "q", true);
      return q instanceof Error ? fail(q.message) : search(world, q as string);
    }
    case "list_prs": {
      const repo = repoOf(world, args);
      if (repo instanceof Error || !repo) return fail(String((repo as Error).message));
      const state = stateFilter(args);
      if (state instanceof Error) return fail(state.message);
      const prs = repo.prs.filter((p) => state === "all" || p.state === state).sort((a, b) => b.number - a.number);
      return ok(prs.map((p) => ({ ...p, user: user(p.user), requested_reviewers: p.requested_reviewers.map(user) })));
    }
    case "add_label": {
      const found = issueOf(world, args);
      if (found instanceof Error) return fail(found.message);
      const name = str(args, "label", true);
      if (name instanceof Error) return fail(name.message);
      const label = world.labels.find((l) => l.name === name);
      if (!label) return fail(`Validation Failed: label "${name}" does not exist`);
      const has = found.issue.labels.some((l) => l.name === name);
      if (!has) found.issue.labels = [...found.issue.labels, label];
      return { ok: true, changed: !has, value: { number: found.issue.number, labels: found.issue.labels.map((l) => ({ ...l })) } };
    }
    case "assign": {
      const found = issueOf(world, args);
      if (found instanceof Error) return fail(found.message);
      const login = str(args, "assignee", true);
      if (login instanceof Error) return fail(login.message);
      const who = world.users.find((u) => u.login === login);
      if (!who) return fail(`Validation Failed: user "${login}" does not exist`);
      const same = found.issue.assignee?.login === who.login;
      found.issue.assignee = who;
      return { ok: true, changed: !same, value: { number: found.issue.number, assignee: user(who) } };
    }
    case "post_comment": {
      const found = issueOf(world, args);
      if (found instanceof Error) return fail(found.message);
      const body = str(args, "body", true);
      if (body instanceof Error) return fail(body.message);
      if ((body as string).trim() === "") return fail(`Validation Failed: "body" must not be empty`);
      const list = found.repo.comments.get(found.issue.number) ?? [];
      // Idempotent in state: the same body from the bot on the same issue is kept once.
      const existing = list.find((c) => c.user.login === world.bot.login && c.body === body);
      if (existing) return { ok: true, changed: false, value: comment(existing) };
      const c: Comment = {
        id: world.nextCommentId++,
        user: world.bot,
        body: body as string,
        created_at: "2026-11-15T00:00:00Z",
        author_association: "MEMBER",
      };
      list.push(c);
      found.repo.comments.set(found.issue.number, list);
      found.issue.comments += 1;
      return { ok: true, changed: true, value: comment(c) };
    }
    default:
      return fail(`unknown tool "${name}"`);
  }
}
