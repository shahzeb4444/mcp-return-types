// The per-run write log of the mock server. Every write call (real or distractor) is appended as one
// JSON line, also failed ones. A duplicate is a successful write whose normalized key was already seen
// in the same run (writes are idempotent in state, so duplicates are visible only here).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export interface WriteEntry {
  seq: number;
  tool: string;
  /** Arguments as the client sent them. */
  args: Record<string, unknown>;
  /** Normalized identity of the write: tool + the arguments that define its effect. */
  key: string;
  ok: boolean;
  /** For successful writes: whether the state changed (false = idempotent repeat or no-op). */
  changed?: boolean;
  error?: string;
}

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
};

/** Normalize the arguments that define a write's effect (e.g. number "12" and 12 are the same issue). */
export function writeKey(tool: string, args: Record<string, unknown>): string {
  const num = (v: unknown): unknown => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);
  switch (tool) {
    case "add_label":
      return JSON.stringify([tool, args.repo, num(args.number), args.label]);
    case "assign":
      return JSON.stringify([tool, args.repo, num(args.number), args.assignee]);
    case "post_comment":
      return JSON.stringify([tool, args.repo, num(args.number), args.body]);
    default:
      return JSON.stringify([tool, canonical(args)]);
  }
}

export class WriteLog {
  readonly entries: WriteEntry[] = [];

  /** `file`, when given, is truncated now (fresh state per run) and then appended to synchronously. */
  constructor(private readonly file?: string) {
    if (file) writeFileSync(file, "");
  }

  add(entry: Omit<WriteEntry, "seq" | "key">): WriteEntry {
    const full: WriteEntry = { seq: this.entries.length + 1, key: writeKey(entry.tool, entry.args), ...entry };
    this.entries.push(full);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(full)}\n`);
    return full;
  }
}

export function readWriteLog(file: string): WriteEntry[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as WriteEntry);
}

/** Successful writes whose key was already seen earlier in the same log. */
export function duplicateWrites(entries: WriteEntry[]): WriteEntry[] {
  const seen = new Set<string>();
  const dups: WriteEntry[] = [];
  for (const e of entries) {
    if (!e.ok) continue;
    if (seen.has(e.key)) dups.push(e);
    else seen.add(e.key);
  }
  return dups;
}
