/**
 * shared/protocol.ts — RPC contract shared by server, client, and CLI.
 *
 * Everything that crosses the WS boundary is defined here as a zod schema.
 * Import this file from server, src/, and cli/ via relative path:
 *   import { ... } from "../shared/protocol";
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export const JSONRPC_VERSION = "2.0" as const;

/** RpcId is just a number or string identifier — no brand, to keep it usable as both type and runtime value. */
export const RpcIdSchema = z.union([z.number(), z.string()]);
export type RpcId = number | string;

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcIdSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcError = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcError>;

export const JsonRpcResponse = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcIdSchema,
  result: z.unknown().optional(),
  error: JsonRpcError.optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

// ---------------------------------------------------------------------------
// Standard error codes
// ---------------------------------------------------------------------------

export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NO_PRIMARY: -32001,
  PRIMARY_TIMEOUT: -32002,
  FONT_NOT_LOADED: -32003,
  LAYER_NOT_FOUND: -32004,
  OUT_OF_BOUNDS: -32005,
  SNAPSHOT_TOO_LARGE: -32006,
  NOT_AUTHORIZED: -32007,
  DOCUMENT_CONFLICT: -32008,
  TRANSACTION_ABORTED: -32009,
  VERSION_NOT_FOUND: -32010,
  ASSET_NOT_FOUND: -32011,
  ASSET_TOO_LARGE: -32012,
  INVALID_ASSET: -32013,
} as const;

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

export const Color = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
  .transform((s) => (s.startsWith("#") ? s : "#" + s));
export type Color = z.infer<typeof Color>;

export const Point = z.object({
  x: z.number(),
  y: z.number(),
  pressure: z.number().min(0).max(1).optional(),
});
export type Point = z.infer<typeof Point>;

/**
 * Immutable rendering snapshot for a stamp brush.
 *
 * New stroke operations embed this object so replay does not change when a
 * named preset is tuned later. `brushPresetId` remains supported for older
 * documents and compact third-party clients.
 */
export const BrushDefinition = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  pkgName: z.string().min(1).max(128),
  width: z.number().positive().max(500),
  smallWidth: z.number().min(0).max(500),
  dynamicWidth: z.number().min(0).max(4),
  minWidth: z.number().min(0).max(500),
  maxWidth: z.number().positive().max(500),
  alpha: z.number().min(0).max(1),
  smallAlpha: z.number().min(0).max(1),
  dynamicAlpha: z.number().min(0).max(4),
  brushFlow: z.number().min(0).max(1),
  smallBrushFlow: z.number().min(0).max(1),
  dynamicBrushFlow: z.number().min(0).max(4),
  spacing: z.number().positive().max(4),
  dynamicSpa: z.number().min(0).max(4),
  hardness: z.number().min(0).max(1),
  roundness: z.number().positive().max(1),
  rotation: z.number().min(-36000).max(36000),
  dynamicRot: z.number().min(0).max(36000),
  rotFlowFinger: z.boolean(),
  useShape: z.boolean(),
  shapeTexture: z.string().max(128),
  useTex: z.boolean(),
  surfaceTexture: z.string().max(128),
  texScale: z.number().positive().max(64),
  reverseTex: z.boolean(),
  reverseShape: z.boolean(),
  eraser: z.boolean(),
  pixelpen: z.boolean(),
  square: z.boolean(),
  supportPressure: z.boolean(),
  pressReverse: z.boolean(),
  rgbToAlpha: z.boolean(),
  smearStrength: z.number().min(-4).max(4),
  hollowVal: z.number().min(0).max(1),
  depth: z.number().min(0).max(100),
  blendType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
});
export type BrushDefinition = z.infer<typeof BrushDefinition>;

type StrokeSeedInput = {
  layerId: string;
  tool: string;
  color: string;
  size: number;
  opacity: number;
  points: Point[];
  brushPresetId?: string;
  brush?: BrushDefinition;
};

