import { createHash } from "node:crypto";
import { Journal } from "./journal.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export class StepFailedError extends Error {
  constructor(readonly stepId: string, readonly attempts: number, readonly causeError: unknown) {
    super(`step "${stepId}" failed after ${attempts} attempt(s): ${String(causeError)}`);
    this.name = "StepFailedError";
  }
}

/** Raised when a replayed step is called with different input than when it was journaled. */
export class NonDeterminismError extends Error {
  constructor(readonly stepId: string) {
    super(`step "${stepId}" was replayed with different input than the journaled run`);
    this.name = "NonDeterminismError";
  }
}

export interface RunStats {
  executed: number;
  replayed: number;
  retries: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 16);
}

/**
 * Durable-execution core. Workflow code calls `step(id, fn)`:
 *  - if the journal already holds a result for `id`, it is returned without running `fn` (replay);
 *  - otherwise `fn` runs with exponential-backoff retries and the result is journaled.
 * Re-running the same workflow function against the same journal therefore resumes where it stopped.
 */
export class DurableRun {
  readonly stats: RunStats = { executed: 0, replayed: 0, retries: 0 };
  private readonly seen = new Set<string>();
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly journal: Journal,
    opts: { retry?: Partial<RetryPolicy>; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.retry = { maxAttempts: 3, baseDelayMs: 100, ...opts.retry };
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async step<T>(stepId: string, fn: () => Promise<T> | T, input?: unknown): Promise<T> {
    if (this.seen.has(stepId)) {
      throw new Error(`duplicate step id "${stepId}" in one run; step ids must be unique`);
    }
    this.seen.add(stepId);

    const inputHash = hashInput(input);
    const prior = this.journal.get(stepId);
    if (prior) {
      if (prior.inputHash !== undefined && prior.inputHash !== inputHash) {
        throw new NonDeterminismError(stepId);
      }
      this.stats.replayed++;
      return prior.value as T;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const value = await fn();
        this.journal.record({
          stepId, status: "ok", attempt, inputHash, value: value ?? null, ts: Date.now(),
        });
        this.stats.executed++;
        return value;
      } catch (err) {
        this.journal.record({
          stepId, status: "failed", attempt, inputHash, error: String(err), ts: Date.now(),
        });
        if (attempt >= this.retry.maxAttempts) throw new StepFailedError(stepId, attempt, err);
        this.stats.retries++;
        await this.sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}
