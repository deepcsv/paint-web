import { randomUUID } from "node:crypto";
import type { Router } from "../rpc/router.js";
import { StateInvariantError, type ServerState } from "../state.js";
import type { EventBus } from "../event-bus.js";
import type { PrimaryClient } from "../primary-client.js";
import type {
  BlendMode,
  CanvasExportResult,
  DocumentRasterLayer,
  LayerId,
} from "../../shared/protocol.js";
import type { registerTempSnapshot as RegisterTempSnapshot } from "../http-server.js";
import type { saveSnapshotPng as SaveSnapshotPng } from "../persistence.js";
import { RpcError } from "../rpc/errors.js";
import { loadSnapshotPng } from "../persistence.js";
import {
  AssetGetParams,
  AssetListParams,
  AssetPutParams,
  CanvasExportParams,
  CanvasAnalyzeParams,
  CanvasGetRegionParams,
  BrushSelfTestParams,
  CanvasSampleParams,
  JSONRPC_VERSION,
  SnapshotLoadParams,
  SnapshotSaveParams,
  TransactionExecuteParams,
} from "../../shared/protocol.js";
import {
  DocumentConflictError,
  DocumentStore,
  DocumentVersionError,
  transactionFingerprint,
} from "../document-store.js";
import {
  needsRasterKeyframe,
  validateDrawBatchOperations,
  validateTransactionOperations,
} from "../document-operations.js";
import { collectDocumentAssetIds, renderDocumentToSvg } from "../headless-renderer.js";
import {
  AssetNotFoundError,
  AssetStore,
  AssetTooLargeError,
  InvalidAssetError,
} from "../asset-store.js";

export interface HandlerDeps {
  router: Router;
  state: ServerState;
  events: EventBus;
  primary: PrimaryClient;
  opLog: import("../op-log.js").OpLog;
  documentStore: DocumentStore;
  assetStore: AssetStore;
  registerTempSnapshot: typeof RegisterTempSnapshot;
  saveSnapshotPng: typeof SaveSnapshotPng;
}

