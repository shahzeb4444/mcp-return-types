#!/usr/bin/env node
// Clean public export: copies the publishable files of this repo into ../mcp-return-types-export (outside the
// repo) and makes one fresh git commit there, with no history and no remote. Then it runs
// scripts/scan-sensitive.mjs on the export and fails if any hit is unaccepted.
//
//   node scripts/export-clean.mjs [--out <dir>]
//
// The file list is what git would publish: tracked files plus untracked files that are not git-ignored
// (so node_modules, dist, .typegen, bench/.env, bench/results/raw and bench/results/dry-run never get in),
// minus the internal-only files in EXCLUDE below. The commit author is this repo's own git user config.
// The script never pushes and never adds a remote.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Internal-only paths (repo-relative, forward slashes), with the reason each stays out. */
export const EXCLUDE = [
  { re: /^node_modules\//, why: "dependencies (npm ci installs them)" },
  { re: /^dist\//, why: "build output (npm run build makes it)" },
  { re: /^bench\/results\/plain-mcp-smoke[^/]*\//, why: "untracked smoke runs, not part of the reported results" },
  { re: /^NOTES\.md$/, why: "agent working notes (dev log, model-call counts, internal decisions)" },
  { re: /^PROGRESS\.md$/, why: "agent milestone checklist and session log" },
  { re: /^AGENTS\.md$/, why: "rulebook for the owner's Claude Code/Codex development loop" },
  { re: /^CLAUDE\.md$/, why: "Claude Code project instructions for the owner's development loop" },
  { re: /^\.claude\//, why: "Claude Code permission settings for the owner's development loop" },
  { re: /^run-loop\.(ps1|sh)$/, why: "the owner's agent loop scripts" },
  { re: /^prompts\//, why: "session prompts for the owner's agent loop" },
  { re: /^SETUP\.md$/, why: "one-time setup of the owner's laptop for the agent loop" },
  { re: /^LAUNCH-POST\.md$/, why: "draft social-media post, not project documentation" },
  { re: /^\.agent-lock$/, why: "agent session lock" },
  { re: /(^|\/)\.env(\.(?!example$)[^/]*)?$/, why: "environment files (the .env.example template is kept)" },
];

const excluded = (rel) => EXCLUDE.find((e) => e.re.test(rel));

function run(cmd, argv, cwd, { quiet = false } = {}) {
  const r = spawn.sync(cmd, argv, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    if (!quiet) process.stderr.write(r.stderr ?? "");
    throw new Error(`${cmd} ${argv.join(" ")} failed (exit ${r.status})`);
  }
  return r.stdout;
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const out = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(repo, "..", "mcp-return-types-export"));
  const relToRepo = path.relative(repo, out);
  if (!relToRepo.startsWith("..") && !path.isAbsolute(relToRepo)) throw new Error(`export folder must be outside the repo: ${out}`);

  // Only ever delete a folder this script made before.
  const marker = path.join(out, ".git", "EXPORT_CLEAN");
  if (fs.existsSync(out)) {
    if (!fs.existsSync(marker)) throw new Error(`${out} exists and was not made by this script; move it away first`);
    fs.rmSync(out, { recursive: true, force: true });
  }

  const listed = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], repo).split("\0").filter(Boolean);
  const files = [];
  const skipped = new Map();
  for (const rel of [...new Set(listed)].sort()) {
    const ex = excluded(rel);
    if (ex) {
      skipped.set(ex.why, (skipped.get(ex.why) ?? 0) + 1);
      continue;
    }
    const abs = path.join(repo, ...rel.split("/"));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue; // deleted in the working tree
    files.push(rel);
  }
  for (const must of ["LICENSE", "README.md", "package.json", "package-lock.json", ".gitignore"])
    if (!files.includes(must)) throw new Error(`required file missing from export: ${must}`);

  for (const rel of files) {
    const dst = path.join(out, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(repo, ...rel.split("/")), dst);
  }

  const name = run("git", ["config", "user.name"], repo).trim();
  const email = run("git", ["config", "user.email"], repo).trim();
  if (!name || !email) throw new Error("git user.name / user.email are not set in this repo");
  const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;

  run("git", ["init", "-q", "-b", "main"], out);
  fs.writeFileSync(marker, "made by scripts/export-clean.mjs\n");
  run("git", ["add", "--all"], out);
  const msg = `mcp-return-types v${version}\n\nClean export of the development repository, without its history.\nSee REDACTIONS.md.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n`;
  const msgFile = path.join(out, ".git", "EXPORT_MSG");
  fs.writeFileSync(msgFile, msg);
  run("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "--file", msgFile], out);
  fs.rmSync(msgFile);

  const committed = run("git", ["ls-files"], out).split("\n").filter(Boolean).length;
  const head = run("git", ["rev-parse", "--short", "HEAD"], out).trim();
  const commits = run("git", ["rev-list", "--count", "HEAD"], out).trim();
  const remotes = run("git", ["remote"], out).trim();
  const status = run("git", ["status", "--porcelain"], out).trim();
  console.log(`export: ${out}`);
  console.log(`files copied: ${files.length}, files in commit: ${committed}, commits: ${commits}, HEAD ${head}`);
  console.log(`author: ${name} (email from git config, not printed); remotes: ${remotes || "none"}; status: ${status ? "DIRTY" : "clean"}`);
  console.log("left out:");
  for (const [why, n] of skipped) console.log(`  ${n} file(s): ${why}`);
  if (committed !== files.length || commits !== "1" || remotes || status) throw new Error("export check failed");

  console.log("\nscanning the export ...");
  const scan = spawn.sync(process.execPath, [path.join(repo, "scripts", "scan-sensitive.mjs"), out, "--history"], {
    stdio: "inherit",
  });
  if (scan.status !== 0) throw new Error("scan of the export found unaccepted hits");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`export-clean: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