/** Stable FNV-1a seed for clients that omit an explicit per-stroke seed. */
export function deriveStrokeSeed(stroke: StrokeSeedInput): number {
  const pointKey = stroke.points
    .map((point) =>
      `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.pressure?.toFixed(4) ?? "auto"}`,
    )
    .join(";");
  const input = [
    stroke.layerId,
    stroke.tool,
    stroke.color,
    stroke.size.toFixed(4),
    stroke.opacity.toFixed(4),
    stroke.brush?.id ?? stroke.brushPresetId ?? "legacy",
    pointKey,
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Rect = z.infer<typeof Rect>;

export const LayerId = z.string();
export type LayerId = z.infer<typeof LayerId>;

export const AssetId = z.string().regex(/^A_[a-f0-9]{64}$/);
export type AssetId = z.infer<typeof AssetId>;
export const AssetMimeType = z.enum(["image/png", "image/jpeg"]);
export type AssetMimeType = z.infer<typeof AssetMimeType>;

export const BlendMode = z.enum([
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
export type BlendMode = z.infer<typeof BlendMode>;

export const Layer = z.object({
  id: LayerId,
  name: z.string(),
  visible: z.boolean(),
  opacity: z.number().min(0).max(1),
  blendMode: BlendMode,
});
export type Layer = z.infer<typeof Layer>;

// Font whitelist — preloaded by the browser
export const FontFamily = z.enum(["noto-sans", "source-han-sans", "monospace"]);
export type FontFamily = z.infer<typeof FontFamily>;

export const FONT_WHITELIST: FontFamily[] = [
  "noto-sans",
  "source-han-sans",
  "monospace",
];

// ---------------------------------------------------------------------------
// canvas.* methods
// ---------------------------------------------------------------------------

export const CanvasGetInfoResult = z.object({
  width: z.number(),
  height: z.number(),
  layers: z.array(Layer),
  activeLayerId: LayerId.nullable(),
  historyLength: z.object({
    undo: z.number(),
    redo: z.number(),
  }),
});
export type CanvasGetInfoResult = z.infer<typeof CanvasGetInfoResult>;

export const CanvasResizeParams = z.object({
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  mode: z.enum(["crop", "scale", "anchor"]).default("anchor"),
});
export type CanvasResizeParams = z.infer<typeof CanvasResizeParams>;

export const CanvasClearParams = z.object({
  layerId: LayerId.optional(),
});
export type CanvasClearParams = z.infer<typeof CanvasClearParams>;

export const CanvasFillParams = z.object({
  color: Color,
  layerId: LayerId.optional(),
});
export type CanvasFillParams = z.infer<typeof CanvasFillParams>;

export const CanvasExportParams = z.object({
  format: z.enum(["png", "jpeg"]).default("png"),
  layerId: LayerId.optional(),
  bounds: Rect.optional(),
  quality: z.number().min(0).max(1).default(0.92),
});
export type CanvasExportParams = z.infer<typeof CanvasExportParams>;
export const CanvasExportResult = z.object({
  url: z.string(),
  size: z.number(),
  expiresAt: z.number(),
});
export type CanvasExportResult = z.infer<typeof CanvasExportResult>;

export const CanvasImportParams = z
  .object({
    url: z.string().min(1).optional(),
    assetId: AssetId.optional(),
    layerId: LayerId.optional(),
  })
  .refine((value) => Number(Boolean(value.url)) + Number(Boolean(value.assetId)) === 1, {
    message: "Exactly one of url or assetId is required",
  });
export type CanvasImportParams = z.infer<typeof CanvasImportParams>;

export const CanvasGetRegionParams = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  layerId: LayerId.optional(),
});
export type CanvasGetRegionParams = z.infer<typeof CanvasGetRegionParams>;
export const CanvasGetRegionResult = z.object({
  url: z.string(),
  expiresAt: z.number(),
});
export type CanvasGetRegionResult = z.infer<typeof CanvasGetRegionResult>;

export const CanvasAnalyzeParams = z
  .object({
    layerId: LayerId.optional(),
    stride: z.number().int().min(1).max(32).default(1),
    alphaThreshold: z.number().int().min(0).max(255).default(1),
    histogramBins: z.number().int().min(4).max(64).default(16),
    dominantColors: z.number().int().min(1).max(12).default(5),
    includeBackground: z.boolean().default(false),
  })
  .optional();
export type CanvasAnalyzeParams = z.infer<typeof CanvasAnalyzeParams>;

export const RgbaColor = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
  a: z.number().int().min(0).max(255),
  hex: z.string().regex(/^#[a-f0-9]{8}$/),
});
export type RgbaColor = z.infer<typeof RgbaColor>;

export const CanvasAnalyzeResult = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  stride: z.number().int().positive(),
  sampledPixels: z.number().int().nonnegative(),
  opaquePixels: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  bounds: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullable(),
  average: RgbaColor,
  luminance: z.object({
    min: z.number().min(0).max(1),
    max: z.number().min(0).max(1),
    mean: z.number().min(0).max(1),
    histogram: z.array(z.number().int().nonnegative()),
  }),
  dominant: z.array(
    z.object({ color: RgbaColor, count: z.number().int().positive(), ratio: z.number() }),
  ),
});
export type CanvasAnalyzeResult = z.infer<typeof CanvasAnalyzeResult>;

export const CanvasSampleParams = z.object({
  layerId: LayerId.optional(),
  points: z
    .array(z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }))
    .min(1)
    .max(512),
});
export type CanvasSampleParams = z.infer<typeof CanvasSampleParams>;
export const CanvasSampleResult = z.object({
  samples: z.array(z.object({ x: z.number(), y: z.number(), color: RgbaColor })),
});
export type CanvasSampleResult = z.infer<typeof CanvasSampleResult>;

// ---------------------------------------------------------------------------
// layer.* methods
// ---------------------------------------------------------------------------

export const LayerCreateParams = z.object({
  name: z.string().max(64).optional(),
  /** Optional client-generated id; if omitted, server generates one. */
  layerId: z
    .string()
    .regex(/^L_[A-Za-z0-9_-]{4,32}$/)
    .optional(),
});
export type LayerCreateParams = z.infer<typeof LayerCreateParams>;
export const LayerCreateResult = z.object({
  layerId: LayerId,
});
export type LayerCreateResult = z.infer<typeof LayerCreateResult>;

