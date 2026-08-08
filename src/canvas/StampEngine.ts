/**
 * StampEngine v6 — deterministic stamp-based brush renderer.
 *
 * v6 foundations:
 *   - Module-level cached buffers (no allocation per stroke/pointermove)
 *   - perfect-freehand centerline streamlining and velocity pressure
 *   - Explicit per-stroke PRNG seeds for replayable jitter
 *   - Dark-mask rgbToAlpha semantics and procedural graphite grain
 *   - Isolated smear source buffer and blend-mode-aware compositing
 */

import type { BrushPreset, StrokePoint, StampPoint } from "../brush/BrushTypes.js";
import { planStroke } from "../brush/StrokePlanner.js";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ── Color ────────────────────────────────────────────────────────────────

interface RGB { r: number; g: number; b: number; a: number; }

function parseColor(hex: string): RGB {
  let s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (s.length === 3) s = s[0]!+s[0]!+s[1]!+s[1]!+s[2]!+s[2]!+"ff";
  else if (s.length === 4) s = s[0]!+s[0]!+s[1]!+s[1]!+s[2]!+s[2]!+s[3]!+s[3]!;
  else if (s.length === 6) s += "ff";
  if (s.length !== 8) throw new Error(`Invalid color: ${hex}`);
  return { r: +("0x"+s.slice(0,2)), g: +("0x"+s.slice(2,4)), b: +("0x"+s.slice(4,6)), a: +("0x"+s.slice(6,8))/255 };
}

function applyDepth(c: RGB, depth: number): RGB {
  if (depth >= 99) return c;
  const lv = Math.max(2, Math.round(depth / 100 * 255));
  const q = (v: number) => Math.round(v / 255 * lv) / lv * 255;
  return { r: q(c.r), g: q(c.g), b: q(c.b), a: c.a };
}

const rgba = (c: RGB) => `rgba(${c.r},${c.g},${c.b},${c.a.toFixed(4)})`;
const rgba0 = (c: RGB) => `rgba(${c.r},${c.g},${c.b},0)`;

// ── PRNG ─────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

// ── Math ─────────────────────────────────────────────────────────────────

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

// ── Cached buffers (module-level, reused across strokes) ─────────────────

let _strokeBuf: OffscreenCanvas | null = null;
let _strokeCtx: OffscreenCanvasRenderingContext2D | null = null;
let _stampBuf: OffscreenCanvas | null = null;
let _stampCtx: OffscreenCanvasRenderingContext2D | null = null;
let _stampBufSize = 0;
let _maskBuf: OffscreenCanvas | null = null;
let _maskCtx: OffscreenCanvasRenderingContext2D | null = null;
let _maskBufSize = 0;
let _smearBuf: OffscreenCanvas | null = null;
let _smearCtx: OffscreenCanvasRenderingContext2D | null = null;

function getStrokeBuffer(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!_strokeBuf || _strokeBuf.width < w || _strokeBuf.height < h) {
    _strokeBuf = new OffscreenCanvas(w, h);
    _strokeCtx = _strokeBuf.getContext("2d", { willReadFrequently: true })!;
  }
  const ctx = _strokeCtx!;
  ctx.clearRect(0, 0, _strokeBuf.width, _strokeBuf.height);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  return ctx;
}

function getStampBuffer(size: number): { ctx: OffscreenCanvasRenderingContext2D; center: number; size: number } {
  if (!_stampBuf || _stampBufSize < size) {
    _stampBufSize = Math.max(size, 256);
    _stampBuf = new OffscreenCanvas(_stampBufSize, _stampBufSize);
    _stampCtx = _stampBuf.getContext("2d", { willReadFrequently: true })!;
  }
  const ctx = _stampCtx!;
  ctx.clearRect(0, 0, _stampBufSize, _stampBufSize);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  return { ctx, center: _stampBufSize / 2, size: _stampBufSize };
}

