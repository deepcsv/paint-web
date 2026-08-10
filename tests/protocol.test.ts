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
});
