import { RpcError } from "../rpc/errors.js";
import { loadSnapshotPng } from "../persistence.js";
import { CanvasExportParams, CanvasGetRegionParams, SnapshotLoadParams, SnapshotSaveParams, } from "../../shared/protocol.js";
export function registerHandlers(deps) {
    const { router, state, events, primary, registerTempSnapshot, saveSnapshotPng } = deps;
    // -------------------------------------------------------------------------
    // canvas.* — pixel work goes to primary; metadata stays on server
    // -------------------------------------------------------------------------
    router.register("canvas.getInfo", () => {
        return state.getInfo({ undo: 0, redo: 0 });
    });
    router.register("canvas.resize", async (params) => {
        const result = await primary.exec("canvas.resize", params);
        const { width, height } = params;
        state.resize(width, height);
        return result;
    });
    router.register("canvas.clear", (params) => primary.exec("canvas.clear", params));
    router.register("canvas.fill", (params) => primary.exec("canvas.fill", params));
    router.register("canvas.export", async (params) => {
        const parsed = CanvasExportParams.parse(params);
        const result = (await primary.exec("canvas.export", parsed));
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
        const result = (await primary.exec("canvas.getRegion", parsed));
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
        const { name } = params;
        const layer = state.createLayer(name);
        void primary.exec("layer.create", { layerId: layer.id, name: layer.name });
        return { layerId: layer.id };
    });
    router.register("layer.delete", (params) => {
        const { layerId } = params;
        if (!state.getLayer(layerId))
            throw RpcError.layerNotFound(layerId);
        state.deleteLayer(layerId);
        void primary.exec("layer.delete", { layerId });
        return { ok: true };
    });
    router.register("layer.list", () => ({ layers: state.layers }));
    router.register("layer.setActive", (params) => {
        const { layerId } = params;
        if (!state.getLayer(layerId))
            throw RpcError.layerNotFound(layerId);
        state.activeLayerId = layerId;
        void primary.exec("layer.setActive", { layerId });
        return { ok: true };
    });
    router.register("layer.setVisible", (params) => {
        const { layerId, visible } = params;
        const layer = state.getLayer(layerId);
        if (!layer)
            throw RpcError.layerNotFound(layerId);
        layer.visible = visible;
        void primary.exec("layer.setVisible", { layerId, visible });
        return { ok: true };
    });
    router.register("layer.setOpacity", (params) => {
        const { layerId, opacity } = params;
        const layer = state.getLayer(layerId);
        if (!layer)
            throw RpcError.layerNotFound(layerId);
        layer.opacity = opacity;
        void primary.exec("layer.setOpacity", { layerId, opacity });
        return { ok: true };
    });
    router.register("layer.setBlendMode", (params) => {
        const { layerId, blendMode } = params;
        const layer = state.getLayer(layerId);
        if (!layer)
            throw RpcError.layerNotFound(layerId);
        layer.blendMode = blendMode;
        void primary.exec("layer.setBlendMode", { layerId, blendMode });
        return { ok: true };
    });
    router.register("layer.rename", (params) => {
        const { layerId, name } = params;
        const layer = state.getLayer(layerId);
        if (!layer)
            throw RpcError.layerNotFound(layerId);
        layer.name = name;
        void primary.exec("layer.rename", { layerId, name });
        return { ok: true };
    });
    router.register("layer.reorder", (params) => {
        const { layerIds } = params;
        state.reorder(layerIds);
        void primary.exec("layer.reorder", { layerIds });
        return { ok: true };
    });
    router.register("layer.merge", (params) => {
        const { fromId, intoId } = params;
        if (!state.getLayer(fromId))
            throw RpcError.layerNotFound(fromId);
        if (!state.getLayer(intoId))
            throw RpcError.layerNotFound(intoId);
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
        const { operations } = params;
        const results = [];
        for (const op of operations) {
            try {
                // Validate against registry
                if (op.method.startsWith("draw.") || op.method.startsWith("filter.")) {
                    await primary.exec(op.method, op.params);
                    results.push({ ok: true });
                }
                else {
                    results.push(RpcError.invalidParams(`batch only allows draw.* or filter.*: ${op.method}`).toObject());
                }
            }
            catch (err) {
                results.push(err instanceof RpcError
                    ? err.toObject()
                    : RpcError.internal(String(err)).toObject());
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
        if (!png)
            throw RpcError.invalidParams(`Snapshot '${name}' not found`);
        // Register as a temp URL, ask primary to load it
        const url = registerTempSnapshot(png, "image/png", 60_000);
        await primary.exec("canvas.import", { url });
        return { width: state.width, height: state.height, layers: state.layers.length };
    });
    // -------------------------------------------------------------------------
    // event.* — subscription management
    // -------------------------------------------------------------------------
    router.register("event.subscribe", (params, ctx) => {
        const { types } = (params ?? {});
        events.subscribe(ctx.clientId, types);
        return undefined;
    });
    router.register("event.unsubscribeAll", (_params, ctx) => {
        events.unsubscribeAll(ctx.clientId);
        return undefined;
    });
    // -------------------------------------------------------------------------
    // draw.text — font whitelist is enforced by zod (FontFamily enum)
    // -------------------------------------------------------------------------
}