export function registerHandlers(deps: HandlerDeps): void {
  const {
    router,
    state,
    events,
    primary,
    opLog,
    documentStore,
    assetStore,
    registerTempSnapshot,
    saveSnapshotPng,
  } = deps;

  type PrimaryLayerState = {
    id: string;
    name: string;
    visible: boolean;
    opacity: number;
    blendMode: BlendMode;
    png: string;
  };

  async function capturePrimaryLayers(): Promise<PrimaryLayerState[]> {
    const result = (await primary.exec("canvas.getState", {})) as { layers?: PrimaryLayerState[] };
    return result.layers ?? [];
  }

  async function captureRasterLayers(): Promise<DocumentRasterLayer[]> {
    return (await capturePrimaryLayers()).map(({ id, png }) => ({ id, png }));
  }

  async function ensureDocumentBaseline(): Promise<void> {
    if (documentStore.baselineCaptured) return;
    documentStore.captureBaseline(await captureRasterLayers());
  }

  async function replayCommit(commitId: string): Promise<void> {
    await ensureDocumentBaseline();
    const snapshot = documentStore.getReplaySnapshot(commitId, { compactActiveLayers: true });
    if (!snapshot.replayable) {
      throw RpcError.documentConflict("Document baseline has not been captured");
    }
    const beforeState = state.snapshot();
    const beforeLayers = await capturePrimaryLayers();
    try {
      await primary.exec("document.replay", snapshot);
      state.restore(snapshot.state);
    } catch (error) {
      state.restore(beforeState);
      let rollbackError: unknown;
      try {
        await primary.exec("document.restoreRaster", {
          state: beforeState,
          layers: beforeLayers,
        });
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
      throw RpcError.transactionAborted("Document restore failed and was rolled back", {
        failure: error instanceof Error ? error.message : error,
        ...(rollbackError
          ? {
              rollbackError:
                rollbackError instanceof Error ? rollbackError.message : rollbackError,
            }
          : {}),
      });
    }
  }

  function assertLayerTarget(params: unknown, required = false): void {
    const layerId = (params as { layerId?: string } | undefined)?.layerId;
    if (required && !layerId) throw RpcError.invalidParams("layerId is required");
    if (layerId && !state.getLayer(layerId)) throw RpcError.layerNotFound(layerId);
  }

  async function undoDocument(steps: number) {
    const plan = documentStore.planUndo(steps);
    await replayCommit(plan.targetCommitId);
    documentStore.applyUndo(plan);
    return documentStore.restoreResult();
  }

  async function redoDocument(steps: number) {
    const plan = documentStore.planRedo(steps);
    await replayCommit(plan.targetCommitId);
    documentStore.applyRedo(plan);
    return documentStore.restoreResult();
  }

  function rethrowDocumentError(error: unknown): never {
    if (error instanceof DocumentConflictError) {
      throw RpcError.documentConflict(error.message);
    }
    if (error instanceof DocumentVersionError) {
      throw RpcError.versionNotFound(error.message);
    }
    if (error instanceof StateInvariantError) {
      throw RpcError.invalidParams(error.message);
    }
    throw error;
  }

  function rethrowAssetError(error: unknown): never {
    if (error instanceof AssetNotFoundError) throw RpcError.assetNotFound(error.assetId);
    if (error instanceof AssetTooLargeError) throw RpcError.assetTooLarge(error.message);
    if (error instanceof InvalidAssetError) throw RpcError.invalidAsset(error.message);
    throw error;
  }

  function assertAsset(assetId: string): void {
    try {
      assetStore.get(assetId);
    } catch (error) {
      rethrowAssetError(error);
    }
  }

  // -------------------------------------------------------------------------
  // canvas.* — pixel work goes to primary; metadata stays on server
  // -------------------------------------------------------------------------

  router.register("canvas.getInfo", () => {
    const { undo, redo } = documentStore.historyLength();
    return state.getInfo({ undo, redo });
  });

  router.register("canvas.resize", async (params) => {
    const result = await primary.exec("canvas.resize", params);
    const { width, height } = params as { width: number; height: number };
    try {
      state.resize(width, height);
    } catch (error) {
      rethrowDocumentError(error);
    }
    return result;
  });

  router.register("canvas.clear", (params) => {
    assertLayerTarget(params);
    return primary.exec("canvas.clear", params);
  });
  router.register("canvas.fill", (params) => {
    assertLayerTarget(params);
    return primary.exec("canvas.fill", params);
  });

  router.register("canvas.export", async (params) => {
    const parsed = CanvasExportParams.parse(params);
    assertLayerTarget(parsed);
    const result = (await primary.exec("canvas.export", parsed)) as CanvasExportResult & {
      png?: string;
      width?: number;
      height?: number;
    };
    // If primary returned an inline base64, materialize it as a temp URL.
    if (typeof result.png === "string") {
      const buffer = Buffer.from(result.png, "base64");
      const url = registerTempSnapshot(buffer, parsed.format === "jpeg" ? "image/jpeg" : "image/png");
      return {
        url,
        size: buffer.byteLength,
        expiresAt: Date.now() + 30_000,
      };
    }
    return result;
  });

  router.register("canvas.import", (params) => {
    assertLayerTarget(params);
    const parsed = params as { url?: string; assetId?: string; layerId?: string };
    if (parsed.assetId) assertAsset(parsed.assetId);
    return primary.exec("canvas.import", {
      ...parsed,
      ...(parsed.assetId ? { url: assetStore.url(parsed.assetId) } : {}),
    });
  });

  router.register("canvas.getRegion", async (params) => {
    const parsed = CanvasGetRegionParams.parse(params);
    assertLayerTarget(parsed);
    const result = (await primary.exec("canvas.getRegion", parsed)) as { png?: string };
    if (typeof result.png === "string") {
      const buffer = Buffer.from(result.png, "base64");
      const url = registerTempSnapshot(buffer, "image/png");
      return { url, expiresAt: Date.now() + 30_000 };
    }
    return result;
  });

  router.register("canvas.analyze", (params) => {
    const parsed = CanvasAnalyzeParams.parse(params ?? {});
    assertLayerTarget(parsed);
    return primary.exec("canvas.analyze", parsed);
  });

  router.register("brush.selfTest", (params) => {
    return primary.exec("brush.selfTest", BrushSelfTestParams.parse(params));
  });

  for (const m of ["watercolor.dry", "watercolor.step", "watercolor.setPaper", "watercolor.probe"] as const) {
    router.register(m, (params) => {
      assertLayerTarget(params as { layerId?: LayerId });
      return primary.exec(m, params);
    });
  }

  router.register("canvas.sample", (params) => {
    const parsed = CanvasSampleParams.parse(params);
    assertLayerTarget(parsed);
    for (const point of parsed.points ?? []) {
      if (point.x >= state.width || point.y >= state.height) {
        throw RpcError.outOfBounds(point.x, point.y);
      }
    }
    if (parsed.region) {
      const { x, y, w, h } = parsed.region;
      if (x + w > state.width || y + h > state.height) {
        throw RpcError.outOfBounds(x + w - 1, y + h - 1);
      }
    }
    return primary.exec("canvas.sample", parsed);
  });

  // -------------------------------------------------------------------------
  // layer.* — metadata mutations on server, pixel operations on primary
  // -------------------------------------------------------------------------

  router.register("layer.create", async (params) => {
    const { name, layerId: clientId } = params as { name?: string; layerId?: string };
    const layerId = clientId ?? "L_" + randomUUID().slice(0, 8);
    if (state.getLayer(layerId)) {
      throw RpcError.documentConflict(`Layer id already exists: ${layerId}`);
    }
    const layerName = name ?? `Layer ${state.layers.length + 1}`;
    await primary.exec("layer.create", { layerId, name: layerName });
    try {
      state.createLayer(layerName, layerId);
    } catch (error) {
      rethrowDocumentError(error);
    }
    return { layerId };
  });

  router.register("layer.delete", async (params) => {
    const { layerId } = params as { layerId: LayerId };
    if (!state.getLayer(layerId)) throw RpcError.layerNotFound(layerId);
    if (state.layers.length === 1) {
      throw RpcError.invalidParams("A document must retain at least one layer");
    }
    await primary.exec("layer.delete", { layerId });
    try {
      state.deleteLayer(layerId);
    } catch (error) {
      rethrowDocumentError(error);
    }
    return { ok: true };
  });

  router.register("layer.list", () => ({ layers: state.layers }));

  router.register("layer.setActive", async (params) => {
    const { layerId } = params as { layerId: LayerId };
    if (!state.getLayer(layerId)) throw RpcError.layerNotFound(layerId);
    await primary.exec("layer.setActive", { layerId });
    state.setActive(layerId);
    return { ok: true };
  });

  router.register("layer.setVisible", async (params) => {
    const { layerId, visible } = params as { layerId: LayerId; visible: boolean };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    await primary.exec("layer.setVisible", { layerId, visible });
    layer.visible = visible;
    return { ok: true };
  });

  router.register("layer.setOpacity", async (params) => {
    const { layerId, opacity } = params as { layerId: LayerId; opacity: number };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    await primary.exec("layer.setOpacity", { layerId, opacity });
    layer.opacity = opacity;
    return { ok: true };
  });

  router.register("layer.setBlendMode", async (params) => {
    const { layerId, blendMode } = params as { layerId: LayerId; blendMode: BlendMode };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    await primary.exec("layer.setBlendMode", { layerId, blendMode });
    layer.blendMode = blendMode;
    return { ok: true };
  });

  router.register("layer.rename", async (params) => {
    const { layerId, name } = params as { layerId: LayerId; name: string };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    await primary.exec("layer.rename", { layerId, name });
    layer.name = name;
    return { ok: true };
  });

  router.register("layer.reorder", async (params) => {
    const { layerIds } = params as { layerIds: LayerId[] };
    try {
      const before = state.snapshot();
      state.reorder(layerIds);
      state.restore(before);
    } catch (error) {
      rethrowDocumentError(error);
    }
    await primary.exec("layer.reorder", { layerIds });
    state.reorder(layerIds);
    return { ok: true };
  });

  router.register("layer.merge", async (params) => {
    const { fromId, intoId } = params as { fromId: LayerId; intoId: LayerId };
    if (!state.getLayer(fromId)) throw RpcError.layerNotFound(fromId);
    if (!state.getLayer(intoId)) throw RpcError.layerNotFound(intoId);
    if (fromId === intoId) throw RpcError.invalidParams("Cannot merge a layer into itself");
    await primary.exec("layer.merge", { fromId, intoId });
    state.merge(fromId, intoId);
    return { ok: true };
  });

  router.register("layer.flatten", async (params) => {
    const requestedId = (params as { layerId?: string } | undefined)?.layerId;
    const layerId = requestedId ?? "L_" + randomUUID().slice(0, 8);
    await primary.exec("layer.flatten", { layerId });
    const layer = state.flatten(layerId);
    return { id: layer.id, name: layer.name };
  });

  router.register("layer.transform", (params) => {
    assertLayerTarget(params, true);
    return primary.exec("layer.transform", params);
  });

  // -------------------------------------------------------------------------
  // draw.* — all pixel-level, all proxied to primary
  // -------------------------------------------------------------------------

  const drawMethods = [
    "draw.stroke",
    "draw.line",
    "draw.rect",
    "draw.circle",
    "draw.ellipse",
    "draw.fill",
    "draw.text",
    "draw.setPixel",
    "draw.path",
    "draw.gradient",
    "draw.image",
    "hand.fill",
    "portrait.draw",
  ];
  for (const m of drawMethods) {
    router.register(m, (params) => {
      assertLayerTarget(params, true);
      if (m === "draw.image") {
        assertAsset((params as { assetId: string }).assetId);
      }
      return primary.exec(m, params);
    });
  }

  router.register("draw.batch", async (params) => {
    const raw = (params as { operations: { method: string; params: unknown }[] }).operations;
    const operations = validateDrawBatchOperations(raw);
    // Validate the complete payload before the renderer sees any mutation.
    // The browser executes the validated batch under one history/render guard,
    // avoiding one full-layer undo copy and one WS round-trip per stroke.
    for (const op of operations) {
      assertLayerTarget(op.params, op.method.startsWith("draw."));
      if (op.method === "draw.image") {
        assertAsset((op.params as { assetId: string }).assetId);
      }
    }
    return primary.exec("draw.batch", { operations });
  });

  // -------------------------------------------------------------------------
  // history.* — compatibility aliases over the canonical document history
  // -------------------------------------------------------------------------

  router.register("history.undo", async (params) => {
    try {
      return await undoDocument((params as { steps: number }).steps);
    } catch (error) {
      rethrowDocumentError(error);
    }
  });
  router.register("history.redo", async (params) => {
    try {
      return await redoDocument((params as { steps: number }).steps);
    } catch (error) {
      rethrowDocumentError(error);
    }
  });
  router.register("history.goto", (params) => primary.exec("history.goto", params));
  router.register("history.getLength", () => documentStore.historyLength());
  router.register("history.clear", () => primary.exec("history.clear", {}));

  // -------------------------------------------------------------------------
  // filter.* — pixel work, proxied
  // -------------------------------------------------------------------------

  const filterMethods = [
    "filter.blur",
    "filter.invert",
    "filter.grayscale",
    "filter.brightness",
    "filter.contrast",
  ];
  for (const m of filterMethods) {
    router.register(m, (params) => {
      assertLayerTarget(params);
      return primary.exec(m, params);
    });
  }

  // -------------------------------------------------------------------------
  // snapshot.* — save to disk, load from disk
  // -------------------------------------------------------------------------

  router.register("snapshot.save", async (params) => {
    const { name } = SnapshotSaveParams.parse(params);
    const snap = await primary.snapshot();
    const { path, size } = await saveSnapshotPng(name, snap.png);
    return { id: name, path, size, width: snap.width, height: snap.height };
  });

  router.register("snapshot.load", async (params) => {
    const { name } = SnapshotLoadParams.parse(params);
    const png = await loadSnapshotPng(name);
    if (!png) throw RpcError.invalidParams(`Snapshot '${name}' not found`);
    // Register as a temp URL, ask primary to load it
    const url = registerTempSnapshot(png, "image/png", 60_000);
    await primary.exec("canvas.import", { url });
    return { width: state.width, height: state.height, layers: state.layers.length };
  });

  // -------------------------------------------------------------------------
  // asset.* — immutable, content-addressed P1 raster library
  // -------------------------------------------------------------------------

  router.register("asset.put", async (params) => {
    try {
      return await assetStore.put(AssetPutParams.parse(params));
    } catch (error) {
      rethrowAssetError(error);
    }
  });

  router.register("asset.get", (params) => {
    const { assetId } = AssetGetParams.parse(params);
    try {
      return assetStore.get(assetId);
    } catch (error) {
      rethrowAssetError(error);
    }
  });

  router.register("asset.list", (params) => {
    const { limit } = AssetListParams.parse(params ?? {}) ?? { limit: 100 };
    return { assets: assetStore.list(limit) };
  });

  // -------------------------------------------------------------------------
  // transaction.* — serialized, idempotent, pixel + metadata rollback
  // -------------------------------------------------------------------------

  router.register("transaction.execute", async (params, ctx) => {
    const parsed = TransactionExecuteParams.parse(params);
    const operations = validateTransactionOperations(parsed.operations);
    const fingerprint = transactionFingerprint(operations);
    try {
      const replayed = documentStore.lookupTransaction(parsed.idempotencyKey, fingerprint);
      if (replayed) return replayed;
    } catch (error) {
      rethrowDocumentError(error);
    }

    await ensureDocumentBaseline();
    const beforeState = state.snapshot();
    const beforeLayers = await capturePrimaryLayers();
    const results: unknown[] = [];
    let failedIndex = -1;
    let failure: unknown;

    const rollbackTransaction = async (reason: unknown, index: number): Promise<never> => {
      state.restore(beforeState);
      let rollbackError: unknown;
      try {
        await primary.exec("document.restoreRaster", {
          state: beforeState,
          layers: beforeLayers,
        });
      } catch (error) {
        rollbackError = error;
      }
      throw RpcError.transactionAborted("Atomic transaction rolled back", {
        failedIndex: index,
        failure: reason instanceof Error ? reason.message : reason,
        ...(rollbackError
          ? {
              rollbackError:
                rollbackError instanceof Error ? rollbackError.message : rollbackError,
            }
          : {}),
      });
    };

    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      const response = await router.dispatch(
        {
          jsonrpc: JSONRPC_VERSION,
          id: `transaction:${parsed.idempotencyKey}:${index}`,
          method: operation.method,
          params: operation.params,
        },
        ctx,
      );
      if (!response || response.error) {
        failedIndex = index;
        failure = response?.error ?? { message: "Mutation returned no response" };
        break;
      }
      results.push(response.result ?? null);
    }

    if (failedIndex >= 0) {
      return rollbackTransaction(failure, failedIndex);
    }

    try {
      const raster = operations.some((operation) =>
        needsRasterKeyframe(operation.method, operation.params),
      )
        ? await captureRasterLayers()
        : undefined;
      return documentStore.recordTransaction({
        idempotencyKey: parsed.idempotencyKey,
        fingerprint,
        message: parsed.message,
        operations,
        results,
        state: state.snapshot(),
        clientId: ctx.clientId,
        raster,
      });
    } catch (error) {
      return rollbackTransaction(error, operations.length);
    }
  });

  // -------------------------------------------------------------------------
  // doc.* — canonical versions, checkpoints and branches
  // -------------------------------------------------------------------------

  router.register("doc.get", (params) => {
    const options = params as {
      commitId?: string;
      compactActiveLayers?: boolean;
    } | undefined;
    try {
      return documentStore.getReplaySnapshot(options?.commitId, {
        compactActiveLayers: options?.compactActiveLayers === true,
      });
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.history", (params) => {
    const limit = (params as { limit?: number } | undefined)?.limit ?? 100;
    return documentStore.history(limit);
  });

  router.register("doc.undo", async (params) => {
    const steps = (params as { steps: number }).steps;
    try {
      return await undoDocument(steps);
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.redo", async (params) => {
    const steps = (params as { steps: number }).steps;
    try {
      return await redoDocument(steps);
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.new", async (params) => {
    const { width, height } = params as { width?: number; height?: number };
    try {
      // Fresh single-layer snapshot at the requested (or current) size.
      const fresh = state.snapshot();
      const layer = {
        id: "L_" + randomUUID().slice(0, 8),
        name: "Layer 1",
        visible: true,
        opacity: 1,
        blendMode: "source-over" as const,
      };
      fresh.layers = [layer];
      fresh.activeLayerId = layer.id;
      if (width) fresh.width = width;
      if (height) fresh.height = height;

      documentStore.reset(fresh);
      // A root-only document has no raster baseline to replay; restore the
      // blank state directly (resize + reconcile layers + clear).
      await primary.exec("document.restoreRaster", { state: fresh, layers: [] });
      state.restore(fresh);
      await opLog.rotate();
      return documentStore.restoreResult();
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.branch.create", (params) => {
    const { name } = params as { name: string };
    try {
      documentStore.createBranch(name);
      return documentStore.restoreResult();
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.branch.list", () => documentStore.listBranches());

  router.register("doc.branch.switch", async (params) => {
    const { name } = params as { name: string };
    try {
      const target = documentStore.branchTarget(name);
      // Creating a branch at HEAD and immediately switching to it requires no
      // renderer work. Avoid exporting every full-resolution layer merely to
      // replay the exact commit that is already on screen.
      if (target !== documentStore.currentCommitId) {
        await replayCommit(target);
      }
      documentStore.applyBranchSwitch(name);
      return documentStore.restoreResult();
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.checkpoint.create", (params) => {
    const { name } = params as { name: string };
    try {
      documentStore.createCheckpoint(name);
      return documentStore.restoreResult();
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.checkpoint.list", () => documentStore.listCheckpoints());

  router.register("doc.checkpoint.restore", async (params) => {
    const { name } = params as { name: string };
    try {
      const target = documentStore.checkpointTarget(name);
      await replayCommit(target);
      documentStore.applyCheckpointRestore(target);
      return documentStore.restoreResult();
    } catch (error) {
      rethrowDocumentError(error);
    }
  });

  router.register("doc.render", async (params) => {
    const commitId = (params as { commitId?: string } | undefined)?.commitId;
    try {
      const snapshot = documentStore.getReplaySnapshot(commitId);
      const assets = new Map<string, { dataUrl: string; width: number; height: number }>();
      for (const assetId of collectDocumentAssetIds(snapshot)) {
        const metadata = assetStore.get(assetId);
        assets.set(assetId, {
          dataUrl: await assetStore.dataUrl(assetId),
          width: metadata.width,
          height: metadata.height,
        });
      }
      const rendered = renderDocumentToSvg(snapshot, { assets });
      const buffer = Buffer.from(rendered.svg, "utf8");
      const ttlMs = 5 * 60_000;
      return {
        url: registerTempSnapshot(buffer, "image/svg+xml", ttlMs),
        size: buffer.byteLength,
        expiresAt: Date.now() + ttlMs,
        mimeType: "image/svg+xml" as const,
        digest: rendered.digest,
        warnings: rendered.warnings,
      };
    } catch (error) {
      if (
        error instanceof AssetNotFoundError ||
        error instanceof AssetTooLargeError ||
        error instanceof InvalidAssetError
      ) {
        rethrowAssetError(error);
      }
      rethrowDocumentError(error);
    }
  });

  // -------------------------------------------------------------------------
  // event.* — subscription management
  // -------------------------------------------------------------------------

  router.register("event.subscribe", (params, ctx) => {
    const { types } = (params ?? {}) as { types?: string[] };
    events.subscribe(ctx.clientId, types);
    return undefined;
  });

  router.register("event.unsubscribeAll", (_params, ctx) => {
    events.unsubscribeAll(ctx.clientId);
    return undefined;
  });

  // -------------------------------------------------------------------------
  // ops.* — operation log
  // -------------------------------------------------------------------------

  router.register("ops.list", (params) => {
    const filter = (params ?? {}) as {
      sinceStep?: number;
      methodPrefix?: string;
      limit?: number;
    };
    return { ops: opLog.list(filter) };
  });

  router.register("ops.clear", async () => {
    await opLog.clear();
    return { ok: true };
  });

  router.register("ops.getStep", () => ({ step: opLog.getStep() }));

  // ops.replay — on the primary, clear canvas then re-apply ops 1..toStep.
  // Optionally return a snapshot URL after replay. The op log itself is NOT
  // mutated (caller can call ops.replay again with the original toStep=count
  // to restore current state).
  router.register("ops.replay", async (params) => {
    const { toStep, snapshot } = params as { toStep: number; snapshot: boolean };
    const ops = opLog.list({}).slice(0, toStep);
    // Clear all layers on primary first
    await primary.exec("canvas.clear", {});
    // Re-apply each op (skip the structural clears themselves to avoid
    // wiping between ops — only re-apply mutate draw/layer/filter)
    for (const op of ops) {
      if (op.method === "canvas.clear" || op.method === "history.clear") continue;
      try {
        await primary.exec(op.method, op.params);
      } catch (err) {
        // best-effort replay; skip failures (e.g. layer already deleted)
        console.warn(`[ops.replay] skip ${op.method}:`, err);
      }
    }
    if (snapshot) {
      const result = (await primary.exec("canvas.export", { format: "png" })) as {
        png?: string;
      };
      if (typeof result.png === "string") {
        const buffer = Buffer.from(result.png, "base64");
        const url = registerTempSnapshot(buffer, "image/png");
        return { url, expiresAt: Date.now() + 30_000, step: toStep, opsApplied: ops.length };
      }
    }
    return { step: toStep, opsApplied: ops.length };
  });

  // -------------------------------------------------------------------------
  // canvas.snapshot / canvas.getState — multimodal agent convenience
  // -------------------------------------------------------------------------

  router.register("canvas.snapshot", async (params) => {
    const result = (await primary.exec("canvas.export", { format: "png" })) as { png?: string };
    if (typeof result.png === "string") {
      const buffer = Buffer.from(result.png, "base64");
      const url = registerTempSnapshot(buffer, "image/png");
      return { url, size: buffer.byteLength, expiresAt: Date.now() + 30_000 };
    }
    return { url: "", size: 0, expiresAt: Date.now() };
  });

  router.register("canvas.getState", async () => {
    // Request the primary to export each layer as a small thumbnail.
    // We get back N base64 PNGs and register each as a temp URL.
    const result = (await primary.exec("canvas.getState", {})) as {
      layers: { id: string; name: string; visible: boolean; opacity: number; blendMode: never; png: string }[];
    };
    const layers = result.layers.map((l) => {
      const buffer = Buffer.from(l.png, "base64");
      const url = registerTempSnapshot(buffer, "image/png", 60_000);
      return {
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        blendMode: l.blendMode,
        thumbnailUrl: url,
        thumbnailExpiresAt: Date.now() + 60_000,
      };
    });
    return {
      width: state.width,
      height: state.height,
      activeLayerId: state.activeLayerId,
      step: opLog.getStep(),
      layers,
    };
  });

  // -------------------------------------------------------------------------
  // draw.text — font whitelist is enforced by zod (FontFamily enum)
  // -------------------------------------------------------------------------
}
