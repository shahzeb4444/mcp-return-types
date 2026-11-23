// The seeded world behind the mock GitHub server (BENCHMARK.md workload): 3 repos, about 1,500 issues
// and about 12,000 comments. Seed 1 is for type warm-up only, seed 2 for evaluation. Everything that a
// task answer depends on (logins, titles, milestones, labels per issue, dates, comments) comes from the
// seed, so the two seeds give different answers (checked by test/bench.tasks.test.ts).
import { createRng, type Rng } from "./rng.js";

export const REPOS = ["acme/api", "acme/web", "acme/cli"] as const;
export type RepoName = (typeof REPOS)[number];

/** Issues whose comment threads are long on purpose (several pages of 50). Same numbers in every seed. */
export const HOT_ISSUES: Record<RepoName, number | undefined> = { "acme/api": 137, "acme/web": undefined, "acme/cli": 64 };

/** "Now" of the world. Every date is before it. */
export const NOW = Date.parse("2026-11-15T00:00:00Z");
const START = Date.parse("2025-01-01T00:00:00Z");

export interface User {
  login: string;
  id: number;
}
export interface Label {
  name: string;
  color: string;
}
export interface Milestone {
  number: number;
  title: string;
  due_on: string | null;
}
export interface Comment {
  id: number;
  user: User;
  body: string;
  created_at: string;
  author_association: "OWNER" | "MEMBER" | "CONTRIBUTOR" | "NONE";
}
export interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  user: User;
  labels: Label[];
  /** Absent (not null) when nobody is assigned. */
  assignee?: User;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  milestone: Milestone | null;
  body: string;
}
export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  user: User;
  head: { ref: string; sha: string };
  base: { ref: string };
  requested_reviewers: User[];
  merged_at: string | null;
  created_at: string;
}
export interface Repo {
  name: RepoName;
  issues: Issue[];
  /** Comments per issue number, oldest first. */
  comments: Map<number, Comment[]>;
  milestones: Milestone[];
  prs: PullRequest[];
}
export interface World {
  seed: number;
  users: User[];
  /** The login the server writes as (post_comment). */
  bot: User;
  labels: Label[];
  repos: Map<RepoName, Repo>;
  nextCommentId: number;
}

/** Label name -> probability per issue. `needs-triage` and `stale` exist but are never pre-assigned (write tasks add them). */
const LABEL_P: [string, number][] = [
  ["bug", 0.3],
  ["enhancement", 0.25],
  ["docs", 0.12],
  ["perf", 0.08],
  ["security", 0.07],
  ["question", 0.08],
  ["wontfix", 0.04],
  ["good first issue", 0.06],
];
const WRITE_ONLY_LABELS = ["needs-triage", "stale"];

const ADJ = [
  "amber", "brisk", "calm", "dusty", "eager", "fuzzy", "gentle", "hazel", "icy", "jolly", "keen", "lucky",
  "misty", "noble", "olive", "proud", "quick", "rusty", "sunny", "tidy", "urban", "vivid", "witty", "young",
  "zesty", "bold", "cosmic", "daring", "frosty", "golden",
];
const NOUN = [
  "otter", "falcon", "badger", "heron", "lynx", "marten", "newt", "orca", "panda", "quail", "raven", "seal",
  "tapir", "urchin", "viper", "walrus", "yak", "zebra", "bison", "crane", "dingo", "egret", "ferret", "gecko",
  "hare", "ibis", "jackal", "koala", "lemur", "moose",
];
const CODENAMES = [
  "Aurora", "Basalt", "Cobalt", "Dune", "Ember", "Fjord", "Granite", "Harbor", "Iris", "Juniper", "Krypton",
  "Lagoon", "Meadow", "Nimbus", "Onyx", "Prism", "Quartz", "Ridge", "Sierra", "Tundra", "Umber", "Vertex",
  "Willow", "Xenon", "Yonder", "Zephyr", "Atlas", "Beacon", "Cedar", "Delta",
];
const VERBS = ["Crash", "Hang", "Wrong output", "Memory leak", "Slow response", "Timeout", "Broken link", "Typo", "Race condition", "Missing error"];
const WHEN = ["when parsing", "while loading", "after updating", "on startup with", "when exporting", "during sync of", "when resizing", "with large"];
const THINGS = ["config files", "the dashboard", "user settings", "CSV import", "the login page", "webhooks", "the cache layer", "nested tables", "unicode paths", "the CLI flags", "search results", "rate limits"];
const PLATFORM = ["on Windows", "on macOS", "in Firefox", "in Safari", "behind a proxy", "in CI", "on ARM", "with Node 22", "in dark mode", "offline"];
const COMMENT_BODIES = [
  "I can reproduce this.", "Same here on the latest version.", "Any update on this?", "Here is a minimal repro.",
  "This looks related to an older issue.", "Fixed in my fork, will open a PR.", "Can you share the logs?",
  "+1", "Still happens after the last release.", "Closing as duplicate?", "Workaround: restart the service.",
  "I think the root cause is in the parser.",
];

const iso = (ms: number): string => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
const between = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng.next() * (hi - lo));

function makeUsers(rng: Rng): User[] {
  const combos = rng.shuffle(ADJ.flatMap((a) => NOUN.map((n) => `${a}-${n}`)));
  const ids = new Set<number>();
  return combos.slice(0, 40).map((base) => {
    let id = rng.int(1000, 999_999);
    while (ids.has(id)) id = rng.int(1000, 999_999);
    ids.add(id);
    return { login: `${base}${rng.int(10, 99)}`, id };
  });
}

function makeLabels(rng: Rng): Label[] {
  const hex = (): string => rng.int(0, 0xffffff).toString(16).padStart(6, "0");
  return [...LABEL_P.map(([name]) => name), ...WRITE_ONLY_LABELS].map((name) => ({ name, color: hex() }));
}

