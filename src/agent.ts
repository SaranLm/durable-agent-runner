import type { DurableRun } from "./durable.js";
import type { ToolRegistry } from "./tools.js";

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
}

export type ModelOutput =
  | { kind: "tool_call"; tool: string; args: Record<string, unknown> }
  | { kind: "final"; text: string };

/**
 * Anything that turns a conversation into the next action. To be resumable it must be a pure
 * function of `messages` (no hidden counters), because journaled model calls are skipped on replay.
 * Plug a real LLM API in behind this interface.
 */
export interface Model {
  next(messages: readonly Message[]): Promise<ModelOutput> | ModelOutput;
}

export interface AgentResult {
  status: "completed" | "max_steps_exceeded";
  answer: string | null;
  modelCalls: number;
  toolCalls: number;
  messages: Message[];
}

export interface AgentOptions {
  run: DurableRun;
  model: Model;
  tools: ToolRegistry;
  task: string;
  maxSteps?: number;
}

/** Agent loop where every model call and tool call is a durable, individually retried step. */
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { run, model, tools, task, maxSteps = 10 } = opts;
  const messages: Message[] = [{ role: "user", content: task }];
  let modelCalls = 0;
  let toolCalls = 0;

  for (let i = 0; i < maxSteps; i++) {
    const snapshot = messages.map((m) => ({ ...m }));
    const output = await run.step(`model:${i}`, () => model.next(snapshot), snapshot);
    modelCalls++;

    if (output.kind === "final") {
      messages.push({ role: "assistant", content: output.text });
      return { status: "completed", answer: output.text, modelCalls, toolCalls, messages };
    }

    messages.push({ role: "assistant", content: JSON.stringify({ tool: output.tool, args: output.args }) });
    const result = await run.step(`tool:${i}`, () => tools.call(output.tool, output.args), {
      tool: output.tool,
      args: output.args,
    });
    toolCalls++;
    messages.push({
      role: "tool",
      content: result.ok ? result.output : `ERROR: ${result.error}`,
    });
  }

  return { status: "max_steps_exceeded", answer: null, modelCalls, toolCalls, messages };
}

/** Deterministic model for tests, evals and demos: replies with scripted[number of assistant turns so far]. */
export function scriptedModel(script: ModelOutput[]): Model {
  return {
    next(messages) {
      const turn = messages.filter((m) => m.role === "assistant").length;
      const out = script[turn];
      if (!out) throw new Error(`script exhausted at turn ${turn}`);
      return out;
    },
  };
}
