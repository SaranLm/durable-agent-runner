import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  stepId: string;
  status: "ok" | "failed";
  attempt: number;
  inputHash?: string;
  value?: unknown;
  error?: string;
  ts: number;
}

/**
 * Append-only JSONL log of step results. This is what makes a run resumable:
 * after a crash we reload it and skip every step that already succeeded.
 * Pass `null` as the path for an in-memory journal (used in tests and evals).
 */
export class Journal {
  private readonly completed = new Map<string, JournalEntry>();
  private readonly failures: JournalEntry[] = [];
  /** Number of unreadable lines skipped while loading (e.g. a torn final write). */
  readonly skippedLines: number = 0;

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      let skipped = 0;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.index(JSON.parse(line) as JournalEntry);
        } catch {
          skipped++; // a crash mid-write can leave a partial last line; ignore it
        }
      }
      this.skippedLines = skipped;
    } else if (path) {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  private index(entry: JournalEntry): void {
    if (entry.status === "ok") this.completed.set(entry.stepId, entry);
    else this.failures.push(entry);
  }

  get(stepId: string): JournalEntry | undefined {
    return this.completed.get(stepId);
  }

  record(entry: JournalEntry): void {
    this.index(entry);
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  get completedCount(): number {
    return this.completed.size;
  }

  get failedAttempts(): number {
    return this.failures.length;
  }
}
