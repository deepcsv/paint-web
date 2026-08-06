import type { Router } from "../rpc/router.js";
import type { ServerState } from "../state.js";
import type { EventBus } from "../event-bus.js";
import type { PrimaryClient } from "../primary-client.js";
import type { CanvasExportResult, LayerId } from "../../shared/protocol.js";
import type { registerTempSnapshot as RegisterTempSnapshot } from "../http-server.js";
import type { saveSnapshotPng as SaveSnapshotPng } from "../persistence.js";
import { RpcError } from "../rpc/errors.js";
import { loadSnapshotPng } from "../persistence.js";
import {
  CanvasExportParams,
  CanvasGetRegionParams,
  SnapshotLoadParams,
  SnapshotSaveParams,
} from "../../shared/protocol.js";

export interface HandlerDeps {
  router: Router;
  state: ServerState;
  events: EventBus;
  primary: PrimaryClient;
  opLog: import("../op-log.js").OpLog;
  registerTempSnapshot: typeof RegisterTempSnapshot;
  saveSnapshotPng: typeof SaveSnapshotPng;
}

export function registerHandlers(deps: HandlerDeps): void {
  const { router, state, events, primary, opLog, registerTempSnapshot, saveSnapshotPng } = deps;

  // -------------------------------------------------------------------------
  // canvas.* — pixel work goes to primary; metadata stays on server
  // -------------------------------------------------------------------------

  router.register("canvas.getInfo", () => {
    return state.getInfo({ undo: 0, redo: 0 });
  });

  router.register("canvas.resize", async (params) => {
    const result = await primary.exec("canvas.resize", params);
    const { width, height } = params as { width: number; height: number };
    state.resize(width, height);
    return result;
  });

  router.register("canvas.clear", (params) => primary.exec("canvas.clear", params));
  router.register("canvas.fill", (params) => primary.exec("canvas.fill", params));

  router.register("canvas.export", async (params) => {
    const parsed = CanvasExportParams.parse(params);
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

  router.register("canvas.import", (params) => primary.exec("canvas.import", params));

  router.register("canvas.getRegion", async (params) => {
    const parsed = CanvasGetRegionParams.parse(params);
    const result = (await primary.exec("canvas.getRegion", parsed)) as { png?: string };
    if (typeof result.png === "string") {
      const buffer = Buffer.from(result.png, "base64");
      const url = registerTempSnapshot(buffer, "image/png");
      return { url, expiresAt: Date.now() + 30_000 };
    }
    return result;
  });

  // -------------------------------------------------------------------------
  // layer.* — metadata mutations on server, pixel operations on primary
  // -------------------------------------------------------------------------

  router.register("layer.create", (params) => {
    const { name, layerId: clientId } = params as { name?: string; layerId?: string };
    const layer = state.createLayer(name, clientId);
    void primary.exec("layer.create", { layerId: layer.id, name: layer.name });
    return { layerId: layer.id };
  });

  router.register("layer.delete", (params) => {
    const { layerId } = params as { layerId: LayerId };
    if (!state.getLayer(layerId)) throw RpcError.layerNotFound(layerId);
    state.deleteLayer(layerId);
    void primary.exec("layer.delete", { layerId });
    return { ok: true };
  });

  router.register("layer.list", () => ({ layers: state.layers }));

  router.register("layer.setActive", (params) => {
    const { layerId } = params as { layerId: LayerId };
    if (!state.getLayer(layerId)) throw RpcError.layerNotFound(layerId);
    state.activeLayerId = layerId;
    void primary.exec("layer.setActive", { layerId });
    return { ok: true };
  });

  router.register("layer.setVisible", (params) => {
    const { layerId, visible } = params as { layerId: LayerId; visible: boolean };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    layer.visible = visible;
    void primary.exec("layer.setVisible", { layerId, visible });
    return { ok: true };
  });

  router.register("layer.setOpacity", (params) => {
    const { layerId, opacity } = params as { layerId: LayerId; opacity: number };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    layer.opacity = opacity;
    void primary.exec("layer.setOpacity", { layerId, opacity });
    return { ok: true };
  });

  router.register("layer.setBlendMode", (params) => {
    const { layerId, blendMode } = params as { layerId: LayerId; blendMode: string };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    layer.blendMode = blendMode as never;
    void primary.exec("layer.setBlendMode", { layerId, blendMode });
    return { ok: true };
  });

  router.register("layer.rename", (params) => {
    const { layerId, name } = params as { layerId: LayerId; name: string };
    const layer = state.getLayer(layerId);
    if (!layer) throw RpcError.layerNotFound(layerId);
    layer.name = name;
    void primary.exec("layer.rename", { layerId, name });
    return { ok: true };
  });

  router.register("layer.reorder", (params) => {
    const { layerIds } = params as { layerIds: LayerId[] };
    state.reorder(layerIds);
    void primary.exec("layer.reorder", { layerIds });
    return { ok: true };
  });

  router.register("layer.merge", (params) => {
    const { fromId, intoId } = params as { fromId: LayerId; intoId: LayerId };
    if (!state.getLayer(fromId)) throw RpcError.layerNotFound(fromId);
    if (!state.getLayer(intoId)) throw RpcError.layerNotFound(intoId);
    state.merge(fromId, intoId);
    void primary.exec("layer.merge", { fromId, intoId });
    return { ok: true };
  });

  router.register("layer.flatten", async () => {
    const result = await primary.exec("layer.flatten", {});
    state.flatten();
    return result;
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
  ];
  for (const m of drawMethods) {
    router.register(m, (params) => primary.exec(m, params));
  }

  router.register("draw.batch", async (params) => {
    const { operations } = params as { operations: { method: string; params: unknown }[] };
    const results: unknown[] = [];
    for (const op of operations) {
      try {
        // Validate against registry
        if (op.method.startsWith("draw.") || op.method.startsWith("filter.")) {
          await primary.exec(op.method, op.params);
          results.push({ ok: true });
        } else {
          results.push(RpcError.invalidParams(`batch only allows draw.* or filter.*: ${op.method}`).toObject());
        }
      } catch (err) {
        results.push(
          err instanceof RpcError
            ? err.toObject()
            : RpcError.internal(String(err)).toObject(),
        );
      }
    }
    return { results };
  });

  // -------------------------------------------------------------------------
  // history.* — proxy to primary (each browser maintains its own stack)
  // -------------------------------------------------------------------------

  router.register("history.undo", (params) => primary.exec("history.undo", params));
  router.register("history.redo", (params) => primary.exec("history.redo", params));
  router.register("history.goto", (params) => primary.exec("history.goto", params));
  router.register("history.getLength", () => primary.exec("history.getLength", {}));
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
    router.register(m, (params) => primary.exec(m, params));
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
