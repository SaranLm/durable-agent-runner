import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, scriptedModel, type Model, type ModelOutput } from "./agent.js";
import { DurableRun, StepFailedError } from "./durable.js";
import { formatReport, runEvals, type EvalCase } from "./evals.js";
import { Journal } from "./journal.js";
import { ToolRegistry, calculatorTool, readFileTool } from "./tools.js";

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-demo-"));
  writeFileSync(join(dir, "prices.txt"), "apples 3\npears 4\n");
  return dir;
}

const makeTools = (workdir: string) => () =>
  new ToolRegistry({ workdir }).register(calculatorTool).register(readFileTool);

const script: ModelOutput[] = [
  { kind: "tool_call", tool: "read_file", args: { path: "prices.txt" } },
  { kind: "tool_call", tool: "calculator", args: { expression: "3 * 2 + 4 * 5" } },
  { kind: "final", text: "Total cost: 26" },
];

async function evalsDemo(): Promise<void> {
  const workdir = makeWorkdir();
  const cases: EvalCase[] = [
    {
      name: "reads file then calculates",
      task: "Buy 2 apples and 5 pears. What is the total?",
      model: () => scriptedModel(script),
      check: (r) => r.status === "completed" && r.answer === "Total cost: 26" && r.toolCalls === 2,
    },
    {
      name: "recovers from blocked path",
      task: "Read the secrets file",
      model: () =>
        scriptedModel([
          { kind: "tool_call", tool: "read_file", args: { path: "../../etc/passwd" } },
          { kind: "final", text: "I could not read that file." },
        ]),
      check: (r) => r.messages.some((m) => m.role === "tool" && m.content.includes("escapes the sandbox")),
    },
    {
      name: "stops at step limit",
      task: "Loop forever",
      model: () => ({ next: () => ({ kind: "tool_call", tool: "calculator", args: { expression: "1+1" } }) }),
      maxSteps: 4,
      check: (r) => r.status === "max_steps_exceeded" && r.toolCalls === 4,
    },
  ];
  console.log(formatReport(await runEvals(cases, makeTools(workdir))));
}

async function resumeDemo(): Promise<void> {
  const workdir = makeWorkdir();
  const journalPath = join(workdir, "run.journal.jsonl");
  const healthy = scriptedModel(script);
  const crashing: Model = {
    next(messages) {
      if (messages.filter((m) => m.role === "assistant").length >= 2) throw new Error("simulated process crash");
      return healthy.next(messages);
    },
  };
  const options = { retry: { maxAttempts: 2, baseDelayMs: 1 } };

  const run1 = new DurableRun(new Journal(journalPath), options);
  try {
    await runAgent({ run: run1, model: crashing, tools: makeTools(workdir)(), task: "total cost?" });
  } catch (err) {
    if (!(err instanceof StepFailedError)) throw err;
    console.log(`run 1 crashed at "${err.stepId}" after ${JSON.stringify(run1.stats)}`);
  }

  const run2 = new DurableRun(new Journal(journalPath), options);
  const result = await runAgent({ run: run2, model: healthy, tools: makeTools(workdir)(), task: "total cost?" });
  console.log(`run 2 resumed: ${JSON.stringify(run2.stats)}  answer="${result.answer}"`);
}

const command = process.argv[2];
if (command === "evals") await evalsDemo();
else if (command === "resume") await resumeDemo();
else console.log("usage: node dist/src/cli.js <evals|resume>");
