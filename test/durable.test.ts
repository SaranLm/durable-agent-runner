import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DurableRun, NonDeterminismError, StepFailedError } from "../src/durable.js";
import { Journal } from "../src/journal.js";

const noSleep = async () => {};
const tmpJournal = () => join(mkdtempSync(join(tmpdir(), "journal-")), "run.jsonl");

describe("DurableRun", () => {
  it("replays journaled steps without re-running them", async () => {
    const path = tmpJournal();
    let calls = 0;
    const work = async (run: DurableRun) => run.step("a", () => ++calls);

    assert.equal(await work(new DurableRun(new Journal(path))), 1);
    const second = new DurableRun(new Journal(path));
    assert.equal(await work(second), 1);          // cached value
    assert.equal(calls, 1);                        // fn not called again
    assert.deepEqual(second.stats, { executed: 0, replayed: 1, retries: 0 });
  });

  it("retries a transient failure with backoff and then succeeds", async () => {
    const delays: number[] = [];
    const run = new DurableRun(new Journal(null), {
      retry: { maxAttempts: 3, baseDelayMs: 10 },
      sleep: async (ms) => void delays.push(ms),
    });
    let attempts = 0;
    const value = await run.step("flaky", () => {
      if (++attempts < 3) throw new Error("boom");
      return "ok";
    });
    assert.equal(value, "ok");
    assert.deepEqual(delays, [10, 20]);            // exponential backoff
    assert.equal(run.stats.retries, 2);
  });

  it("throws StepFailedError after max attempts and journals each failure", async () => {
    const journal = new Journal(null);
    const run = new DurableRun(journal, { retry: { maxAttempts: 2 }, sleep: noSleep });
    await assert.rejects(
      run.step("bad", () => { throw new Error("nope"); }),
      (err: unknown) => err instanceof StepFailedError && err.attempts === 2,
    );
    assert.equal(journal.failedAttempts, 2);
    assert.equal(journal.get("bad"), undefined);   // failed steps are not treated as complete
  });

  it("detects non-deterministic replay when the input changed", async () => {
    const path = tmpJournal();
    await new DurableRun(new Journal(path)).step("s", () => 1, { q: "a" });
    await assert.rejects(
      new DurableRun(new Journal(path)).step("s", () => 1, { q: "b" }),
      NonDeterminismError,
    );
  });

  it("rejects duplicate step ids within one run", async () => {
    const run = new DurableRun(new Journal(null));
    await run.step("x", () => 1);
    await assert.rejects(run.step("x", () => 2), /duplicate step id/);
  });

  it("stores undefined results as null so they survive a reload", async () => {
    const path = tmpJournal();
    await new DurableRun(new Journal(path)).step("void", () => undefined);
    assert.equal(new Journal(path).get("void")?.value, null);
  });
});

describe("Journal", () => {
  it("ignores a torn final line left by a crash mid-write", async () => {
    const path = tmpJournal();
    await new DurableRun(new Journal(path)).step("a", () => 42);
    appendFileSync(path, '{"stepId":"b","status":"ok","att');   // partial write
    const reloaded = new Journal(path);
    assert.equal(reloaded.get("a")?.value, 42);
    assert.equal(reloaded.get("b"), undefined);
    assert.equal(reloaded.skippedLines, 1);
  });

  it("starts empty for a missing or blank file", () => {
    const path = tmpJournal();
    writeFileSync(path, "\n\n");
    assert.equal(new Journal(path).completedCount, 0);
  });
});
