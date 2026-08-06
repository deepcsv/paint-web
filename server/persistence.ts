import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeSnapshotName } from "./sanitize.js";

// Resolve relative to cwd so both dev and prod work consistently
const DATA_DIR = resolve(process.cwd(), "data");

let stateWriteScheduled = false;
let pendingStateJson = "";

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

/** Schedule metadata write (debounced). Safe to call rapidly. */
export function scheduleStateWrite(stateJson: string): void {
  pendingStateJson = stateJson;
  if (stateWriteScheduled) return;
  stateWriteScheduled = true;
  setTimeout(async () => {
    stateWriteScheduled = false;
    try {
      await ensureDataDir();
      await writeFile(join(DATA_DIR, "state.json"), pendingStateJson, "utf8");
    } catch (err) {
      console.error("[persistence] state.json write failed:", err);
    }
  }, 500);
}

export async function loadState(): Promise<unknown | null> {
  try {
    const text = await readFile(join(DATA_DIR, "state.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function saveSnapshotPng(name: string, png: Buffer): Promise<{ path: string; size: number }> {
  await ensureDataDir();
  const safe = sanitizeSnapshotName(name);
  const path = join(DATA_DIR, `${safe}.png`);
  await writeFile(path, png);
  return { path, size: png.byteLength };
}

export async function loadSnapshotPng(name: string): Promise<Buffer | null> {
  try {
    const safe = sanitizeSnapshotName(name);
    return await readFile(join(DATA_DIR, `${safe}.png`));
  } catch {
    return null;
  }
}

export async function listSnapshots(): Promise<string[]> {
  try {
    const files = await readdir(DATA_DIR);
    return files
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

export async function deleteSnapshot(name: string): Promise<boolean> {
  try {
    const safe = sanitizeSnapshotName(name);
    await unlink(join(DATA_DIR, `${safe}.png`));
    return true;
  } catch {
    return false;
  }
}
