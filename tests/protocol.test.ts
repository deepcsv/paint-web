import { describe, it, expect } from "vitest";
import {
  DrawStrokeParams,
  DrawFillParams,
  DrawTextParams,
  CanvasExportParams,
  SnapshotSaveParams,
  Color,
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
    }
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
});
