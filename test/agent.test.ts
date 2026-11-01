import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runAgent, scriptedModel, type Model, type ModelOutput } from "../src/agent.js";
import { DurableRun, StepFailedError } from "../src/durable.js";
import { formatReport, runEvals } from "../src/evals.js";
import { Journal } from "../src/journal.js";
import { ToolRegistry, calculatorTool } from "../src/tools.js";

const noSleep = async () => {};

/** Registry whose "charge" tool has a visible side effect, so double execution would be detectable. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  const charges: string[] = [];
  const tools = new ToolRegistry({ workdir: dir }).register(calculatorTool).register({
    name: "charge",
    description: "Charge a customer",
    params: { customer: "string" },
    run: (args) => {
      charges.push(args.customer as string);
      return `charged ${args.customer}`;
    },
  });
  return { dir, tools, charges, journalPath: join(dir, "run.jsonl") };
}

const script: ModelOutput[] = [
  { kind: "tool_call", tool: "charge", args: { customer: "acme" } },
  { kind: "tool_call", tool: "calculator", args: { expression: "40 + 2" } },
  { kind: "tool_call", tool: "charge", args: { customer: "globex" } },
  { kind: "final", text: "done: 42" },
];

describe("runAgent", () => {
  it("completes a multi-step task and counts model and tool calls", async () => {
    const { tools } = setup();
    const result = await runAgent({
      run: new DurableRun(new Journal(null)), model: scriptedModel(script), tools, task: "go",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.answer, "done: 42");
    assert.equal(result.modelCalls, 4);
    assert.equal(result.toolCalls, 3);
  });

  it("feeds tool errors back to the model so it can recover", async () => {
    const { tools } = setup();
    const model: Model = {
      next(messages) {
        const last = messages.at(-1)!;
        if (last.role === "user") return { kind: "tool_call", tool: "calculator", args: { expression: "1 / 0" } };
        if (last.content.startsWith("ERROR")) return { kind: "final", text: "that is undefined" };
        return { kind: "final", text: "unexpected" };
      },
    };
    const result = await runAgent({ run: new DurableRun(new Journal(null)), model, tools, task: "divide" });
    assert.equal(result.answer, "that is undefined");
    assert.match(result.messages[2]!.content, /division by zero/);
  });

  it("stops after maxSteps instead of looping forever", async () => {
    const { tools } = setup();
    const model: Model = { next: () => ({ kind: "tool_call", tool: "calculator", args: { expression: "1" } }) };
    const result = await runAgent({
      run: new DurableRun(new Journal(null)), model, tools, task: "loop", maxSteps: 3,
    });
    assert.equal(result.status, "max_steps_exceeded");
    assert.equal(result.toolCalls, 3);
  });
});

describe("crash and resume", () => {
  it("resumes from the journal without repeating side effects", async () => {
    const { tools, charges, journalPath } = setup();
    const healthy = scriptedModel(script);
    const crashAtTurn = 2;
    const crashing: Model = {
      next(messages) {
        if (messages.filter((m) => m.role === "assistant").length >= crashAtTurn) throw new Error("process died");
        return healthy.next(messages);
      },
    };
    const opts = { retry: { maxAttempts: 2 }, sleep: noSleep };

    const run1 = new DurableRun(new Journal(journalPath), opts);
    await assert.rejects(
      runAgent({ run: run1, model: crashing, tools, task: "bill" }),
      (err: unknown) => err instanceof StepFailedError && err.stepId === "model:2",
    );
    assert.deepEqual(charges, ["acme"]);                           // first charge happened once

    const run2 = new DurableRun(new Journal(journalPath), opts);
    const result = await runAgent({ run: run2, model: healthy, tools, task: "bill" });
    assert.equal(result.answer, "done: 42");
    assert.deepEqual(charges, ["acme", "globex"]);                 // acme was NOT charged again
    assert.equal(run2.stats.replayed, 4);                          // model:0 tool:0 model:1 tool:1
    assert.equal(run2.stats.executed, 3);                          // model:2 tool:2 model:3
  });

  it("retries a flaky model call and still completes in one run", async () => {
    const { tools } = setup();
    let failures = 1;
    const healthy = scriptedModel([{ kind: "final", text: "ok" }]);
    const flaky: Model = {
      next(messages) {
        if (failures-- > 0) throw new Error("503 from model API");
        return healthy.next(messages);
      },
    };
    const run = new DurableRun(new Journal(null), { retry: { maxAttempts: 3 }, sleep: noSleep });
    const result = await runAgent({ run, model: flaky, tools, task: "hi" });
    assert.equal(result.answer, "ok");
    assert.equal(run.stats.retries, 1);
  });
});

describe("evals", () => {
  it("reports passes, failures and thrown errors per case", async () => {
    const { tools } = setup();
    const report = await runEvals(
      [
        { name: "passes", task: "t", model: () => scriptedModel([{ kind: "final", text: "yes" }]), check: (r) => r.answer === "yes" },
        { name: "fails check", task: "t", model: () => scriptedModel([{ kind: "final", text: "no" }]), check: (r) => r.answer === "yes" },
        { name: "model throws", task: "t", model: () => scriptedModel([]), check: () => true },
      ],
      () => tools,
    );
    assert.equal(report.passed, 1);
    assert.equal(report.total, 3);
    assert.equal(report.outcomes[2]!.passed, false);
    assert.match(report.outcomes[2]!.error ?? "", /script exhausted/);
    assert.match(formatReport(report), /1\/3 eval cases passed/);
  });
});
