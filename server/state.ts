import { randomUUID } from "node:crypto";
import type { CanvasGetInfoResult, Layer, LayerId } from "../shared/protocol.js";

/**
 * ServerState — authoritative metadata only. No pixels.
 * Pixels live in the primary browser.
 */
export class ServerState {
  width = 1280;
  height = 720;
  layers: Layer[] = [];
  activeLayerId: LayerId | null = null;

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

  getInfo(history: { undo: number; redo: number }): CanvasGetInfoResult {
    return {
      width: this.width,
      height: this.height,
      layers: structuredClone(this.layers),
      activeLayerId: this.activeLayerId,
      historyLength: history,
    };
  }

  createLayer(name?: string, clientId?: string): Layer {
    const id = clientId ?? "L_" + randomUUID().slice(0, 8);
    const layer: Layer = {
      id,
      name: name ?? `Layer ${this.layers.length + 1}`,
      visible: true,
      opacity: 1,
      blendMode: "source-over",
    };
    this.layers.push(layer);
    if (this.activeLayerId === null) this.activeLayerId = id;
    return layer;
  }

  getLayer(layerId: LayerId): Layer | undefined {
    return this.layers.find((l) => l.id === layerId);
  }

  deleteLayer(layerId: LayerId): void {
    const idx = this.layers.findIndex((l) => l.id === layerId);
    if (idx === -1) return;
    this.layers.splice(idx, 1);
    if (this.activeLayerId === layerId) {
      this.activeLayerId = this.layers[idx]!.id ?? this.layers[idx - 1]?.id ?? null;
    }
  }

  reorder(layerIds: LayerId[]): void {
    const byId = new Map(this.layers.map((l) => [l.id, l]));
    const reordered: Layer[] = [];
    for (const id of layerIds) {
      const layer = byId.get(id);
      if (layer) reordered.push(layer);
    }
    // Any layers not in the input are appended in their original order.
    for (const l of this.layers) {
      if (!layerIds.includes(l.id)) reordered.push(l);
    }
    this.layers = reordered;
  }

  merge(fromId: LayerId, intoId: LayerId): void {
    if (fromId === intoId) return;
    this.deleteLayer(fromId);
  }

  flatten(): void {
    if (this.layers.length === 0) return;
    const visible = this.layers.filter((l) => l.visible);
    if (visible.length === 0) return;
    const first = visible[0]!;
    const id = "L_" + randomUUID().slice(0, 8);
    const merged: Layer = {
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

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  toJSON(): object {
    return {
      width: this.width,
      height: this.height,
      layers: this.layers,
      activeLayerId: this.activeLayerId,
    };
  }

  fromJSON(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;
    if (typeof d.width === "number") this.width = d.width;
    if (typeof d.height === "number") this.height = d.height;
    if (Array.isArray(d.layers)) {
      this.layers = d.layers.filter(
        (l): l is Layer =>
          typeof l === "object" && l !== null && typeof (l as Layer).id === "string",
      );
    }
    if (typeof d.activeLayerId === "string" || d.activeLayerId === null) {
      this.activeLayerId = d.activeLayerId as LayerId | null;
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
      this.activeLayerId = this.layers[0]!.id;
    }
  }
}