export const LayerDeleteParams = z.object({ layerId: LayerId });
export type LayerDeleteParams = z.infer<typeof LayerDeleteParams>;
export const LayerListResult = z.object({
  layers: z.array(Layer),
});
export type LayerListResult = z.infer<typeof LayerListResult>;
export const LayerSetActiveParams = z.object({ layerId: LayerId });
export type LayerSetActiveParams = z.infer<typeof LayerSetActiveParams>;
export const LayerSetVisibleParams = z.object({
  layerId: LayerId,
  visible: z.boolean(),
});
export type LayerSetVisibleParams = z.infer<typeof LayerSetVisibleParams>;
export const LayerSetOpacityParams = z.object({
  layerId: LayerId,
  opacity: z.number().min(0).max(1),
});
export type LayerSetOpacityParams = z.infer<typeof LayerSetOpacityParams>;
export const LayerSetBlendModeParams = z.object({
  layerId: LayerId,
  blendMode: BlendMode,
});
export type LayerSetBlendModeParams = z.infer<typeof LayerSetBlendModeParams>;
export const LayerRenameParams = z.object({
  layerId: LayerId,
  name: z.string().max(64),
});
export type LayerRenameParams = z.infer<typeof LayerRenameParams>;
export const LayerReorderParams = z.object({
  layerIds: z.array(LayerId),
});
export type LayerReorderParams = z.infer<typeof LayerReorderParams>;
export const LayerMergeParams = z.object({
  fromId: LayerId,
  intoId: LayerId,
});
export type LayerMergeParams = z.infer<typeof LayerMergeParams>;
export const LayerFlattenParams = z
  .object({
    /** Server-selected id used to keep all renderers deterministic. */
    layerId: LayerId.optional(),
  })
  .optional();
export type LayerFlattenParams = z.infer<typeof LayerFlattenParams>;
export const LayerFlattenResult = z.object({ id: LayerId, name: z.string() });
export type LayerFlattenResult = z.infer<typeof LayerFlattenResult>;

export const LayerTransformParams = z.object({
  layerId: LayerId,
  translateX: z.number().default(0),
  translateY: z.number().default(0),
  scaleX: z.number().min(-100).max(100).refine((value) => value !== 0).default(1),
  scaleY: z.number().min(-100).max(100).refine((value) => value !== 0).default(1),
  rotate: z.number().min(-36000).max(36000).default(0),
  pivotX: z.number().optional(),
  pivotY: z.number().optional(),
  smoothing: z.boolean().default(true),
});
export type LayerTransformParams = z.infer<typeof LayerTransformParams>;

// ---------------------------------------------------------------------------
// draw.* methods
// ---------------------------------------------------------------------------

const DrawStrokeInput = z.object({
  layerId: LayerId,
  tool: z.enum(["brush", "eraser"]),
  color: Color.default("#000000"),
  size: z.number().positive().max(500),
  opacity: z.number().min(0).max(1).default(1),
  points: z.array(Point).min(1),
  /** Legacy/compact preset reference. New first-party clients also embed `brush`. */
  brushPresetId: z.string().min(1).max(128).optional(),
  /** Immutable brush parameters used for exact replay across preset revisions. */
  brush: BrushDefinition.optional(),
  /** Explicit PRNG seed. If omitted, validation derives one from stable stroke input. */
  seed: z.number().int().min(0).max(0xffff_ffff).optional(),
  /** Version of the deterministic stamp/path algorithm used by this operation. */
  strokeVersion: z.literal(2).default(2),
});
export const DrawStrokeParams = DrawStrokeInput.transform((params) => ({
  ...params,
  seed: params.seed ?? deriveStrokeSeed(params),
}));
export type DrawStrokeInput = z.input<typeof DrawStrokeParams>;
export type DrawStrokeParams = z.infer<typeof DrawStrokeParams>;

export const DrawLineParams = z.object({
  layerId: LayerId,
  from: Point,
  to: Point,
  color: Color.default("#000000"),
  size: z.number().positive().max(500),
  opacity: z.number().min(0).max(1).default(1),
  dash: z.array(z.number()).optional(),
});
export type DrawLineParams = z.infer<typeof DrawLineParams>;

export const DrawRectParams = z.object({
  layerId: LayerId,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  stroke: Color.optional(),
  fill: Color.optional(),
  strokeWidth: z.number().positive().max(500).default(1),
  opacity: z.number().min(0).max(1).default(1),
});
export type DrawRectParams = z.infer<typeof DrawRectParams>;

export const DrawCircleParams = z.object({
  layerId: LayerId,
  cx: z.number(),
  cy: z.number(),
  r: z.number().positive(),
  stroke: Color.optional(),
  fill: Color.optional(),
  strokeWidth: z.number().positive().max(500).default(1),
  opacity: z.number().min(0).max(1).default(1),
});
export type DrawCircleParams = z.infer<typeof DrawCircleParams>;

