import { describe, it, expect, beforeEach } from "vitest";
import { Canvas } from "@napi-rs/canvas";
import { renderStroke, clearProcTexCache } from "../src/canvas/StampEngine.js";
import type { BrushPreset } from "../src/brush/BrushTypes.js";
import { DEFAULT_BRUSH } from "../src/brush/BrushTypes.js";
import { ALL_BRUSHES, getByNameOrId, getById, NAME_TO_ID } from "../src/brush/BrushPresets.js";
import { BrushDefinition } from "../shared/protocol.js";

// Run the exact Canvas2D pixel paths in Node through the Skia-backed Canvas
// implementation instead of silently skipping every rendering assertion.
if (typeof globalThis.OffscreenCanvas === "undefined") {
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: Canvas,
  });
}
const maybeDescribe = describe;

// ── Helpers: create real offscreen canvas ────────────────────────────────

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return { canvas, ctx };
}

function getPixel(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): Uint8ClampedArray {
  return ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
}

function isTransparent(px: Uint8ClampedArray): boolean {
  return px[3] === 0;
}

function pixelHex(px: Uint8ClampedArray): string {
  return `${px[0].toString(16).padStart(2,"0")}${px[1].toString(16).padStart(2,"0")}${px[2].toString(16).padStart(2,"0")}`;
}

// ── Test presets ─────────────────────────────────────────────────────────

const HARD_ROUND: BrushPreset = { ...DEFAULT_BRUSH, width: 30, hardness: 1, spacing: 0.15, alpha: 1, brushFlow: 1, supportPressure: true };
const SOFT_ROUND: BrushPreset = { ...DEFAULT_BRUSH, width: 40, hardness: 0.3, spacing: 0.1, alpha: 0.8, brushFlow: 0.5, supportPressure: true };
const ERASER_PRESET: BrushPreset = { ...DEFAULT_BRUSH, width: 30, eraser: true, hardness: 1, spacing: 0.15 };
const MARKER: BrushPreset = { ...DEFAULT_BRUSH, width: 60, hardness: 1, roundness: 0.81, spacing: 0.03, alpha: 1, brushFlow: 1, useShape: true, shapeTexture: "makebi_shape", supportPressure: true };

// ════════════════════════════════════════════════════════════════════════
// P0: source-in must NOT destroy existing layer content
// ════════════════════════════════════════════════════════════════════════

