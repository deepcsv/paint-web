import { randomUUID } from "node:crypto";
import type { CanvasGetInfoResult, Layer, LayerId } from "../shared/protocol.js";

export interface ServerStateSnapshot {
  width: number;
  height: number;
  layers: Layer[];
  activeLayerId: LayerId;
}

export class StateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateInvariantError";
  }
}

function cloneSnapshot(snapshot: ServerStateSnapshot): ServerStateSnapshot {
  return structuredClone(snapshot);
}

function makeDefaultLayer(): Layer {
  return {
    id: "L_" + randomUUID().slice(0, 8),
    name: "Layer 1",
    visible: true,
    opacity: 1,
    blendMode: "source-over",
  };
}

/**
 * ServerState is the authoritative structural state of the artwork.
 *
 * P0 invariants:
 * - a document always has at least one layer;
 * - layer ids are unique;
 * - activeLayerId always points at a live layer;
 * - every public mutation either leaves a valid state or rolls back.
 *
 * Pixel commands are recorded by DocumentStore and rendered by browser or
 * headless renderers. This class deliberately owns only structural state.
 */
export class ServerState {
  width = 1280;
  height = 720;
  layers: Layer[] = [];
  activeLayerId: LayerId;

  constructor() {
    const layer = makeDefaultLayer();
    this.layers.push(layer);
    this.activeLayerId = layer.id;
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

  snapshot(): ServerStateSnapshot {
    return cloneSnapshot({
      width: this.width,
      height: this.height,
      layers: this.layers,
      activeLayerId: this.activeLayerId,
    });
  }

  restore(snapshot: ServerStateSnapshot): void {
    this.validateSnapshot(snapshot);
    const copy = cloneSnapshot(snapshot);
    this.width = copy.width;
    this.height = copy.height;
    this.layers = copy.layers;
    this.activeLayerId = copy.activeLayerId;
  }

  /** Run a synchronous structural mutation with copy-on-write rollback. */
  transact<T>(mutation: () => T): T {
    const before = this.snapshot();
    try {
      const result = mutation();
      this.assertInvariants();
      return result;
    } catch (error) {
      this.restore(before);
      throw error;
    }
  }

  createLayer(name?: string, clientId?: string): Layer {
    const id = clientId ?? "L_" + randomUUID().slice(0, 8);
    if (this.layers.some((layer) => layer.id === id)) {
      throw new StateInvariantError(`Layer id already exists: ${id}`);
    }
    const layer: Layer = {
      id,
      name: name ?? `Layer ${this.layers.length + 1}`,
      visible: true,
      opacity: 1,
      blendMode: "source-over",
    };
    this.layers.push(layer);
    this.assertInvariants();
    return structuredClone(layer);
  }

  getLayer(layerId: LayerId): Layer | undefined {
    return this.layers.find((layer) => layer.id === layerId);
  }

  deleteLayer(layerId: LayerId): void {
    const idx = this.layers.findIndex((layer) => layer.id === layerId);
    if (idx === -1) throw new StateInvariantError(`Layer not found: ${layerId}`);
    if (this.layers.length === 1) {
      throw new StateInvariantError("A document must retain at least one layer");
    }
    this.layers.splice(idx, 1);
    if (this.activeLayerId === layerId) {
      this.activeLayerId = this.layers[idx]?.id ?? this.layers[idx - 1]!.id;
    }
    this.assertInvariants();
  }

  setActive(layerId: LayerId): void {
    if (!this.getLayer(layerId)) throw new StateInvariantError(`Layer not found: ${layerId}`);
    this.activeLayerId = layerId;
  }

  reorder(layerIds: LayerId[]): void {
    const requested = new Set(layerIds);
    const existing = new Set(this.layers.map((layer) => layer.id));
    if (
      layerIds.length !== this.layers.length ||
      requested.size !== layerIds.length ||
      [...existing].some((id) => !requested.has(id))
    ) {
      throw new StateInvariantError("layer.reorder must contain every layer id exactly once");
    }
    const byId = new Map(this.layers.map((layer) => [layer.id, layer]));
    this.layers = layerIds.map((id) => byId.get(id)!);
    this.assertInvariants();
  }

  merge(fromId: LayerId, intoId: LayerId): void {
    if (fromId === intoId) throw new StateInvariantError("Cannot merge a layer into itself");
    if (!this.getLayer(fromId)) throw new StateInvariantError(`Layer not found: ${fromId}`);
    if (!this.getLayer(intoId)) throw new StateInvariantError(`Layer not found: ${intoId}`);
    this.deleteLayer(fromId);
    this.activeLayerId = intoId;
    this.assertInvariants();
  }

  flatten(layerId?: LayerId): Layer {
    const id = layerId ?? "L_" + randomUUID().slice(0, 8);
    const merged: Layer = {
      id,
      name: "Flattened",
      visible: true,
      opacity: 1,
      blendMode: "source-over",
    };
    this.layers = [merged];
    this.activeLayerId = id;
    this.assertInvariants();
    return structuredClone(merged);
  }

  resize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new StateInvariantError("Canvas dimensions must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.assertInvariants();
  }

  assertInvariants(): void {
    this.validateSnapshot({
      width: this.width,
      height: this.height,
      layers: this.layers,
      activeLayerId: this.activeLayerId,
    });
  }

  toJSON(): ServerStateSnapshot {
    return this.snapshot();
  }

  /** Load legacy state.json and repair invalid historical metadata safely. */
  fromJSON(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;
    const width =
      typeof d.width === "number" && Number.isInteger(d.width) && d.width > 0
        ? d.width
        : this.width;
    const height =
      typeof d.height === "number" && Number.isInteger(d.height) && d.height > 0
        ? d.height
        : this.height;

    const seen = new Set<string>();
    const layers = Array.isArray(d.layers)
      ? d.layers
          .filter((candidate): candidate is Layer => {
            if (typeof candidate !== "object" || candidate === null) return false;
            const layer = candidate as Partial<Layer>;
            if (typeof layer.id !== "string" || seen.has(layer.id)) return false;
            seen.add(layer.id);
            return true;
          })
          .map((layer, index): Layer => ({
            id: layer.id,
            name: typeof layer.name === "string" ? layer.name : `Layer ${index + 1}`,
            visible: typeof layer.visible === "boolean" ? layer.visible : true,
            opacity:
              typeof layer.opacity === "number" && layer.opacity >= 0 && layer.opacity <= 1
                ? layer.opacity
                : 1,
            blendMode: layer.blendMode ?? "source-over",
          }))
      : [];

    if (layers.length === 0) layers.push(makeDefaultLayer());
    const requestedActive = typeof d.activeLayerId === "string" ? d.activeLayerId : null;
    const activeLayerId = layers.some((layer) => layer.id === requestedActive)
      ? requestedActive!
      : layers[0]!.id;
    this.restore({ width, height, layers, activeLayerId });
  }

  private validateSnapshot(snapshot: ServerStateSnapshot): void {
    if (
      !Number.isInteger(snapshot.width) ||
      !Number.isInteger(snapshot.height) ||
      snapshot.width <= 0 ||
      snapshot.height <= 0
    ) {
      throw new StateInvariantError("Canvas dimensions must be positive integers");
    }
    if (snapshot.layers.length === 0) {
      throw new StateInvariantError("A document must contain at least one layer");
    }
    const ids = snapshot.layers.map((layer) => layer.id);
    if (new Set(ids).size !== ids.length) {
      throw new StateInvariantError("Layer ids must be unique");
    }
    if (!ids.includes(snapshot.activeLayerId)) {
      throw new StateInvariantError("activeLayerId must reference a live layer");
    }
    for (const layer of snapshot.layers) {
      if (layer.opacity < 0 || layer.opacity > 1) {
        throw new StateInvariantError(`Layer opacity out of range: ${layer.id}`);
      }
    }
  }
}
