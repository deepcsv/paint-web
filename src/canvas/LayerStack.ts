import type { Layer, LayerId, BlendMode } from "../../shared/protocol.js";

interface InternalLayer extends Layer {
  /** OffscreenCanvas holding pixels; null when OffscreenCanvas unavailable. */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** dirty flag — set when pixels change */
  dirty: boolean;
}

function makeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    return { canvas: c, ctx };
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  return { canvas: c, ctx };
}

/**
 * LayerStack — manages all layers and composites them onto a destination.
 * Each layer has its own offscreen canvas with its own pixels.
 */
export class LayerStack {
  private layers = new Map<LayerId, InternalLayer>();
  private order: LayerId[] = []; // bottom-to-top
  activeLayerId: LayerId | null = null;
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  createLayer(id: LayerId, name: string): Layer {
    // Idempotent: if a layer with this id already exists (e.g. the browser
    // pre-created locally before the RPC round-trip completed, and the
    // server's internal.exec echo just arrived), don't duplicate the entry
    // in the order array — that would make listLayers() show the same
    // layer twice in the UI.
    const existing = this.layers.get(id);
    if (existing) {
      // Update name in case the server canonicalized it.
      existing.name = name;
      return this.toPublic(existing);
    }
    const { canvas, ctx } = makeCanvas(this.width, this.height);
    const layer: InternalLayer = {
      id,
      name,
      visible: true,
      opacity: 1,
      blendMode: "source-over",
      canvas,
      ctx,
      dirty: false,
    };
    this.layers.set(id, layer);
    this.order.push(id);
    if (this.activeLayerId === null) this.activeLayerId = id;
    return this.toPublic(layer);
  }

