import { describe, expect, it } from "vitest";
import { analyzePixels, samplePixels } from "../src/canvas/CanvasAnalyzer.js";

function image(width: number, height: number, values: number[]): ImageData {
  return { width, height, data: new Uint8ClampedArray(values) } as ImageData;
}

describe("CanvasAnalyzer", () => {
  it("reports occupancy, bounds, average color and luminance", () => {
    const pixels = image(2, 2, [
      255, 0, 0, 255,
      0, 0, 0, 0,
      0, 0, 255, 255,
      255, 255, 255, 128,
    ]);

    const result = analyzePixels(pixels, {
      stride: 1,
      alphaThreshold: 1,
      histogramBins: 8,
      dominantColors: 3,
    });

    expect(result).toMatchObject({
      sampledPixels: 4,
      opaquePixels: 3,
      coverage: 0.75,
      bounds: { x: 0, y: 0, w: 2, h: 2 },
    });
    expect(result.average.a).toBe(160);
    expect(result.luminance.histogram).toHaveLength(8);
    expect(result.luminance.histogram.reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(result.dominant).toHaveLength(3);
  });

  it("samples exact RGBA colors at requested points", () => {
    const pixels = image(2, 1, [255, 128, 0, 255, 0, 64, 255, 128]);

    expect(samplePixels(pixels, [{ x: 1, y: 0 }])).toEqual({
      samples: [{ x: 1, y: 0, color: { r: 0, g: 64, b: 255, a: 128, hex: "#0040ff80" } }],
    });
  });

  it("honors an alpha threshold of zero", () => {
    const pixels = image(1, 1, [12, 34, 56, 0]);
    const result = analyzePixels(pixels, {
      stride: 1,
      alphaThreshold: 0,
      histogramBins: 4,
      dominantColors: 1,
    });

    expect(result).toMatchObject({ sampledPixels: 1, opaquePixels: 1, coverage: 1 });
    expect(result.dominant[0]?.color.hex).toBe("#0c223800");
  });
});
