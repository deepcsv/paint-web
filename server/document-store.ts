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
  /** LRU ordering stamp (monotonic). */
  seq?: number;
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

type ReplayOptions = {
  compactActiveLayers?: boolean;
};

/**
 * Build a blank, native-operation replay containing only layers that survive
 * in the target state. This is safe when every surviving layer has an
 * auditable layer.create in the commit chain and no later raster/global layer
 * mutation makes those creates insufficient as a reconstruction boundary.
 */
function compactActiveLayerReplay(
  state: ServerStateSnapshot,
  operations: DocumentOperation[],
): Pick<DocumentReplaySnapshot, "baseState" | "baseRaster" | "operations"> | null {
  const liveLayers = state.layers;
  const liveIds = new Set(liveLayers.map((layer) => layer.id));
  const lastCreateIndex = new Map<string, number>();

  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    const layerId = (operation.params as { layerId?: unknown } | undefined)?.layerId;
    if (operation.method === "layer.create" && typeof layerId === "string" && liveIds.has(layerId)) {
      lastCreateIndex.set(layerId, index);
    }
  }

  if (liveLayers.length === 0 || liveLayers.some((layer) => !lastCreateIndex.has(layer.id))) {
    return null;
  }

  const replayStart = Math.min(...lastCreateIndex.values());
  const baseLayerId = [...lastCreateIndex.entries()].find(([, index]) => index === replayStart)?.[0];
  const baseLayer = structuredClone(liveLayers.find((layer) => layer.id === baseLayerId)!);
  const created = new Set<string>([baseLayer.id]);
  const compacted: DocumentOperation[] = [];

  for (let index = replayStart; index < operations.length; index++) {
    const operation = operations[index]!;
    const params = (operation.params ?? {}) as Record<string, unknown>;
    const method = operation.method;

    if (
      method === "snapshot.load"
      || method === "canvas.import"
      || method === "layer.merge"
      || method === "layer.flatten"
      || method === "canvas.resize"
    ) {
      return null;
    }

    if (method === "layer.create") {
      const layerId = typeof params.layerId === "string" ? params.layerId : null;
      if (!layerId || !liveIds.has(layerId) || lastCreateIndex.get(layerId) !== index) continue;
      if (layerId === baseLayer.id) continue;
      created.add(layerId);
      compacted.push(structuredClone(operation));
      continue;
    }

    if (method === "layer.reorder") {
      const layerIds = Array.isArray(params.layerIds)
        ? params.layerIds.filter((layerId): layerId is string => typeof layerId === "string" && created.has(layerId))
        : [];
      if (layerIds.length !== created.size || new Set(layerIds).size !== created.size) return null;
      compacted.push({
        ...structuredClone(operation),
        params: { ...structuredClone(params), layerIds },
      });
      continue;
    }

    const layerId = typeof params.layerId === "string" ? params.layerId : null;
    if (layerId) {
      if (!liveIds.has(layerId)) continue;
      const createIndex = lastCreateIndex.get(layerId)!;
      if (index < createIndex || !created.has(layerId)) continue;
      if (method === "layer.delete") return null;
      compacted.push(structuredClone(operation));
      continue;
    }

    if (method === "canvas.clear" || method === "canvas.fill") {
      compacted.push(structuredClone(operation));
      continue;
    }

    // Native drawing and layer/filter mutations are expected to identify a
    // target layer. An unfamiliar target-less operation makes compaction
    // ambiguous, so fall back to the complete historical replay.
    if (method.startsWith("draw.") || method.startsWith("filter.") || method.startsWith("layer.")) {
      return null;
    }
  }

  if (compacted.length >= operations.length) return null;
  return {
    baseState: {
      width: state.width,
      height: state.height,
      layers: [baseLayer],
      activeLayerId: baseLayer.id,
    },
    baseRaster: [],
    operations: compacted,
  };
}

/**
 * Versioned canonical artwork document.
 *
 * Every commit stores an immutable structural snapshot plus deterministic
 * operations. Pixel baselines are captured once, before the first P0 edit,
 * so browser reconnects and branch restores can rebuild the exact document.
 */
/**
 * Memory policy (long agent sessions): replay only ever needs the most recent
 * raster keyframe on a root→commit path — older keyframes are a pure undo-depth
 * optimization, so they are pruned to MAX_RASTER_KEYFRAMES newest. The
 * idempotency map is an LRU capped at MAX_IDEMPOTENCY_RECORDS.
 */
export const MAX_RASTER_KEYFRAMES = 4;
export const MAX_IDEMPOTENCY_RECORDS = 512;

export class DocumentStore {
  private data: PersistedDocumentStore;
  private idempotencySeq = 0;

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

    this.data = this.constructRoot(initialState);
    return;
  }

  private constructRoot(initialState: ServerStateSnapshot): PersistedDocumentStore {
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
    return {
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

  /**
   * Replace the store with a brand-new document (fresh id, single root
   * commit, no raster keyframes / idempotency / redo history). The caller is
   * responsible for restoring ServerState and replaying the blank snapshot
   * to the primary renderer.
   */
  reset(initialState: ServerStateSnapshot): void {
    const persisted = this.constructRoot(initialState);
    this.data = persisted;
    this.idempotencySeq = 0;
    this.touch();
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
      seq: ++this.idempotencySeq,
    };
    this.pruneIdempotency();
    this.touch();
    return result;
  }

  getReplaySnapshot(
    commitId = this.currentCommitId,
    options: ReplayOptions = {},
  ): DocumentReplaySnapshot {
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
    const compacted = options.compactActiveLayers
      ? compactActiveLayerReplay(commit.state, operations)
      : null;
    return {
      schemaVersion: 1,
      documentId: this.data.documentId,
      title: this.data.title,
      revision: commit.revision,
      commitId: commit.id,
      branch: commit.id === this.currentCommitId ? this.currentBranch : commit.branch,
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt,
      baseState: compacted?.baseState ?? cloneState(baseState),
      state: cloneState(commit.state),
      baseRaster: compacted?.baseRaster ?? structuredClone(baseRaster),
      operations: compacted?.operations ?? operations,
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
    this.pruneRasterKeyframes();
    this.touch();
    return this.summary(commit);
  }

  /**
   * Strip raster payloads from all but the newest MAX_RASTER_KEYFRAMES
   * keyframe-bearing commits. Correctness: buildReplaySnapshot falls back to
   * an older keyframe (or the baseline) and replays forward, so pruned
   * rasters only cost replay time on deep undo, never fidelity.
   */
  private pruneRasterKeyframes(): void {
    const withRaster = Object.values(this.data.commits)
      .filter((c) => c.raster)
      .sort((a, b) => b.revision - a.revision);
    for (const commit of withRaster.slice(MAX_RASTER_KEYFRAMES)) {
      delete commit.raster;
    }
  }

  /** Cap the idempotency LRU: drop oldest entries beyond the limit. */
  private pruneIdempotency(): void {
    const keys = Object.keys(this.data.idempotency);
    if (keys.length <= MAX_IDEMPOTENCY_RECORDS) return;
    const ordered = keys.sort(
      (a, b) => (this.data.idempotency[a].seq ?? 0) - (this.data.idempotency[b].seq ?? 0),
    );
    const excess = ordered.length - MAX_IDEMPOTENCY_RECORDS;
    for (const key of ordered.slice(0, excess)) delete this.data.idempotency[key];
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
