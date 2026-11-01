import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Errors that are the model's fault (bad args, blocked path, timeout). They are reported back to the model, not retried. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolContext {
  workdir: string;
}

export interface Tool {
  name: string;
  description: string;
  params: Record<string, "string" | "number">;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

const MAX_OUTPUT_CHARS = 10_000;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly ctx: ToolContext,
    private readonly timeoutMs = 2_000,
  ) {}

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  list(): { name: string; description: string }[] {
    return [...this.tools.values()].map(({ name, description }) => ({ name, description }));
  }

  /** Validates args, runs the tool with a timeout and output cap. Unexpected exceptions propagate so the caller can retry. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool "${name}"` };

    for (const key of Object.keys(args)) {
      if (!(key in tool.params)) return { ok: false, error: `unexpected argument "${key}"` };
    }
    for (const [key, type] of Object.entries(tool.params)) {
      if (typeof args[key] !== type) return { ok: false, error: `argument "${key}" must be a ${type}` };
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(`timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
      });
      const output = await Promise.race([Promise.resolve(tool.run(args, this.ctx)), timeout]);
      const text = output.length > MAX_OUTPUT_CHARS ? output.slice(0, MAX_OUTPUT_CHARS) + "\n[truncated]" : output;
      return { ok: true, output: text };
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Resolves `userPath` inside `workdir`, rejecting traversal and symlink escapes. */
export function resolveInside(workdir: string, userPath: string): string {
  if (isAbsolute(userPath)) throw new ToolError("absolute paths are not allowed");
  const root = realpathSync(workdir);
  const target = resolve(root, userPath);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new ToolError(`file not found: ${userPath}`);
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("path escapes the sandbox directory");
  return real;
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the sandbox directory",
  params: { path: "string" },
  run(args, ctx) {
    const file = resolveInside(ctx.workdir, args.path as string);
    if (!statSync(file).isFile()) throw new ToolError("not a regular file");
    return readFileSync(file, "utf8");
  },
};

/** Safe arithmetic evaluator (recursive descent). Never uses eval(). Supports + - * / parentheses and unary minus. */
export function evaluate(expression: string): number {
  const tokens = expression.match(/\d+\.?\d*|\.\d+|[-+*/()]|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary(): number {
    const tok = next();
    if (tok === undefined) throw new ToolError("unexpected end of expression");
    if (tok === "(") {
      const value = additive();
      if (next() !== ")") throw new ToolError("missing closing parenthesis");
      return value;
    }
    if (tok === "-") return -primary();
    if (tok === "+") return primary();
    if (/^(\d+\.?\d*|\.\d+)$/.test(tok)) return Number(tok);
    throw new ToolError(`unexpected token "${tok}"`);
  }
  function multiplicative(): number {
    let value = primary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const rhs = primary();
      if (op === "/" && rhs === 0) throw new ToolError("division by zero");
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }
  function additive(): number {
    let value = multiplicative();
    while (peek() === "+" || peek() === "-") {
      value = next() === "+" ? value + multiplicative() : value - multiplicative();
    }
    return value;
  }

  const result = additive();
  if (pos < tokens.length) throw new ToolError(`unexpected token "${tokens[pos]}"`);
  return result;
}

export const calculatorTool: Tool = {
  name: "calculator",
  description: "Evaluate an arithmetic expression such as (2 + 3) * 4",
  params: { expression: "string" },
  run: (args) => String(evaluate(args.expression as string)),
};
