import { createHash, randomUUID } from "node:crypto";
import type {
  DocumentCommitSummary,
  DocumentHistoryResult,
  DocumentOperation,
  DocumentRasterLayer,
  DocumentReplaySnapshot,
  TransactionExecuteResult,
  TransactionOperation,
} from "../shared/protocol.js";
import type { ServerStateSnapshot } from "./state.js";

interface DocumentCommit {
  id: string;
  parentId: string | null;
  branch: string;
  revision: number;
  ts: number;
  clientId: string;
  message: string;
  operations: DocumentOperation[];
  state: ServerStateSnapshot;
  /** Exact raster keyframe for operations that cannot be durably replayed from params alone. */
  raster?: DocumentRasterLayer[];
}

interface IdempotencyRecord {
  fingerprint: string;
  result: TransactionExecuteResult;
}

interface PersistedDocumentStore {
  schemaVersion: 1;
  documentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nextRevision: number;
  currentBranch: string;
  branches: Record<string, string>;
  checkpoints: Record<string, string>;
  redo: Record<string, string[]>;
  rootCommitId: string;
  baseState: ServerStateSnapshot;
  baseRaster: DocumentRasterLayer[];
  baselineCaptured: boolean;
  commits: Record<string, DocumentCommit>;
  idempotency: Record<string, IdempotencyRecord>;
}

export class DocumentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentConflictError";
  }
}

export class DocumentVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentVersionError";
  }
}

export interface UndoPlan {
  fromCommitId: string;
  targetCommitId: string;
  displaced: string[];
}

export interface RedoPlan {
  fromCommitId: string;
  targetCommitId: string;
  consume: number;
}

