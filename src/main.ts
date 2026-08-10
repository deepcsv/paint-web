import { WSClient } from "./net/WSClient.js";
import { CanvasController } from "./canvas/CanvasController.js";
import { PointerHandler, type Tool } from "./input/PointerHandler.js";
import { Toolbar } from "./ui/Toolbar.js";
import { ColorPicker } from "./ui/ColorPicker.js";
import { BrushPanel } from "./ui/BrushPanel.js";
import { preloadTextures, getTexture } from "./brush/TextureLoader.js";
import type { BrushPreset } from "./brush/BrushTypes.js";
import { renderStrokeLive } from "./canvas/StampEngine.js";
import { SizeSlider } from "./ui/SizeSlider.js";
import { LayerPanel } from "./ui/LayerPanel.js";
import { StatusBar } from "./ui/StatusBar.js";
import type {
  DocumentReplaySnapshot,
  DocumentStateSnapshot,
  DrawStrokeInput,
} from "../shared/protocol.js";

const CLIENT_ID_KEY = "paint-web.clientId";
const SEQ_KEY = "paint-web.lastEventSeq";

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = "B_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const connStatus = document.getElementById("conn-status")!;
const primaryStatus = document.getElementById("primary-status")!;
const seqStatus = document.getElementById("seq-status")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

const toolbar = new Toolbar(document.getElementById("toolbar")!);
const colorPicker = new ColorPicker(document.getElementById("color-picker")!);
const sizeSlider = new SizeSlider(document.getElementById("size-slider")!);
const brushPanel = new BrushPanel(document.getElementById("brush-panel")!);

// Active brush preset — BrushPanel initializes this to the pencil preset.
let activeBrushPreset: BrushPreset | null = null;

function createStrokeSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]!;
}

// Brush panel selection
brushPanel.onChange((preset) => {
  activeBrushPreset = preset;
  const textureNames = [preset.shapeTexture, preset.surfaceTexture].filter(Boolean);
  if (textureNames.length > 0) void preloadTextures(textureNames);
  console.log("[brush] selected:", preset.name, "id:", preset.id);
});
const layerPanel = new LayerPanel(document.getElementById("layer-panel")!);
const statusBar = new StatusBar(document.getElementById("status-bar")!);
const actions = document.getElementById("actions")!;

// ---------------------------------------------------------------------------
// Canvas controller + state
// ---------------------------------------------------------------------------
const controller = new CanvasController(1280, 720, canvas);

function refreshLayerPanel(): void {
  const info = controller.getInfo();
  layerPanel.update(info.layers, info.activeLayerId);
  statusBar.setCanvasInfo(info.width, info.height);
  const active = info.layers.find((l) => l.id === info.activeLayerId);
  statusBar.setActiveLayer(info.activeLayerId, active?.name);
}
refreshLayerPanel();

layerPanel.setHandlers({
  onSelect: (id) => {
    void wsClient.request("layer.setActive", { layerId: id }).catch(console.warn);
  },
  onToggleVisible: (id, visible) => {
    void wsClient.request("layer.setVisible", { layerId: id, visible }).catch(console.warn);
  },
  onSetOpacity: (id, opacity) => {
    void wsClient.request("layer.setOpacity", { layerId: id, opacity }).catch(console.warn);
  },
  onRename: (id, name) => {
    void wsClient.request("layer.rename", { layerId: id, name }).catch(console.warn);
  },
  onAdd: async () => {
    const layerId = "L_" + Math.random().toString(36).slice(2, 10);
    const name = `Layer ${controller.getInfo().layers.length + 1}`;
    void wsClient.request("layer.create", { layerId, name }).catch(console.warn);
  },
  onDelete: async (id) => {
    // Deletion is server-authoritative so the final-layer invariant cannot
    // leave the local browser in a state the server rejected.
    await wsClient.request("layer.delete", { layerId: id }).catch(console.warn);
  },
});