function getMaskBuffer(size: number): { ctx: OffscreenCanvasRenderingContext2D; center: number; size: number } {
  if (!_maskBuf || _maskBufSize < size) {
    _maskBufSize = Math.max(size, 256);
    _maskBuf = new OffscreenCanvas(_maskBufSize, _maskBufSize);
    _maskCtx = _maskBuf.getContext("2d", { willReadFrequently: true })!;
  }
  const ctx = _maskCtx!;
  ctx.clearRect(0, 0, _maskBufSize, _maskBufSize);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  return { ctx, center: _maskBufSize / 2, size: _maskBufSize };
}

function captureSmearSource(source: AnyCtx, width: number, height: number): OffscreenCanvas {
  if (!_smearBuf || _smearBuf.width < width || _smearBuf.height < height) {
    _smearBuf = new OffscreenCanvas(width, height);
    _smearCtx = _smearBuf.getContext("2d")!;
  }
  const ctx = _smearCtx!;
  ctx.clearRect(0, 0, _smearBuf.width, _smearBuf.height);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(source.canvas as CanvasImageSource, 0, 0);
  return _smearBuf;
}

// ── Procedural textures ──────────────────────────────────────────────────

const procTexCache = new Map<string, OffscreenCanvas>();
let procTexCachePixels = 0;
const PROC_TEX_CACHE_PIXEL_BUDGET = 8_000_000;

function quantizeProceduralSize(size: number): number {
  // Pressure produces many nearby floating-point widths. Four-pixel buckets
  // are visually indistinguishable for noisy tips and keep the cache bounded.
  return clamp(Math.round(size / 4) * 4, 16, 512);
}

function cacheProceduralShape(key: string, texture: OffscreenCanvas): void {
  procTexCache.set(key, texture);
  procTexCachePixels += texture.width * texture.height;

  while (procTexCachePixels > PROC_TEX_CACHE_PIXEL_BUDGET && procTexCache.size > 1) {
    const oldestKey = procTexCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = procTexCache.get(oldestKey);
    procTexCache.delete(oldestKey);
    if (oldest) procTexCachePixels -= oldest.width * oldest.height;
  }
}

function generateProceduralShape(preset: BrushPreset, size: number): OffscreenCanvas {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d")!;
  const cx = size / 2;
  const r = size / 2;
  const rng = mulberry32(hashStr(preset.id + ":" + Math.round(size)));

  if (preset.hardness < 0.5) {
    ctx.fillStyle = "rgba(255,255,255,1)";
    for (let i = 0; i < size * size * 0.15; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * r;
      ctx.globalAlpha = rng() * 0.8;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a)*dist, cx + Math.sin(a)*dist, Math.max(0.5, rng()*2), 0, Math.PI*2);
      ctx.fill();
    }
  } else if (preset.roundness < 0.8) {
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.globalAlpha = 0.3 + rng() * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a)*r*0.2, cx + Math.sin(a)*r*0.2);
      ctx.lineTo(cx + Math.cos(a)*r, cx + Math.sin(a)*r);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.arc(cx, cx, r * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.globalAlpha = 0.3 + rng() * 0.3;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a)*r*0.85, cx + Math.sin(a)*r*0.85, rng()*r*0.15, 0, Math.PI*2);
      ctx.fill();
    }
  }
  return c;
}

function getProceduralShape(preset: BrushPreset, size: number): OffscreenCanvas {
  const quantizedSize = quantizeProceduralSize(size);
  const key = `${preset.id}:${quantizedSize}`;
  let tex = procTexCache.get(key);
  if (tex) {
    // Refresh insertion order so eviction approximates least-recently-used.
    procTexCache.delete(key);
    procTexCache.set(key, tex);
    return tex;
  }

  tex = generateProceduralShape(preset, quantizedSize);
  cacheProceduralShape(key, tex);
  return tex;
}

// ── Stamp geometry ───────────────────────────────────────────────────────

interface StampGenCtx { preset: BrushPreset; sizeMult: number; rng: () => number; }

function effWidth(g: StampGenCtx, p: number): number {
  const pr = g.preset.pressReverse ? 1 - p : p;
  let w = lerp(g.preset.smallWidth, g.preset.width, pr) * g.sizeMult;
  if (g.preset.dynamicWidth > 0) w *= 1 + (g.rng()*2-1) * g.preset.dynamicWidth;
  return clamp(w, (g.preset.minWidth || 0.5) * g.sizeMult, (g.preset.maxWidth || 500) * g.sizeMult);
}

