type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface StrokeOptions {
  tool: "brush" | "eraser";
  color: string;
  size: number;
  opacity: number;
  /** Smoothing factor 0-1 (0 = none, 1 = heavy). Default 0.5 */
  smoothing?: number;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure?: number;
}

/**
 * StrokeEngine — renders a freehand stroke onto a 2D context.
 *
 * Strategy:
 * - Map raw points to display-sized points (pressure affects size).
 * - Use quadratic Bézier smoothing between midpoints of consecutive points.
 * - Single path commit per stroke (efficient, browser-optimized).
 *
 * For "live" painting (UI pointer down/move), call start(), then segment()
 * repeatedly, then commit(). For RPC-mode (one shot), call commit() with the
 * full point list.
 */
export class StrokeEngine {
  /**
   * Draw a complete stroke from a point list. Single commit; no live preview.
   */
  static drawStroke(ctx: AnyCtx, opts: StrokeOptions, points: StrokePoint[]): void {
    if (points.length === 0) return;
    if (points.length === 1) {
      // Single dot
      const p = points[0]!;
      StrokeEngine.dot(ctx, opts, p);
      return;
    }
    StrokeEngine.setupCtx(ctx, opts);
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i]!;
      const next = points[i + 1]!;
      const midX = (p.x + next.x) / 2;
      const midY = (p.y + next.y) / 2;
      ctx.quadraticCurveTo(p.x, p.y, midX, midY);
    }
    const last = points[points.length - 1]!;
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw a single dot — used for clicks or single-point strokes.
   */
  static dot(ctx: AnyCtx, opts: StrokeOptions, p: StrokePoint): void {
    StrokeEngine.setupCtx(ctx, opts);
    ctx.beginPath();
    const r = StrokeEngine.displaySize(opts.size, p.pressure) / 2;
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = opts.color;
    ctx.globalAlpha = opts.opacity;
    if (opts.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
    }
    ctx.fill();
    ctx.restore();
  }

  /**
   * Compute display size from base size + optional pressure.
   * pressure: 0..1, defaults to 0.5 when undefined.
   * Mapping: displaySize = base * (0.3 + 0.7 * pressure)
   */
  static displaySize(baseSize: number, pressure?: number): number {
    const p = pressure === undefined ? 0.5 : Math.max(0, Math.min(1, pressure));
    return baseSize * (0.3 + 0.7 * p);
  }

  private static setupCtx(ctx: AnyCtx, opts: StrokeOptions): void {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = opts.opacity;
    if (opts.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = opts.color;
    }
    // lineWidth is set per-segment in live mode; in single-shot mode we use base size
    ctx.lineWidth = opts.size;
  }
}
