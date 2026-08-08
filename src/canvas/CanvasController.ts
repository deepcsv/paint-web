import { LayerStack } from "./LayerStack.js";
import { HistoryStack } from "./HistoryStack.js";
import { StrokeEngine } from "./StrokeEngine.js";
import { renderStroke as renderStampStroke } from "./StampEngine.js";
import { ShapeRenderer } from "./ShapeRenderer.js";
import { floodFill } from "./FillEngine.js";
import { FilterEngine } from "./FilterEngine.js";
import { analyzePixels, samplePixels } from "./CanvasAnalyzer.js";
import { getById as getPresetById } from "../brush/BrushPresets.js";
import { getTexture } from "../brush/TextureLoader.js";
import type {
  CanvasAnalyzeParams,
  CanvasAnalyzeResult,
  CanvasSampleParams,
  CanvasSampleResult,
  DrawGradientParams,
  DrawImageParams,
  DrawStrokeParams,
  DrawLineParams,
  DrawRectParams,
  DrawCircleParams,
  DrawEllipseParams,
  DrawFillParams,
  DrawTextParams,
  DrawSetPixelParams,
  DrawPathParams,
  LayerTransformParams,
  BlendMode,
  Layer,
  LayerId,
} from "../../shared/protocol.js";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * CanvasController — the bridge between RPC (server) and the actual canvas
 * pixels. Each method corresponds to an RPC method, validated upstream.
 *
 * When this client is the primary, the server proxies RPCs here via
 * `internal.exec`. When it's a secondary, it applies events received
 * via the WSClient's onEvent callback.
 *
 * All mutate methods push undo snapshots onto the local HistoryStack.
 */
export class CanvasController {
  readonly layers: LayerStack;
  readonly history: HistoryStack;
  readonly renderCanvas: HTMLCanvasElement;
  private renderCtx: CanvasRenderingContext2D;
  private renderScheduled = false;
  private historyEnabled = true;
  private onAfterChange?: () => void;

  constructor(width: number, height: number, renderCanvas: HTMLCanvasElement) {
    this.layers = new LayerStack(width, height);
    this.history = new HistoryStack();
    this.renderCanvas = renderCanvas;
    renderCanvas.width = width;
    renderCanvas.height = height;
    this.renderCtx = renderCanvas.getContext("2d")!;
    // Initial layer
    this.layers.createLayer("L_" + Math.random().toString(36).slice(2, 10), "Layer 1");
    this.requestRender();
  }

  setOnAfterChange(cb: () => void): void {
    this.onAfterChange = cb;
  }