export const DrawEllipseParams = z.object({
  layerId: LayerId,
  cx: z.number(),
  cy: z.number(),
  rx: z.number().positive(),
  ry: z.number().positive(),
  stroke: Color.optional(),
  fill: Color.optional(),
  strokeWidth: z.number().positive().max(500).default(1),
  opacity: z.number().min(0).max(1).default(1),
});
export type DrawEllipseParams = z.infer<typeof DrawEllipseParams>;

export const DrawFillParams = z.object({
  layerId: LayerId,
  x: z.number().int(),
  y: z.number().int(),
  color: Color,
  tolerance: z.number().min(0).max(64).default(16),
});
export type DrawFillParams = z.infer<typeof DrawFillParams>;

export const DrawTextParams = z.object({
  layerId: LayerId,
  x: z.number(),
  y: z.number(),
  text: z.string().max(2048),
  fontFamily: FontFamily.default("noto-sans"),
  size: z.number().positive().max(400),
  color: Color.default("#000000"),
  align: z.enum(["left", "center", "right"]).default("left"),
  opacity: z.number().min(0).max(1).default(1),
});
export type DrawTextParams = z.infer<typeof DrawTextParams>;

export const DrawSetPixelParams = z.object({
  layerId: LayerId,
  x: z.number().int(),
  y: z.number().int(),
  color: Color,
});
export type DrawSetPixelParams = z.infer<typeof DrawSetPixelParams>;

export const PathCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("M"), x: z.number(), y: z.number() }),
  z.object({ op: z.literal("L"), x: z.number(), y: z.number() }),
  z.object({ op: z.literal("Q"), cx: z.number(), cy: z.number(), x: z.number(), y: z.number() }),
  z.object({
    op: z.literal("C"),
    c1x: z.number(),
    c1y: z.number(),
    c2x: z.number(),
    c2y: z.number(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({ op: z.literal("Z") }),
]);
export type PathCommand = z.infer<typeof PathCommand>;

export const DrawPathParams = z
  .object({
    layerId: LayerId,
    commands: z.array(PathCommand).min(2).max(4096),
    stroke: Color.optional(),
    fill: Color.optional(),
    strokeWidth: z.number().positive().max(500).default(1),
    opacity: z.number().min(0).max(1).default(1),
    fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
    lineCap: z.enum(["butt", "round", "square"]).default("round"),
    lineJoin: z.enum(["round", "bevel", "miter"]).default("round"),
  })
  .refine((value) => value.commands[0]?.op === "M", {
    message: "Path must start with an M command",
    path: ["commands", 0],
  })
  .refine((value) => Boolean(value.stroke || value.fill), {
    message: "Path requires stroke or fill",
  });
export type DrawPathParams = z.infer<typeof DrawPathParams>;

export const GradientStop = z.object({
  offset: z.number().min(0).max(1),
  color: Color,
});
export type GradientStop = z.infer<typeof GradientStop>;

export const GradientDefinition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("linear"), from: Point, to: Point }),
  z.object({
    type: z.literal("radial"),
    inner: z.object({ x: z.number(), y: z.number(), r: z.number().nonnegative() }),
    outer: z.object({ x: z.number(), y: z.number(), r: z.number().positive() }),
  }),
]);
export type GradientDefinition = z.infer<typeof GradientDefinition>;

export const GradientShape = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rect"),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  }),
  z.object({ type: z.literal("circle"), cx: z.number(), cy: z.number(), r: z.number().positive() }),
  z.object({
    type: z.literal("ellipse"),
    cx: z.number(),
    cy: z.number(),
    rx: z.number().positive(),
    ry: z.number().positive(),
  }),
]);
export type GradientShape = z.infer<typeof GradientShape>;

export const DrawGradientParams = z
  .object({
    layerId: LayerId,
    gradient: GradientDefinition,
    shape: GradientShape,
    stops: z.array(GradientStop).min(2).max(32),
    opacity: z.number().min(0).max(1).default(1),
  })
  .superRefine((value, ctx) => {
    for (let index = 1; index < value.stops.length; index++) {
      if (value.stops[index]!.offset < value.stops[index - 1]!.offset) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Gradient stops must be ordered by offset",
          path: ["stops", index, "offset"],
        });
      }
    }
  });
export type DrawGradientParams = z.infer<typeof DrawGradientParams>;

export const DrawImageParams = z.object({
  layerId: LayerId,
  assetId: AssetId,
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  opacity: z.number().min(0).max(1).default(1),
  rotate: z.number().min(-36000).max(36000).default(0),
  smoothing: z.boolean().default(true),
});
export type DrawImageParams = z.infer<typeof DrawImageParams>;

export const DrawBatchParams = z.object({
  operations: z
    .array(
      z.object({
        method: z.string(),
        params: z.unknown(),
      }),
    )
    .min(1)
    .max(2000),
});
export type DrawBatchParams = z.infer<typeof DrawBatchParams>;
export const DrawBatchResult = z.object({
  results: z.array(z.union([z.object({ ok: z.literal(true) }), JsonRpcError])),
});
export type DrawBatchResult = z.infer<typeof DrawBatchResult>;

