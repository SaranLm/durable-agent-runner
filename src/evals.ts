import { runAgent, type AgentResult, type Model } from "./agent.js";
import { DurableRun } from "./durable.js";
import { Journal } from "./journal.js";
import type { ToolRegistry } from "./tools.js";

export interface EvalCase {
  name: string;
  task: string;
  model: () => Model;
  /** Returns true when the agent's result is acceptable. */
  check: (result: AgentResult) => boolean;
  maxSteps?: number;
}

export interface EvalOutcome {
  name: string;
  passed: boolean;
  modelCalls: number;
  toolCalls: number;
  ms: number;
  error?: string;
}

export interface EvalReport {
  passed: number;
  total: number;
  outcomes: EvalOutcome[];
}

/** Runs each case in a fresh in-memory journal and records pass/fail plus cost metrics (calls, latency). */
export async function runEvals(cases: EvalCase[], makeTools: () => ToolRegistry): Promise<EvalReport> {
  const outcomes: EvalOutcome[] = [];
  for (const c of cases) {
    const started = performance.now();
    try {
      const run = new DurableRun(new Journal(null), { retry: { maxAttempts: 1 } });
      const result = await runAgent({
        run, model: c.model(), tools: makeTools(), task: c.task, maxSteps: c.maxSteps,
      });
      outcomes.push({
        name: c.name,
        passed: c.check(result),
        modelCalls: result.modelCalls,
        toolCalls: result.toolCalls,
        ms: Math.round(performance.now() - started),
      });
    } catch (err) {
      outcomes.push({
        name: c.name, passed: false, modelCalls: 0, toolCalls: 0,
        ms: Math.round(performance.now() - started), error: String(err),
      });
    }
  }
  return { passed: outcomes.filter((o) => o.passed).length, total: outcomes.length, outcomes };
}

export function formatReport(report: EvalReport): string {
  const lines = report.outcomes.map(
    (o) =>
      `${o.passed ? "PASS" : "FAIL"}  ${o.name.padEnd(34)} model=${o.modelCalls} tools=${o.toolCalls} ${o.ms}ms` +
      (o.error ? `  (${o.error})` : ""),
  );
  lines.push("", `${report.passed}/${report.total} eval cases passed`);
  return lines.join("\n");
}
