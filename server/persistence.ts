import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeSnapshotName } from "./sanitize.js";

// Resolve relative to cwd so both dev and prod work consistently
const DATA_DIR = resolve(process.cwd(), "data");

const STATE_FILE = join(DATA_DIR, "state.json");
const DOCUMENT_FILE = join(DATA_DIR, "document.json");

let stateWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStateJson = "";
let documentWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDocumentJson = "";
let writeChain = Promise.resolve();

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await ensureDataDir();
  const tmp = `${path}.tmp`;
  const backup = `${path}.bak`;
  try {
    await copyFile(path, backup);
  } catch {
    // First write has no previous file to preserve.
  }
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

function enqueueAtomicWrite(path: string, text: string, label: string): void {
  writeChain = writeChain
    .then(() => atomicWrite(path, text))
    .catch((err) => console.error(`[persistence] ${label} write failed:`, err));
}

/** Schedule legacy metadata write (debounced and atomic). */
export function scheduleStateWrite(stateJson: string): void {
  pendingStateJson = stateJson;
  if (stateWriteTimer) return;
  stateWriteTimer = setTimeout(() => {
    stateWriteTimer = null;
    enqueueAtomicWrite(STATE_FILE, pendingStateJson, "state.json");
  }, 500);
}

/** Schedule canonical document write (debounced and atomic). */
export function scheduleDocumentWrite(documentJson: string): void {
  pendingDocumentJson = documentJson;
  if (documentWriteTimer) return;
  documentWriteTimer = setTimeout(() => {
    documentWriteTimer = null;
    enqueueAtomicWrite(DOCUMENT_FILE, pendingDocumentJson, "document.json");
  }, 100);
}

async function loadJsonWithBackup(path: string): Promise<unknown | null> {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      const text = await readFile(candidate, "utf8");
      return JSON.parse(text);
    } catch {
      // Try the backup, then report no persisted value.
    }
  }
  return null;
}

export async function loadState(): Promise<unknown | null> {
  return loadJsonWithBackup(STATE_FILE);
}

export async function loadDocument(): Promise<unknown | null> {
  return loadJsonWithBackup(DOCUMENT_FILE);
}

/** Flush scheduled state/document writes before a graceful shutdown or test. */
export async function flushPersistence(): Promise<void> {
  if (stateWriteTimer) {
    clearTimeout(stateWriteTimer);
    stateWriteTimer = null;
    enqueueAtomicWrite(STATE_FILE, pendingStateJson, "state.json");
  }
  if (documentWriteTimer) {
    clearTimeout(documentWriteTimer);
    documentWriteTimer = null;
    enqueueAtomicWrite(DOCUMENT_FILE, pendingDocumentJson, "document.json");
  }
  await writeChain;
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
