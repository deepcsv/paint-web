type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * FilterEngine — applies in-place filters to a layer.
 *
 * Each method reads the current ImageData, mutates it, and writes it back.
 * Caller is responsible for pushing undo before invoking.
 *
 * Note: Canvas2D has built-in `ctx.filter` for some operations, but we
 * implement them in JS for predictable cross-browser behavior and so
 * RPC results are deterministic (server can reproduce).
 */
export class FilterEngine {
  static async invert(ctx: AnyCtx, width: number, height: number): Promise<void> {
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i]!;
      d[i + 1] = 255 - d[i + 1]!;
      d[i + 2] = 255 - d[i + 2]!;
      // alpha unchanged
    }
    ctx.putImageData(img, 0, 0);
  }

  static async grayscale(ctx: AnyCtx, width: number, height: number): Promise<void> {
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      d[i] = d[i + 1] = d[i + 2] = lum;
    }
    ctx.putImageData(img, 0, 0);
  }

  static async brightness(
    ctx: AnyCtx,
    width: number,
    height: number,
    amount: number, // -1..1
  ): Promise<void> {
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    const delta = Math.round(amount * 255);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp(d[i]! + delta);
      d[i + 1] = clamp(d[i + 1]! + delta);
      d[i + 2] = clamp(d[i + 2]! + delta);
    }
    ctx.putImageData(img, 0, 0);
  }

  static async contrast(
    ctx: AnyCtx,
    width: number,
    height: number,
    amount: number, // -1..1
  ): Promise<void> {
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    // amount: -1 → all gray (128), 0 → identity, +1 → max contrast
    const factor = 1 + amount; // 0..2
    const intercept = 128 * (1 - factor);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp(d[i]! * factor + intercept);
      d[i + 1] = clamp(d[i + 1]! * factor + intercept);
      d[i + 2] = clamp(d[i + 2]! * factor + intercept);
    }
    ctx.putImageData(img, 0, 0);
  }

  static async blur(
    ctx: AnyCtx,
    width: number,
    height: number,
    radius: number,
  ): Promise<void> {
    const r = Math.max(1, Math.floor(radius));
    // Separable box blur, 2 passes (horizontal then vertical)
    const src = ctx.getImageData(0, 0, width, height);
    const horizontal = boxBlurPass(src.data, width, height, r, true);
    const both = boxBlurPass(horizontal, width, height, r, false);
    // Construct a fresh ImageData with the blurred buffer
    const out = ctx.createImageData(width, height);
    out.data.set(both);
    ctx.putImageData(out, 0, 0);
  }
}

function clamp(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Single-pass separable box blur.
 * `horizontal`: true → blur along X; false → blur along Y.
 */
function boxBlurPass(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const window = radius * 2 + 1;
  const invWin = 1 / window;

  const len = horizontal ? height : width;
  const innerLen = horizontal ? width : height;

  for (let line = 0; line < len; line++) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;

    // Initial window: pixels 0..radius (and right edge for left padding)
    for (let k = -radius; k <= radius; k++) {
      const idx = clampIdx(k, innerLen);
      const pIdx = pixelIndex(line, idx, horizontal, width) * 4;
      sumR += src[pIdx]!;
      sumG += src[pIdx + 1]!;
      sumB += src[pIdx + 2]!;
      sumA += src[pIdx + 3]!;
    }

    for (let i = 0; i < innerLen; i++) {
      const outIdx = pixelIndex(line, i, horizontal, width) * 4;
      out[outIdx] = sumR * invWin;
      out[outIdx + 1] = sumG * invWin;
      out[outIdx + 2] = sumB * invWin;
      out[outIdx + 3] = sumA * invWin;

      // Slide window: subtract leftmost, add next-right
      const leftK = i - radius;
      const rightK = i + radius + 1;
      const leftIdx = clampIdx(leftK, innerLen);
      const rightIdx = clampIdx(rightK, innerLen);
      const leftP = pixelIndex(line, leftIdx, horizontal, width) * 4;
      const rightP = pixelIndex(line, rightIdx, horizontal, width) * 4;
      sumR += src[rightP]! - src[leftP]!;
      sumG += src[rightP + 1]! - src[leftP + 1]!;
      sumB += src[rightP + 2]! - src[leftP + 2]!;
      sumA += src[rightP + 3]! - src[leftP + 3]!;
    }
  }
  return out;
}

function pixelIndex(line: number, i: number, horizontal: boolean, width: number): number {
  return horizontal ? line * width + i : i * width + line;
}

function clampIdx(k: number, len: number): number {
  if (k < 0) return 0;
  if (k >= len) return len - 1;
  return k;
}