  private requestRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.layers.composite(this.renderCtx);
    });
  }

  /**
   * Public alias for requestRender — used by main.ts live-preview path
   * (pointer down/move) to trigger composite after drawing directly to a
   * layer's ctx. Without this, the canvas never refreshes and strokes
   * are invisible.
   *
   * The private-only version is unreachable via `controller["requestRender"]`
   * because TypeScript-private methods aren't part of the public surface and
   * bracket access from outside the class can be optimized away by bundlers.
   */
  triggerRender(): void {
    this.requestRender();
  }

  private snapshotForUndo(layerId: LayerId): void {
    if (!this.historyEnabled) return;
    const data = this.layers.getLayerImageData(layerId);
    if (data) this.history.pushBeforeChange(layerId, data);
  }

  /**
   * Apply a deterministic document replay without allocating a full-canvas
   * undo snapshot for every historical operation. A detailed artwork can
   * contain thousands of strokes; replay history is already preserved by the
   * canonical document log, so duplicating it as ImageData is both redundant
   * and capable of exhausting the browser's memory.
   */
  async withoutHistory<T>(operation: () => T | Promise<T>): Promise<T> {
    const previouslyEnabled = this.historyEnabled;
    this.historyEnabled = false;
    try {
      return await operation();
    } finally {
      this.historyEnabled = previouslyEnabled;
    }
  }

  private getCtx(layerId: LayerId): AnyCtx | null {
    const layer = this.layers.getLayer(layerId);
    return layer ? layer.ctx : null;
  }

  // -------------------------------------------------------------------------
  // canvas.*
  // -------------------------------------------------------------------------

  getInfo() {
    return {
      width: this.layers.width,
      height: this.layers.height,
      layers: this.layers.listLayers(),
      activeLayerId: this.layers.activeLayerId,
      historyLength: this.history.getAggregateLength(),
    };
  }

  /**
   * Sync local layer stack with server's authoritative metadata.
   * Called after sync.hello. Preserves local pixels for matching layer ids;
   * creates empty layers for server-only ids; drops local-only layers.
   */
  reconcileFromServer(layers: Layer[], activeLayerId: string | null): void {
    this.layers.reconcile(layers, activeLayerId);
    this.requestRender();
    this.onAfterChange?.();
  }

  resize(params: { width: number; height: number; mode: "crop" | "scale" | "anchor" }): void {
    this.history.clear();
    this.layers.resize(params.width, params.height, params.mode);
    this.renderCanvas.width = params.width;
    this.renderCanvas.height = params.height;
    this.requestRender();
    this.onAfterChange?.();
  }

  clear(params: { layerId?: LayerId }): void {
    if (params.layerId) {
      this.snapshotForUndo(params.layerId);
      this.layers.clearLayer(params.layerId);
    } else {
      for (const layer of this.layers.listLayers()) {
        this.snapshotForUndo(layer.id);
      }
      this.layers.clearAll();
    }
    this.requestRender();
  }

  fill(params: { color: string; layerId?: LayerId }): void {
    const targets = params.layerId
      ? [params.layerId]
      : this.layers.listLayers().map((l) => l.id);
    for (const id of targets) {
      this.snapshotForUndo(id);
      const ctx = this.getCtx(id);
      if (!ctx) continue;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = params.color;
      ctx.fillRect(0, 0, this.layers.width, this.layers.height);
      ctx.restore();
    }
    this.requestRender();
  }

  async exportComposite(params: { format: "png" | "jpeg"; quality?: number }): Promise<{ png: string }> {
    const blob = await this.layers.exportComposite(params.format, params.quality ?? 0.92);
    const png = await blobToBase64(blob);
    return { png };
  }

  async exportLayer(params: { layerId: LayerId; format: "png" | "jpeg"; quality?: number }): Promise<{ png: string } | null> {
    const blob = await this.layers.exportLayer(params.layerId, params.format, params.quality ?? 0.92);
    if (!blob) return null;
    const png = await blobToBase64(blob);
    return { png };
  }

  async getRegion(params: { x: number; y: number; w: number; h: number; layerId?: LayerId }): Promise<{ png: string }> {
    const { x, y, w, h } = params;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d")!;
    if (params.layerId) {
      // Single layer: copy from that layer's pixels
      const layer = this.layers.getLayer(params.layerId);
      if (!layer) throw new Error("layer not found");
      offCtx.drawImage(layer.canvas as CanvasImageSource, x, y, w, h, 0, 0, w, h);
    } else {
      // Composite: render the visible composite, then crop
      offCtx.drawImage(this.renderCanvas, x, y, w, h, 0, 0, w, h);
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      off.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    return { png: await blobToBase64(blob) };
  }

  async import(params: { url?: string; assetId?: string; layerId?: LayerId }): Promise<void> {
    const targetLayer = params.layerId ?? this.layers.activeLayerId;
    if (!targetLayer) throw new Error("no active layer");
    const url = params.url ?? (params.assetId ? `/asset/${encodeURIComponent(params.assetId)}` : "");
    if (!url) throw new Error("asset url is required");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
    const blob = await response.blob();
    this.snapshotForUndo(targetLayer);
    const loaded = await this.layers.loadIntoLayer(targetLayer, blob);
    if (!loaded) throw new Error("asset decode failed");
    this.requestRender();
  }

  analyze(params: NonNullable<CanvasAnalyzeParams>): CanvasAnalyzeResult {
    const image = params.layerId
      ? this.layers.getLayerImageData(params.layerId)
      : this.layers.getCompositeImageData(params.includeBackground);
    if (!image) throw new Error("layer not found");
    return analyzePixels(image, params);
  }

  sample(params: CanvasSampleParams): CanvasSampleResult {
    const image = params.layerId
      ? this.layers.getLayerImageData(params.layerId)
      : this.layers.getCompositeImageData(true);
    if (!image) throw new Error("layer not found");
    return samplePixels(image, params.points);
  }

  // -------------------------------------------------------------------------
  // layer.*
  // -------------------------------------------------------------------------

  createLayer(params: { layerId: string; name: string }): { layerId: string } {
    this.layers.createLayer(params.layerId, params.name);
    this.requestRender();
    this.onAfterChange?.();
    return { layerId: params.layerId };
  }

  deleteLayer(params: { layerId: LayerId }): void {
    this.history.dropLayer(params.layerId);
    this.layers.deleteLayer(params.layerId);
    this.requestRender();
    this.onAfterChange?.();
  }

  setActive(params: { layerId: LayerId }): void {
    this.layers.setActive(params.layerId);
    this.onAfterChange?.();
  }

  setVisible(params: { layerId: LayerId; visible: boolean }): void {
    this.layers.setVisible(params.layerId, params.visible);
    this.requestRender();
    this.onAfterChange?.();
  }

  setOpacity(params: { layerId: LayerId; opacity: number }): void {
    this.layers.setOpacity(params.layerId, params.opacity);
    this.requestRender();
    this.onAfterChange?.();
  }

  setBlendMode(params: { layerId: LayerId; blendMode: BlendMode }): void {
    this.layers.setBlendMode(params.layerId, params.blendMode);
    this.requestRender();
    this.onAfterChange?.();
  }

  rename(params: { layerId: LayerId; name: string }): void {
    this.layers.rename(params.layerId, params.name);
    this.onAfterChange?.();
  }

  reorder(params: { layerIds: LayerId[] }): void {
    this.layers.reorder(params.layerIds);
    this.requestRender();
    this.onAfterChange?.();
  }

  merge(params: { fromId: LayerId; intoId: LayerId }): void {
    this.snapshotForUndo(params.intoId);
    this.layers.merge(params.fromId, params.intoId);
    this.history.dropLayer(params.fromId);
    this.requestRender();
    this.onAfterChange?.();
  }

  flatten(params?: { layerId?: string }): { id: string; name: string } {
    this.history.clear();
    const result = this.layers.flatten(params?.layerId);
    this.requestRender();
    this.onAfterChange?.();
    return result;
  }

  transformLayer(params: LayerTransformParams): void {
    this.snapshotForUndo(params.layerId);
    if (!this.layers.transformLayer(params)) throw new Error("layer not found");
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // draw.*
  // -------------------------------------------------------------------------

  stroke(params: DrawStrokeParams): void {
    if (!params.layerId) return;
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;

    // Embedded brush snapshots make replay independent of future preset edits.
    // ID-only operations remain supported for v1 documents and compact clients.
    if (params.brush || params.brushPresetId) {
      const preset = params.brush ?? getPresetById(params.brushPresetId!);
      const textures: { shape?: ImageBitmap; surface?: ImageBitmap } = {};
      if (preset.shapeTexture) textures.shape = getTexture(preset.shapeTexture);
      if (preset.surfaceTexture) textures.surface = getTexture(preset.surfaceTexture);
      const sizeMult = params.size / Math.max(preset.width, 1);
      renderStampStroke(ctx, preset, params.points, params.color, textures, sizeMult, {
        forceEraser: params.tool === "eraser",
        opacityOverride: params.opacity,
        seed: params.seed,
        smearSource: Math.abs(preset.smearStrength) > 0.001 ? ctx : undefined,
      });
    } else {
      StrokeEngine.drawStroke(
        ctx,
        { tool: params.tool, color: params.color, size: params.size, opacity: params.opacity },
        params.points,
      );
    }
    this.requestRender();
  }

  line(params: DrawLineParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.line(ctx, params);
    this.requestRender();
  }

  rect(params: DrawRectParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.rect(ctx, params);
    this.requestRender();
  }

  circle(params: DrawCircleParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.circle(ctx, params);
    this.requestRender();
  }

  ellipse(params: DrawEllipseParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.ellipse(ctx, params);
    this.requestRender();
  }

  async fillBucket(params: DrawFillParams): Promise<void> {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    await floodFill(ctx, this.layers.width, this.layers.height, params);
    this.requestRender();
  }

  text(params: DrawTextParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    const fontFamily = cssFontFamily(params.fontFamily);
    ShapeRenderer.text(ctx, {
      x: params.x,
      y: params.y,
      text: params.text,
      fontFamily,
      size: params.size,
      color: params.color,
      align: params.align,
      opacity: params.opacity,
    });
    this.requestRender();
  }

  setPixel(params: DrawSetPixelParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.setPixel(ctx, params.x, params.y, params.color);
    this.requestRender();
  }

  path(params: DrawPathParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.path(ctx, params);
    this.requestRender();
  }

  gradient(params: DrawGradientParams): void {
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    ShapeRenderer.gradient(ctx, params);
    this.requestRender();
  }

  async image(params: DrawImageParams): Promise<void> {
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    const response = await fetch(`/asset/${encodeURIComponent(params.assetId)}`);
    if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    this.snapshotForUndo(params.layerId);
    const width = params.width ?? bitmap.width;
    const height = params.height ?? bitmap.height;
    const centerX = params.x + width / 2;
    const centerY = params.y + height / 2;
    ctx.save();
    ctx.globalAlpha = params.opacity;
    ctx.imageSmoothingEnabled = params.smoothing;
    ctx.translate(centerX, centerY);
    ctx.rotate((params.rotate * Math.PI) / 180);
    ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
    ctx.restore();
    bitmap.close?.();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // history.*
  // -------------------------------------------------------------------------

  undo(params: { steps?: number }): { steps: number } {
    const steps = params.steps ?? 1;
    let applied = 0;
    for (let i = 0; i < steps; i++) {
      const id = this.layers.activeLayerId;
      if (!id) break;
      const current = this.layers.getLayerImageData(id);
      if (!current) break;
      const previous = this.history.undo(id, current);
      if (!previous) break;
      this.layers.setLayerImageData(id, previous);
      applied++;
    }
    this.requestRender();
    return { steps: applied };
  }

  redo(params: { steps?: number }): { steps: number } {
    const steps = params.steps ?? 1;
    let applied = 0;
    for (let i = 0; i < steps; i++) {
      const id = this.layers.activeLayerId;
      if (!id) break;
      const current = this.layers.getLayerImageData(id);
      if (!current) break;
      const next = this.history.redo(id, current);
      if (!next) break;
      this.layers.setLayerImageData(id, next);
      applied++;
    }
    this.requestRender();
    return { steps: applied };
  }

  goto(params: { index: number }): void {
    // Without a linear log we approximate: undo/redo to align undo count.
    // v2 will track a true linear history log.
    void params;
  }

  getLength() {
    return this.history.getAggregateLength();
  }

  clearHistory(): void {
    this.history.clear();
    this.onAfterChange?.();
  }

  // -------------------------------------------------------------------------
  // filter.*
  // -------------------------------------------------------------------------

  async applyFilter(
    layerId: LayerId | undefined,
    fn: (ctx: AnyCtx, width: number, height: number) => Promise<void>,
  ): Promise<void> {
    const targets = layerId
      ? [layerId]
      : this.layers.listLayers().map((l) => l.id);
    for (const id of targets) {
      this.snapshotForUndo(id);
      const ctx = this.getCtx(id);
      if (!ctx) continue;
      await fn(ctx, this.layers.width, this.layers.height);
    }
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Snapshot for persistence
  // -------------------------------------------------------------------------

  async snapshot(): Promise<{ png: BufferShim; width: number; height: number }> {
    const blob = await this.layers.exportComposite("png");
    const png = await blobToBase64(blob);
    return { png, width: this.layers.width, height: this.layers.height };
  }
}

type BufferShim = string;

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip "data:image/png;base64," prefix
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function cssFontFamily(name: string): string {
  switch (name) {
    case "noto-sans":
      return "'Noto Sans', sans-serif";
    case "source-han-sans":
      return "'Source Han Sans CN', 'Noto Sans CJK SC', sans-serif";
    case "monospace":
      return "monospace";
    default:
      return name;
  }
}
