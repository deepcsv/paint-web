/**
 * BrushPreset — a complete brush definition with all rendering parameters.
 *
 * Reverse-engineered from 画世界's BrushJson.java (70 fields).
 * 94 presets extracted via Frida hook on ConcealHelper.decryptByte().
 */

export interface BrushPreset {
  /** Unique ID within the package. */
  id: string;
  /** Human-readable name (Chinese). */
  name: string;
  /** Package name (e.g. "常规画笔"). */
  pkgName: string;

  // ── Size ──────────────────────────────────────────────────────────
  /** Max brush width in pixels (at full pressure). */
  width: number;
  /** Min brush width (at zero pressure). */
  smallWidth: number;
  /** Width random jitter factor. */
  dynamicWidth: number;
  /** Absolute minimum width clamps. */
  minWidth: number;
  /** Absolute maximum width clamps. */
  maxWidth: number;

  // ── Opacity & Flow ────────────────────────────────────────────────
  /** Base opacity (0..1). */
  alpha: number;
  /** Min opacity (at zero pressure). */
  smallAlpha: number;
  /** Opacity random jitter. */
  dynamicAlpha: number;
  /** Brush flow — per-stamp opacity multiplier (0..1). */
  brushFlow: number;
  /** Min flow (at zero pressure). */
  smallBrushFlow: number;
  /** Flow random jitter. */
  dynamicBrushFlow: number;

  // ── Spacing ───────────────────────────────────────────────────────
  /** Stamp spacing as a fraction of brush width (0.02..0.70). */
  spacing: number;
  /** Spacing random jitter. */
  dynamicSpa: number;

  // ── Shape ─────────────────────────────────────────────────────────
  /** Edge hardness (0=soft, 1=sharp). Controls RadialGradient stops. */
  hardness: number;
  /** Roundness — Y-scale of stamp (0.3..1.0). 1=perfect circle. */
  roundness: number;
  /** Base rotation angle in degrees. */
  rotation: number;
  /** Rotation random jitter. */
  dynamicRot: number;
  /** If true, stamp rotates to follow stroke direction. */
  rotFlowFinger: boolean;

  // ── Texture ───────────────────────────────────────────────────────
  /** Use shape texture (brush tip silhouette). */
  useShape: boolean;
  /** Shape texture filename (without path, maps to /textures/xxx.png). */
  shapeTexture: string;
  /** Use surface texture (adds surface detail). */
  useTex: boolean;
  /** Surface texture filename. */
  surfaceTexture: string;
  /** Texture scale multiplier. */
  texScale: number;
  /** Reverse texture (invert alpha). */
  reverseTex: boolean;
  /** Reverse shape (invert alpha). */
  reverseShape: boolean;

  // ── Special ───────────────────────────────────────────────────────
  /** Eraser mode (destination-out compositing). */
  eraser: boolean;
  /** Pixel pen — no anti-aliasing. */
  pixelpen: boolean;
  /** Square stamp shape. */
  square: boolean;
  /** Supports pressure sensitivity. */
  supportPressure: boolean;
  /** Reverse pressure (light press = wide). */
  pressReverse: boolean;
  /** RGB to alpha channel conversion. */
  rgbToAlpha: boolean;
  /** Smear strength — drag surrounding pixels. */
  smearStrength: number;
  /** Hollow center value (0=solid, >0=hollow ring). */
  hollowVal: number;
  /** Color depth percentage (0..100). */
  depth: number;
  /** Blend mode: 0=NORMAL, 1=MULTIPLY, 2=SCREEN, 3=LINEAR_DODGE. */
  blendType: 0 | 1 | 2 | 3;
}

/** Default brush — a basic hard round brush. Used when no preset is selected. */
export const DEFAULT_BRUSH: BrushPreset = {
  id: "default",
  name: "默认画笔",
  pkgName: "基础",
  width: 20,
  smallWidth: 1,
  dynamicWidth: 0,
  minWidth: 1,
  maxWidth: 500,
  alpha: 1,
  smallAlpha: 0.3,
  dynamicAlpha: 0,
  brushFlow: 1,
  smallBrushFlow: 0.5,
  dynamicBrushFlow: 0,
  spacing: 0.1,
  dynamicSpa: 0,
  hardness: 1,
  roundness: 1,
  rotation: 0,
  dynamicRot: 0,
  rotFlowFinger: false,
  useShape: false,
  shapeTexture: "",
  useTex: false,
  surfaceTexture: "",
  texScale: 1,
  reverseTex: false,
  reverseShape: false,
  eraser: false,
  pixelpen: false,
  square: false,
  supportPressure: true,
  pressReverse: false,
  rgbToAlpha: false,
  smearStrength: 0,
  hollowVal: 0,
  depth: 100,
  blendType: 0,
};

/** A point in a stroke path. */
export interface StrokePoint {
  x: number;
  y: number;
  /** Pressure 0..1. Omitted mouse/agent pressure is inferred by StrokePlanner. */
  pressure?: number;
}

/** A stamp point generated along the smoothed path. */
export interface StampPoint {
  x: number;
  y: number;
  /** Effective width at this stamp (after pressure interpolation). */
  width: number;
  /** Effective alpha at this stamp (after pressure + flow interpolation). */
  alpha: number;
  /** Stroke direction angle in radians (for rotFlowFinger). */
  angle: number;
}