maybeDescribe("P0: stamp buffer isolation", () => {
  beforeEach(() => clearProcTexCache());

  it("drawing a stamp at X does NOT erase content at Y", () => {
    const { ctx } = makeCanvas(400, 200);
    // Draw a red block at left
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(50, 50, 100, 100);
    // Verify red block exists
    const pxBefore = getPixel(ctx, 100, 100);
    expect(pixelHex(pxBefore)).toBe("ff0000");
    expect(pxBefore[3]).toBe(255);

    // Draw a hard-round stamp at right side
    renderStroke(ctx, HARD_ROUND, [{ x: 300, y: 100 }, { x: 320, y: 100 }], "#0000ff", {});

    // The red block at (100,100) must still be there
    const pxAfter = getPixel(ctx, 100, 100);
    expect(pixelHex(pxAfter)).toBe("ff0000");
    expect(pxAfter[3]).toBe(255); // NOT transparent
  });

  it("drawing multiple stamps does NOT erase earlier stamps", () => {
    const { ctx } = makeCanvas(400, 200);
    // Stroke 1 at top
    renderStroke(ctx, HARD_ROUND, [{ x: 50, y: 50 }, { x: 150, y: 50 }], "#ff0000", {});
    const p1 = getPixel(ctx, 100, 50);
    expect(p1[3]).toBeGreaterThan(200); // should be opaque red

    // Stroke 2 at bottom
    renderStroke(ctx, HARD_ROUND, [{ x: 50, y: 150 }, { x: 150, y: 150 }], "#00ff00", {});
    const p2 = getPixel(ctx, 100, 150);
    expect(p2[3]).toBeGreaterThan(200);

    // Stroke 1 must still be intact after stroke 2
    const p1After = getPixel(ctx, 100, 50);
    expect(pixelHex(p1After)).toBe("ff0000");
    expect(p1After[3]).toBeGreaterThan(200);
  });

  it("soft-edged brush does NOT destroy existing content (P0 regression)", () => {
    const { ctx } = makeCanvas(400, 200);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(20, 20, 80, 80);

    // Soft brush elsewhere — this was the original P0 trigger
    renderStroke(ctx, SOFT_ROUND, [{ x: 250, y: 100 }, { x: 300, y: 100 }], "#ff0000", {});

    // Existing green block must be intact
    const px = getPixel(ctx, 60, 60);
    expect(pixelHex(px)).toBe("00ff00");
    expect(px[3]).toBe(255);
  });

  it("MARKER (useShape=true, triggers source-in) does NOT erase existing content", () => {
    const { ctx } = makeCanvas(400, 200);
    // Draw a red block at left
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(50, 50, 100, 100);
    const pxBefore = getPixel(ctx, 100, 100);
    expect(pxBefore[3]).toBe(255);

    // MARKER has useShape=true → triggers source-in in stamp buffer.
    // This is the exact code path from the original P0 bug.
    renderStroke(ctx, MARKER, [{ x: 300, y: 100 }, { x: 320, y: 100 }], "#0000ff", {});

    // Red block at (100,100) must survive the source-in stamp
    const pxAfter = getPixel(ctx, 100, 100);
    expect(pixelHex(pxAfter)).toBe("ff0000");
    expect(pxAfter[3]).toBe(255);
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1: stroke-level opacity (not per-stamp)
// ════════════════════════════════════════════════════════════════════════

maybeDescribe("P1: stroke-level opacity", () => {
  it("opacity=0.15 produces visibly lighter result than opacity=1.0", () => {
    const { ctx: ctxFull } = makeCanvas(200, 100);
    const { ctx: ctxLow } = makeCanvas(200, 100);

    const brush: BrushPreset = { ...HARD_ROUND, width: 40, spacing: 0.03 }; // dense spacing

    const points = [{ x: 50, y: 50, pressure: 1 }, { x: 150, y: 50, pressure: 1 }];
    renderStroke(ctxFull, brush, points, "#000000", {}, 1, { opacityOverride: 1.0 });
    renderStroke(ctxLow, brush, points, "#000000", {}, 1, { opacityOverride: 0.15 });

    const pxFull = getPixel(ctxFull, 100, 50);
    const pxLow = getPixel(ctxLow, 100, 50);

    // Full opacity should be near-black (low R,G,B values)
    expect(pxFull[0]).toBeLessThan(50);
    expect(pxFull[3]).toBeGreaterThan(200);

    // On a transparent surface unpremultiplied RGB remains black; alpha carries
    // the stroke-level opacity difference.
    expect(pxLow[3]).toBeLessThan(pxFull[3]);
  });

  it("eraser mode with low opacity partially erases", () => {
    const { ctx } = makeCanvas(200, 100);
    // Fill with red
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 200, 100);

    // Erase at 50% opacity
    renderStroke(ctx, { ...HARD_ROUND, eraser: true }, [{ x: 50, y: 50, pressure: 1 }, { x: 150, y: 50, pressure: 1 }], "#000000", {}, 1, { opacityOverride: 0.5 });

    // Erased area should be partially transparent
    const px = getPixel(ctx, 100, 50);
    expect(px[3]).toBeLessThan(255);
    expect(px[3]).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1: rotation includes preset.rotation
// ════════════════════════════════════════════════════════════════════════

maybeDescribe("P1: rotation", () => {
  it("preset.rotation=90 produces vertical stamp on horizontal stroke", () => {
    const { ctx: ctx90 } = makeCanvas(200, 200);
    const { ctx: ctx0 } = makeCanvas(200, 200);

    const brush90: BrushPreset = { ...HARD_ROUND, rotation: 90, roundness: 0.3, rotFlowFinger: false, width: 60 };
    const brush0: BrushPreset = { ...HARD_ROUND, rotation: 0, roundness: 0.3, rotFlowFinger: false, width: 60 };

    // Horizontal stroke — rotation should affect the stamp orientation
    const points = [{ x: 100, y: 100, pressure: 1 }];
    renderStroke(ctx90, brush90, points, "#000000", {});
    renderStroke(ctx0, brush0, points, "#000000", {});

    // With rotation=90 and roundness=0.3, the stamp is elongated vertically
    // With rotation=0, the stamp is elongated horizontally
    // So at the midpoint (100,100), the 90° rotation should have MORE pixels ABOVE/BELOW
    // and FEWER pixels LEFT/RIGHT compared to the 0° rotation.

    // Sample inside the 30px major radius, away from the antialiased boundary.
    const above90 = getPixel(ctx90, 100, 75);
    const above0 = getPixel(ctx0, 100, 75);

    // The 90° rotated stamp should have more coverage above center than the 0° stamp
    expect(above90[3]).toBeGreaterThan(above0[3]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1: deterministic rendering (same input → same output)
// ════════════════════════════════════════════════════════════════════════

maybeDescribe("P1: determinism", () => {
  it("same stroke produces identical pixel output", () => {
    const { ctx: ctxA } = makeCanvas(200, 100);
    const { ctx: ctxB } = makeCanvas(200, 100);

    const brush: BrushPreset = { ...HARD_ROUND, dynamicWidth: 0.3, dynamicRot: 15, width: 50 };

    renderStroke(ctxA, brush, [{ x: 20, y: 50 }, { x: 180, y: 50 }], "#ff0000", {});
    renderStroke(ctxB, brush, [{ x: 20, y: 50 }, { x: 180, y: 50 }], "#ff0000", {});

    // Sample 10 points along the stroke
    for (let i = 30; i <= 170; i += 15) {
      const pa = getPixel(ctxA, i, 50);
      const pb = getPixel(ctxB, i, 50);
      expect(pa[0]).toBe(pb[0]);
      expect(pa[1]).toBe(pb[1]);
      expect(pa[2]).toBe(pb[2]);
      expect(pa[3]).toBe(pb[3]);
    }
  });

  it("procedural texture is deterministic across cache clears", () => {
    clearProcTexCache();
    const { ctx: ctxA } = makeCanvas(200, 100);
    const brush: BrushPreset = { ...HARD_ROUND, useShape: true, shapeTexture: "", hardness: 0.5, width: 60 };
    renderStroke(ctxA, brush, [{ x: 50, y: 50 }, { x: 150, y: 50 }], "#000000", {});

    clearProcTexCache();
    const { ctx: ctxB } = makeCanvas(200, 100);
    renderStroke(ctxB, brush, [{ x: 50, y: 50 }, { x: 150, y: 50 }], "#000000", {});

    // Same preset ID + size → same texture → same pixel output
    for (let i = 60; i <= 140; i += 10) {
      const pa = getPixel(ctxA, i, 50);
      const pb = getPixel(ctxB, i, 50);
      expect(pa[0]).toBe(pb[0]);
      expect(pa[3]).toBe(pb[3]);
    }
  });

  it("different explicit seeds produce different dynamic grain", () => {
    const { ctx: ctxA } = makeCanvas(220, 100);
    const { ctx: ctxB } = makeCanvas(220, 100);
    const brush: BrushPreset = {
      ...HARD_ROUND,
      useTex: true,
      surfaceTexture: "graphite-tooth",
      dynamicWidth: 0.25,
      dynamicRot: 25,
      width: 36,
    };
    const points = [{ x: 20, y: 50, pressure: 0.7 }, { x: 200, y: 50, pressure: 0.7 }];

    renderStroke(ctxA, brush, points, "#222222", {}, 1, { seed: 1 });
    renderStroke(ctxB, brush, points, "#222222", {}, 1, { seed: 2 });

    const a = ctxA.getImageData(0, 0, 220, 100).data;
    const b = ctxB.getImageData(0, 0, 220, 100).data;
    expect(a.some((channel, index) => channel !== b[index])).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// v5: rgbToAlpha, reverseAlpha, smear
// ════════════════════════════════════════════════════════════════════════

maybeDescribe("v6: rgbToAlpha", () => {
  it("does not erase a geometric stamp based on the selected paint color", () => {
    const { ctx } = makeCanvas(200, 100);
    const brush: BrushPreset = { ...HARD_ROUND, rgbToAlpha: true, width: 40, hardness: 1, spacing: 0.5 };
    renderStroke(ctx, brush, [{ x: 80, y: 50, pressure: 1 }, { x: 120, y: 50, pressure: 1 }], "#000000", {});
    // rgbToAlpha applies to texture masks, never to the chosen stroke color.
    const px = getPixel(ctx, 100, 50);
    expect(px[3]).toBeGreaterThan(0);
  });

  it("treats black texture pixels as paint and white pixels as empty", () => {
    const { ctx } = makeCanvas(120, 120);
    const tip = new Canvas(20, 20);
    const tipCtx = tip.getContext("2d");
    tipCtx.fillStyle = "#ffffff";
    tipCtx.fillRect(0, 0, 20, 20);
    tipCtx.fillStyle = "#000000";
    tipCtx.beginPath();
    tipCtx.arc(10, 10, 5, 0, Math.PI * 2);
    tipCtx.fill();
    const brush: BrushPreset = {
      ...HARD_ROUND,
      width: 40,
      smallWidth: 40,
      spacing: 1,
      useShape: true,
      shapeTexture: "test-mask",
      rgbToAlpha: true,
    };

    renderStroke(
      ctx,
      brush,
      [{ x: 60, y: 60, pressure: 1 }],
      "#3a2b20",
      { shape: tip as unknown as ImageBitmap },
      1,
      { seed: 7 },
    );

    expect(getPixel(ctx, 60, 60)[3]).toBeGreaterThan(200);
    expect(getPixel(ctx, 43, 60)[3]).toBeLessThan(20);
  });
});

maybeDescribe("v6: reverseShape (alpha inversion)", () => {
  it("reverseShape produces different result than non-reversed", () => {
    const { ctx: ctxNormal } = makeCanvas(200, 100);
    const { ctx: ctxReversed } = makeCanvas(200, 100);
    const normal: BrushPreset = { ...MARKER, reverseShape: false };
    const reversed: BrushPreset = { ...MARKER, reverseShape: true };
    const points = [{ x: 50, y: 50, pressure: 1 }, { x: 150, y: 50, pressure: 1 }];
    renderStroke(ctxNormal, normal, points, "#ff0000", {});
    renderStroke(ctxReversed, reversed, points, "#ff0000", {});
    // Results should differ somewhere in the complete inverted mask, even if
    // overlapping dabs happen to cover the exact center in both variants.
    const normalPixels = ctxNormal.getImageData(0, 0, 200, 100).data;
    const reversedPixels = ctxReversed.getImageData(0, 0, 200, 100).data;
    expect(normalPixels.some((channel, index) => channel !== reversedPixels[index])).toBe(true);
  });
});

maybeDescribe("v6: smearStrength", () => {
  it("smear drags existing pixels along the stroke", () => {
    const { ctx } = makeCanvas(300, 100);
    // Draw a sharp boundary at x=100
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(100, 0, 200, 100);

    const brush: BrushPreset = { ...HARD_ROUND, smearStrength: 0.5, width: 30, spacing: 0.1, hardness: 1, alpha: 0.5, brushFlow: 1 };
    // Stroke left→right across the boundary
    renderStroke(ctx, brush, [{ x: 50, y: 50, pressure: 1 }, { x: 250, y: 50, pressure: 1 }], "#ffffff00", {}, 1, { smearSource: ctx });

    // Moving left→right drags red from behind the brush into the blue side.
    const px = getPixel(ctx, 104, 50);
    expect(px[0]).toBeGreaterThan(0);
  });
});

maybeDescribe("v6: buffer reuse (no per-stroke allocation)", () => {
  it("multiple strokes work correctly with cached buffers", () => {
    const { ctx } = makeCanvas(400, 200);
    // Draw 5 strokes of different colors — cached buffers must not interfere
    for (let i = 0; i < 5; i++) {
      const red = (i * 50).toString(16).padStart(2, "0");
      renderStroke(ctx, HARD_ROUND, [{ x: 50, y: 20 + i * 35 }, { x: 350, y: 20 + i * 35 }], `#${red}0000`, {});
    }
    // Each stroke should be visible at its own y position
    for (let i = 0; i < 5; i++) {
      const px = getPixel(ctx, 200, 20 + i * 35);
      expect(px[3]).toBeGreaterThan(100); // not blank
    }
  });

  it("crops a reused larger buffer instead of rescaling it", () => {
    const { ctx: large } = makeCanvas(400, 200);
    const { ctx: small } = makeCanvas(200, 100);
    const points = [{ x: 50, y: 50, pressure: 1 }, { x: 150, y: 50, pressure: 1 }];

    renderStroke(large, HARD_ROUND, [{ x: 250, y: 100, pressure: 1 }], "#000000", {});
    renderStroke(small, HARD_ROUND, points, "#000000", {});

    expect(getPixel(small, 100, 50)[3]).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// BrushPresets — name/ID lookup
// ════════════════════════════════════════════════════════════════════════

describe("BrushPresets — name/ID lookup", () => {
  it("keeps every shipped preset valid as an immutable protocol snapshot", () => {
    expect(ALL_BRUSHES).toHaveLength(94);
    for (const brush of ALL_BRUSHES) expect(BrushDefinition.safeParse(brush).success).toBe(true);
  });

  it("getByNameOrId finds brushes by Chinese name", () => {
    const brush = getByNameOrId("铅笔");
    expect(brush.id).not.toBe("default");
    expect(brush.name).toBe("铅笔");
  });

  it("getByNameOrId finds brushes by base64 ID", () => {
    const pencilId = NAME_TO_ID["铅笔"];
    expect(pencilId).toBeDefined();
    const brush = getByNameOrId(pencilId!);
    expect(brush.name).toBe("铅笔");
  });

  it("getByNameOrId falls back to DEFAULT_BRUSH for unknown names", () => {
    const brush = getByNameOrId("不存在的笔刷");
    expect(brush.id).toBe("default");
  });

  it("getById returns correct brush for pencil", () => {
    const pencilId = NAME_TO_ID["铅笔"];
    const brush = getById(pencilId!);
    expect(brush.name).toBe("铅笔");
    expect(brush.width).toBe(20);
    expect(brush.hardness).toBe(1);
    expect(brush.useTex).toBe(true);
    expect(brush.supportPressure).toBe(true);
  });
});