function cloneState(state: ServerStateSnapshot): ServerStateSnapshot {
  return structuredClone(state);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function transactionFingerprint(operations: TransactionOperation[]): string {
  return sha256(canonicalJson(operations));
}

function normalizeOperation(
  method: string,
  params: unknown,
  result: unknown,
): { method: string; params: unknown; result: unknown }[] {
  if (method === "draw.batch") {
    const batch = params as { operations?: TransactionOperation[] } | undefined;
    const batchResult = result as { results?: unknown[] } | undefined;
    return (batch?.operations ?? []).flatMap((operation, index) => {
      const operationResult = batchResult?.results?.[index];
      if (
        !operationResult ||
        typeof operationResult !== "object" ||
        (operationResult as { ok?: boolean }).ok !== true
      ) {
        return [];
      }
      return [{
        method: operation.method,
        params: operation.params,
        result: operationResult,
      }];
    });
  }

  if (method === "layer.create") {
    const layerId = (result as { layerId?: string } | undefined)?.layerId;
    return [
      {
        method,
        params: { ...((params ?? {}) as object), ...(layerId ? { layerId } : {}) },
        result,
      },
    ];
  }

  if (method === "layer.flatten") {
    const layerId = (result as { id?: string } | undefined)?.id;
    return [{ method, params: layerId ? { layerId } : params, result }];
  }

  return [{ method, params, result }];
}

/**
 * Versioned canonical artwork document.
 *
 * Every commit stores an immutable structural snapshot plus deterministic
 * operations. Pixel baselines are captured once, before the first P0 edit,
 * so browser reconnects and branch restores can rebuild the exact document.
 */
export class DocumentStore {
  private data: PersistedDocumentStore;

  constructor(
    initialState: ServerStateSnapshot,
    private readonly onChange: (json: string) => void = () => {},
    persisted?: unknown,
  ) {
    const loaded = this.parsePersisted(persisted);
    if (loaded) {
      this.data = loaded;
      return;
    }

    const now = Date.now();
    const documentId = "D_" + randomUUID().slice(0, 12);
    const rootPayload = canonicalJson({ documentId, state: initialState });
    const rootCommitId = `C_0_${sha256(rootPayload).slice(0, 12)}`;
    const root: DocumentCommit = {
      id: rootCommitId,
      parentId: null,
      branch: "main",
      revision: 0,
      ts: now,
      clientId: "system",
      message: "Document created",
      operations: [],
      state: cloneState(initialState),
    };
    this.data = {
      schemaVersion: 1,
      documentId,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
      nextRevision: 1,
      currentBranch: "main",
      branches: { main: rootCommitId },
      checkpoints: {},
      redo: { main: [] },
      rootCommitId,
      baseState: cloneState(initialState),
      baseRaster: [],
      baselineCaptured: false,
      commits: { [rootCommitId]: root },
      idempotency: {},
    };
  }

  get documentId(): string {
    return this.data.documentId;
  }

  get currentBranch(): string {
    return this.data.currentBranch;
  }

  get currentCommitId(): string {
    return this.data.branches[this.data.currentBranch]!;
  }

  get revision(): number {
    return this.currentCommit().revision;
  }

  get baselineCaptured(): boolean {
    return this.data.baselineCaptured;
  }

  currentState(): ServerStateSnapshot {
    return cloneState(this.currentCommit().state);
  }

  captureBaseline(layers: DocumentRasterLayer[]): void {
    if (this.data.baselineCaptured) return;
    this.data.baseRaster = this.validateRaster(layers, this.data.baseState, "Baseline");
    this.data.baselineCaptured = true;
    this.touch();
  }

  lookupTransaction(
    idempotencyKey: string,
    fingerprint: string,
  ): TransactionExecuteResult | null {
    const existing = this.data.idempotency[idempotencyKey];
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) {
      throw new DocumentConflictError(
        `Idempotency key '${idempotencyKey}' was already used with different operations`,
      );
    }
    return { ...structuredClone(existing.result), replayed: true };
  }

  recordOperation(
    method: string,
    params: unknown,
    result: unknown,
    state: ServerStateSnapshot,
    clientId: string,
    raster?: DocumentRasterLayer[],
  ): DocumentCommitSummary {
    const normalized = normalizeOperation(method, params, result);
    return this.createCommit(normalized, state, clientId, method, undefined, raster);
  }

  recordTransaction(args: {
    idempotencyKey: string;
    fingerprint: string;
    message: string;
    operations: TransactionOperation[];
    results: unknown[];
    state: ServerStateSnapshot;
    clientId: string;
    raster?: DocumentRasterLayer[];
  }): TransactionExecuteResult {
    const transactionId = `T_${sha256(`${args.idempotencyKey}:${args.fingerprint}`).slice(0, 16)}`;
    const normalized = args.operations.flatMap((operation, index) =>
      normalizeOperation(operation.method, operation.params, args.results[index]),
    );
    const commit = this.createCommit(
      normalized,
      args.state,
      args.clientId,
      args.message,
      transactionId,
      args.raster,
    );
    const result: TransactionExecuteResult = {
      transactionId,
      commitId: commit.id,
      revision: commit.revision,
      replayed: false,
      results: structuredClone(args.results),
    };
    this.data.idempotency[args.idempotencyKey] = {
      fingerprint: args.fingerprint,
      result: structuredClone(result),
    };
    this.touch();
    return result;
  }

  getReplaySnapshot(commitId = this.currentCommitId): DocumentReplaySnapshot {
    const commit = this.getCommit(commitId);
    const chain: DocumentCommit[] = [];
    let cursor: DocumentCommit | null = commit;
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parentId ? this.getCommit(cursor.parentId) : null;
    }
    chain.reverse();
    let baseState = this.data.baseState;
    let baseRaster = this.data.baseRaster;
    let operationStart = 0;
    for (let index = chain.length - 1; index >= 0; index--) {
      const keyframe = chain[index];
      if (!keyframe?.raster) continue;
      baseState = keyframe.state;
      baseRaster = keyframe.raster;
      operationStart = index + 1;
      break;
    }
    const operations = chain
      .slice(operationStart)
      .flatMap((item) => structuredClone(item.operations));
    return {
      schemaVersion: 1,
      documentId: this.data.documentId,
      title: this.data.title,
      revision: commit.revision,
      commitId: commit.id,
      branch: commit.id === this.currentCommitId ? this.currentBranch : commit.branch,
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt,
      baseState: cloneState(baseState),
      state: cloneState(commit.state),
      baseRaster: structuredClone(baseRaster),
      operations,
      replayable: this.data.baselineCaptured,
    };
  }

  history(limit = 100): DocumentHistoryResult {
    const commits: DocumentCommitSummary[] = [];
    let cursor: DocumentCommit | null = this.currentCommit();
    while (cursor && commits.length < limit) {
      commits.push(this.summary(cursor));
      cursor = cursor.parentId ? this.getCommit(cursor.parentId) : null;
    }
    return {
      currentCommitId: this.currentCommitId,
      currentBranch: this.currentBranch,
      canUndo: this.currentCommit().parentId !== null,
      canRedo: (this.data.redo[this.currentBranch] ?? []).length > 0,
      commits,
    };
  }

  historyLength(): { undo: number; redo: number; total: number } {
    let undo = 0;
    let cursor = this.currentCommit();
    while (cursor.parentId) {
      undo += 1;
      cursor = this.getCommit(cursor.parentId);
    }
    const redo = (this.data.redo[this.currentBranch] ?? []).length;
    return { undo, redo, total: undo + redo };
  }

  planUndo(steps: number): UndoPlan {
    const fromCommitId = this.currentCommitId;
    const displaced: string[] = [];
    let cursor = this.currentCommit();
    for (let index = 0; index < steps; index++) {
      if (!cursor.parentId) break;
      displaced.push(cursor.id);
      cursor = this.getCommit(cursor.parentId);
    }
    if (cursor.id === fromCommitId) throw new DocumentVersionError("Nothing to undo");
    return { fromCommitId, targetCommitId: cursor.id, displaced };
  }

  applyUndo(plan: UndoPlan): void {
    if (this.currentCommitId !== plan.fromCommitId) {
      throw new DocumentConflictError("Document changed while undo was being prepared");
    }
    this.data.branches[this.currentBranch] = plan.targetCommitId;
    const stack = (this.data.redo[this.currentBranch] ??= []);
    stack.push(...plan.displaced);
    this.touch();
  }

  planRedo(steps: number): RedoPlan {
    const stack = this.data.redo[this.currentBranch] ?? [];
    if (stack.length === 0) throw new DocumentVersionError("Nothing to redo");
    const consume = Math.min(steps, stack.length);
    const targetCommitId = stack[stack.length - consume]!;
    return { fromCommitId: this.currentCommitId, targetCommitId, consume };
  }

  applyRedo(plan: RedoPlan): void {
    if (this.currentCommitId !== plan.fromCommitId) {
      throw new DocumentConflictError("Document changed while redo was being prepared");
    }
    this.data.redo[this.currentBranch]!.splice(-plan.consume, plan.consume);
    this.data.branches[this.currentBranch] = plan.targetCommitId;
    this.touch();
  }

  createBranch(name: string): DocumentCommitSummary {
    if (this.data.branches[name]) throw new DocumentConflictError(`Branch already exists: ${name}`);
    this.data.branches[name] = this.currentCommitId;
    this.data.redo[name] = [];
    this.touch();
    return this.summary(this.currentCommit());
  }

  listBranches(): { current: string; branches: { name: string; commitId: string }[] } {
    return {
      current: this.currentBranch,
      branches: Object.entries(this.data.branches)
        .map(([name, commitId]) => ({ name, commitId }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  branchTarget(name: string): string {
    const target = this.data.branches[name];
    if (!target) throw new DocumentVersionError(`Branch not found: ${name}`);
    return target;
  }

  applyBranchSwitch(name: string): void {
    this.branchTarget(name);
    this.data.currentBranch = name;
    this.touch();
  }

  createCheckpoint(name: string): DocumentCommitSummary {
    this.data.checkpoints[name] = this.currentCommitId;
    this.touch();
    return this.summary(this.currentCommit());
  }

  listCheckpoints(): { checkpoints: { name: string; commitId: string; revision: number }[] } {
    return {
      checkpoints: Object.entries(this.data.checkpoints)
        .map(([name, commitId]) => ({
          name,
          commitId,
          revision: this.getCommit(commitId).revision,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  checkpointTarget(name: string): string {
    const target = this.data.checkpoints[name];
    if (!target) throw new DocumentVersionError(`Checkpoint not found: ${name}`);
    return target;
  }

  applyCheckpointRestore(commitId: string): void {
    this.getCommit(commitId);
    const current = this.currentCommitId;
    this.data.branches[this.currentBranch] = commitId;
    if (current !== commitId) (this.data.redo[this.currentBranch] ??= []).push(current);
    this.touch();
  }

  restoreResult(commitId = this.currentCommitId): {
    commitId: string;
    revision: number;
    branch: string;
  } {
    const commit = this.getCommit(commitId);
    return { commitId: commit.id, revision: commit.revision, branch: this.currentBranch };
  }

  serialize(): string {
    return JSON.stringify(this.data);
  }

  private createCommit(
    normalized: { method: string; params: unknown; result: unknown }[],
    state: ServerStateSnapshot,
    clientId: string,
    message: string,
    transactionId?: string,
    raster?: DocumentRasterLayer[],
  ): DocumentCommitSummary {
    const validatedRaster = raster ? this.validateRaster(raster, state, "Keyframe") : undefined;
    const revision = this.data.nextRevision++;
    const ts = Date.now();
    const operations: DocumentOperation[] = normalized.map((operation, index) => ({
      id: `O_${revision}_${index + 1}`,
      method: operation.method,
      params: structuredClone(operation.params),
      result: structuredClone(operation.result),
      clientId,
      ts,
      ...(transactionId ? { transactionId } : {}),
    }));
    const parentId = this.currentCommitId;
    const payload = canonicalJson({ parentId, revision, operations, state });
    const id = `C_${revision}_${sha256(payload).slice(0, 12)}`;
    const commit: DocumentCommit = {
      id,
      parentId,
      branch: this.currentBranch,
      revision,
      ts,
      clientId,
      message,
      operations,
      state: cloneState(state),
      ...(validatedRaster ? { raster: validatedRaster } : {}),
    };
    this.data.commits[id] = commit;
    this.data.branches[this.currentBranch] = id;
    this.data.redo[this.currentBranch] = [];
    this.touch();
    return this.summary(commit);
  }

  private currentCommit(): DocumentCommit {
    return this.getCommit(this.currentCommitId);
  }

  private getCommit(id: string): DocumentCommit {
    const commit = this.data.commits[id];
    if (!commit) throw new DocumentVersionError(`Commit not found: ${id}`);
    return commit;
  }

  private summary(commit: DocumentCommit): DocumentCommitSummary {
    return {
      id: commit.id,
      parentId: commit.parentId,
      branch: commit.branch,
      revision: commit.revision,
      ts: commit.ts,
      clientId: commit.clientId,
      message: commit.message,
      operationCount: commit.operations.length,
    };
  }

  private validateRaster(
    layers: DocumentRasterLayer[],
    state: ServerStateSnapshot,
    label: string,
  ): DocumentRasterLayer[] {
    const expected = new Set(state.layers.map((layer) => layer.id));
    const captured = new Set(layers.map((layer) => layer.id));
    if (
      captured.size !== layers.length ||
      captured.size !== expected.size ||
      [...expected].some((id) => !captured.has(id))
    ) {
      throw new DocumentConflictError(
        `${label} layer mismatch: expected ${expected.size}, captured ${captured.size}`,
      );
    }
    return structuredClone(layers);
  }

  private touch(): void {
    this.data.updatedAt = Date.now();
    this.onChange(this.serialize());
  }

  private parsePersisted(value: unknown): PersistedDocumentStore | null {
    if (!value || typeof value !== "object") return null;
    const data = value as Partial<PersistedDocumentStore>;
    if (
      data.schemaVersion !== 1 ||
      typeof data.documentId !== "string" ||
      typeof data.currentBranch !== "string" ||
      !data.branches ||
      !data.commits ||
      !data.rootCommitId ||
      !data.baseState ||
      !data.branches[data.currentBranch]
    ) {
      return null;
    }
    return structuredClone(data as PersistedDocumentStore);
  }
}
