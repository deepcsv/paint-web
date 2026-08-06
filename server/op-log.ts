import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const OPS_FILE = resolve(DATA_DIR, "ops.jsonl");

export interface OpEntry {
  /** Monotonic 1-based step number. */
  step: number;
  /** Wall clock when the op was executed. */
  ts: number;
  /** Originating client. */
  clientId: string;
  /** RPC method name (e.g. "draw.rect"). */
  method: string;
  /** RPC params (post zod validation). */
  params: unknown;
  /** Result returned by the handler (undefined for void). */
  result: unknown;
}

/**
 * OpLog — append-only log of every mutating RPC. Used for:
 *  - inspection (agent queries "what happened so far")
 *  - replay (agent rebuilds state at any past step)
 *  - audit (persisted to disk)
 *
 * Non-mutating RPCs (canvas.getInfo, layer.list, history.getLength, export,
 * getRegion, subscribe, sync.*) are NOT logged.
 */
export class OpLog {
  private ops: OpEntry[] = [];
  private writeScheduled = false;
  private pendingAppend: string[] = [];

  constructor() {
    // Best-effort load of any persisted log on startup
    this.loadFromDisk().catch((err) => {
      console.warn("[op-log] failed to load ops.jsonl:", err);
    });
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const text = await readFile(OPS_FILE, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as OpEntry;
          this.ops.push(obj);
        } catch {
          // skip corrupt lines
        }
      }
      if (this.ops.length > 0) {
        console.log(`[op-log] loaded ${this.ops.length} ops from disk`);
      }
    } catch {
      // no file yet — fine
    }
  }

  /** Append an op to the in-memory log and schedule disk persistence. */
  append(op: Omit<OpEntry, "step" | "ts">): OpEntry {
    const entry: OpEntry = {
      step: this.ops.length + 1,
      ts: Date.now(),
      ...op,
    };
    this.ops.push(entry);
    this.pendingAppend.push(JSON.stringify(entry));
    this.scheduleFlush();
    return entry;
  }

  list(filter?: { sinceStep?: number; methodPrefix?: string; limit?: number }): OpEntry[] {
    let result = this.ops;
    if (filter?.sinceStep !== undefined) {
      result = result.filter((o) => o.step >= filter.sinceStep!);
    }
    if (filter?.methodPrefix) {
      result = result.filter((o) => o.method.startsWith(filter.methodPrefix!));
    }
    if (filter?.limit !== undefined) {
      result = result.slice(-filter.limit);
    }
    return result;
  }

  /** Current step count (= highest step number assigned). */
  getStep(): number {
    return this.ops.length;
  }

  /** Get a specific step's op, or null. */
  getAt(step: number): OpEntry | null {
    return this.ops[step - 1] ?? null;
  }

  /** Clear both in-memory and on-disk log. */
  async clear(): Promise<void> {
    this.ops = [];
    this.pendingAppend = [];
    try {
      await unlink(OPS_FILE);
    } catch {
      // file may not exist
    }
  }

  private scheduleFlush(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    setTimeout(async () => {
      this.writeScheduled = false;
      const batch = this.pendingAppend;
      this.pendingAppend = [];
      if (batch.length === 0) return;
      try {
        await mkdir(DATA_DIR, { recursive: true });
        const text = batch.map((l) => l + "\n").join("");
        await appendFile(OPS_FILE, text, "utf8");
      } catch (err) {
        console.error("[op-log] flush failed:", err);
        // Put unflushed entries back at the front
        this.pendingAppend.unshift(...batch);
      }
    }, 300);
  }

  /** For testing/debugging: serialize entire log to a JSON string. */
  toJSON(): string {
    return JSON.stringify(this.ops, null, 2);
  }

  /** Replace the entire log file (used by tests). */
  async reset(): Promise<void> {
    await this.clear();
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OPS_FILE, "", "utf8");
  }
}