function makeMilestones(rng: Rng, names: string[]): Milestone[] {
  return names.map((name, i) => ({
    number: i + 1,
    title: `${name} ${rng.int(1, 9)}.${rng.int(0, 9)}`,
    due_on: rng.chance(0.75) ? iso(between(rng, Date.parse("2026-01-01T00:00:00Z"), Date.parse("2027-06-01T00:00:00Z"))) : null,
  }));
}

function makeTitle(rng: Rng, used: Set<string>): string {
  for (;;) {
    const t = `${rng.pick(VERBS)} ${rng.pick(WHEN)} ${rng.pick(THINGS)} ${rng.pick(PLATFORM)}`;
    if (!used.has(t)) {
      used.add(t);
      return t;
    }
  }
}

/** Geometric-ish comment count with mean about 8. */
const commentCount = (rng: Rng): number => Math.min(48, Math.floor(-Math.log(1 - rng.next()) * 8.3));

export function buildWorld(seed: number): World {
  const root = createRng(seed * 7919 + 17);
  const users = makeUsers(root.fork("users"));
  const labels = makeLabels(root.fork("labels"));
  const labelByName = new Map(labels.map((l) => [l.name, l]));
  // Popularity: a few users write most of the issues and comments (Zipf-like). Authors, commenters and
  // assignees each get their own seeded order, so "the most active user" differs between those roles.
  const zipf = (label: string): number[] => root.fork(label).shuffle(users.map((_, i) => 1 / (i + 1) ** 0.8));
  const authorW = zipf("weights:author");
  const commentW = zipf("weights:comment");
  const assigneeW = zipf("weights:assignee");
  const codenames = root.fork("milestones").shuffle(CODENAMES);
  const usedTitles = new Set<string>();
  let commentId = 1_000_000 + root.fork("ids").int(0, 100_000);
  const repos = new Map<RepoName, Repo>();

  REPOS.forEach((name, r) => {
    const rng = root.fork(`repo:${name}`);
    const milestones = makeMilestones(rng, codenames.slice(r * 4, r * 4 + 4));
    const n = rng.int(450, 550);
    const issues: Issue[] = [];
    const comments = new Map<number, Comment[]>();
    const regulars = rng.shuffle(users).slice(0, 8);
    for (let number = 1; number <= n; number++) {
      const author = rng.weighted(users, authorW);
      const created = between(rng, START, NOW - 5 * 86_400_000);
      const open = rng.chance(0.55);
      const closed = open ? null : between(rng, created + 3_600_000, NOW - 86_400_000);
      const updated = between(rng, closed ?? created + 60_000, NOW);
      let issueLabels = LABEL_P.filter(([, p]) => rng.chance(p)).map(([l]) => labelByName.get(l) as Label);
      if (issueLabels.length === 0 && rng.chance(0.85)) issueLabels = [labelByName.get(rng.pick(LABEL_P)[0]) as Label];
      const hot = HOT_ISSUES[name] === number;
      const count = hot ? (name === "acme/cli" ? rng.int(120, 170) : rng.int(55, 80)) : commentCount(rng);
      const list: Comment[] = [];
      let t = created;
      for (let c = 0; c < count; c++) {
        t = between(rng, t + 1000, Math.max(t + 2000, Math.min(NOW, updated + 1000)));
        const who = hot && name === "acme/cli" && rng.chance(0.7) ? rng.pick(regulars) : rng.weighted(users, commentW);
        list.push({
          id: commentId++,
          user: who,
          body: rng.pick(COMMENT_BODIES),
          created_at: iso(t),
          author_association: who === author ? "OWNER" : rng.pick(["MEMBER", "CONTRIBUTOR", "NONE"] as const),
        });
      }
      comments.set(number, list);
      const issue: Issue = {
        number,
        title: makeTitle(rng, usedTitles),
        state: open ? "open" : "closed",
        user: author,
        labels: issueLabels,
        comments: count,
        created_at: iso(created),
        updated_at: iso(Math.max(updated, t)),
        closed_at: closed === null ? null : iso(closed),
        milestone: rng.chance(0.5) ? rng.pick(milestones) : null,
        body: `${rng.pick(COMMENT_BODIES)} Steps: ${rng.int(1, 9)}. Version ${rng.int(1, 4)}.${rng.int(0, 20)}.`,
      };
      if (rng.chance(0.55)) issue.assignee = rng.weighted(users, assigneeW);
      issues.push(issue);
    }
    const prs: PullRequest[] = [];
    for (let i = 0, count = rng.int(30, 45); i < count; i++) {
      const state = rng.chance(0.4) ? "open" : "closed";
      const created = between(rng, START, NOW);
      prs.push({
        number: n + 1 + i,
        title: `Fix: ${makeTitle(rng, usedTitles).toLowerCase()}`,
        state,
        draft: state === "open" && rng.chance(0.25),
        user: rng.weighted(users, authorW),
        head: { ref: `fix/${rng.int(100, 999)}-${rng.pick(NOUN)}`, sha: rng.int(0, 0xfffffff).toString(16).padStart(7, "0") },
        base: { ref: rng.chance(0.85) ? "main" : "release" },
        requested_reviewers: rng.shuffle(users).slice(0, rng.int(0, 3)),
        merged_at: state === "closed" && rng.chance(0.7) ? iso(between(rng, created, NOW)) : null,
        created_at: iso(created),
      });
    }
    repos.set(name, { name, issues, comments, milestones, prs });
  });

  return { seed, users, bot: { login: "bench-bot", id: 1 }, labels, repos, nextCommentId: commentId };
}

/** Issues are listed newest first, like GitHub. */
export const newestFirst = (a: Issue, b: Issue): number => b.number - a.number;
