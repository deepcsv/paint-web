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
export const JSONRPC_VERSION = "2.0";
/** RpcId is just a number or string identifier — no brand, to keep it usable as both type and runtime value. */
export const RpcIdSchema = z.union([z.number(), z.string()]);
export const JsonRpcRequest = z.object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RpcIdSchema.optional(),
    method: z.string(),
    params: z.unknown().optional(),
});
export const JsonRpcError = z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
});
export const JsonRpcResponse = z.object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RpcIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcError.optional(),
});
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
};
// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------
export const Color = z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
    .transform((s) => (s.startsWith("#") ? s : "#" + s));
export const Point = z.object({
    x: z.number(),
    y: z.number(),
    pressure: z.number().min(0).max(1).optional(),
});
export const Rect = z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
});
export const LayerId = z.string();
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
export const Layer = z.object({
    id: LayerId,
    name: z.string(),
    visible: z.boolean(),
    opacity: z.number().min(0).max(1),
    blendMode: BlendMode,
});
// Font whitelist — preloaded by the browser
export const FontFamily = z.enum(["noto-sans", "source-han-sans", "monospace"]);
export const FONT_WHITELIST = [
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
export const CanvasResizeParams = z.object({
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    mode: z.enum(["crop", "scale", "anchor"]).default("anchor"),
});
export const CanvasClearParams = z.object({
    layerId: LayerId.optional(),
});
export const CanvasFillParams = z.object({
    color: Color,
    layerId: LayerId.optional(),
});
export const CanvasExportParams = z.object({
    format: z.enum(["png", "jpeg"]).default("png"),
    layerId: LayerId.optional(),
    bounds: Rect.optional(),
    quality: z.number().min(0).max(1).default(0.92),
});
export const CanvasExportResult = z.object({
    url: z.string(),
    size: z.number(),
    expiresAt: z.number(),
});
export const CanvasImportParams = z.object({
    url: z.string(),
    layerId: LayerId.optional(),
});
export const CanvasGetRegionParams = z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    layerId: LayerId.optional(),
});
export const CanvasGetRegionResult = z.object({
    url: z.string(),
    expiresAt: z.number(),
});
// ---------------------------------------------------------------------------
// layer.* methods
// ---------------------------------------------------------------------------
export const LayerCreateParams = z.object({
    name: z.string().max(64).optional(),
});
export const LayerCreateResult = z.object({
    layerId: LayerId,
});
export const LayerDeleteParams = z.object({ layerId: LayerId });
export const LayerListResult = z.object({
    layers: z.array(Layer),
});
export const LayerSetActiveParams = z.object({ layerId: LayerId });
export const LayerSetVisibleParams = z.object({
    layerId: LayerId,
    visible: z.boolean(),
});
export const LayerSetOpacityParams = z.object({
    layerId: LayerId,
    opacity: z.number().min(0).max(1),
});
export const LayerSetBlendModeParams = z.object({
    layerId: LayerId,
    blendMode: BlendMode,
});
export const LayerRenameParams = z.object({
    layerId: LayerId,
    name: z.string().max(64),
});
export const LayerReorderParams = z.object({
    layerIds: z.array(LayerId),
});
export const LayerMergeParams = z.object({
    fromId: LayerId,
    intoId: LayerId,
});
// ---------------------------------------------------------------------------
// draw.* methods
// ---------------------------------------------------------------------------
export const DrawStrokeParams = z.object({
    layerId: LayerId,
    tool: z.enum(["brush", "eraser"]),
    color: Color.default("#000000"),
    size: z.number().positive().max(500),
    opacity: z.number().min(0).max(1).default(1),
    points: z.array(Point).min(1),
});
export const DrawLineParams = z.object({
    layerId: LayerId,
    from: Point,
    to: Point,
    color: Color.default("#000000"),
    size: z.number().positive().max(500),
    opacity: z.number().min(0).max(1).default(1),
    dash: z.array(z.number()).optional(),
});
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
export const DrawFillParams = z.object({
    layerId: LayerId,
    x: z.number().int(),
    y: z.number().int(),
    color: Color,
    tolerance: z.number().min(0).max(64).default(16),
});
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
export const DrawSetPixelParams = z.object({
    layerId: LayerId,
    x: z.number().int(),
    y: z.number().int(),
    color: Color,
});
export const DrawBatchParams = z.object({
    operations: z
        .array(z.object({
        method: z.string(),
        params: z.unknown(),
    }))
        .min(1)
        .max(2000),
});
export const DrawBatchResult = z.object({
    results: z.array(z.union([z.object({ ok: z.literal(true) }), JsonRpcError])),
});
// ---------------------------------------------------------------------------
// history.* methods
// ---------------------------------------------------------------------------
export const HistoryUndoParams = z.object({
    steps: z.number().int().positive().max(100).default(1),
});
export const HistoryRedoParams = z.object({
    steps: z.number().int().positive().max(100).default(1),
});
export const HistoryGotoParams = z.object({
    index: z.number().int().nonnegative(),
});
export const HistoryGetLengthResult = z.object({
    undo: z.number(),
    redo: z.number(),
    total: z.number(),
});
// ---------------------------------------------------------------------------
// filter.* methods
// ---------------------------------------------------------------------------
export const FilterBlurParams = z.object({
    layerId: LayerId.optional(),
    radius: z.number().positive().max(50),
});
export const FilterInvertParams = z.object({ layerId: LayerId.optional() });
export const FilterGrayscaleParams = z.object({ layerId: LayerId.optional() });
export const FilterBrightnessParams = z.object({
    layerId: LayerId.optional(),
    amount: z.number().min(-1).max(1),
});
export const FilterContrastParams = z.object({
    layerId: LayerId.optional(),
    amount: z.number().min(-1).max(1),
});
// ---------------------------------------------------------------------------
// snapshot.* methods
// ---------------------------------------------------------------------------
export const SnapshotSaveParams = z.object({
    name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .max(64),
});
export const SnapshotSaveResult = z.object({
    id: z.string(),
    path: z.string(),
    size: z.number(),
    width: z.number(),
    height: z.number(),
});
export const SnapshotLoadParams = z.object({
    name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .max(64),
});
export const SnapshotLoadResult = z.object({
    width: z.number(),
    height: z.number(),
    layers: z.number(),
});
// ---------------------------------------------------------------------------
// event.* methods
// ---------------------------------------------------------------------------
export const EventSubscribeParams = z.object({
    types: z.array(z.string()).optional(),
});
// ---------------------------------------------------------------------------
// sync.* (handshake, not user-facing)
// ---------------------------------------------------------------------------
export const SyncHelloParams = z.object({
    role: z.enum(["browser", "agent"]),
    clientId: z.string().min(1),
    lastEventSeq: z.number().int().nonnegative().optional(),
});
export const SyncHelloResult = z.object({
    clientId: z.string(),
    isPrimary: z.boolean(),
    serverEventSeq: z.number(),
    state: CanvasGetInfoResult,
});
// ---------------------------------------------------------------------------
// Event types — server -> all clients (notifications, no id)
// ---------------------------------------------------------------------------
export const EventEnvelope = z.object({
    seq: z.number().int().nonnegative(),
    type: z.string(),
    data: z.unknown(),
});
export const EVENT_TYPES = [
    "stroke.started",
    "stroke.committed",
    "layer.created",
    "layer.deleted",
    "layer.changed",
    "layer.reordered",
    "layer.merged",
    "layer.flattened",
    "canvas.resized",
    "canvas.cleared",
    "canvas.filled",
    "history.undone",
    "history.redone",
    "history.cleared",
    "snapshot.saved",
    "snapshot.loaded",
    "filter.applied",
    "draw.batched",
    "client.connected",
    "client.disconnected",
    "primary.changed",
    "error",
];
export const METHODS = {
    // canvas.*
    "canvas.getInfo": { result: CanvasGetInfoResult },
    "canvas.resize": { params: CanvasResizeParams, needsPrimary: true, emitsEvent: "canvas.resized" },
    "canvas.clear": { params: CanvasClearParams, needsPrimary: true, emitsEvent: "canvas.cleared" },
    "canvas.fill": { params: CanvasFillParams, needsPrimary: true, emitsEvent: "canvas.filled" },
    "canvas.export": { params: CanvasExportParams, result: CanvasExportResult, needsPrimary: true },
    "canvas.import": { params: CanvasImportParams, needsPrimary: true },
    "canvas.getRegion": { params: CanvasGetRegionParams, result: CanvasGetRegionResult, needsPrimary: true },
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
    "layer.flatten": { needsPrimary: true, emitsEvent: "layer.flattened" },
    // draw.*
    "draw.stroke": { params: DrawStrokeParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.line": { params: DrawLineParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.rect": { params: DrawRectParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.circle": { params: DrawCircleParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.ellipse": { params: DrawEllipseParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.fill": { params: DrawFillParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.text": { params: DrawTextParams, needsPrimary: true, emitsEvent: "stroke.committed" },
    "draw.setPixel": { params: DrawSetPixelParams, needsPrimary: true, emitsEvent: "stroke.committed" },
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
export const InternalSnapshotParams = z.object({
    requestId: RpcIdSchema,
    /** if true, only metadata (no PNG blob) is needed */
    metadataOnly: z.boolean().default(false),
});
