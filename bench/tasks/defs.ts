// The 20 benchmark tasks (BENCHMARK.md "Tasks") and their oracles. An oracle computes the answer or the
// expected writes straight from the seeded world, never through the tools. `npm run bench:tasks`
// writes bench/tasks/<id>.json from these definitions with the seed-2 (evaluation) answers;
// test/bench.tasks.test.ts checks that the files are up to date and that seed 1 gives a different
// answer for every task (anti-leak).
import type { Issue, RepoName, World } from "../mock-server/data.js";

export type Category = "nested" | "pagination" | "write" | "control";
export type AnswerType = "number" | "string" | "set" | "none";
export type Answer = number | string | (number | string)[];

export interface ExpectedWrite {
  tool: "add_label" | "assign" | "post_comment";
  args: { repo: RepoName; number: number; label?: string; assignee?: string; body?: string };
}

export interface TaskDef {
  id: string;
  category: Category;
  /** What the task is about, for the docs table (never shown to the model). */
  needs: string;
  prompt: string;
  answer_type: AnswerType;
  oracle: (w: World) => { answer?: Answer; writes?: ExpectedWrite[] };
}

const issues = (w: World, repo: RepoName): Issue[] => w.repos.get(repo)?.issues ?? [];
const has = (i: Issue, label: string): boolean => i.labels.some((l) => l.name === label);
const open = (i: Issue): boolean => i.state === "open";
const commentsOf = (w: World, repo: RepoName, n: number) => w.repos.get(repo)?.comments.get(n) ?? [];
const counts = <T>(xs: T[]): Map<T, number> => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
/** The key with the highest count; ties go to the alphabetically first key. */
const argmaxAlpha = (m: Map<string, number>): string =>
  [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
const sortedNums = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const sortedStrs = (xs: string[]): string[] => [...new Set(xs)].sort();

const SET_NUMBERS = "Reply with a JSON array of issue numbers.";
const SET_LOGINS = "Reply with a JSON array of logins.";

export const TASKS: TaskDef[] = [
  // ---- 8 nested or optional fields ----
  {
    id: "nested-01",
    category: "nested",
    needs: "optional assignee (absent key), labels[].name, comments count",
    prompt: "In acme/api, how many open issues have the label `bug`, have nobody assigned, and have more than 5 comments? Reply with the number.",
    answer_type: "number",
    oracle: (w) => ({
      answer: issues(w, "acme/api").filter((i) => open(i) && has(i, "bug") && i.assignee === undefined && i.comments > 5).length,
    }),
  },
  {
    id: "nested-02",
    category: "nested",
    needs: "comment user.login across several issues, labels[].name",
    prompt: `In acme/web, which users commented on at least 4 different open issues that have the label \`perf\`? ${SET_LOGINS}`,
    answer_type: "set",
    oracle: (w) => {
      const perIssue = issues(w, "acme/web")
        .filter((i) => open(i) && has(i, "perf"))
        .flatMap((i) => sortedStrs(commentsOf(w, "acme/web", i.number).map((c) => c.user.login)));
      return { answer: sortedStrs([...counts(perIssue)].filter(([, n]) => n >= 4).map(([l]) => l)) };
    },
  },
  {
    id: "nested-03",
    category: "nested",
    needs: "nullable milestone, labels[].name, state",
    prompt: `In acme/cli, which closed issues have the label \`security\` and no milestone? ${SET_NUMBERS}`,
    answer_type: "set",
    oracle: (w) => ({
      answer: sortedNums(issues(w, "acme/cli").filter((i) => !open(i) && has(i, "security") && i.milestone === null).map((i) => i.number)),
    }),
  },
  {
    id: "nested-04",
    category: "nested",
    needs: "nested milestone.title, nullable milestone",
    prompt:
      "In acme/api, which milestone has the most open issues? Reply with the milestone title. If there is a tie, give the title that comes first alphabetically.",
    answer_type: "string",
    oracle: (w) => ({
      answer: argmaxAlpha(counts(issues(w, "acme/api").filter((i) => open(i) && i.milestone !== null).map((i) => i.milestone?.title as string))),
    }),
  },
  {
    id: "nested-05",
    category: "nested",
    needs: "optional assignee.login",
    prompt:
      "In acme/web, which user is assigned to the most open issues? Reply with the login. If there is a tie, give the login that comes first alphabetically.",
    answer_type: "string",
    oracle: (w) => ({
      answer: argmaxAlpha(counts(issues(w, "acme/web").filter((i) => open(i) && i.assignee).map((i) => i.assignee?.login as string))),
    }),
  },
  {
    id: "nested-06",
    category: "nested",
    needs: "nullable closed_at, date-time parsing",
    prompt: "In acme/cli, how many issues were closed during October 2026 (UTC, judged by the time they were closed)? Reply with the number.",
    answer_type: "number",
    oracle: (w) => ({
      answer: issues(w, "acme/cli").filter((i) => i.closed_at !== null && i.closed_at >= "2026-10-01T00:00:00Z" && i.closed_at < "2026-11-01T00:00:00Z").length,
    }),
  },
  {
    id: "nested-07",
    category: "nested",
    needs: "labels as objects (labels[].name), two labels at once",
    prompt: `In acme/web, which open issues have both the \`bug\` label and the \`perf\` label? ${SET_NUMBERS}`,
    answer_type: "set",
    oracle: (w) => ({ answer: sortedNums(issues(w, "acme/web").filter((i) => open(i) && has(i, "bug") && has(i, "perf")).map((i) => i.number)) }),
  },
  {
    id: "nested-08",
    category: "nested",
    needs: "comment user.login, two pages of comments",
    prompt: `On issue #137 in acme/api, which users wrote at least 2 comments? ${SET_LOGINS}`,
    answer_type: "set",
    oracle: (w) => ({
      answer: sortedStrs([...counts(commentsOf(w, "acme/api", 137).map((c) => c.user.login))].filter(([, n]) => n >= 2).map(([l]) => l)),
    }),
  },
  // ---- 6 pagination ----
  {
    id: "page-01",
    category: "pagination",
    needs: "all pages of list_issues (state all), next_page null",
    prompt: "How many issues does acme/web have in total, open and closed together? Reply with the number.",
    answer_type: "number",
    oracle: (w) => ({ answer: issues(w, "acme/web").length }),
  },
  {
    id: "page-02",
    category: "pagination",
    needs: "3+ pages of list_comments",
    prompt: `On issue #64 in acme/cli, which users wrote at least 5 comments? ${SET_LOGINS}`,
    answer_type: "set",
    oracle: (w) => ({
      answer: sortedStrs([...counts(commentsOf(w, "acme/cli", 64).map((c) => c.user.login))].filter(([, n]) => n >= 5).map(([l]) => l)),
    }),
  },
  {
    id: "page-03",
    category: "pagination",
    needs: "last page of a newest-first list, nullable milestone",
    prompt:
      "What is the title of the oldest open issue in acme/api that has no milestone? The oldest issue is the one with the lowest number. Reply with the exact title.",
    answer_type: "string",
    oracle: (w) => ({ answer: issues(w, "acme/api").find((i) => open(i) && i.milestone === null)?.title ?? "" }),
  },
  {
    id: "page-04",
    category: "pagination",
    needs: "all pages of closed issues",
    prompt: "How many closed issues does acme/cli have? Reply with the number.",
    answer_type: "number",
    oracle: (w) => ({ answer: issues(w, "acme/cli").filter((i) => !open(i)).length }),
  },
  {
    id: "page-05",
    category: "pagination",
    needs: "all pages (state all), user.login",
    prompt:
      "Which user opened the most issues in acme/web, counting open and closed issues? Reply with the login. If there is a tie, give the login that comes first alphabetically.",
    answer_type: "string",
    oracle: (w) => ({ answer: argmaxAlpha(counts(issues(w, "acme/web").map((i) => i.user.login))) }),
  },
  {
    id: "page-06",
    category: "pagination",
    needs: "all pages (state all), comments count",
    prompt:
      "Which issue in acme/web, open or closed, has the most comments? Reply with the issue number. If there is a tie, give the lowest number.",
    answer_type: "number",
    oracle: (w) => ({
      answer: [...issues(w, "acme/web")].sort((a, b) => b.comments - a.comments || a.number - b.number)[0]?.number ?? 0,
    }),
  },
  // ---- 4 writes ----
  {
    id: "write-01",
    category: "write",
    needs: "empty labels array, all pages, add_label",
    prompt:
      "In acme/cli, add the label `needs-triage` to every open issue that has no labels at all. Do not change any other issue. When you are done, reply with the word done.",
    answer_type: "none",
    oracle: (w) => ({
      writes: issues(w, "acme/cli")
        .filter((i) => open(i) && i.labels.length === 0)
        .map((i) => ({ tool: "add_label", args: { repo: "acme/cli", number: i.number, label: "needs-triage" } })),
    }),
  },
  {
    id: "write-02",
    category: "write",
    needs: "optional assignee, user.login, assign",
    prompt:
      "In acme/api, every open issue that has the label `security` and has nobody assigned must be assigned to the user who opened it. Make these assignments and do not change any other issue. When you are done, reply with the word done.",
    answer_type: "none",
    oracle: (w) => ({
      writes: issues(w, "acme/api")
        .filter((i) => open(i) && has(i, "security") && i.assignee === undefined)
        .map((i) => ({ tool: "assign", args: { repo: "acme/api", number: i.number, assignee: i.user.login } })),
    }),
  },
  {
    id: "write-03",
    category: "write",
    needs: "optional assignee.login, post_comment exactly once each",
    prompt:
      "In acme/web, post one comment on every open issue that has the label `perf` and has an assignee. The comment body must be exactly `ping @LOGIN`, where LOGIN is that issue's assignee login. Post exactly one comment per issue and do not comment anywhere else. When you are done, reply with the word done.",
    answer_type: "none",
    oracle: (w) => ({
      writes: issues(w, "acme/web")
        .filter((i) => open(i) && has(i, "perf") && i.assignee)
        .map((i) => ({ tool: "post_comment", args: { repo: "acme/web", number: i.number, body: `ping @${i.assignee?.login}` } })),
    }),
  },
  {
    id: "write-04",
    category: "write",
    needs: "nullable milestone, updated_at date, add_label",
    prompt:
      "In acme/api, add the label `stale` to every open issue that has the label `bug`, has no milestone, and was last updated (updated_at) before 2026-06-01T00:00:00Z. Do not change any other issue. When you are done, reply with the word done.",
    answer_type: "none",
    oracle: (w) => ({
      writes: issues(w, "acme/api")
        .filter((i) => open(i) && has(i, "bug") && i.milestone === null && i.updated_at < "2026-06-01T00:00:00Z")
        .map((i) => ({ tool: "add_label", args: { repo: "acme/api", number: i.number, label: "stale" } })),
    }),
  },
  // ---- 2 single-call controls ----
  {
    id: "ctrl-01",
    category: "control",
    needs: "one get_issue call, title",
    prompt: "What is the title of issue #42 in acme/api? Reply with the exact title.",
    answer_type: "string",
    oracle: (w) => ({ answer: issues(w, "acme/api")[41]?.title ?? "" }),
  },
  {
    id: "ctrl-02",
    category: "control",
    needs: "one get_issue call, user.login",
    prompt: "Which user opened issue #7 in acme/web? Reply with the login.",
    answer_type: "string",
    oracle: (w) => ({ answer: issues(w, "acme/web")[6]?.user.login ?? "" }),
  },
];

/** The fixed 12-task pilot subset (BENCHMARK.md): 5 nested/optional, 4 pagination, 2 writes, 1 control. */
export const PILOT_IDS = [
  "nested-01",
  "nested-03",
  "nested-04",
  "nested-06",
  "nested-07",
  "page-01",
  "page-02",
  "page-03",
  "page-06",
  "write-01",
  "write-03",
  "ctrl-01",
];
