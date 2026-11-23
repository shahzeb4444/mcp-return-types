import spawn from "cross-spawn";
import path from "node:path";
import { ROOT } from "./helpers.js";

const TSC = path.join(ROOT, "node_modules", "typescript", "lib", "tsc.js");

/** Run `tsc --noEmit --strict` on files in `cwd`. No tsconfig is read, so the repo's settings do not leak in. */
export function compileTs(cwd: string, files: string[]): { ok: boolean; output: string } {
  const r = spawn.sync(
    process.execPath,
    [TSC, "--noEmit", "--strict", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", ...files],
    { cwd, encoding: "utf8" },
  );
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
