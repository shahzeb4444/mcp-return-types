#!/usr/bin/env node
// Pre-publication scan for secrets and personal data.
//
//   node scripts/scan-sensitive.mjs [dir] [--history]
//
// Scans every text file under <dir> (default: the current directory), skipping .git and node_modules.
// With --history it also scans every commit reachable in <dir>'s git repo: diffs (added and removed lines),
// commit messages, author/committer identities and every file name ever added.
//
// The local identity terms (OS user name, machine name, git user.email) are read at run time and are never
// written to disk or printed: every matched value is printed as its first 4 characters only.
// Exit code: 0 when every hit is accepted, 1 when any hit is unaccepted, 2 on usage error.
// Each accepted hit names its reason; see REDACTIONS.md for the same list in prose.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";

const args = process.argv.slice(2);
const withHistory = args.includes("--history");
const dirArg = args.find((a) => !a.startsWith("--"));
const root = path.resolve(dirArg ?? ".");
if (!fs.existsSync(root)) {
  console.error(`no such directory: ${root}`);
  process.exit(2);
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

function git(argv, cwd = root) {
  const r = spawn.sync("git", argv, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : "";
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- local identity terms (never printed) ------------------------------------------------------------
const identity = [];
const user = os.userInfo().username;
const host = os.hostname();
const gitEmail = (git(["config", "user.email"]) || git(["config", "user.email"], process.cwd())).trim();
const addTerm = (t, kind) => {
  if (t && t.length >= 4 && !identity.some((x) => x.t.toLowerCase() === t.toLowerCase())) identity.push({ t, kind });
};
addTerm(user, "os-user-name");
addTerm(user.replace(/\s+/g, ""), "os-user-name");
for (const part of user.split(/\s+/)) addTerm(part, "os-user-name-part");
const shortName = user.replace(/[\s.]+/g, "").toUpperCase();
if (shortName.length > 8) addTerm(`${shortName.slice(0, 6)}~`, "os-user-8.3-name");
addTerm(host, "machine-name");
if (process.env.COMPUTERNAME) addTerm(process.env.COMPUTERNAME, "machine-name");
addTerm(gitEmail, "git-user-email");
// Generic, all-caps 2-3 letter parts ("Dr") are too short to be meaningful and are skipped by addTerm.

// ---- patterns ------------------------------------------------------------------------------------------
const PATTERNS = [
  { kind: "secret:sk-", re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/g },
  { kind: "secret:ghp_", re: /\bgh[pousr]_[A-Za-z0-9]{10,}/g },
  { kind: "secret:github_pat_", re: /\bgithub_pat_[A-Za-z0-9_]{10,}/g },
  { kind: "secret:bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  { kind: "secret:AKIA", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "secret:private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "secret:slack", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: "secret:google", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: "secret:npm", re: /\bnpm_[A-Za-z0-9]{30,}/g },
  {
    kind: "secret:assignment",
    re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{16,}/gi,
  },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { kind: "abspath:home", re: /(?:\b[A-Za-z]:(?:\\{1,2}|\/)|\/[a-z]\/)(?:Users|Documents and Settings)(?:\\{1,2}|\/)[^\\/"'\s]+/gi },
  { kind: "abspath:home", re: /(?<![A-Za-z0-9.])\/(?:home|Users)\/[A-Za-z0-9._-]+/g },
  { kind: "abspath:temp", re: /AppData(?:\\{1,2}|\/)Local(?:\\{1,2}|\/)Temp|(?<![A-Za-z0-9.])\/tmp\/[A-Za-z0-9._-]+/gi },
  { kind: "abspath:drive", re: /(?:file:\/\/\/)?(?<![A-Za-z0-9\\])[A-Za-z]:(?:\\{1,2}|\/)[A-Za-z][^"'\s`<>|*?]*/g },
  { kind: "abspath:drive", re: /(?<![A-Za-z0-9.:])\/[a-z]\/(?:dev|Users|Program Files)[^"'\s`]*/g },
];
for (const { t, kind } of identity) PATTERNS.push({ kind: `identity:${kind}`, re: new RegExp(escapeRe(t), "gi") });

// ---- accepted hits (each with a reason) ----------------------------------------------------------------
// file: regex on the repo-relative path (forward slashes). value: regex the matched value must satisfy.
const ACCEPT = [
  {
    kind: /^secret:sk-$/,
    file: /^test\/bench\.preflight\.test\.ts$/,
    value: /^sk-(?:ant-)?SECRET-\d+$/,
    reason: "fake key in a unit test that checks the preflight never prints keys",
  },
  {
    kind: /^abspath:(home|drive)$/,
    file: /^test\/infer\.rule11-caps\.test\.ts$/,
    value: /someone/,
    reason: "synthetic path in a unit test fixture (no real user)",
  },
  {
    kind: /^abspath:drive$/,
    file: /^test\/fixtures\//,
    value: /^C:\\tmpcwd$/,
    reason: "synthetic path in a test fixture",
  },
  {
    kind: /^abspath:drive$/,
    file: /./,
    value: /^(?:file:\/\/\/)?C:(?:\\{1,2}|\/)(?:dev(?:\\{1,2}|\/)mcp-(?:typegen|return-types)|Program Files(?:\\{1,2}|\/)nodejs)(?:[\\/][^"'\s`]*)?$|^(?:file:\/\/\/)?C:(?:\\{1,2}|\/)(?:dev|Program)$|^C:\/dev(?:\/mcp-(?:typegen|return-types))?/i,
    reason:
      "repo checkout path (C:\\dev\\mcp-typegen) or the Node.js install path: no user, machine or account name. In raw result files it is recorded harness metadata (serverCommand), kept byte-identical; in docs it is an example path",
  },
  {
    kind: /^abspath:drive$/,
    file: /\.(md|ts|mjs|ps1)$/,
    value: /^[A-Za-z]:(?:\\{1,2}|\/)(?:path|tmp|temp|x|y|foo|repo|work|src|some|my)/i,
    reason: "generic example path in docs or code",
  },
  {
    kind: /^abspath:drive$/,
    file: /^test\//,
    value: /^C:\\{1,2}dev\\{1,2}x\.js$/,
    reason: "example path in a unit test of shell quoting",
  },
  {
    kind: /^email$/,
    file: /^test\//,
    value: /^[a-z]@[a-z]\.(?:co|org)$/,
    reason: "synthetic address in a unit test of the email format rule",
  },
  {
    kind: /^env-file$/,
    file: /^bench\/\.env$/,
    value: /./,
    reason: "history only: the config template committed in the first commit (BENCH_* settings, no keys or tokens) and deleted in the next; the live file is git-ignored and never exported",
  },
  {
    kind: /^email$/,
    file: /./,
    value: /^noreply@anthropic\.com$|@example\.(?:com|org|net)$|^git@github\.com$|^[^@]+@[0-9]+\.[0-9]+\.[0-9]+$/i,
    reason: "non-personal address (commit trailer bot address, example domain, or an npm name@version string)",
  },
];

function accepted(kind, file, value) {
  if (kind === "identity:git-user-email" && (file === "(commit author)" || file === "(commit committer)"))
    return "commit author/committer is the owner's own git user config, kept on purpose";
  if (kind.startsWith("identity:git-user-email") || kind.startsWith("identity:os-") || kind.startsWith("identity:machine"))
    return null; // identity hits are never accepted automatically
  for (const a of ACCEPT) if (a.kind.test(kind) && a.file.test(file) && a.value.test(value)) return a.reason;
  return null;
}

const mask = (v) => `${v.slice(0, 4)}… (${v.length} chars)`;

// ---- collect ------------------------------------------------------------------------------------------
const hits = new Map(); // key -> {scope, file, kind, masked, lines:Set, count, reason}
function record(scope, file, kind, value, where) {
  // an email that is the git user's own address is reported once, as identity
  if (kind === "email" && gitEmail && value.toLowerCase() === gitEmail.toLowerCase()) return;
  const reason = accepted(kind, file, value);
  const key = `${scope}\0${file}\0${kind}\0${value}`;
  let h = hits.get(key);
  if (!h) hits.set(key, (h = { scope, file, kind, masked: mask(value), where: [], count: 0, reason }));
  h.count++;
  if (h.where.length < 6) h.where.push(where);
}

function scanText(scope, file, text, whereOf) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      for (const m of line.matchAll(p.re)) {
        let v = m[0];
        if (p.kind.startsWith("abspath:drive")) v = v.replace(/[),.;:\]]+$/, "");
        record(scope, file, p.kind, v, whereOf(i));
      }
    }
  }
}

const isEnvName = (f) => /(^|\/)\.env(\.[^/]*)?$/i.test(f) && !/\.env\.example$/i.test(f);

let fileCount = 0;
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (ent.isDirectory()) {
      walk(abs);
      continue;
    }
    if (!ent.isFile()) continue;
    fileCount++;
    if (isEnvName(rel)) record("tree", rel, "env-file", ent.name, "file");
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    scanText("tree", rel, buf.toString("utf8"), (i) => `${i + 1}`);
  }
}
walk(root);

let commitCount = 0;
if (withHistory) {
  const ids = git(["rev-list", "--all"]).split(/\s+/).filter(Boolean);
  commitCount = ids.length;
  // identities
  for (const l of git(["log", "--all", "--format=%h%x09%an%x09%ae%x09%cn%x09%ce"]).split("\n").filter(Boolean)) {
    const [h, an, ae, cn, ce] = l.split("\t");
    for (const [label, v] of [["author", `${an} <${ae}>`], ["committer", `${cn} <${ce}>`]])
      scanText("history", `(commit ${label})`, v, () => h);
  }
  // messages
  for (const id of ids) scanText("history", "(commit message)", git(["log", "-1", "--format=%B", id]), () => id.slice(0, 7));
  // every file name ever added
  for (const f of new Set(git(["log", "--all", "--diff-filter=A", "--name-only", "--format="]).split("\n").filter(Boolean)))
    if (isEnvName(f)) record("history", f, "env-file", path.basename(f), "added in history");
  // diffs: only + and - lines
  for (const id of ids) {
    const diff = git(["show", "--no-color", "--format=", "--unified=0", "--no-ext-diff", "--text", id]);
    let file = "?";
    const out = [];
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        const f = line.slice(4).replace(/^[ab]\//, "");
        if (f !== "/dev/null") file = f;
        continue;
      }
      if (line.startsWith("diff --git ")) {
        if (out.length) scanText("history", out.file, out.join("\n"), () => id.slice(0, 7));
        out.length = 0;
        continue;
      }
      if (line[0] === "+" || line[0] === "-") {
        out.file = file;
        out.push(line.slice(1));
      }
    }
    if (out.length) scanText("history", out.file, out.join("\n"), () => id.slice(0, 7));
  }
}

// ---- report -------------------------------------------------------------------------------------------
const all = [...hits.values()].sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0) || a.file.localeCompare(b.file));
const bad = all.filter((h) => !h.reason);
const ok = all.filter((h) => h.reason);
console.log(`scan of ${root}: ${fileCount} files${withHistory ? `, ${commitCount} commits` : ""}`);
console.log(`identity terms checked: ${identity.map((x) => x.kind).join(", ")}`);
console.log(`\nUNACCEPTED hits: ${bad.length}`);
for (const h of bad)
  console.log(`  [${h.scope}] ${h.file}:${h.where.join(",")}${h.count > h.where.length ? ` (+${h.count - h.where.length} more)` : ""}  ${h.kind}  ${h.masked}`);
const byReason = new Map();
for (const h of ok) {
  const r = byReason.get(h.reason) ?? { n: 0, files: new Set(), kinds: new Set() };
  r.n += h.count;
  r.files.add(h.file);
  r.kinds.add(h.kind);
  byReason.set(h.reason, r);
}
console.log(`\naccepted hits: ${ok.reduce((s, h) => s + h.count, 0)} in ${new Set(ok.map((h) => h.file)).size} files`);
for (const [reason, r] of byReason) {
  const files = [...r.files];
  console.log(`  ${r.n} x ${[...r.kinds].join("/")} in ${files.length} file(s), e.g. ${files.slice(0, 3).join(", ")}\n      reason: ${reason}`);
}
if (process.argv.includes("--verbose"))
  for (const h of ok) console.log(`  ok [${h.scope}] ${h.file}:${h.where.join(",")} ${h.kind} ${h.masked}`);
process.exit(bad.length ? 1 : 0);
