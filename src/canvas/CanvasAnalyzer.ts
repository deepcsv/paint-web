import type {
  CanvasAnalyzeResult,
  CanvasSampleResult,
  RgbaColor,
} from "../../shared/protocol.js";

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, "0");
}

function rgba(r: number, g: number, b: number, a: number): RgbaColor {
  const color = { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampByte(a) };
  return { ...color, hex: `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}${hexByte(color.a)}` };
}

export interface AnalyzePixelsOptions {
  stride: number;
  alphaThreshold: number;
  histogramBins: number;
  dominantColors: number;
}

/** Deterministic quantitative inspection for an RGBA canvas image. */
export function analyzePixels(
  image: ImageData,
  options: AnalyzePixelsOptions,
): CanvasAnalyzeResult {
  const stride = Math.max(1, Math.floor(options.stride));
  const bins = Math.max(4, Math.floor(options.histogramBins));
  const histogram = Array.from({ length: bins }, () => 0);
  const threshold = Math.max(0, Math.floor(options.alphaThreshold));
  const buckets = new Map<
    string,
    { count: number; r: number; g: number; b: number; a: number }
  >();
  let sampledPixels = 0;
  let opaquePixels = 0;
  let alphaTotal = 0;
  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;
  let weightTotal = 0;
  let luminanceTotal = 0;
  let luminanceMin = 1;
  let luminanceMax = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const index = (y * image.width + x) * 4;
      const r = image.data[index]!;
      const g = image.data[index + 1]!;
      const b = image.data[index + 2]!;
      const a = image.data[index + 3]!;
      sampledPixels += 1;
      alphaTotal += a;
      if (a < threshold) continue;

      opaquePixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const alphaWeight = a / 255;
      weightedR += r * alphaWeight;
      weightedG += g * alphaWeight;
      weightedB += b * alphaWeight;
      weightTotal += alphaWeight;
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      luminanceTotal += luminance;
      luminanceMin = Math.min(luminanceMin, luminance);
      luminanceMax = Math.max(luminanceMax, luminance);
      histogram[Math.min(bins - 1, Math.floor(luminance * bins))]! += 1;

      const key = `${r >> 4}:${g >> 4}:${b >> 4}:${a >> 5}`;
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, a: 0 };
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.a += a;
      buckets.set(key, bucket);
    }
  }

  const average =
    weightTotal > 0
      ? rgba(
          weightedR / weightTotal,
          weightedG / weightTotal,
          weightedB / weightTotal,
          alphaTotal / sampledPixels,
        )
      : rgba(0, 0, 0, 0);
  const dominant = [...buckets.values()]
    .sort((a, b) => b.count - a.count || b.a - a.a || b.r + b.g + b.b - (a.r + a.g + a.b))
    .slice(0, options.dominantColors)
    .map((bucket) => ({
      color: rgba(
        bucket.r / bucket.count,
        bucket.g / bucket.count,
        bucket.b / bucket.count,
        bucket.a / bucket.count,
      ),
      count: bucket.count,
      ratio: opaquePixels > 0 ? bucket.count / opaquePixels : 0,
    }));

  return {
    width: image.width,
    height: image.height,
    stride,
    sampledPixels,
    opaquePixels,
    coverage: sampledPixels > 0 ? opaquePixels / sampledPixels : 0,
    bounds:
      maxX >= minX && maxY >= minY
        ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
        : null,
    average,
    luminance: {
      min: opaquePixels > 0 ? luminanceMin : 0,
      max: opaquePixels > 0 ? luminanceMax : 0,
      mean: opaquePixels > 0 ? luminanceTotal / opaquePixels : 0,
      histogram,
    },
    dominant,
  };
}

export function samplePixels(
  image: ImageData,
  points: { x: number; y: number }[],
): CanvasSampleResult {
  return {
    samples: points.map(({ x, y }) => {
      const index = (y * image.width + x) * 4;
      return {
        x,
        y,
        color: rgba(
          image.data[index]!,
          image.data[index + 1]!,
          image.data[index + 2]!,
          image.data[index + 3]!,
        ),
      };
    }),
  };
}
