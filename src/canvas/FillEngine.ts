type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FillOptions {
  x: number;
  y: number;
  color: string;
  tolerance: number; // 0..64, max squared RGBA distance to consider "same"
}

/**
 * FillEngine — flood fill (paint bucket) using BFS over an ImageData buffer.
 *
 * Algorithm:
 * 1. Read full layer ImageData.
 * 2. Sample target color at (x, y).
 * 3. BFS over 4-connected pixels matching target color within tolerance.
 * 4. Write fill color to all visited pixels.
 * 5. putImageData back.
 *
 * For large fills we yield to the event loop every 50ms of work to keep the
 * UI responsive.
 *
 * Returns the dirty bounds (for history tracking).
 */
export async function floodFill(
  ctx: AnyCtx,
  width: number,
  height: number,
  opts: FillOptions,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const { x, y, color, tolerance } = opts;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const targetIdx = (y * width + x) * 4;
  const targetR = data[targetIdx]!;
  const targetG = data[targetIdx + 1]!;
  const targetB = data[targetIdx + 2]!;
  const targetA = data[targetIdx + 3]!;

  const fill = parseColor(color);
  if (
    fill.r === targetR &&
    fill.g === targetG &&
    fill.b === targetB &&
    fill.a === targetA
  ) {
    return null; // already same color
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height * 2); // pairs of (x,y)
  let qHead = 0;
  let qTail = 0;
  queue[qTail++] = x;
  queue[qTail++] = y;
  visited[y * width + x] = 1;

  const tolSq = tolerance * tolerance;
  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;

  const yieldInterval = 50000; // pixels processed between yields
  let sinceLastYield = 0;
  const startTime = Date.now();

  while (qHead < qTail) {
    const cx = queue[qHead++];
    const cy = queue[qHead++];

    const idx = (cy * width + cx) * 4;
    const r = data[idx]!;
    const g = data[idx + 1]!;
    const b = data[idx + 2]!;
    const a = data[idx + 3]!;

    if (!matchesTarget(r, g, b, a, targetR, targetG, targetB, targetA, tolSq)) {
      continue;
    }

    // Paint this pixel
    data[idx] = fill.r;
    data[idx + 1] = fill.g;
    data[idx + 2] = fill.b;
    data[idx + 3] = fill.a;

    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;

    // Enqueue neighbors (4-connected)
    if (cx > 0) {
      const ni = cy * width + (cx - 1);
      if (!visited[ni]) {
        visited[ni] = 1;
        queue[qTail++] = cx - 1;
        queue[qTail++] = cy;
      }
    }
    if (cx < width - 1) {
      const ni = cy * width + (cx + 1);
      if (!visited[ni]) {
        visited[ni] = 1;
        queue[qTail++] = cx + 1;
        queue[qTail++] = cy;
      }
    }
    if (cy > 0) {
      const ni = (cy - 1) * width + cx;
      if (!visited[ni]) {
        visited[ni] = 1;
        queue[qTail++] = cx;
        queue[qTail++] = cy - 1;
      }
    }
    if (cy < height - 1) {
      const ni = (cy + 1) * width + cx;
      if (!visited[ni]) {
        visited[ni] = 1;
        queue[qTail++] = cx;
        queue[qTail++] = cy + 1;
      }
    }

    sinceLastYield++;
    if (sinceLastYield >= yieldInterval && Date.now() - startTime > 50) {
      sinceLastYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

function matchesTarget(
  r: number,
  g: number,
  b: number,
  a: number,
  tR: number,
  tG: number,
  tB: number,
  tA: number,
  tolSq: number,
): boolean {
  if (tolSq === 0) {
    return r === tR && g === tG && b === tB && a === tA;
  }
  const dr = r - tR;
  const dg = g - tG;
  const db = b - tB;
  const da = a - tA;
  const distSq = dr * dr + dg * dg + db * db + da * da;
  return distSq <= tolSq;
}

function parseColor(c: string): { r: number; g: number; b: number; a: number } {
  // Accept "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" (also without leading #)
  let s = c.startsWith("#") ? c.slice(1) : c;
  if (s.length === 3) {
    s = s
      .split("")
      .map((ch) => ch + ch)
      .join("") + "ff";
  } else if (s.length === 4) {
    s = s
      .split("")
      .map((ch) => ch + ch)
      .join("");
  } else if (s.length === 6) {
    s = s + "ff";
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = parseInt(s.slice(6, 8), 16);
  return { r, g, b, a };
}
