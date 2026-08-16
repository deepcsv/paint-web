export type Tool = "brush" | "eraser" | "line" | "rect" | "circle" | "ellipse" | "fill" | "text" | "setPixel";

export interface PointerHandlerOptions {
  canvas: HTMLCanvasElement;
  displayWidth: number;
  displayHeight: number;
  /** Native canvas width (for scaling display coords → canvas coords). */
  canvasWidth: number;
  canvasHeight: number;
  onStrokeStart: (point: { x: number; y: number; pressure?: number }) => void;
  onStrokeSegment: (point: { x: number; y: number; pressure?: number }) => void;
  onStrokeEnd: () => void;
  onClick: (point: { x: number; y: number; pressure: number }) => void;
  onMove: (point: { x: number; y: number }) => void;
}

/**
 * PointerHandler — normalizes PointerEvent into canvas-space coordinates.
 * Applies display→canvas scaling.
 */
export class PointerHandler {
  private activePointerId: number | null = null;
  private opts: PointerHandlerOptions;

  constructor(opts: PointerHandlerOptions) {
    this.opts = opts;
    opts.canvas.addEventListener("pointerdown", this.onDown);
    opts.canvas.addEventListener("pointermove", this.onMove);
    opts.canvas.addEventListener("pointerup", this.onUp);
    opts.canvas.addEventListener("pointerleave", this.onLeave);
    opts.canvas.addEventListener("pointercancel", this.onCancel);
  }

  updateScale(displayWidth: number, displayHeight: number, canvasWidth: number, canvasHeight: number): void {
    this.opts.displayWidth = displayWidth;
    this.opts.displayHeight = displayHeight;
    this.opts.canvasWidth = canvasWidth;
    this.opts.canvasHeight = canvasHeight;
  }

  dispose(): void {
    const c = this.opts.canvas;
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointerleave", this.onLeave);
    c.removeEventListener("pointercancel", this.onCancel);
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.opts.canvas.setPointerCapture(e.pointerId);
    this.activePointerId = e.pointerId;
    const p = this.toCanvasCoord(e);
    this.opts.onStrokeStart(p);
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.toCanvasCoord(e);
    this.opts.onMove(p);
    if (this.activePointerId === e.pointerId) {
      this.opts.onStrokeSegment(p);
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (this.activePointerId !== e.pointerId) return;
    this.activePointerId = null;
    try {
      this.opts.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.opts.onStrokeEnd();
  };

  private onLeave = (_e: PointerEvent): void => {
    // Don't end stroke on leave — pointer capture keeps it active
  };

  private onCancel = (e: PointerEvent): void => {
    if (this.activePointerId !== e.pointerId) return;
    this.activePointerId = null;
    this.opts.onStrokeEnd();
  };

  private toCanvasCoord(e: PointerEvent): { x: number; y: number; pressure?: number } {
    const canvas = this.opts.canvas;
    const rect = canvas.getBoundingClientRect();
    const displayX = e.clientX - rect.left;
    const displayY = e.clientY - rect.top;
    // Read the live bitmap size on every event: RPC-side resize / doc.new /
    // document replay all mutate canvas.width without notifying this handler,
    // and a stale cached size desynchronizes the cursor hotspot from the
    // actual stroke position by the resize ratio.
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (displayX * scaleX) | 0;
    const y = (displayY * scaleY) | 0;
    // Mouse events report a synthetic constant pressure. Leaving it undefined
    // lets the stroke planner infer expressive pressure from pointer velocity.
    const pressure = e.pointerType !== "mouse" && e.pressure > 0 ? e.pressure : undefined;
    return pressure === undefined ? { x, y } : { x, y, pressure };
  }
}
