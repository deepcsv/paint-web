import { describe, it, expect } from "vitest";
import {
  AssetPutParams,
  CanvasImportParams,
  DrawStrokeParams,
  DrawGradientParams,
  DrawPathParams,
  DrawFillParams,
  DrawTextParams,
  CanvasExportParams,
  SnapshotSaveParams,
  Color,
  DocumentGetParams,
  DocumentReplaySnapshot,
  TransactionExecuteParams,
  CanvasSampleParams,
  BrushSelfTestParams,
  WatercolorStepParams,
  WatercolorSetPaperParams,
  WatercolorProbeParams,
  WatercolorDryParams
} from "../shared/protocol.js";

describe("protocol schemas", () => {
  it("Color accepts #rrggbb, #rrggbbaa with or without #", () => {
    expect(Color.parse("ff0000")).toBe("#ff0000");
    expect(Color.parse("#ff000080")).toBe("#ff000080");
    expect(() => Color.parse("#000")).toThrow(); // no 3-digit shorthand
  });

  it("DrawStrokeParams validates tool enum", () => {
    const r = DrawStrokeParams.safeParse({
      layerId: "L1",
      tool: "brush",
      color: "#ff0000",
      size: 5,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.opacity).toBe(1); // default
      expect(r.data.points.length).toBe(2);
      expect(r.data.strokeVersion).toBe(2);
      expect(r.data.seed).toBeTypeOf("number");
    }
  });

  it("derives stable stroke seeds and preserves explicit seeds", () => {
    const input = {
      layerId: "L_seed",
      tool: "brush" as const,
      color: "#222222",
      size: 6,
      points: [{ x: 1, y: 2 }, { x: 10, y: 12 }],
    };
    const first = DrawStrokeParams.parse(input);
    const second = DrawStrokeParams.parse(input);
    const changed = DrawStrokeParams.parse({ ...input, points: [{ x: 1, y: 2 }, { x: 11, y: 12 }] });
    const explicit = DrawStrokeParams.parse({ ...input, seed: 42 });

    expect(first.seed).toBe(second.seed);
    expect(changed.seed).not.toBe(first.seed);
    expect(explicit.seed).toBe(42);
  });

  it("DrawStrokeParams rejects invalid tool", () => {
    const r = DrawStrokeParams.safeParse({ layerId: "L1", tool: "spray", size: 5, points: [] });
    expect(r.success).toBe(false);
  });

  it("DrawStrokeParams requires at least 1 point", () => {
    const r = DrawStrokeParams.safeParse({
      layerId: "L1",
      tool: "brush",
      size: 5,
      points: [],
    });
    expect(r.success).toBe(false);
  });

  it("DrawFillParams enforces tolerance range", () => {
    const r = DrawFillParams.safeParse({
      layerId: "L1",
      x: 0,
      y: 0,
      color: "#000000",
      tolerance: 200, // too high
    });
    expect(r.success).toBe(false);
  });

  it("DrawTextParams restricts fontFamily to whitelist", () => {
    const r = DrawTextParams.safeParse({
      layerId: "L1",
      x: 0,
      y: 0,
      text: "hi",
      fontFamily: "comic-sans",
      size: 16,
      color: "#000000",
    });
    expect(r.success).toBe(false);
  });

  it("CanvasExportParams sets default format", () => {
    const r = CanvasExportParams.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe("png");
  });

  it("SnapshotSaveParams rejects path-traversal names", () => {
    expect(SnapshotSaveParams.safeParse({ name: "../evil" }).success).toBe(false);
    expect(SnapshotSaveParams.safeParse({ name: "ok_name-1" }).success).toBe(true);
  });

  it("TransactionExecuteParams supplies a commit message and requires a retry key", () => {
    const parsed = TransactionExecuteParams.safeParse({
      idempotencyKey: "pass-01",
      operations: [{ method: "canvas.clear", params: {} }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.message).toBe("Atomic edit");
    expect(
      TransactionExecuteParams.safeParse({ operations: [{ method: "canvas.clear", params: {} }] })
        .success,
    ).toBe(false);
  });

  it("DocumentReplaySnapshot validates canonical recovery payloads", () => {
    const layer = {
      id: "L_base",
      name: "Base",
      visible: true,
      opacity: 1,
      blendMode: "source-over" as const,
    };
    expect(
      DocumentReplaySnapshot.safeParse({
        schemaVersion: 1,
        documentId: "D_test",
        title: "Test",
        revision: 0,
        commitId: "C_0",
        branch: "main",
        createdAt: 1,
        updatedAt: 1,
        baseState: { width: 1280, height: 720, layers: [layer], activeLayerId: layer.id },
        state: { width: 1280, height: 720, layers: [layer], activeLayerId: layer.id },
        baseRaster: [{ id: layer.id, png: "" }],
        operations: [],
        replayable: true,
      }).success,
    ).toBe(true);
  });

  it("preserves the active-layer replay compaction request", () => {
    expect(DocumentGetParams.parse({ compactActiveLayers: true })).toEqual({
      compactActiveLayers: true,
    });
  });

  it("CanvasImportParams requires exactly one durable or external source", () => {
    const assetId = `A_${"a".repeat(64)}`;
    expect(CanvasImportParams.safeParse({ assetId }).success).toBe(true);
    expect(CanvasImportParams.safeParse({ url: "/snapshot/example" }).success).toBe(true);
    expect(CanvasImportParams.safeParse({}).success).toBe(false);
    expect(CanvasImportParams.safeParse({ assetId, url: "/both" }).success).toBe(false);
  });

  it("validates P1 paths and ordered gradients", () => {
    expect(
      DrawPathParams.safeParse({
        layerId: "L_path",
        commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 10, y: 10 }],
        stroke: "#000000",
      }).success,
    ).toBe(true);
    expect(
      DrawPathParams.safeParse({
        layerId: "L_path",
        commands: [{ op: "L", x: 0, y: 0 }, { op: "Z" }],
        fill: "#ffffff",
      }).success,
    ).toBe(false);
    expect(
      DrawGradientParams.safeParse({
        layerId: "L_gradient",
        gradient: { type: "linear", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
        shape: { type: "rect", x: 0, y: 0, w: 100, h: 100 },
        stops: [
          { offset: 0.8, color: "#ffffff" },
          { offset: 0.2, color: "#000000" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported asset media and malformed base64", () => {
    expect(
      AssetPutParams.safeParse({ data: "aW1hZ2U=", mimeType: "image/png", name: "reference" })
        .success,
    ).toBe(true);
    expect(AssetPutParams.safeParse({ data: "%%%", mimeType: "image/png" }).success).toBe(false);
    expect(AssetPutParams.safeParse({ data: "aW1hZ2U=", mimeType: "image/svg+xml" }).success).toBe(false);
  });

describe("P1 upgrades: clip / gradient fill / region sampling / brush.selfTest", () => {
  it("DrawPathParams accepts gradient fill and clip, rejects clip without M", () => {
    const ok = DrawPathParams.safeParse({
      layerId: "L_a",
      commands: [
        { op: "M", x: 0, y: 0 },
        { op: "L", x: 10, y: 10 },
        { op: "Z" },
      ],
      fill: { gradient: { type: "linear", from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, stops: [{ offset: 0, color: "#112233" }] } },
      clip: [
        { op: "M", x: 0, y: 0 },
        { op: "L", x: 20, y: 0 },
        { op: "L", x: 20, y: 20 },
        { op: "Z" },
      ],
    });
    expect(ok.success).toBe(true);

    const badClip = DrawPathParams.safeParse({
      layerId: "L_a",
      commands: [
        { op: "M", x: 0, y: 0 },
        { op: "L", x: 10, y: 10 },
      ],
      fill: "#ffffff",
      clip: [
        { op: "L", x: 0, y: 0 },
        { op: "L", x: 5, y: 5 },
      ],
    });
    expect(badClip.success).toBe(false);
  });

  it("DrawStrokeParams accepts optional clip mask", () => {
    const ok = DrawStrokeParams.safeParse({
      layerId: "L_a",
      tool: "brush",
      color: "#000000",
      size: 4,
      points: [{ x: 1, y: 1, pressure: 0.5 }],
      clip: [
        { op: "M", x: 0, y: 0 },
        { op: "L", x: 9, y: 0 },
        { op: "L", x: 9, y: 9 },
        { op: "Z" },
      ],
    });
    expect(ok.success && ok.data.clip?.length === 4).toBe(true);
  });

  it("CanvasSampleParams requires points or region; region stride bounded", () => {
    expect(CanvasSampleParams.safeParse({ points: [{ x: 1, y: 1 }] }).success).toBe(true);
    expect(
      CanvasSampleParams.safeParse({ region: { x: 0, y: 0, w: 100, h: 100 } }).success,
    ).toBe(true);
    expect(CanvasSampleParams.safeParse({}).success).toBe(false);
    expect(
      CanvasSampleParams.safeParse({ region: { x: 0, y: 0, w: 10, h: 10, stride: 64 } }).success,
    ).toBe(false);
  });

  it("BrushSelfTestParams applies sane defaults and bounds", () => {
    expect(BrushSelfTestParams.safeParse({}).success).toBe(true);
    expect(BrushSelfTestParams.safeParse({ presets: ["中性笔"], size: 8, opacities: [0.5] }).success).toBe(true);
    expect(BrushSelfTestParams.safeParse({ opacities: [] }).success).toBe(false);
    expect(BrushSelfTestParams.safeParse({ size: 5000 }).success).toBe(false);
  });
});

describe("watercolor tool and methods", () => {
  it("draw.stroke accepts the watercolor tool with wetness and pigments", () => {
    const ok = DrawStrokeParams.safeParse({
      layerId: "L_w",
      tool: "watercolor",
      color: "#000000",
      size: 30,
      points: [{ x: 1, y: 1, pressure: 0.6 }],
      water: 0.55,
      pigments: [{ name: "French Ultramarine", amount: 1 }],
    });
    expect(ok.success).toBe(true);
  });

  it("water method schemas validate bounds", () => {
    expect(WatercolorStepParams.safeParse({ layerId: "L_w" }).success).toBe(true);
    expect(WatercolorStepParams.safeParse({ layerId: "L_w", frames: 9999 }).success).toBe(false);
    expect(WatercolorSetPaperParams.safeParse({ layerId: "L_w", preset: "cold" }).success).toBe(true);
    expect(WatercolorSetPaperParams.safeParse({ layerId: "L_w", preset: "bamboo" }).success).toBe(false);
    expect(WatercolorProbeParams.safeParse({ layerId: "L_w", x: 0.5, y: 0.5 }).success).toBe(true);
    expect(WatercolorDryParams.safeParse({}).success).toBe(false);
  });

  it("pigment library derives K/S and builds slot loads", async () => {
    const mod = await import("../src/brush/WatercolorPigments.js");
    expect(mod.PIGMENTS.length).toBeGreaterThanOrEqual(16);
    const ultra = mod.pigmentByName("french ultramarine");
    expect(ultra).toBeDefined();
    expect(ultra!.K.every(k => k >= 0)).toBe(true);
    const slots = mod.buildSlotLoads([{ name: "French Ultramarine", amount: 1 }], 0.5);
    expect(slots.loads[0]).toBeGreaterThan(0);
    expect(slots.loads[0]).toBeLessThanOrEqual(0.16 * 2);
    // dilution saturates below 2.2
    expect(mod.dilute(100)).toBeLessThanOrEqual(2.2);
    // K-M reflectance over white stays in range
    const r = mod.kmReflect(ultra!.K[0], ultra!.S[0], 0.93);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe("hand tool (five-layer error synthesis)", () => {
  it("draw.stroke accepts the hand tool with error options", () => {
    const ok = DrawStrokeParams.safeParse({
      layerId: "L_h",
      tool: "hand",
      color: "#1f1d1a",
      size: 4,
      points: [{ x: 10, y: 10 }, { x: 200, y: 30 }],
      hand: { style: "broken", amp: 3.2, taper: 0.25, over: 5, crumbs: true },
    });
    expect(ok.success).toBe(true);
  });

  it("hand options bounds enforced", () => {
    expect(DrawStrokeParams.safeParse({
      layerId: "L_h", tool: "hand", color: "#000000", size: 4,
      points: [{ x: 0, y: 0 }], hand: { style: "gogh" },
    }).success).toBe(false);
    expect(DrawStrokeParams.safeParse({
      layerId: "L_h", tool: "hand", color: "#000000", size: 4,
      points: [{ x: 0, y: 0 }], hand: { amp: 99 },
    }).success).toBe(false);
    expect(DrawStrokeParams.safeParse({
      layerId: "L_h", tool: "hand", color: "#000000", size: 4,
      points: [{ x: 0, y: 0 }], hand: { taper: 0.9 },
    }).success).toBe(false);
  });

  it("HandEngine primitives are deterministic per seed", async () => {
    const { handStroke, handHatchFill } = await import("../src/canvas/HandEngine.js");
    const { Canvas } = await import("@napi-rs/canvas");
    const draw = (seed: number) => {
      const c = new Canvas(200, 100);
      const ctx = c.getContext("2d");
      handStroke(ctx, [[20, 50], [100, 40], [180, 60]], 6, { seed, alpha: 0.9 });
      handHatchFill(ctx, [[30, 10], [170, 10], [170, 90], [30, 90]], 8, 0.8, 0.5, { seed: seed + 1 });
      return ctx.getImageData(0, 0, 200, 100).data;
    };
    const a = draw(42), b = draw(42), c2 = draw(43);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(c2))).not.toBe(0);
  });
});
});