// ---------------------------------------------------------------------------
// history.* methods
// ---------------------------------------------------------------------------

export const HistoryUndoParams = z.object({
  steps: z.number().int().positive().max(100).default(1),
});
export type HistoryUndoParams = z.infer<typeof HistoryUndoParams>;
export const HistoryRedoParams = z.object({
  steps: z.number().int().positive().max(100).default(1),
});
export type HistoryRedoParams = z.infer<typeof HistoryRedoParams>;
export const HistoryGotoParams = z.object({
  index: z.number().int().nonnegative(),
});
export type HistoryGotoParams = z.infer<typeof HistoryGotoParams>;
export const HistoryGetLengthResult = z.object({
  undo: z.number(),
  redo: z.number(),
  total: z.number(),
});
export type HistoryGetLengthResult = z.infer<typeof HistoryGetLengthResult>;

// ---------------------------------------------------------------------------
// filter.* methods
// ---------------------------------------------------------------------------

export const FilterBlurParams = z.object({
  layerId: LayerId.optional(),
  radius: z.number().positive().max(50),
});
export type FilterBlurParams = z.infer<typeof FilterBlurParams>;
export const FilterInvertParams = z.object({ layerId: LayerId.optional() });
export type FilterInvertParams = z.infer<typeof FilterInvertParams>;
export const FilterGrayscaleParams = z.object({ layerId: LayerId.optional() });
export type FilterGrayscaleParams = z.infer<typeof FilterGrayscaleParams>;
export const FilterBrightnessParams = z.object({
  layerId: LayerId.optional(),
  amount: z.number().min(-1).max(1),
});
export type FilterBrightnessParams = z.infer<typeof FilterBrightnessParams>;
export const FilterContrastParams = z.object({
  layerId: LayerId.optional(),
  amount: z.number().min(-1).max(1),
});
export type FilterContrastParams = z.infer<typeof FilterContrastParams>;

// ---------------------------------------------------------------------------
// snapshot.* methods
// ---------------------------------------------------------------------------

export const SnapshotSaveParams = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(64),
});
export type SnapshotSaveParams = z.infer<typeof SnapshotSaveParams>;
export const SnapshotSaveResult = z.object({
  id: z.string(),
  path: z.string(),
  size: z.number(),
  width: z.number(),
  height: z.number(),
});
export type SnapshotSaveResult = z.infer<typeof SnapshotSaveResult>;
export const SnapshotLoadParams = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(64),
});
export type SnapshotLoadParams = z.infer<typeof SnapshotLoadParams>;
export const SnapshotLoadResult = z.object({
  width: z.number(),
  height: z.number(),
  layers: z.number(),
});
export type SnapshotLoadResult = z.infer<typeof SnapshotLoadResult>;

// ---------------------------------------------------------------------------
// asset.* — P1 immutable content-addressed raster assets
// ---------------------------------------------------------------------------

export const AssetMetadata = z.object({
  id: AssetId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: AssetMimeType,
  size: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
  createdAt: z.number(),
  url: z.string(),
});
export type AssetMetadata = z.infer<typeof AssetMetadata>;

export const AssetPutParams = z.object({
  data: z
    .string()
    .min(4)
    .max(28_000_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Expected base64 asset data"),
  mimeType: AssetMimeType,
  name: z.string().min(1).max(128).optional(),
});
export type AssetPutParams = z.infer<typeof AssetPutParams>;
export const AssetPutResult = AssetMetadata.extend({ existing: z.boolean() });
export type AssetPutResult = z.infer<typeof AssetPutResult>;

export const AssetGetParams = z.object({ assetId: AssetId });
export const AssetListParams = z
  .object({ limit: z.number().int().positive().max(1000).default(100) })
  .optional();
export const AssetListResult = z.object({ assets: z.array(AssetMetadata) });
export type AssetListResult = z.infer<typeof AssetListResult>;

// ---------------------------------------------------------------------------
// transaction.* and doc.* — P0 canonical document/version foundation
// ---------------------------------------------------------------------------

export const DocumentStateSnapshot = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  layers: z.array(Layer).min(1),
  activeLayerId: LayerId,
});
export type DocumentStateSnapshot = z.infer<typeof DocumentStateSnapshot>;

export const DocumentRasterLayer = z.object({
  id: LayerId,
  png: z.string(),
});
export type DocumentRasterLayer = z.infer<typeof DocumentRasterLayer>;

export const DocumentOperation = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  clientId: z.string(),
  ts: z.number(),
  transactionId: z.string().optional(),
});
export type DocumentOperation = z.infer<typeof DocumentOperation>;