function effAlpha(g: StampGenCtx, p: number): number {
  const pr = g.preset.pressReverse ? 1 - p : p;
  let a = lerp(g.preset.smallAlpha, g.preset.alpha, pr);
  let flow = lerp(g.preset.smallBrushFlow, g.preset.brushFlow, pr);
  if (g.preset.dynamicAlpha > 0) a *= 1 + (g.rng()*2-1) * g.preset.dynamicAlpha;
  if (g.preset.dynamicBrushFlow > 0) flow *= 1 + (g.rng()*2-1) * g.preset.dynamicBrushFlow;
  return clamp(a * flow, 0, 1);
}

function effRotation(g: StampGenCtx, strokeAngle: number): number {
  const baseRot = (g.preset.rotation * Math.PI) / 180;
  const angle = g.preset.rotFlowFinger ? strokeAngle + baseRot : baseRot;
  return g.preset.dynamicRot > 0 ? angle + (g.rng()*2-1) * g.preset.dynamicRot * Math.PI / 180 : angle;
}

function effSpacing(g: StampGenCtx, width: number): number {
  let sp = g.preset.spacing * width;
  if (g.preset.dynamicSpa > 0) sp *= 1 + (g.rng()*2-1) * g.preset.dynamicSpa;
  return Math.max(0.5, sp);
}

function makeStamp(x: number, y: number, pressure: number, strokeAngle: number, g: StampGenCtx): StampPoint {
  return {
    x: g.preset.pixelpen ? Math.round(x) : x,
    y: g.preset.pixelpen ? Math.round(y) : y,
    width: effWidth(g, pressure),
    alpha: effAlpha(g, pressure),
    angle: effRotation(g, strokeAngle),
  };
}

function generateStamps(smoothed: StrokePoint[], g: StampGenCtx): StampPoint[] {
  if (smoothed.length < 1) return [];
  const stamps: StampPoint[] = [];
  let acc = 0;
  if (smoothed.length === 1) {
    stamps.push(makeStamp(smoothed[0]!.x, smoothed[0]!.y, smoothed[0]!.pressure ?? 0.5, 0, g));
    return stamps;
  }
  for (let i = 0; i < smoothed.length - 1; i++) {
    const a = smoothed[i]!, b = smoothed[i + 1]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const segLen = Math.sqrt(dx*dx + dy*dy);
    if (segLen < 0.01) continue;
    const angle = Math.atan2(dy, dx);
    while (acc < segLen) {
      const t = acc / segLen;
      const pp = lerp(a.pressure ?? 0.5, b.pressure ?? 0.5, t);
      const stamp = makeStamp(a.x + dx*t, a.y + dy*t, pp, angle, g);
      stamps.push(stamp);
      acc += effSpacing(g, stamp.width);
    }
    acc -= segLen;
  }
  const last = smoothed[smoothed.length - 1]!;
  const prev = smoothed[smoothed.length - 2] ?? last;
  stamps.push(makeStamp(last.x, last.y, last.pressure ?? 0.5, Math.atan2(last.y - prev.y, last.x - prev.x), g));
  return stamps;
}

// ── Per-stamp post-processing ────────────────────────────────────────────

/** Invert alpha channel via getImageData (correct alpha mask inversion). */
function invertAlpha(ctx: OffscreenCanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const x = Math.round(cx - size / 2);
  const y = Math.round(cy - size / 2);
  const w = Math.round(size);
  try {
    const img = ctx.getImageData(x, y, w, w);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
    ctx.putImageData(img, x, y);
  } catch { /* willReadFrequently not set */ }
}

