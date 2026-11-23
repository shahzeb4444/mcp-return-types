// Writes bench/tasks/<id>.json (seed-2 answers from the oracles) and bench/tasks/pilot.json.
//   npm run bench:tasks
// test/bench.tasks.test.ts fails when the committed files differ from what this would write.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "../grade.js";
import { buildWorld } from "../mock-server/data.js";
import { PILOT_IDS, TASKS, type TaskDef } from "./defs.js";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_SEED = 2;

export function taskJson(def: TaskDef, seed = EVAL_SEED): Task {
  const { answer, writes } = def.oracle(buildWorld(seed));
  const task: Task = { id: def.id, category: def.category, prompt: def.prompt, answer_type: def.answer_type };
  if (answer !== undefined) task.answer = answer;
  if (writes !== undefined) task.expected_state = { writes };
  return task;
}

export const pilotJson = (): { description: string; tasks: string[] } => ({
  description: "Fixed pilot subset (BENCHMARK.md): 5 nested/optional, 4 pagination, 2 writes, 1 control.",
  tasks: PILOT_IDS,
});

export const serialize = (x: unknown): string => `${JSON.stringify(x, null, 2)}\n`;

function isEntryPoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  for (const def of TASKS) writeFileSync(path.join(DIR, `${def.id}.json`), serialize(taskJson(def)));
  writeFileSync(path.join(DIR, "pilot.json"), serialize(pilotJson()));
  console.log(`wrote ${TASKS.length} tasks and pilot.json to ${DIR}`);
}
