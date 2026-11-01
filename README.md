# Durable Agent Runner (TypeScript)

A small runtime for **AI agents that survive crashes**. Every model call and every tool call is a
journaled step: if the process dies halfway through a task, re-running it resumes from the log
instead of starting over, and side effects (charging a customer, sending an email) are **not repeated**.

It is a learning/portfolio project that explores the core ideas behind durable execution for agents:
resumable workflows, retries, sandboxed tools and evaluations. It has no runtime dependencies.

> **Scope:** tests and demos use a deterministic *scripted* model. The `Model` interface is where a
> real LLM API would plug in; no model API is called by this repo. The journal is a local JSONL file,
> so this is single-process, not a distributed system.

## How it works
```
runAgent(task)
  loop:
    step("model:i")  ->  Model.next(messages)        journaled, retried with backoff
    step("tool:i")   ->  ToolRegistry.call(...)      journaled, validated, time-limited
```
- **Journal** (`src/journal.ts`): append-only JSONL log of completed steps. A torn last line from a crash mid-write is ignored on reload.
- **DurableRun** (`src/durable.ts`): `step(id, fn, input)` returns the journaled result if it exists, otherwise runs `fn` with exponential-backoff retries. Replaying a step with *different* input throws `NonDeterminismError`; duplicate step ids in one run are rejected.
- **Tools** (`src/tools.ts`): argument validation, per-call timeout, output size cap. Errors that are the model's fault (bad args, blocked path, timeout) are returned to the model so it can recover; unexpected exceptions propagate and are retried.
- **Sandbox**: `read_file` is jailed to a working directory (blocks `../`, absolute paths and symlink escapes). The `calculator` tool uses a hand-written parser, never `eval`.
- **Agent loop** (`src/agent.ts`): step limit, message history, pluggable `Model`.
- **Evals** (`src/evals.ts`): run cases and report pass/fail with model calls, tool calls and latency.

## Run it
Requires Node 22+.
```bash
npm install
npm test               # compiles and runs 24 tests
npm run demo           # eval harness
npm run demo:resume    # crash and resume
```

### Crash and resume demo
```
run 1 crashed at "model:2" after {"executed":4,"replayed":0,"retries":1}
run 2 resumed: {"executed":1,"replayed":4,"retries":0}  answer="Total cost: 26"
```
Run 2 skipped the four steps already in the journal and executed only the remaining one.

### Eval demo
```
PASS  reads file then calculates         model=3 tools=2 3ms
PASS  recovers from blocked path         model=2 tools=1 1ms
PASS  stops at step limit                model=4 tools=4 1ms

3/3 eval cases passed
```

## Use your own model
```ts
import { DurableRun, Journal, ToolRegistry, calculatorTool, runAgent, type Model } from "./src/index.js";

const model: Model = {
  async next(messages) {
    // call your LLM API here and map its reply to:
    //   { kind: "tool_call", tool, args }  or  { kind: "final", text }
  },
};
```
A model must be a pure function of `messages` (no hidden counters), because journaled model calls are skipped on replay.

## Project structure
```
src/journal.ts    append-only step log
src/durable.ts    DurableRun: replay, retries, determinism checks
src/tools.ts      tool registry, sandboxed read_file, safe calculator
src/agent.ts      agent loop and scripted model
src/evals.ts      eval harness
src/cli.ts        demos
test/             24 tests (node:test)
```

## Ideas to extend
- Add an adapter for a real model API and run evals against it
- Store the journal in SQLite or Postgres, with a lease so only one worker owns a run
- Run tools in a subprocess or container instead of in-process
- Add a tool for HTTP requests with an allow-list

## Author
**Saranpaulraj V** - [GitHub](https://github.com/SaranLm) · [LinkedIn](https://www.linkedin.com/in/saranpaulraj-v-7a6296258)