// ---------------------------------------------------------------------------
// Pointer handling for live drawing
// ---------------------------------------------------------------------------
interface PendingStroke {
  tool: "brush" | "eraser";
  color: string;
  size: number;
  opacity: number;
  points: { x: number; y: number; pressure?: number }[];
  layerId: string | null;
  brush: BrushPreset | null;
  seed: number;
}

let pendingStroke: PendingStroke | null = null;
let shapeStart: { x: number; y: number } | null = null;
let shapeEnd: { x: number; y: number } | null = null;

// Overlay canvas for shape-tool live preview (line/rect/circle/ellipse).
// Without this, dragging a shape tool shows nothing until pointerup.
const overlay = document.createElement("canvas");
overlay.width = canvas.width;
overlay.height = canvas.height;
overlay.style.position = "absolute";
overlay.style.left = "0";
overlay.style.top = "0";
overlay.style.width = "100%";
overlay.style.height = "100%";
overlay.style.pointerEvents = "none";
overlay.style.zIndex = "2";
// The wrapper centers the canvas; we attach overlay next to it and sync size via ResizeObserver
const wrapper = document.getElementById("canvas-wrapper")!;
// Position overlay exactly on top of the canvas
const canvasRectSync = () => {
  if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
  }
  const r = canvas.getBoundingClientRect();
  const wr = wrapper.getBoundingClientRect();
  overlay.style.left = `${r.left - wr.left}px`;
  overlay.style.top = `${r.top - wr.top}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;
};
wrapper.style.position = wrapper.style.position || "relative";
wrapper.appendChild(overlay);
const overlayCtx = overlay.getContext("2d")!;
const ro = new ResizeObserver(canvasRectSync);
ro.observe(canvas);
ro.observe(wrapper);
canvasRectSync();

function clearOverlay(): void {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

function drawShapePreview(tool: "line" | "rect" | "circle" | "ellipse", a: { x: number; y: number }, b: { x: number; y: number }): void {
  clearOverlay();
  const color = colorPicker.getColor();
  const size = Math.max(1, sizeSlider.getSize());
  overlayCtx.save();
  overlayCtx.strokeStyle = color;
  overlayCtx.fillStyle = color + "40"; // 25% alpha fill for visibility
  overlayCtx.lineWidth = size;
  overlayCtx.lineCap = "round";
  overlayCtx.lineJoin = "round";
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (tool === "line") {
    overlayCtx.beginPath();
    overlayCtx.moveTo(a.x, a.y);
    overlayCtx.lineTo(b.x, b.y);
    overlayCtx.stroke();
  } else if (tool === "rect") {
    overlayCtx.fillRect(minX, minY, w, h);
    overlayCtx.strokeRect(minX, minY, w, h);
  } else if (tool === "ellipse") {
    overlayCtx.beginPath();
    overlayCtx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    overlayCtx.fill();
    overlayCtx.stroke();
  } else if (tool === "circle") {
    const r = Math.max(w, h) / 2;
    overlayCtx.beginPath();
    overlayCtx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, r, 0, Math.PI * 2);
    overlayCtx.fill();
    overlayCtx.stroke();
  }
  overlayCtx.restore();
}

function drawStrokePreview(stroke: PendingStroke): void {
  clearOverlay();
  if (stroke.points.length === 0) return;

  // If a brush preset is active, use the stamp engine for live preview.
  // This gives a true representation of what the committed stroke will look like.
  if (stroke.brush) {
    const preset = stroke.brush;
    const textures: { shape?: ImageBitmap; surface?: ImageBitmap } = {};
    if (preset.shapeTexture) textures.shape = getTexture(preset.shapeTexture);
    if (preset.surfaceTexture) textures.surface = getTexture(preset.surfaceTexture);
    const sizeMult = stroke.size / Math.max(preset.width, 1);
    const smearSource = Math.abs(preset.smearStrength) > 0.001 && stroke.layerId
      ? controller.layers.getLayer(stroke.layerId)?.ctx
      : undefined;
    renderStrokeLive(overlayCtx, preset, stroke.points, stroke.color, textures, sizeMult, {
      forceEraser: stroke.tool === "eraser",
      opacityOverride: stroke.opacity,
      seed: stroke.seed,
      smearSource,
    });
    return;
  }

  // Fallback: simple line preview when no preset is selected
  overlayCtx.save();
  overlayCtx.globalAlpha = stroke.tool === "eraser" ? 0.7 : stroke.opacity;
  overlayCtx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
  overlayCtx.fillStyle = overlayCtx.strokeStyle;
  overlayCtx.lineCap = "round";
  overlayCtx.lineJoin = "round";
  overlayCtx.lineWidth = stroke.size;
  if (stroke.tool === "eraser") overlayCtx.setLineDash([Math.max(2, stroke.size), Math.max(2, stroke.size / 2)]);
  overlayCtx.beginPath();
  const first = stroke.points[0]!;
  overlayCtx.moveTo(first.x, first.y);
  for (let index = 1; index < stroke.points.length; index++) {
    const point = stroke.points[index]!;
    overlayCtx.lineTo(point.x, point.y);
  }
  if (stroke.points.length === 1) {
    overlayCtx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
    overlayCtx.fill();
  } else {
    overlayCtx.stroke();
  }
  overlayCtx.restore();
}

const pointer = new PointerHandler({
  canvas,
  displayWidth: canvas.clientWidth,
  displayHeight: canvas.clientHeight,
  canvasWidth: canvas.width,
  canvasHeight: canvas.height,
  onStrokeStart: (p) => {
    statusBar.setPos(p.x, p.y);
    const tool = toolbar.getTool();
    const layerId = controller.layers.activeLayerId;
    console.log("[stroke] start tool=", tool, "layerId=", layerId, "p=", p);
    if (!layerId) return;

    if (tool === "fill") {
      void (async () => {
        await wsClient.request("draw.fill", {
          layerId,
          x: p.x,
          y: p.y,
          color: colorPicker.getColor(),
          tolerance: 16,
        });
        // Server-side handlers will route to primary (us) via internal.exec,
        // which will apply the change. Refresh is automatic via onAfterChange.
      })();
      return;
    }

    if (tool === "setPixel") {
      // A 1x1 pixel is invisible on a 1280x720 canvas (especially when the
      // browser CSS-scales the canvas down). Treat the Pixel tool as a
      // size-slider-controlled square stamp instead — click places a
      // square of the selected size, centered on the click point.
      // For true single-pixel control, agents can still call the
      // draw.setPixel RPC directly (it remains 1x1 in the protocol).
      const sz = Math.max(1, sizeSlider.getSize());
      void wsClient.request("draw.rect", {
        layerId,
        x: p.x - Math.floor(sz / 2),
        y: p.y - Math.floor(sz / 2),
        w: sz,
        h: sz,
        fill: colorPicker.getColor(),
        // strokeWidth must be > 0 (zod schema), but no stroke color means
        // no stroke is drawn anyway.
        strokeWidth: 1,
      }).catch(console.warn);
      return;
    }

    if (tool === "text") {
      const text = prompt("Enter text:");
      if (text) {
        void wsClient.request("draw.text", {
          layerId,
          x: p.x,
          y: p.y,
          text,
          fontFamily: "noto-sans",
          size: sizeSlider.getSize(),
          color: colorPicker.getColor(),
        });
      }
      return;
    }

    if (tool === "line" || tool === "rect" || tool === "circle" || tool === "ellipse") {
      shapeStart = { x: p.x, y: p.y };
      shapeEnd = { x: p.x, y: p.y };
      return;
    }

    // brush or eraser — start collecting points
    pendingStroke = {
      tool: tool as "brush" | "eraser",
      color: colorPicker.getColor(),
      size: sizeSlider.getSize(),
      opacity: 1,
      points: [p],
      layerId,
      brush: activeBrushPreset,
      seed: createStrokeSeed(),
    };
  },
  onStrokeSegment: (p) => {
    statusBar.setPos(p.x, p.y);
    // Shape tools: update overlay preview
    if (shapeStart) {
      shapeEnd = { x: p.x, y: p.y };
      const tool = toolbar.getTool();
      if (tool === "line" || tool === "rect" || tool === "circle" || tool === "ellipse") {
        drawShapePreview(tool, shapeStart, shapeEnd);
      }
      return;
    }
    if (pendingStroke) {
      pendingStroke.points.push(p);
      drawStrokePreview(pendingStroke);
    }
  },
  onStrokeEnd: () => {
    // Shape tools: commit final shape via RPC, then clear overlay
    if (shapeStart && shapeEnd) {
      const tool = toolbar.getTool();
      const layerId = controller.layers.activeLayerId;
      const color = colorPicker.getColor();
      const size = Math.max(1, sizeSlider.getSize());
      const a = shapeStart;
      const b = shapeEnd;
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);

      // Hide preview before RPC; the actual draw will arrive via internal.exec
      // routed back to this same browser (since we're primary).
      clearOverlay();

      if (layerId) {
        if (tool === "line") {
          void wsClient.request("draw.line", {
            layerId,
            from: { x: a.x, y: a.y },
            to: { x: b.x, y: b.y },
            color,
            size,
          }).catch(console.warn);
        } else if (tool === "rect") {
          void wsClient.request("draw.rect", {
            layerId,
            x: minX,
            y: minY,
            w,
            h,
            stroke: color,
            fill: color + "40",
            strokeWidth: size,
          }).catch(console.warn);
        } else if (tool === "ellipse") {
          void wsClient.request("draw.ellipse", {
            layerId,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            rx: w / 2,
            ry: h / 2,
            stroke: color,
            fill: color + "40",
            strokeWidth: size,
          }).catch(console.warn);
        } else if (tool === "circle") {
          const r = Math.max(w, h) / 2;
          void wsClient.request("draw.circle", {
            layerId,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            r,
            stroke: color,
            fill: color + "40",
            strokeWidth: size,
          }).catch(console.warn);
        }
      }
      shapeStart = null;
      shapeEnd = null;
      return;
    }
    shapeStart = null;
    shapeEnd = null;

    if (pendingStroke) {
      clearOverlay();
      const pts = pendingStroke.points;
      const params: DrawStrokeInput = {
        layerId: pendingStroke.layerId!,
        tool: pendingStroke.tool,
        color: pendingStroke.color,
        size: pendingStroke.size,
        opacity: pendingStroke.opacity,
        points: pts,
        seed: pendingStroke.seed,
        strokeVersion: 2,
        // Store an immutable brush snapshot so future preset tuning cannot
        // change the pixels produced by replaying this operation.
        ...(pendingStroke.brush
          ? { brushPresetId: pendingStroke.brush.id, brush: pendingStroke.brush }
          : {}),
      };
      void wsClient.request("draw.stroke", params).catch(console.warn);
      pendingStroke = null;
    }
  },
  onClick: () => {},
  onMove: (p) => {
    statusBar.setPos(p.x, p.y);
  },
});

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------
actions.addEventListener("click", (e) => {
  const btn = e.target as HTMLButtonElement;
  if (!btn.dataset.action) return;
  switch (btn.dataset.action) {
    case "undo":
      void wsClient.request("doc.undo", { steps: 1 }).catch(console.warn);
      break;
    case "redo":
      void wsClient.request("doc.redo", { steps: 1 }).catch(console.warn);
      break;
    case "clear":
      if (confirm("Clear canvas?")) {
        void wsClient.request("canvas.clear", {}).catch(console.warn);
      }
      break;
    case "export":
      void (async () => {
        const result = await wsClient.request<{ url: string }>("canvas.export", {
          format: "png",
        });
        const a = document.createElement("a");
        a.href = result.url;
        a.download = "canvas.png";
        a.click();
      })();
      break;
  }
});

// ---------------------------------------------------------------------------
// WS client + RPC routing when this browser is primary
// ---------------------------------------------------------------------------
controller.setOnAfterChange(refreshLayerPanel);

// Register primary RPC handlers — when server proxies a draw.* to us, we
// dispatch by method name.
const internalHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
// Wrap each handler with a debug log so we can see what's actually being
// dispatched to the primary browser. Drop these once stable.
function wrapHandler<T>(name: string, fn: (p: T) => unknown): (p: unknown) => unknown {
  return (p: unknown) => {
    const params = p as { layerId?: string };
    if (!name.startsWith("draw.")) {
      console.log(`[primary] exec ${name}`, params?.layerId ? `layer=${params.layerId}` : "(no layer)");
    }
    return fn(p as T);
  };
}

internalHandlers.set("canvas.getInfo", wrapHandler("canvas.getInfo", () => controller.getInfo()));
internalHandlers.set("canvas.resize", (p) => controller.resize(p as never));
internalHandlers.set("canvas.clear", (p) => controller.clear(p as never));
internalHandlers.set("canvas.fill", (p) => controller.fill(p as never));
internalHandlers.set("canvas.export", async (p) => {
  const params = p as { format: "png" | "jpeg"; quality?: number; layerId?: string };
  if (params.layerId) return await controller.exportLayer({ ...params, layerId: params.layerId });
  return await controller.exportComposite(params);
});
internalHandlers.set("canvas.getRegion", (p) => controller.getRegion(p as never));
internalHandlers.set("canvas.import", (p) => controller.import(p as never));
internalHandlers.set("canvas.analyze", (p) => controller.analyze(p as never));
internalHandlers.set("canvas.sample", (p) => controller.sample(p as never));
internalHandlers.set("layer.create", (p) => {
  const r = controller.createLayer(p as never);
  refreshLayerPanel();
  return r;
});
internalHandlers.set("layer.delete", (p) => {
  controller.deleteLayer(p as never);
  refreshLayerPanel();
});
internalHandlers.set("layer.setActive", (p) => {
  controller.setActive(p as never);
  refreshLayerPanel();
});
internalHandlers.set("layer.setVisible", (p) => controller.setVisible(p as never));
internalHandlers.set("layer.setOpacity", (p) => controller.setOpacity(p as never));
internalHandlers.set("layer.setBlendMode", (p) => controller.setBlendMode(p as never));
internalHandlers.set("layer.rename", (p) => {
  controller.rename(p as never);
  refreshLayerPanel();
});
internalHandlers.set("layer.reorder", (p) => {
  controller.reorder(p as never);
  refreshLayerPanel();
});
internalHandlers.set("layer.merge", (p) => {
  controller.merge(p as never);
  refreshLayerPanel();
});
internalHandlers.set("layer.flatten", (p) => {
  const result = controller.flatten(p as { layerId?: string } | undefined);
  refreshLayerPanel();
  return result;
});
internalHandlers.set("layer.transform", (p) => controller.transformLayer(p as never));
internalHandlers.set("draw.stroke", wrapHandler("draw.stroke", (p: never) => controller.stroke(p)));
internalHandlers.set("draw.line", wrapHandler("draw.line", (p: never) => controller.line(p)));
internalHandlers.set("draw.rect", wrapHandler("draw.rect", (p: never) => controller.rect(p)));
internalHandlers.set("draw.circle", wrapHandler("draw.circle", (p: never) => controller.circle(p)));
internalHandlers.set("draw.ellipse", wrapHandler("draw.ellipse", (p: never) => controller.ellipse(p)));
internalHandlers.set("draw.fill", wrapHandler("draw.fill", (p: never) => controller.fillBucket(p)));
internalHandlers.set("draw.text", wrapHandler("draw.text", (p: never) => controller.text(p)));
internalHandlers.set("draw.setPixel", (p) => controller.setPixel(p as never));
internalHandlers.set("draw.path", (p) => controller.path(p as never));
internalHandlers.set("draw.gradient", (p) => controller.gradient(p as never));
internalHandlers.set("draw.image", (p) => controller.image(p as never));
internalHandlers.set("draw.batch", async (p) => {
  const { operations } = p as { operations: { method: string; params: unknown }[] };
  const results: ({ ok: true } | { code: number; message: string })[] = [];
  await controller.withoutHistory(() =>
    controller.withoutIntermediateRendering(async () => {
      for (const [index, operation] of operations.entries()) {
        const handler = operation.method === "draw.batch"
          ? undefined
          : internalHandlers.get(operation.method);
        if (!handler) {
          results.push({ code: -32601, message: `No handler for ${operation.method}` });
        } else {
          try {
            await handler(operation.params);
            results.push({ ok: true });
          } catch (error) {
            results.push({
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if ((index + 1) % 24 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    }),
  );
  refreshLayerPanel();
  return { results };
});
internalHandlers.set("history.undo", (p) => controller.undo(p as never));
internalHandlers.set("history.redo", (p) => controller.redo(p as never));
internalHandlers.set("history.goto", (p) => controller.goto(p as never));
internalHandlers.set("history.getLength", () => controller.getLength());
internalHandlers.set("history.clear", () => controller.clearHistory());
internalHandlers.set("filter.blur", (p) => {
  const params = p as { layerId?: string; radius: number };
  return controller.applyFilter(params.layerId, async (ctx, w, h) => {
    const m = await import("./canvas/FilterEngine.js");
    await m.FilterEngine.blur(ctx, w, h, params.radius);
  });
});
internalHandlers.set("filter.invert", (p) => {
  const params = p as { layerId?: string };
  return controller.applyFilter(params.layerId, async (ctx, w, h) => {
    const m = await import("./canvas/FilterEngine.js");
    await m.FilterEngine.invert(ctx, w, h);
  });
});
internalHandlers.set("filter.grayscale", (p) => {
  const params = p as { layerId?: string };
  return controller.applyFilter(params.layerId, async (ctx, w, h) => {
    const m = await import("./canvas/FilterEngine.js");
    await m.FilterEngine.grayscale(ctx, w, h);
  });
});
internalHandlers.set("filter.brightness", (p) => {
  const params = p as { layerId?: string; amount: number };
  return controller.applyFilter(params.layerId, async (ctx, w, h) => {
    const m = await import("./canvas/FilterEngine.js");
    await m.FilterEngine.brightness(ctx, w, h, params.amount);
  });
});
internalHandlers.set("filter.contrast", (p) => {
  const params = p as { layerId?: string; amount: number };
  return controller.applyFilter(params.layerId, async (ctx, w, h) => {
    const m = await import("./canvas/FilterEngine.js");
    await m.FilterEngine.contrast(ctx, w, h, params.amount);
  });
});
internalHandlers.set("internal.snapshot", () => controller.snapshot());
// canvas.getState — return per-layer metadata + thumbnail PNG (base64).
// Server registers each as a temp URL for multimodal agent inspection.
internalHandlers.set("canvas.getState", async () => {
  const layers = controller.layers.listLayers();
  const out: { id: string; name: string; visible: boolean; opacity: number; blendMode: string; png: string }[] = [];
  for (const layer of layers) {
    const blob = await controller.layers.exportLayer(layer.id, "png");
    if (!blob) continue;
    const png = await blobToBase64(blob);
    out.push({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      png,
    });
  }
  return { layers: out };
});

internalHandlers.set("document.prepareBaseline", (params) => {
  const { state } = params as { state: DocumentStateSnapshot };
  const info = controller.getInfo();
  if (info.width !== state.width || info.height !== state.height) {
    controller.resize({ width: state.width, height: state.height, mode: "anchor" });
  }
  // Preserve pixels for matching ids (important during a server restart),
  // while replacing a fresh page's unrelated local layer ids.
  controller.reconcileFromServer(state.layers, state.activeLayerId);
  controller.triggerRender();
  refreshLayerPanel();
  return { ok: true };
});

internalHandlers.set("document.restoreRaster", async (params) => {
  const payload = params as {
    state: DocumentStateSnapshot;
    layers: { id: string; png: string }[];
  };
  await restoreRasterState(payload.state, payload.layers);
  return { ok: true };
});

internalHandlers.set("document.replay", async (params) => {
  const snapshot = params as DocumentReplaySnapshot;
  if (!snapshot.replayable) throw new Error("Document has no captured pixel baseline");
  const warnings: string[] = [];
  await controller.withoutHistory(() =>
    controller.withoutIntermediateRendering(async () => {
      await restoreRasterState(snapshot.baseState, snapshot.baseRaster);
      for (const [index, operation] of snapshot.operations.entries()) {
        const handler = internalHandlers.get(operation.method);
        if (!handler || operation.method.startsWith("document.")) {
          warnings.push(`Skipped unsupported replay operation: ${operation.method}`);
          continue;
        }
        await handler(operation.params);
        // Large native-brush documents can contain thousands of operations.
        // Yield periodically so WebSocket heartbeats and browser watchdogs stay
        // responsive while retaining a single final composite.
        if ((index + 1) % 24 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      controller.reconcileFromServer(snapshot.state.layers, snapshot.state.activeLayerId);
    }),
  );
  controller.clearHistory();
  controller.triggerRender();
  refreshLayerPanel();
  return { ok: true, revision: snapshot.revision, warnings };
});

async function restoreRasterState(
  state: DocumentStateSnapshot,
  rasterLayers: { id: string; png: string }[],
): Promise<void> {
  const info = controller.getInfo();
  if (info.width !== state.width || info.height !== state.height) {
    controller.resize({ width: state.width, height: state.height, mode: "anchor" });
  }
  controller.reconcileFromServer(state.layers, state.activeLayerId);
  controller.clear({});
  const stateLayerIds = new Set(state.layers.map((layer) => layer.id));
  for (const layer of rasterLayers) {
    // A baseline captured by an older browser can contain its throwaway local
    // bootstrap layer even though that id was never part of the canonical
    // base state. It cannot contribute to the document and must not abort an
    // otherwise valid native-operation replay.
    if (!stateLayerIds.has(layer.id)) continue;
    const blob = base64PngToBlob(layer.png);
    const restored = await controller.layers.loadIntoLayer(layer.id, blob);
    if (!restored) throw new Error(`Unable to restore raster layer ${layer.id}`);
  }
  controller.reconcileFromServer(state.layers, state.activeLayerId);
  controller.clearHistory();
  controller.triggerRender();
  refreshLayerPanel();
}

function base64PngToBlob(png: string): Blob {
  const binary = atob(png);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}

// Helper used by canvas.getState handler above — defined locally because
// CanvasController doesn't expose blobToBase64 publicly.
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------
function setConnStatus(connected: boolean) {
  connStatus.textContent = connected ? "connected" : "disconnected";
  connStatus.className = "pill " + (connected ? "pill-connected" : "pill-disconnected");
}
function setPrimaryStatus(primary: boolean) {
  primaryStatus.textContent = primary ? "primary" : "secondary";
  primaryStatus.className = "pill " + (primary ? "pill-primary" : "pill-secondary");
}
function setSeq(seq: number) {
  seqStatus.textContent = `seq: ${seq}`;
}

let remoteEventChain = Promise.resolve();

const wsClient = new WSClient({
  clientId: getClientId(),
  role: "browser",
  internalHandlers,
  onConnect: async (hello) => {
    setConnStatus(true);
    console.log("[connect] isPrimary:", hello.isPrimary, "serverEventSeq:", hello.serverEventSeq);
    // Sync local layer stack with the server's authoritative metadata.
    const state = hello.state as {
      width: number;
      height: number;
      layers: { id: string; name: string; visible: boolean; opacity: number; blendMode: never }[];
      activeLayerId: string | null;
    };
    console.log("[connect] server state:", JSON.stringify(state));
    if (state.width !== controller.getInfo().width || state.height !== controller.getInfo().height) {
      controller.resize({ width: state.width, height: state.height, mode: "anchor" });
    }
    controller.reconcileFromServer(state.layers, state.activeLayerId);
    refreshLayerPanel();
    if (hello.document?.replayable) {
      await internalHandlers.get("document.replay")?.(hello.document);
    }
    wsClient.notify("event.subscribe", {});
    console.log("[connect] after reconcile, local:", JSON.stringify(controller.getInfo()));
  },
  onDisconnect: () => setConnStatus(false),
  onPrimaryChange: (isPrimary) => {
    setPrimaryStatus(isPrimary);
    if (isPrimary && wsClient.connected) {
      remoteEventChain = remoteEventChain
        .then(() => syncCanonicalDocument())
        .catch((error) => console.warn("[primary sync] failed:", error));
    }
  },
  onEvent: (type, data, seq) => {
    setSeq(seq);
    // Apply events from other clients so secondary browsers stay in sync.
    // Primary doesn't need to apply — it already executed.
    if (!wsClient.primary) {
      remoteEventChain = remoteEventChain
        .then(() => applyRemoteEvent(type, data))
        .catch((error) => console.warn("[event apply] failed:", error));
    }
  },
  getLastEventSeq: () => {
    const n = parseInt(localStorage.getItem(SEQ_KEY) ?? "0", 10);
    return isNaN(n) ? undefined : n;
  },
  setLastEventSeq: (seq) => localStorage.setItem(SEQ_KEY, String(seq)),
});

void wsClient.connect();

// Expose for debugging
(window as unknown as { __paint: { controller: CanvasController; ws: WSClient; toolbar: Toolbar; pointer: PointerHandler } }).__paint = {
  controller,
  ws: wsClient,
  toolbar,
  pointer,
};

// ---------------------------------------------------------------------------
// Apply events from other clients (for secondary browsers)
// ---------------------------------------------------------------------------
async function applyRemoteEvent(type: string, data: unknown): Promise<void> {
  if (type === "draw.batched") {
    const event = (data ?? {}) as {
      method?: string;
      params?: { operations?: { method: string; params: unknown }[] };
      result?: { results?: ({ ok?: boolean } | unknown)[] };
    };
    const operations = event.params?.operations ?? [];
    const results = event.result?.results ?? [];
    const successful = operations.filter((_, index) => {
      const result = results[index];
      return Boolean(result && typeof result === "object" && (result as { ok?: boolean }).ok === true);
    });
    if (successful.length > 0) {
      await internalHandlers.get("draw.batch")?.({ operations: successful });
    }
    return;
  }
  if (
    type === "transaction.committed" ||
    type === "document.restored" ||
    type === "snapshot.loaded" ||
    type === "canvas.imported" ||
    type === "history.undone" ||
    type === "history.redone"
  ) {
    await syncCanonicalDocument();
    return;
  }
  if (!type.startsWith("stroke.") && !type.startsWith("layer.") && !type.startsWith("canvas.") && !type.startsWith("filter.")) {
    return;
  }
  const d = (data ?? {}) as { method?: string; params?: unknown };
  if (!d.method) return;
  // Use the same internal handlers
  const h = internalHandlers.get(d.method);
  if (h) {
    try {
      await h(d.params);
      refreshLayerPanel();
    } catch (err) {
      console.warn("[event apply] failed:", err);
    }
  }
}

async function syncCanonicalDocument(): Promise<void> {
  try {
    const snapshot = await wsClient.request<DocumentReplaySnapshot>("doc.get", {
      compactActiveLayers: true,
    });
    if (snapshot.replayable) await internalHandlers.get("document.replay")?.(snapshot);
  } catch (error) {
    console.warn("[document sync] failed:", error);
  }
}