/** Convert grayscale mask values into alpha. Dark pixels are opaque by default. */
function applyLuminanceMask(
  ctx: OffscreenCanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  darkIsOpaque: boolean,
  opacityFloor = 0,
): void {
  const x = Math.round(cx - size / 2);
  const y = Math.round(cy - size / 2);
  const w = Math.round(size);
  try {
    const img = ctx.getImageData(x, y, w, w);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299*d[i]! + 0.587*d[i+1]! + 0.114*d[i+2]!) / 255;
      const mask = darkIsOpaque ? 1 - lum : lum;
      const sourceAlpha = d[i+3]! / 255;
      const alpha = sourceAlpha * (opacityFloor + (1 - opacityFloor) * mask);
      d[i] = 255;
      d[i+1] = 255;
      d[i+2] = 255;
      d[i+3] = Math.round(clamp(alpha, 0, 1) * 255);
    }
    ctx.putImageData(img, x, y);
  } catch { /* skip */ }
}

function tintCurrentMask(
  ctx: OffscreenCanvasRenderingContext2D,
  half: number,
  color: RGB,
): void {
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = rgba(color);
  ctx.fillRect(-half, -half, half * 2, half * 2);
  ctx.globalCompositeOperation = "source-over";
}

/** Deterministic paper/tooth breakup when no decoded texture asset exists. */
function applyProceduralSurface(
  ctx: OffscreenCanvasRenderingContext2D,
  preset: BrushPreset,
  width: number,
  seed: number,
): void {
  const half = width / 2;
  const rng = mulberry32(seed ^ hashStr(`${preset.id}:${preset.surfaceTexture}:surface`));
  const area = width * width;
  const count = Math.round(clamp(area * 0.045, 18, 1600));
  const removal = preset.reverseTex ? 0.14 : 0.42;

  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000000";
  for (let index = 0; index < count; index++) {
    const x = (rng() * 2 - 1) * half;
    const y = (rng() * 2 - 1) * half;
    const radius = Math.max(0.18, width * (0.002 + rng() * 0.012));
    ctx.globalAlpha = removal * (0.2 + rng() * 0.8);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sparse directional scratches stop the grain from reading as airbrush noise.
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = Math.max(0.25, width * 0.006);
  for (let index = 0; index < Math.max(2, Math.round(width / 12)); index++) {
    const x = (rng() * 2 - 1) * half;
    const y = (rng() * 2 - 1) * half;
    const length = width * (0.08 + rng() * 0.22);
    ctx.globalAlpha = removal * (0.15 + rng() * 0.35);
    ctx.beginPath();
    ctx.moveTo(x - length / 2, y);
    ctx.lineTo(x + length / 2, y + (rng() * 2 - 1) * width * 0.03);
    ctx.stroke();
  }
  ctx.restore();
}

// ── Stamp content rendering ──────────────────────────────────────────────

interface LoadedTextures { shape?: ImageBitmap; surface?: ImageBitmap; }

function renderStampContent(
  stampCtx: OffscreenCanvasRenderingContext2D,
  preset: BrushPreset,
  width: number,
  color: RGB,
  textures: LoadedTextures,
  bufferCenter: number,
  textureSeed: number,
): void {
  const half = width / 2;
  stampCtx.save();
  stampCtx.translate(bufferCenter, bufferCenter);
  if (preset.pixelpen) stampCtx.imageSmoothingEnabled = false;

  const shapeTex = (preset.useShape && textures.shape) ? textures.shape : null;
  const surfaceTex = (preset.useTex && textures.surface) ? textures.surface : null;

  // 1. Stamp body
  if (shapeTex) {
    stampCtx.drawImage(shapeTex, -half, -half, width, width);
    if (preset.rgbToAlpha) {
      // Brush-tip masks conventionally use black as paint and white as empty.
      applyLuminanceMask(stampCtx, bufferCenter, bufferCenter, width, !preset.reverseShape);
    } else if (preset.reverseShape) {
      invertAlpha(stampCtx, bufferCenter, bufferCenter, width);
    }
    tintCurrentMask(stampCtx, half, color);
  } else if (preset.useShape) {
    const procTex = getProceduralShape(preset, Math.round(width));
    stampCtx.drawImage(procTex, -half, -half, width, width);
    if (preset.reverseShape) invertAlpha(stampCtx, bufferCenter, bufferCenter, width);
    tintCurrentMask(stampCtx, half, color);
  } else {
    drawHardnessCircle(stampCtx, half, color, preset.hardness, preset.square);
  }

  // 2. Surface texture modulates alpha; it never leaks its RGB into the stroke.
  if (surfaceTex) {
    const mask = getMaskBuffer(Math.ceil(width));
    mask.ctx.drawImage(surfaceTex, mask.center - half, mask.center - half, width, width);
    applyLuminanceMask(mask.ctx, mask.center, mask.center, width, !preset.reverseTex, 0.18);
    stampCtx.globalCompositeOperation = "destination-in";
    stampCtx.drawImage(
      _maskBuf!,
      mask.center - half,
      mask.center - half,
      width,
      width,
      -half,
      -half,
      width,
      width,
    );
    stampCtx.globalCompositeOperation = "source-over";
  } else if (preset.useTex) {
    applyProceduralSurface(stampCtx, preset, width, textureSeed);
  }

  // 3. Hollow center
  if (preset.hollowVal > 0) {
    const innerR = half * (1 - preset.hollowVal);
    if (innerR > 0.5) {
      stampCtx.globalCompositeOperation = "destination-out";
      stampCtx.beginPath();
      stampCtx.arc(0, 0, innerR, 0, Math.PI * 2);
      stampCtx.fill();
      stampCtx.globalCompositeOperation = "source-over";
    }
  }

  stampCtx.restore();
}

function drawHardnessCircle(ctx: AnyCtx, radius: number, color: RGB, hardness: number, square: boolean): void {
  if (hardness >= 0.99) {
    ctx.fillStyle = rgba(color);
    if (square) ctx.fillRect(-radius, -radius, radius*2, radius*2);
    else { ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI*2); ctx.fill(); }
    return;
  }
  const inner = Math.max(0, radius * hardness);
  const grad = ctx.createRadialGradient(0, 0, inner, 0, 0, radius);
  grad.addColorStop(0, rgba(color));
  grad.addColorStop(1, rgba0(color));
  ctx.fillStyle = grad;
  if (square) ctx.fillRect(-radius, -radius, radius*2, radius*2);
  else { ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI*2); ctx.fill(); }
}

