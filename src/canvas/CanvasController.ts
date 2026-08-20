import { LayerStack } from "./LayerStack.js";
import { HistoryStack } from "./HistoryStack.js";
import { StrokeEngine } from "./StrokeEngine.js";
import { renderStroke as renderStampStroke } from "./StampEngine.js";
import { ShapeRenderer } from "./ShapeRenderer.js";
import { floodFill } from "./FillEngine.js";
import { FilterEngine } from "./FilterEngine.js";
import { analyzePixels, samplePixels } from "./CanvasAnalyzer.js";
import { tracePathCommands } from "./ShapeRenderer.js";
import { ALL_BRUSHES, getById as getPresetById, getByNameOrId } from "../brush/BrushPresets.js";
import { loadTexture } from "../brush/TextureLoader.js";
import { WatercolorSim, type WatercolorSplat } from "./WatercolorSim.js";
import { handStroke, handBroken, handHatchFill, handScribbleFill, handPencilFill, handStippleFill, PEN_PRESETS } from "./HandEngine.js";
import * as PortraitEngine from "./PortraitEngine.js";
import { buildSlotLoads } from "../brush/WatercolorPigments.js";
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
  HandFillParams,
  LayerTransformParams,
  BlendMode,
  Layer,
  LayerId,
} from "../../shared/protocol.js";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Flatten PathCommand[] (M/L/Q/C/Z) to a polyline point list for fill regions. */
function pathCommandsToPts(cmds: { op: string; x?: number; y?: number; cx?: number; cy?: number; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[]): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let cx = 0, cy = 0;
  for (const c of cmds) {
    if (c.op === "M" || c.op === "L") {
      cx = c.x ?? cx; cy = c.y ?? cy;
      pts.push([cx, cy]);
    } else if (c.op === "Q" && c.cx !== undefined && c.cy !== undefined && c.x !== undefined && c.y !== undefined) {
      const [x0, y0] = pts[pts.length - 1] ?? [cx, cy];
      const qx = c.cx, qy = c.cy, qxe = c.x, qye = c.y;
      for (let i = 1; i <= 6; i++) {
        const t = i / 6, u = 1 - t;
        pts.push([u * u * x0 + 2 * u * t * qx + t * t * qxe, u * u * y0 + 2 * u * t * qy + t * t * qye]);
      }
      cx = qxe; cy = qye;
    } else if (c.op === "C" && c.c1x !== undefined && c.c1y !== undefined && c.c2x !== undefined && c.c2y !== undefined && c.x !== undefined && c.y !== undefined) {
      const [x0, y0] = pts[pts.length - 1] ?? [cx, cy];
      const c1x = c.c1x, c1y = c.c1y, c2x = c.c2x, c2y = c.c2y, c3x = c.x, c3y = c.y;
      for (let i = 1; i <= 8; i++) {
        const t = i / 8, u = 1 - t;
        pts.push([u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * c3x,
                  u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * c3y]);
      }
      cx = c3x; cy = c3y;
    } else if (c.op === "Z" && pts.length) {
      pts.push([pts[0][0], pts[0][1]]);
    }
  }
  return pts;
}

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
  /** Live watercolor simulations keyed by layer id (raster layers whose
   *  pixels are the K-M composite of the sim while wet). */
  private watercolorSims = new Map<LayerId, WatercolorSim>();
  readonly history: HistoryStack;
  readonly renderCanvas: HTMLCanvasElement;
  private renderCtx: CanvasRenderingContext2D;
  private renderScheduled = false;
  private renderSuspendDepth = 0;
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
    if (this.renderSuspendDepth > 0) return;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.renderSuspendDepth > 0) return;
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

  /** Defer expensive full-layer compositing until a mutation batch is done. */
  async withoutIntermediateRendering<T>(operation: () => T | Promise<T>): Promise<T> {
    this.renderSuspendDepth += 1;
    try {
      return await operation();
    } finally {
      this.renderSuspendDepth -= 1;
      if (this.renderSuspendDepth === 0) this.requestRender();
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
    if (params.region) return sampleRegion(image, params.region);
    return samplePixels(image, params.points!);
  }

  /**
   * Offscreen brush calibration: render one horizontal stroke per opacity for
   * each preset and measure deltaL / coverage against the white background.
   * Exposes silent engine degradation (missing textures, dead presets) and
   * lets agents pick opacity curves empirically.
   */
  async brushSelfTest(params: {
    presets?: string[];
    size?: number;
    opacities?: number[];
  }): Promise<{ background: { r: number; g: number; b: number; a: number }; tests: { id: string; name: string; results: { opacity: number; deltaL: number; coverage: number }[] }[] }> {
    const size = params.size ?? 8;
    const opacities = params.opacities?.length ? params.opacities : [0.2, 0.5, 0.8];
    const queries = params.presets?.length ? params.presets : ALL_BRUSHES.map((b) => b.name);
    const band = Math.ceil(size * 2.5);
    const rowH = band + 14;
    const tests: { id: string; name: string; results: { opacity: number; deltaL: number; coverage: number }[] }[] = [];
    for (const query of queries) {
      const preset = getByNameOrId(query);
      await Promise.all(
        [preset.shapeTexture, preset.surfaceTexture].filter(Boolean).map((n) => loadTexture(n as string)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = 220;
      canvas.height = rowH * opacities.length;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const results: { opacity: number; deltaL: number; coverage: number }[] = [];
      for (let i = 0; i < opacities.length; i++) {
        const y = i * rowH + band / 2;
        const textures: { shape?: ImageBitmap; surface?: ImageBitmap } = {};
        if (preset.shapeTexture) textures.shape = getTexture(preset.shapeTexture);
        if (preset.surfaceTexture) textures.surface = getTexture(preset.surfaceTexture);
        // Pressure sweep 0.12 -> 0.95: dynamic brushes (pressReverse nibs,
        // low-flow airbrushes) hit their bold zone somewhere on the ramp, so
        // a single fixed pressure can never misjudge them as dead.
        const sweep = [];
        for (let k = 0; k <= 12; k++) {
          sweep.push({ x: 20 + (k / 12) * 180, y: y + Math.sin(k) * 0.5, pressure: 0.12 + (k / 12) * 0.83 });
        }
        renderStampStroke(ctx, preset, sweep, "#323232", textures, size / Math.max(preset.width, 1), {
          opacityOverride: opacities[i],
          seed: 7,
        });
        // measure band
        const data = ctx.getImageData(0, i * rowH, canvas.width, band).data;
        let sum = 0;
        let covered = 0;
        let n = 0;
        for (let py = 0; py < band; py++) {
          for (let px = 0; px < canvas.width; px++) {
            const o = (py * canvas.width + px) * 4;
            const l = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
            const d = 255 - l; // vs white
            n++;
            if (d > 8) {
              covered++;
              sum += d;
            }
          }
        }
        results.push({
          opacity: opacities[i],
          deltaL: covered ? +(sum / covered).toFixed(1) : 0,
          coverage: n ? +(covered / n).toFixed(3) : 0,
        });
      }
      tests.push({ id: preset.id, name: preset.name, results });
    }
    return {
      background: { r: 255, g: 255, b: 255, a: 255 },
      tests,
    };
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

  async stroke(params: DrawStrokeParams): Promise<void> {
    if (!params.layerId) return;
    if (params.tool === "watercolor") return this.watercolorStroke(params);
    if (params.tool === "hand") return this.handStrokeDraw(params);
    // RPC strokes bypass UI selection; make sure stamp textures are loaded
    // instead of silently falling back to the procedural mask.
    const texNames = [params.brush?.shapeTexture, params.brush?.surfaceTexture].filter(Boolean) as string[];
    if (texNames.length) await Promise.all(texNames.map((n) => loadTexture(n)));
    this.snapshotForUndo(params.layerId);
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;

    // Embedded brush snapshots make replay independent of future preset edits.
    // ID-only operations remain supported for v1 documents and compact clients.
    const clipRestore = applyClipMask(ctx, params.clip);
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
    if (clipRestore) ctx.restore();
    this.requestRender();
  }

  private async watercolorStroke(params: DrawStrokeParams): Promise<void> {
    const layerId = params.layerId!;
    let sim = this.watercolorSims.get(layerId);
    if (!sim) {
      const layer = this.layers.listLayers().find(l => l.id === layerId);
      const w = layer ? this.layers.width : this.layers.width;
      const scale = Math.min(1, 1024 / Math.max(w, this.layers.height));
      sim = new WatercolorSim(Math.round(this.layers.width * scale), Math.round(this.layers.height * scale));
      this.watercolorSims.set(layerId, sim);
    }
    this.snapshotForUndo(layerId);
    const mix = params.pigments ?? [];
    const slots = buildSlotLoads(mix, params.water ?? 0.5);
    sim.setSlots(slots);
    const mode: 0 | 1 | 2 = (params.tool === "watercolor" ? 0 : 0) as 0;
    const water = params.water ?? 0.5;
    // spatial stamping: a splat lands every 0.38r of travel
    const r = Math.max(4, params.size * 0.5) / (sim.W / this.layers.width);
    const wPer = 0.02 + 0.22 * water * water;
    const splats: WatercolorSplat[] = [];
    let sx: number | null = null, sy = 0;
    const spacing = Math.max(r * 0.38, 1.5);
    const toSim = (p: { x: number; y: number }) => ({
      x: (p.x / this.layers.width) * sim!.W,
      y: (1 - p.y / this.layers.height) * sim!.H,
    });
    for (let i = 0; i < params.points.length; i++) {
      const cur = params.points[i]!;
      const sim1 = toSim(cur);
      if (i === 0) {
        splats.push({ x: sim1.x, y: sim1.y, r, water: wPer, vx: 0, vy: 0 });
        sx = sim1.x; sy = sim1.y;
        continue;
      }
      const prev = toSim(params.points[i - 1]!);
      const dx = sim1.x - prev.x, dy = sim1.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const kick = Math.min(1.2, len * 0.06);
      const vx = (dx / len) * kick, vy = (dy / len) * kick;
      const n = Math.max(1, Math.ceil(len / (spacing / 3)));
      for (let j = 1; j <= n; j++) {
        const x = prev.x + (dx * j) / n;
        const y = prev.y + (dy * j) / n;
        if (sx === null || Math.hypot(x - sx, y - sy) >= spacing) {
          splats.push({ x, y, r, water: wPer, vx, vy });
          sx = x; sy = y;
        }
      }
    }
    const toolMode: 0 | 1 | 2 = mix.length === 0 && water > 0.85 ? 1 : mode;
    // Temporal application: a real stroke dwells, so the brush keeps pumping
    // splats (radial splat-out impulses) into the puddle over time. One-shot
    // dumping produces a tight bead; interleaving small chunks with sim steps
    // reproduces the sustained outward drive of a live drag.
    const CHUNK = 1;
    for (let i = 0; i < splats.length; i += CHUNK) {
      sim.stroke({
        mode: toolMode,
        water,
        splats: splats.slice(i, i + CHUNK),
        pig0: slots.loads.slice(0, 4),
        pig1: slots.loads.slice(4, 8),
      });
    }
    this.compositeWatercolor(layerId, sim);
  }

  /** Blit the sim's K-M composite onto the layer's 2D canvas. */
  private compositeWatercolor(layerId: LayerId, sim: WatercolorSim): void {
    const ctx = this.getCtx(layerId);
    if (!ctx) return;
    sim.render();
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      sim.canvas as CanvasImageSource,
      0, 0, sim.W, sim.H,
      0, 0, this.layers.width, this.layers.height,
    );
    ctx.restore();
    this.requestRender();
  }

  watercolorDry(layerId: LayerId): boolean {
    const sim = this.watercolorSims.get(layerId);
    if (!sim) return false;
    this.snapshotForUndo(layerId);
    // evaporate hard: many ticks, then fix the wash into the ground
    sim.step(240);
    sim.bake();
    this.compositeWatercolor(layerId, sim);
    return true;
  }

  watercolorStep(layerId: LayerId, frames: number): boolean {
    const sim = this.watercolorSims.get(layerId);
    if (!sim) return false;
    sim.step(frames);
    this.compositeWatercolor(layerId, sim);
    return true;
  }

  watercolorSetPaper(layerId: LayerId, preset: string, seed?: number): boolean {
    const sim = this.watercolorSims.get(layerId);
    if (!sim) return false;
    sim.setPaper(preset, seed ?? 7.31);
    sim.clearAll();
    this.compositeWatercolor(layerId, sim);
    return true;
  }

  watercolorProbe(layerId: LayerId, x: number, y: number) {
    const sim = this.watercolorSims.get(layerId);
    if (!sim) return null;
    return sim.probe(x, y);
  }

  /** Five-layer hand-error synthesis stroke (see HandEngine). */
  private handStrokeDraw(params: DrawStrokeParams): void {
    const ctx = this.getCtx(params.layerId!);
    if (!ctx) return;
    this.snapshotForUndo(params.layerId!);
    const h = params.hand ?? {};
    const pts: Array<[number, number]> = params.points.map(p => [p.x, p.y]);
    const hex = params.color ?? "#000000";
    const color: [number, number, number] = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    // v2: pen preset expansion (a-dude port)
    const pen = h.pen ? PEN_PRESETS[h.pen] : undefined;
    const opts = {
      seed: params.seed ?? 1,
      color,
      alpha: params.opacity,
      amp: h.amp,
      taper: h.taper,
      over: h.over,
      crumbs: h.crumbs,
      ghost: h.ghost ?? (h.style === "ghost" ? 0.75 : 0.35),
      wedge: h.wedge ?? h.style === "wedge",
      press: h.press ?? pen?.press,
      dry: h.dry ?? pen?.dry,
      pool: h.pool ?? pen?.pool,
      split: h.split ?? pen?.split,
      bite: h.bite ?? pen?.bite,
      fbm: h.fbm ?? (pen !== undefined),
    };
    const w = params.size;
    if (h.style === "broken") {
      handBroken(ctx, pts, w, { ...opts, over: opts.over ?? w * 0.6 });
    } else if (h.style === "clean") {
      handStroke(ctx, pts, w, { ...opts, crumbs: false, ghost: 0, amp: h.amp ?? 1.2 });
    } else {
      handStroke(ctx, pts, w, { ...opts, over: opts.over ?? w * 0.7 });
    }
    this.requestRender();
  }

  /** Four hand-drawn fill styles, all rendered inside a clip region. */
  handFill(params: HandFillParams): void {
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return;
    this.snapshotForUndo(params.layerId);
    const region = pathCommandsToPts(params.region);
    if (region.length < 3) return;
    const hex = params.color ?? "#1F1D1A";
    const color: [number, number, number] = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const opts = { seed: params.seed ?? 1, color };
    switch (params.kind) {
      case "pencil":
        handPencilFill(ctx, region, params.darkness ?? 0.8, opts);
        break;
      case "hatch":
        handHatchFill(ctx, region, params.spacing ?? 8, params.ang ?? 0.9, params.alpha, params.width, opts);
        break;
      case "scribble":
        handScribbleFill(ctx, region, params.spacing ?? 6, params.alpha, opts);
        break;
      case "stipple":
        handStippleFill(ctx, region, params.spacing ?? 5, params.alpha, opts);
        break;
    }
    this.requestRender();
  }

  /** programmatic portrait casting — five-axis person → skull → quirk → features. */
  portraitDraw(params: import("../../shared/protocol.js").PortraitDrawParams): { spec: unknown } {
    const ctx = this.getCtx(params.layerId);
    if (!ctx) return { spec: null };
    this.snapshotForUndo(params.layerId);
    const { drawPortrait, castPortrait } = PortraitEngine;
    drawPortrait(ctx, params.seed, params.x, params.y, params.size, { ink: params.ink, paper: params.paper });
    const spec = castPortrait(params.seed);
    this.requestRender();
    return { spec };
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


// ---------------------------------------------------------------------------
// Clip mask / region sampling helpers
// ---------------------------------------------------------------------------

type ClipCtx = Parameters<typeof tracePathCommands>[0] & { save(): void; restore(): void; beginPath(): void; clip(): void };
function applyClipMask(
  ctx: ClipCtx,
  clip?: { op: string; x?: number; y?: number; cx?: number; cy?: number; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[],
): boolean {
  if (!clip?.length) return false;
  ctx.save();
  ctx.beginPath();
  tracePathCommands(ctx, clip);
  ctx.clip();
  return true;
}

/** Sample every stride-th pixel of a region (bounded to 4096 samples). */
function sampleRegion(
  image: ImageData,
  region: { x: number; y: number; w: number; h: number; stride: number },
): { samples: { x: number; y: number; color: { r: number; g: number; b: number; a: number; hex: string } }[] } {
  const stride = Math.max(1, region.stride);
  let cols = Math.ceil(region.w / stride);
  let rows = Math.ceil(region.h / stride);
  const cap = 4096;
  let effStride = stride;
  if (cols * rows > cap) {
    effStride = Math.max(stride, Math.ceil(Math.sqrt((region.w * region.h) / cap)));
    cols = Math.ceil(region.w / effStride);
    rows = Math.ceil(region.h / effStride);
  }
  const samples: { x: number; y: number; color: { r: number; g: number; b: number; a: number; hex: string } }[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const px = region.x + Math.min(i * effStride, region.w - 1);
      const py = region.y + Math.min(j * effStride, region.h - 1);
      const o = (py * image.width + px) * 4;
      const r = image.data[o], g = image.data[o + 1], b = image.data[o + 2];
      samples.push({
        x: px,
        y: py,
        color: {
          r,
          g,
          b,
          a: image.data[o + 3],
          hex: "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""),
        },
      });
    }
  }
  return { samples };
}
