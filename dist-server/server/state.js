import { randomUUID } from "node:crypto";
/**
 * ServerState — authoritative metadata only. No pixels.
 * Pixels live in the primary browser.
 */
export class ServerState {
    width = 1280;
    height = 720;
    layers = [];
    activeLayerId = null;
    constructor() {
        // Start with a single default layer
        const id = "L_" + randomUUID().slice(0, 8);
        this.layers.push({
            id,
            name: "Layer 1",
            visible: true,
            opacity: 1,
            blendMode: "source-over",
        });
        this.activeLayerId = id;
    }
    getInfo(history) {
        return {
            width: this.width,
            height: this.height,
            layers: structuredClone(this.layers),
            activeLayerId: this.activeLayerId,
            historyLength: history,
        };
    }
    createLayer(name) {
        const id = "L_" + randomUUID().slice(0, 8);
        const layer = {
            id,
            name: name ?? `Layer ${this.layers.length + 1}`,
            visible: true,
            opacity: 1,
            blendMode: "source-over",
        };
        this.layers.push(layer);
        if (this.activeLayerId === null)
            this.activeLayerId = id;
        return layer;
    }
    getLayer(layerId) {
        return this.layers.find((l) => l.id === layerId);
    }
    deleteLayer(layerId) {
        const idx = this.layers.findIndex((l) => l.id === layerId);
        if (idx === -1)
            return;
        this.layers.splice(idx, 1);
        if (this.activeLayerId === layerId) {
            this.activeLayerId = this.layers[idx].id ?? this.layers[idx - 1]?.id ?? null;
        }
    }
    reorder(layerIds) {
        const byId = new Map(this.layers.map((l) => [l.id, l]));
        const reordered = [];
        for (const id of layerIds) {
            const layer = byId.get(id);
            if (layer)
                reordered.push(layer);
        }
        // Any layers not in the input are appended in their original order.
        for (const l of this.layers) {
            if (!layerIds.includes(l.id))
                reordered.push(l);
        }
        this.layers = reordered;
    }
    merge(fromId, intoId) {
        if (fromId === intoId)
            return;
        this.deleteLayer(fromId);
    }
    flatten() {
        if (this.layers.length === 0)
            return;
        const visible = this.layers.filter((l) => l.visible);
        if (visible.length === 0)
            return;
        const first = visible[0];
        const id = "L_" + randomUUID().slice(0, 8);
        const merged = {
            id,
            name: "Flattened",
            visible: true,
            opacity: 1,
            blendMode: "source-over",
        };
        this.layers = [merged];
        this.activeLayerId = id;
        void first; // appease linter
    }
    resize(width, height) {
        this.width = width;
        this.height = height;
    }
    toJSON() {
        return {
            width: this.width,
            height: this.height,
            layers: this.layers,
            activeLayerId: this.activeLayerId,
        };
    }
    fromJSON(data) {
        if (typeof data !== "object" || data === null)
            return;
        const d = data;
        if (typeof d.width === "number")
            this.width = d.width;
        if (typeof d.height === "number")
            this.height = d.height;
        if (Array.isArray(d.layers)) {
            this.layers = d.layers.filter((l) => typeof l === "object" && l !== null && typeof l.id === "string");
        }
        if (typeof d.activeLayerId === "string" || d.activeLayerId === null) {
            this.activeLayerId = d.activeLayerId;
        }
        if (this.layers.length === 0) {
            const id = "L_" + randomUUID().slice(0, 8);
            this.layers.push({
                id,
                name: "Layer 1",
                visible: true,
                opacity: 1,
                blendMode: "source-over",
            });
            this.activeLayerId = id;
        }
        if (this.activeLayerId && !this.layers.some((l) => l.id === this.activeLayerId)) {
            this.activeLayerId = this.layers[0].id;
        }
    }
}