// ── Public API ──────────────────────────────────────────────────────────

interface RenderOptions {
  forceEraser?: boolean;
  opacityOverride?: number;
  /** Stable unsigned 32-bit seed stored with the canonical stroke operation. */
  seed?: number;
  /** Source canvas for smear effect (the layer being drawn on). */
  smearSource?: AnyCtx;
}

const BLEND_OPERATIONS: Record<BrushPreset["blendType"], GlobalCompositeOperation> = {
  0: "source-over",
  1: "multiply",
  2: "screen",
  3: "lighter",
};

export function renderStroke(
  ctx: AnyCtx,
  preset: BrushPreset,
  points: StrokePoint[],
  color: string,
  textures: LoadedTextures,
  sizeMultiplier: number = 1,
  opts: RenderOptions = {},
): void {
  if (points.length === 0) return;
  const parsed = applyDepth(parseColor(color), preset.depth);
  const opacity = opts.opacityOverride ?? 1;
  const isEraser = opts.forceEraser || preset.eraser;
  const hasSmear = Math.abs(preset.smearStrength) > 0.001;
  const fallbackSeed = hashStr(
    `${preset.id}|${color}|${points.map((point) => `${point.x},${point.y},${point.pressure ?? "auto"}`).join(";")}`,
  );
  const seed = (opts.seed ?? fallbackSeed) >>> 0;
  const rng = mulberry32(seed);

  const adjusted: StrokePoint[] = preset.supportPressure ? points : points.map((p) => ({ ...p, pressure: 0.7 }));
  const genCtx: StampGenCtx = { preset, sizeMult: sizeMultiplier, rng };
  const centerline = preset.pixelpen
    ? adjusted
    : planStroke(adjusted, {
        size: Math.max(1, preset.width * sizeMultiplier),
        streamline: 0.42,
        simulatePressure: preset.supportPressure,
        last: true,
      });
  const stamps = generateStamps(centerline, genCtx);
  if (stamps.length === 0) return;

  // Get cached stroke buffer (no allocation!)
  const canvasW = (ctx.canvas as { width: number }).width || 1280;
  const canvasH = (ctx.canvas as { height: number }).height || 720;
  const strokeCtx = getStrokeBuffer(canvasW, canvasH);

  const smearSource = hasSmear && !isEraser
    ? captureSmearSource(opts.smearSource ?? ctx, canvasW, canvasH)
    : null;

  let maxW = 1;
  for (const stamp of stamps) maxW = Math.max(maxW, stamp.width);
  const stampBuf = getStampBuffer(Math.ceil(maxW));

  for (let stampIndex = 0; stampIndex < stamps.length; stampIndex++) {
    const stamp = stamps[stampIndex]!;
    const w = stamp.width;
    if (w < 0.5) continue;

    // Drag a frozen sample from behind the dab into its new position.
    if (smearSource) {
      const offX = Math.cos(stamp.angle) * w * preset.smearStrength;
      const offY = Math.sin(stamp.angle) * w * preset.smearStrength;
      strokeCtx.save();
      strokeCtx.globalAlpha = clamp(Math.abs(preset.smearStrength), 0, 1) * stamp.alpha;
      strokeCtx.drawImage(smearSource,
        Math.round(stamp.x - offX - w/2), Math.round(stamp.y - offY - w/2), Math.round(w), Math.round(w),
        stamp.x - w/2, stamp.y - w/2, w, w);
      strokeCtx.restore();
    }

    // Render stamp content to stamp buffer
    stampBuf.ctx.clearRect(0, 0, stampBuf.size, stampBuf.size);
    renderStampContent(
      stampBuf.ctx,
      preset,
      w,
      parsed,
      textures,
      stampBuf.center,
      (seed ^ Math.imul(stampIndex + 1, 0x9e3779b1)) >>> 0,
    );

    // Composite stamp buffer → stroke buffer
    strokeCtx.save();
    strokeCtx.translate(stamp.x, stamp.y);
    strokeCtx.rotate(stamp.angle);
    if (preset.roundness < 1) strokeCtx.scale(1, preset.roundness);
    strokeCtx.globalAlpha = stamp.alpha;
    strokeCtx.drawImage(_stampBuf!,
      stampBuf.center - w/2, stampBuf.center - w/2, w, w,
      -w/2, -w/2, w, w);
    strokeCtx.restore();
  }

  // Final composite: stroke buffer → target layer with stroke-level opacity
  ctx.save();
  try {
    ctx.globalCompositeOperation = isEraser ? "destination-out" : BLEND_OPERATIONS[preset.blendType];
    ctx.globalAlpha = opacity;
    // Cached buffers may be larger than the current target. Crop the source
    // explicitly so switching canvas/test sizes never rescales stroke pixels.
    ctx.drawImage(_strokeBuf!, 0, 0, canvasW, canvasH, 0, 0, canvasW, canvasH);
  } finally {
    ctx.restore();
  }
}

export function renderStrokeLive(
  ctx: AnyCtx, preset: BrushPreset, points: StrokePoint[], color: string,
  textures: LoadedTextures, sizeMultiplier: number = 1, opts: RenderOptions = {},
): void {
  renderStroke(ctx, preset, points, color, textures, sizeMultiplier, opts);
}

export function renderPreviewDab(
  ctx: AnyCtx, preset: BrushPreset, x: number, y: number, color: string, textures: LoadedTextures,
): void {
  try {
    const parsed = parseColor(color);
    const w = Math.min(preset.width, 40);
    const buf = getStampBuffer(Math.ceil(w));
    renderStampContent(buf.ctx, preset, w, parsed, textures, buf.center, hashStr(preset.id));
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = preset.alpha * preset.brushFlow;
    ctx.drawImage(_stampBuf!, buf.center - w/2, buf.center - w/2, w, w, -w/2, -w/2, w, w);
    ctx.restore();
  } catch { /* skip */ }
}

export function clearProcTexCache(): void {
  procTexCache.clear();
  procTexCachePixels = 0;
}
