import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolError, ToolRegistry, calculatorTool, evaluate, readFileTool } from "../src/tools.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-"));
  const workdir = join(root, "work");
  mkdirSync(workdir);
  writeFileSync(join(workdir, "hello.txt"), "hi there");
  writeFileSync(join(root, "secret.txt"), "TOP SECRET");
  const registry = new ToolRegistry({ workdir }, 100).register(readFileTool).register(calculatorTool);
  return { root, workdir, registry };
}

describe("ToolRegistry validation", () => {
  it("reports unknown tools, missing args, wrong types and extra args to the model", async () => {
    const { registry } = sandbox();
    assert.deepEqual(await registry.call("nope", {}), { ok: false, error: 'unknown tool "nope"' });
    assert.match((await registry.call("read_file", {}) as { error: string }).error, /must be a string/);
    assert.match((await registry.call("read_file", { path: 5 }) as { error: string }).error, /must be a string/);
    assert.match((await registry.call("read_file", { path: "a", extra: 1 }) as { error: string }).error, /unexpected argument/);
  });

  it("times out slow tools", async () => {
    const { registry } = sandbox();
    registry.register({
      name: "slow", description: "", params: {},
      run: () => new Promise<string>((r) => setTimeout(() => r("late"), 500)),
    });
    const result = await registry.call("slow", {});
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /timed out/);
  });

  it("truncates very large output", async () => {
    const { registry } = sandbox();
    registry.register({ name: "big", description: "", params: {}, run: () => "x".repeat(50_000) });
    const result = await registry.call("big", {});
    assert.ok(result.ok && result.output.length < 10_100 && result.output.endsWith("[truncated]"));
  });

  it("lets unexpected exceptions propagate so the step can be retried", async () => {
    const { registry } = sandbox();
    registry.register({ name: "crash", description: "", params: {}, run: () => { throw new Error("db down"); } });
    await assert.rejects(registry.call("crash", {}), /db down/);
  });
});

describe("read_file sandbox", () => {
  it("reads files inside the working directory", async () => {
    const { registry } = sandbox();
    assert.deepEqual(await registry.call("read_file", { path: "hello.txt" }), { ok: true, output: "hi there" });
  });

  it("blocks ../ traversal, absolute paths and missing files", async () => {
    const { registry } = sandbox();
    const traversal = await registry.call("read_file", { path: "../secret.txt" });
    assert.match((traversal as { error: string }).error, /escapes the sandbox/);
    const absolute = await registry.call("read_file", { path: "/etc/passwd" });
    assert.match((absolute as { error: string }).error, /absolute paths/);
    const missing = await registry.call("read_file", { path: "ghost.txt" });
    assert.match((missing as { error: string }).error, /file not found/);
  });

  it("blocks a symlink that points outside the sandbox", async () => {
    const { root, workdir, registry } = sandbox();
    symlinkSync(join(root, "secret.txt"), join(workdir, "link.txt"));
    const result = await registry.call("read_file", { path: "link.txt" });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /escapes the sandbox/);
  });
});

describe("calculator", () => {
  it("respects precedence, parentheses, decimals and unary minus", () => {
    assert.equal(evaluate("2 + 3 * 4"), 14);
    assert.equal(evaluate("(2 + 3) * 4"), 20);
    assert.equal(evaluate("-3 + 10 / 4"), -0.5);
    assert.equal(evaluate("1.5 * 2"), 3);
    assert.equal(evaluate("--4"), 4);
  });

  it("rejects malformed input and division by zero", () => {
    for (const bad of ["", "2 +", "(1 + 2", "1 2", "5 / 0", "2 ** 3"]) {
      assert.throws(() => evaluate(bad), ToolError, `expected "${bad}" to be rejected`);
    }
  });

  it("never executes code: injection attempts are rejected as tokens", async () => {
    const { registry } = sandbox();
    for (const payload of ["process.exit(1)", "1; require('fs')", "constructor.constructor('return 1')()"]) {
      const result = await registry.call("calculator", { expression: payload });
      assert.equal(result.ok, false, payload);
    }
  });
});