export const DocumentReplaySnapshot = z.object({
  schemaVersion: z.literal(1),
  documentId: z.string(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  commitId: z.string(),
  branch: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  baseState: DocumentStateSnapshot,
  state: DocumentStateSnapshot,
  baseRaster: z.array(DocumentRasterLayer),
  operations: z.array(DocumentOperation),
  replayable: z.boolean(),
});
export type DocumentReplaySnapshot = z.infer<typeof DocumentReplaySnapshot>;

export const DocumentCommitSummary = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  branch: z.string(),
  revision: z.number().int().nonnegative(),
  ts: z.number(),
  clientId: z.string(),
  message: z.string(),
  operationCount: z.number().int().nonnegative(),
});
export type DocumentCommitSummary = z.infer<typeof DocumentCommitSummary>;

export const TransactionOperation = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type TransactionOperation = z.infer<typeof TransactionOperation>;

export const TransactionExecuteParams = z.object({
  idempotencyKey: z.string().min(1).max(128),
  message: z.string().max(256).default("Atomic edit"),
  operations: z.array(TransactionOperation).min(1).max(256),
});
export type TransactionExecuteParams = z.infer<typeof TransactionExecuteParams>;
export const TransactionExecuteResult = z.object({
  transactionId: z.string(),
  commitId: z.string(),
  revision: z.number().int().nonnegative(),
  replayed: z.boolean(),
  results: z.array(z.unknown()),
});
export type TransactionExecuteResult = z.infer<typeof TransactionExecuteResult>;

export const DocumentGetParams = z
  .object({
    commitId: z.string().optional(),
    compactActiveLayers: z.boolean().optional(),
  })
  .optional();
export const DocumentHistoryParams = z
  .object({ limit: z.number().int().positive().max(1000).default(100) })
  .optional();