  deleteLayer(id: LayerId): void {
    this.layers.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeLayerId === id) {
      this.activeLayerId = this.order[this.order.length - 1] ?? null;
    }
  }

  getLayer(id: LayerId): InternalLayer | undefined {
    return this.layers.get(id);
  }

  getActiveCtx(): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; layer: InternalLayer } | null {
    if (this.activeLayerId === null) return null;
    const layer = this.layers.get(this.activeLayerId);
    if (!layer) return null;
    return { ctx: layer.ctx, layer };
  }

  listLayers(): Layer[] {
    return this.order.map((id) => this.toPublic(this.layers.get(id)!));
  }

  setActive(id: LayerId): boolean {
    if (!this.layers.has(id)) return false;
    this.activeLayerId = id;
    return true;
  }

  setVisible(id: LayerId, visible: boolean): void {
    const l = this.layers.get(id);
    if (l) l.visible = visible;
  }

  setOpacity(id: LayerId, opacity: number): void {
    const l = this.layers.get(id);
    if (l) l.opacity = opacity;
  }

  setBlendMode(id: LayerId, blendMode: BlendMode): void {
    const l = this.layers.get(id);
    if (l) l.blendMode = blendMode;
  }

  rename(id: LayerId, name: string): void {
    const l = this.layers.get(id);
    if (l) l.name = name;
  }

  reorder(layerIds: LayerId[]): void {
    const newOrder: LayerId[] = [];
    for (const id of layerIds) {
      if (this.layers.has(id)) newOrder.push(id);
    }
    // Append any layers not in the input
    for (const id of this.order) {
      if (!newOrder.includes(id)) newOrder.push(id);
    }
    this.order = newOrder;
  }

  merge(fromId: LayerId, intoId: LayerId): void {
    const from = this.layers.get(fromId);
    const into = this.layers.get(intoId);
    if (!from || !into) return;
    // Composite from onto into using from's opacity and blend mode
    const intoCtx = into.ctx;
    intoCtx.save();
    intoCtx.globalAlpha = from.opacity;
    intoCtx.globalCompositeOperation = from.blendMode;
    const src = from.canvas as CanvasImageSource;
    intoCtx.drawImage(src, 0, 0);
    intoCtx.restore();
    into.dirty = true;
    this.deleteLayer(fromId);
  }

  flatten(layerId?: LayerId): { id: LayerId; name: string } {
    // Composite all visible layers top-to-bottom onto a fresh canvas,
    // then replace all layers with the merged result.
    const { canvas, ctx } = makeCanvas(this.width, this.height);
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.fillRect(0, 0, this.width, this.height);
    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i]!;
      const l = this.layers.get(id);
      if (!l || !l.visible) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blendMode;
      ctx.drawImage(l.canvas as CanvasImageSource, 0, 0);
      ctx.restore();
    }
    // Clear all existing layers
    for (const id of [...this.layers.keys()]) this.layers.delete(id);
    this.order = [];
    // Create one new layer
    const newId = layerId ?? "L_" + Math.random().toString(36).slice(2, 10);
    const newLayer: InternalLayer = {
      id: newId,
      name: "Flattened",
      visible: true,
      opacity: 1,
      blendMode: "source-over",
      canvas,
      ctx: ctx as never,
      dirty: true,
    };
    this.layers.set(newId, newLayer);
    this.order.push(newId);
    this.activeLayerId = newId;
    return { id: newId, name: "Flattened" };
  }

  resize(width: number, height: number, mode: "crop" | "scale" | "anchor"): void {
    const oldW = this.width;
    const oldH = this.height;
    this.width = width;
    this.height = height;
    for (const layer of this.layers.values()) {
      const { canvas: newCanvas, ctx: newCtx } = makeCanvas(width, height);
      if (mode === "scale") {
        newCtx.drawImage(layer.canvas as CanvasImageSource, 0, 0, width, height);
      } else {
        // crop or anchor — draw at origin, may clip or have empty area
        newCtx.drawImage(layer.canvas as CanvasImageSource, 0, 0);
      }
      layer.canvas = newCanvas;
      layer.ctx = newCtx;
      layer.dirty = true;
    }
    void oldW;
    void oldH;
  }

  /** Composite all visible layers onto the given destination context. */
  composite(dest: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    dest.clearRect(0, 0, this.width, this.height);
    dest.fillStyle = "rgba(255,255,255,1)";
    dest.fillRect(0, 0, this.width, this.height);
    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i]!;
      const l = this.layers.get(id);
      if (!l || !l.visible) continue;
      dest.save();
      dest.globalAlpha = l.opacity;
      dest.globalCompositeOperation = l.blendMode;
      dest.drawImage(l.canvas as CanvasImageSource, 0, 0);
      dest.restore();
    }
  }

  /** Composite only one layer onto dest (for region/export operations). */
  compositeLayer(
    layerId: LayerId,
    dest: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ): boolean {
    const l = this.layers.get(layerId);
    if (!l) return false;
    dest.clearRect(0, 0, this.width, this.height);
    dest.drawImage(l.canvas as CanvasImageSource, 0, 0);
    return true;
  }

  /** Get the pixel data of one layer. */
  getLayerImageData(layerId: LayerId): ImageData | null {
    const l = this.layers.get(layerId);
    if (!l) return null;
    return l.ctx.getImageData(0, 0, this.width, this.height);
  }

  /** Replace a layer's pixels with the given ImageData. */
  setLayerImageData(layerId: LayerId, data: ImageData): boolean {
    const l = this.layers.get(layerId);
    if (!l) return false;
    l.ctx.putImageData(data, 0, 0);
    l.dirty = true;
    return true;
  }

  clearLayer(layerId: LayerId): void {
    const l = this.layers.get(layerId);
    if (!l) return;
    l.ctx.clearRect(0, 0, this.width, this.height);
    l.dirty = true;
  }

  clearAll(): void {
    for (const l of this.layers.values()) {
      l.ctx.clearRect(0, 0, this.width, this.height);
      l.dirty = true;
    }
  }

  /**
   * Reconcile local layers with the server's authoritative layer list.
   * - Layers present on server but missing locally → create empty.
   * - Layers present locally but missing on server → delete.
   * - Layers present on both → preserve local pixels, update metadata.
   * - activeLayerId is set to server's value.
   *
   * This is the fix for the "drew on a layer that doesn't exist locally" bug:
   * without reconcile, server's default layer id and browser's default layer
   * id never matched, so RPCs targeting server's layer id silently no-op'd
   * on the primary browser.
   */
  reconcile(serverLayers: Layer[], activeLayerId: LayerId | null): void {
    const serverIds = new Set(serverLayers.map((l) => l.id));

    // Delete local layers not on server
    for (const id of [...this.layers.keys()]) {
      if (!serverIds.has(id)) {
        this.layers.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }

    // Create missing layers + update metadata for existing ones
    const newOrder: LayerId[] = [];
    for (const serverLayer of serverLayers) {
      let local = this.layers.get(serverLayer.id);
      if (!local) {
        // Create empty layer with the server's id
        const { canvas, ctx } = makeCanvas(this.width, this.height);
        local = {
          id: serverLayer.id,
          name: serverLayer.name,
          visible: serverLayer.visible,
          opacity: serverLayer.opacity,
          blendMode: serverLayer.blendMode,
          canvas,
          ctx,
          dirty: false,
        };
        this.layers.set(serverLayer.id, local);
      } else {
        // Update metadata but preserve pixels
        local.name = serverLayer.name;
        local.visible = serverLayer.visible;
        local.opacity = serverLayer.opacity;
        local.blendMode = serverLayer.blendMode;
      }
      newOrder.push(serverLayer.id);
    }
    this.order = newOrder;
    this.activeLayerId = activeLayerId;
  }

  /** Export as PNG/JPEG blob URL via composite of all layers. */
  async exportComposite(format: "png" | "jpeg", quality = 0.92): Promise<Blob> {
    const { canvas, ctx } = makeCanvas(this.width, this.height);
    this.composite(ctx);
    if (canvas instanceof OffscreenCanvas) {
      return await canvas.convertToBlob({
        type: format === "jpeg" ? "image/jpeg" : "image/png",
        quality,
      });
    }
    // HTMLCanvasElement path
    return await new Promise((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        format === "jpeg" ? "image/jpeg" : "image/png",
        quality,
      );
    });
  }

  /** Export a single layer as PNG. */
  async exportLayer(layerId: LayerId, format: "png" | "jpeg", quality = 0.92): Promise<Blob | null> {
    const l = this.layers.get(layerId);
    if (!l) return null;
    if (l.canvas instanceof OffscreenCanvas) {
      return await l.canvas.convertToBlob({
        type: format === "jpeg" ? "image/jpeg" : "image/png",
        quality,
      });
    }
    return await new Promise((resolve, reject) => {
      (l.canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        format === "jpeg" ? "image/jpeg" : "image/png",
        quality,
      );
    });
  }

  /** Load a PNG into a layer, replacing its content. */
  async loadIntoLayer(layerId: LayerId, pngBlob: Blob): Promise<boolean> {
    const l = this.layers.get(layerId);
    if (!l) return false;
    try {
      const bitmap = await createImageBitmap(pngBlob);
      l.ctx.clearRect(0, 0, this.width, this.height);
      l.ctx.drawImage(bitmap, 0, 0);
      l.dirty = true;
      bitmap.close?.();
      return true;
    } catch (err) {
      console.error("[layer] loadIntoLayer failed:", err);
      return false;
    }
  }

  private toPublic(l: InternalLayer): Layer {
    return {
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
    };
  }
}
