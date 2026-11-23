// The "no harm" check of the plain-MCP test (Amendment 3, not gating): 3 simple tasks on the pinned
// @modelcontextprotocol/server-everything 1.0.0. The answers follow from the server's code (echo returns
// "Echo: <message>", get-sum the sum, get-structured-content fixed weather per city). Graded with the
// existing grader (no writes expected).
import type { Task } from "../grade.js";
import type { FakeSolver } from "./clients.js";

export const EVERYTHING_TASKS: Task[] = [
  {
    id: "ev-echo",
    category: "control",
    prompt: "Call the echo tool with the message typegen-no-harm-7. Reply with the exact text it returned.",
    answer_type: "string",
    answer: "Echo: typegen-no-harm-7",
  },
  {
    id: "ev-sum",
    category: "control",
    prompt: "Use the get-sum tool to add 1234.5 and 4321.25. Reply with the number it returned.",
    answer_type: "number",
    answer: 5555.75,
  },
  {
    id: "ev-weather",
    category: "control",
    prompt: "Use the get-structured-content tool to get the weather for Chicago. What is the humidity? Reply with the number.",
    answer_type: "number",
    answer: 82,
  },
];

/** Scripted solvers for the fake client. */
export const EVERYTHING_SOLVERS: Record<string, FakeSolver> = {
  "ev-echo": async (call) => String(await call("echo", { message: "typegen-no-harm-7" })),
  "ev-sum": async (call) => String(/is (-?\d+(?:\.\d+)?)/.exec(String(await call("get-sum", { a: 1234.5, b: 4321.25 })))?.[1]),
  "ev-weather": async (call) => String(((await call("get-structured-content", { location: "Chicago" })) as { humidity: number }).humidity),
};