export const DocumentHistoryResult = z.object({
  currentCommitId: z.string(),
  currentBranch: z.string(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  commits: z.array(DocumentCommitSummary),
});
export type DocumentHistoryResult = z.infer<typeof DocumentHistoryResult>;

export const DocumentStepParams = z.object({
  steps: z.number().int().positive().max(100).default(1),
});
export const DocumentRestoreResult = z.object({
  commitId: z.string(),
  revision: z.number().int().nonnegative(),
  branch: z.string(),
});
export type DocumentRestoreResult = z.infer<typeof DocumentRestoreResult>;

const RefName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
export const DocumentBranchCreateParams = z.object({ name: RefName });
export const DocumentBranchSwitchParams = z.object({ name: RefName });
export const DocumentBranchListResult = z.object({
  current: z.string(),
  branches: z.array(z.object({ name: z.string(), commitId: z.string() })),
});
export const DocumentCheckpointCreateParams = z.object({
  name: RefName,
  message: z.string().max(256).optional(),
});
export const DocumentCheckpointRestoreParams = z.object({ name: RefName });
export const DocumentCheckpointListResult = z.object({
  checkpoints: z.array(
    z.object({ name: z.string(), commitId: z.string(), revision: z.number() }),
  ),
});

export const DocumentRenderParams = z.object({
  format: z.literal("svg").default("svg"),
  commitId: z.string().optional(),
});
export const DocumentRenderResult = z.object({
  url: z.string(),
  size: z.number(),
  expiresAt: z.number(),
  mimeType: z.literal("image/svg+xml"),
  digest: z.string(),
  warnings: z.array(z.string()),
});
export type DocumentRenderResult = z.infer<typeof DocumentRenderResult>;

// ---------------------------------------------------------------------------
// event.* methods
// ---------------------------------------------------------------------------

export const EventSubscribeParams = z.object({
  types: z.array(z.string()).optional(),
});
export type EventSubscribeParams = z.infer<typeof EventSubscribeParams>;

// ---------------------------------------------------------------------------
// sync.* (handshake, not user-facing)
// ---------------------------------------------------------------------------

export const SyncHelloParams = z.object({
  role: z.enum(["browser", "agent"]),
  clientId: z.string().min(1),
  lastEventSeq: z.number().int().nonnegative().optional(),
});
export type SyncHelloParams = z.infer<typeof SyncHelloParams>;
export const SyncHelloResult = z.object({
  clientId: z.string(),
  isPrimary: z.boolean(),
  serverEventSeq: z.number(),
  state: CanvasGetInfoResult,
  document: DocumentReplaySnapshot.optional(),
});
export type SyncHelloResult = z.infer<typeof SyncHelloResult>;

// ---------------------------------------------------------------------------
// Event types — server -> all clients (notifications, no id)
// ---------------------------------------------------------------------------

export const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const EVENT_TYPES = [
  "stroke.started",
  "stroke.committed",
  "layer.created",
  "layer.deleted",
  "layer.changed",
  "layer.reordered",
  "layer.merged",
  "layer.flattened",
  "layer.transformed",
  "canvas.resized",
  "canvas.cleared",
  "canvas.filled",
  "canvas.imported",
  "history.undone",
  "history.redone",
  "history.cleared",
  "snapshot.saved",
  "snapshot.loaded",
  "filter.applied",
  "draw.batched",
  "transaction.committed",
  "document.committed",
  "document.restored",
  "document.branch.created",
  "document.checkpoint.created",
  "client.connected",
  "client.disconnected",
  "primary.changed",
  "error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Method registry — single source of truth for the router
// ---------------------------------------------------------------------------

export type MethodDef = {
  params?: z.ZodTypeAny;
  result?: z.ZodTypeAny;
  /** if true, the call requires a primary browser to be present */
  needsPrimary?: boolean;
  /** if true, this method is treated as a notification (no response) */
  notification?: boolean;
  /** if true, this method is broadcast as an event after execution */
  emitsEvent?: string;
};

export const METHODS: Record<string, MethodDef> = {
  // canvas.*
  "canvas.getInfo": { result: CanvasGetInfoResult },
  "canvas.resize": { params: CanvasResizeParams, needsPrimary: true, emitsEvent: "canvas.resized" },
  "canvas.clear": { params: CanvasClearParams, needsPrimary: true, emitsEvent: "canvas.cleared" },
  "canvas.fill": { params: CanvasFillParams, needsPrimary: true, emitsEvent: "canvas.filled" },
  "canvas.export": { params: CanvasExportParams, result: CanvasExportResult, needsPrimary: true },
  "canvas.import": { params: CanvasImportParams, needsPrimary: true, emitsEvent: "canvas.imported" },
  "canvas.getRegion": { params: CanvasGetRegionParams, result: CanvasGetRegionResult, needsPrimary: true },
  "canvas.analyze": { params: CanvasAnalyzeParams, result: CanvasAnalyzeResult, needsPrimary: true },
  "canvas.sample": { params: CanvasSampleParams, result: CanvasSampleResult, needsPrimary: true },

  // layer.*
  "layer.create": { params: LayerCreateParams, result: LayerCreateResult, needsPrimary: true, emitsEvent: "layer.created" },
  "layer.delete": { params: LayerDeleteParams, needsPrimary: true, emitsEvent: "layer.deleted" },
  "layer.list": { result: LayerListResult },
  "layer.setActive": { params: LayerSetActiveParams, needsPrimary: true, emitsEvent: "layer.changed" },
  "layer.setVisible": { params: LayerSetVisibleParams, needsPrimary: true, emitsEvent: "layer.changed" },
  "layer.setOpacity": { params: LayerSetOpacityParams, needsPrimary: true, emitsEvent: "layer.changed" },
  "layer.setBlendMode": { params: LayerSetBlendModeParams, needsPrimary: true, emitsEvent: "layer.changed" },
  "layer.rename": { params: LayerRenameParams, needsPrimary: true, emitsEvent: "layer.changed" },
  "layer.reorder": { params: LayerReorderParams, needsPrimary: true, emitsEvent: "layer.reordered" },
  "layer.merge": { params: LayerMergeParams, needsPrimary: true, emitsEvent: "layer.merged" },
  "layer.flatten": { params: LayerFlattenParams, result: LayerFlattenResult, needsPrimary: true, emitsEvent: "layer.flattened" },
  "layer.transform": { params: LayerTransformParams, needsPrimary: true, emitsEvent: "layer.transformed" },

  // draw.*
  "draw.stroke": { params: DrawStrokeParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.line": { params: DrawLineParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.rect": { params: DrawRectParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.circle": { params: DrawCircleParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.ellipse": { params: DrawEllipseParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.fill": { params: DrawFillParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.text": { params: DrawTextParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.setPixel": { params: DrawSetPixelParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.path": { params: DrawPathParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.gradient": { params: DrawGradientParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.image": { params: DrawImageParams, needsPrimary: true, emitsEvent: "stroke.committed" },
  "draw.batch": { params: DrawBatchParams, result: DrawBatchResult, needsPrimary: true, emitsEvent: "draw.batched" },

  // history.*
  "history.undo": { params: HistoryUndoParams, needsPrimary: true, emitsEvent: "history.undone" },
  "history.redo": { params: HistoryRedoParams, needsPrimary: true, emitsEvent: "history.redone" },
  "history.goto": { params: HistoryGotoParams, needsPrimary: true, emitsEvent: "history.undone" },
  "history.getLength": { result: HistoryGetLengthResult },
  "history.clear": { needsPrimary: true, emitsEvent: "history.cleared" },

  // filter.*
  "filter.blur": { params: FilterBlurParams, needsPrimary: true, emitsEvent: "filter.applied" },
  "filter.invert": { params: FilterInvertParams, needsPrimary: true, emitsEvent: "filter.applied" },
  "filter.grayscale": { params: FilterGrayscaleParams, needsPrimary: true, emitsEvent: "filter.applied" },
  "filter.brightness": { params: FilterBrightnessParams, needsPrimary: true, emitsEvent: "filter.applied" },
  "filter.contrast": { params: FilterContrastParams, needsPrimary: true, emitsEvent: "filter.applied" },

  // snapshot.*
  "snapshot.save": { params: SnapshotSaveParams, result: SnapshotSaveResult, needsPrimary: true, emitsEvent: "snapshot.saved" },
  "snapshot.load": { params: SnapshotLoadParams, result: SnapshotLoadResult, needsPrimary: true, emitsEvent: "snapshot.loaded" },

  // asset.* — immutable content-addressed raster library.
  "asset.put": { params: AssetPutParams, result: AssetPutResult },
  "asset.get": { params: AssetGetParams, result: AssetMetadata },
  "asset.list": { params: AssetListParams, result: AssetListResult },

  // transaction.* — validated, serialized and rolled back as one commit.
  "transaction.execute": {
    params: TransactionExecuteParams,
    result: TransactionExecuteResult,
    needsPrimary: true,
    emitsEvent: "transaction.committed",
  },

  // doc.* — canonical document, exact version history and branching.
  "doc.get": { params: DocumentGetParams, result: DocumentReplaySnapshot },
  "doc.history": { params: DocumentHistoryParams, result: DocumentHistoryResult },
  "doc.undo": { params: DocumentStepParams, result: DocumentRestoreResult, needsPrimary: true, emitsEvent: "document.restored" },
  "doc.redo": { params: DocumentStepParams, result: DocumentRestoreResult, needsPrimary: true, emitsEvent: "document.restored" },
  "doc.branch.create": { params: DocumentBranchCreateParams, result: DocumentRestoreResult, emitsEvent: "document.branch.created" },
  "doc.branch.list": { result: DocumentBranchListResult },
  "doc.branch.switch": { params: DocumentBranchSwitchParams, result: DocumentRestoreResult, needsPrimary: true, emitsEvent: "document.restored" },
  "doc.checkpoint.create": { params: DocumentCheckpointCreateParams, result: DocumentRestoreResult, emitsEvent: "document.checkpoint.created" },
  "doc.checkpoint.list": { result: DocumentCheckpointListResult },
  "doc.checkpoint.restore": { params: DocumentCheckpointRestoreParams, result: DocumentRestoreResult, needsPrimary: true, emitsEvent: "document.restored" },
  "doc.render": { params: DocumentRenderParams, result: DocumentRenderResult },

  // ops.* — operation log (mutation history). Read-only queries + clear.
  // No emitsEvent: ops.list/clear are about the log itself, not canvas state.
  "ops.list": {
    params: z
      .object({
        sinceStep: z.number().int().nonnegative().optional(),
        methodPrefix: z.string().optional(),
        limit: z.number().int().positive().max(10000).optional(),
      })
      .optional(),
  },
  "ops.clear": {},
  "ops.getStep": { result: z.object({ step: z.number() }) },

  // ops.replay — clear the canvas on the primary and re-apply ops 1..toStep.
  // Used by agents to capture snapshots at past steps without permanently
  // destroying current state (caller is expected to follow with another
  // replay to restore). Returns the canvas.export-style URL after replay.
  "ops.replay": {
    params: z.object({
      toStep: z.number().int().nonnegative(),
      snapshot: z.boolean().default(true),
    }),
    needsPrimary: true,
    emitsEvent: "history.cleared",
  },

  // canvas.snapshot — convenience alias for canvas.export { format: "png" }.
  // Returns same shape. Useful for agent workflows that want a current pic.
  "canvas.snapshot": { result: CanvasExportResult, needsPrimary: true },

  // canvas.getState — full JSON state of all layers with per-layer thumbnail
  // URLs. Designed for multimodal agent inspection (look at all layers at once
  // without N separate RPCs).
  "canvas.getState": {
    result: z.object({
      width: z.number(),
      height: z.number(),
      activeLayerId: LayerId.nullable(),
      step: z.number(),
      layers: z.array(
        z.object({
          id: LayerId,
          name: z.string(),
          visible: z.boolean(),
          opacity: z.number(),
          blendMode: BlendMode,
          thumbnailUrl: z.string(),
          thumbnailExpiresAt: z.number(),
        }),
      ),
    }),
    needsPrimary: true,
  },

  // event.*
  "event.subscribe": { params: EventSubscribeParams, notification: true },
  "event.unsubscribeAll": { notification: true },

  // sync.*
  "sync.hello": { params: SyncHelloParams, result: SyncHelloResult },

  // heartbeat (notification, keeps connection alive)
  "heartbeat.ping": { notification: true },
};

// ---------------------------------------------------------------------------
// Internal proxy protocol — server <-> primary browser
// ---------------------------------------------------------------------------

/**
 * When server needs primary to execute a pixel-level RPC, it sends an
 * `internal.exec` request to the primary. Primary returns the result.
 *
 * This is the only method that is server-initiated (server is the requester).
 */
export const InternalExecParams = z.object({
  origMethod: z.string(),
  origParams: z.unknown(),
  requestId: RpcIdSchema,
});
export type InternalExecParams = z.infer<typeof InternalExecParams>;

export const InternalSnapshotParams = z.object({
  requestId: RpcIdSchema,
  /** if true, only metadata (no PNG blob) is needed */
  metadataOnly: z.boolean().default(false),
});
export type InternalSnapshotParams = z.infer<typeof InternalSnapshotParams>;
