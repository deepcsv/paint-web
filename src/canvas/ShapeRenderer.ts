type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LineOpts {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  size: number;
  opacity: number;
  dash?: number[];
}

export interface RectOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  stroke?: string;
  fill?: string;
  strokeWidth: number;
  opacity: number;
}

export interface CircleOpts {
  cx: number;
  cy: number;
  r: number;
  stroke?: string;
  fill?: string;
  strokeWidth: number;
  opacity: number;
}

export interface EllipseOpts {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  stroke?: string;
  fill?: string;
  strokeWidth: number;
  opacity: number;
}

export class ShapeRenderer {
  static line(ctx: AnyCtx, opts: LineOpts): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = opts.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
    ctx.moveTo(opts.from.x, opts.from.y);
    ctx.lineTo(opts.to.x, opts.to.y);
    ctx.stroke();
    ctx.restore();
  }

  static rect(ctx: AnyCtx, opts: RectOpts): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    if (opts.fill) {
      ctx.fillStyle = opts.fill;
      ctx.fillRect(opts.x, opts.y, opts.w, opts.h);
    }
    if (opts.stroke && opts.strokeWidth > 0) {
      ctx.strokeStyle = opts.stroke;
      ctx.lineWidth = opts.strokeWidth;
      ctx.strokeRect(opts.x, opts.y, opts.w, opts.h);
    }
    ctx.restore();
  }

  static circle(ctx: AnyCtx, opts: CircleOpts): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    ctx.beginPath();
    ctx.arc(opts.cx, opts.cy, opts.r, 0, Math.PI * 2);
    if (opts.fill) {
      ctx.fillStyle = opts.fill;
      ctx.fill();
    }
    if (opts.stroke && opts.strokeWidth > 0) {
      ctx.strokeStyle = opts.stroke;
      ctx.lineWidth = opts.strokeWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  static ellipse(ctx: AnyCtx, opts: EllipseOpts): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    ctx.beginPath();
    ctx.ellipse(opts.cx, opts.cy, opts.rx, opts.ry, 0, 0, Math.PI * 2);
    if (opts.fill) {
      ctx.fillStyle = opts.fill;
      ctx.fill();
    }
    if (opts.stroke && opts.strokeWidth > 0) {
      ctx.strokeStyle = opts.stroke;
      ctx.lineWidth = opts.strokeWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  static text(
    ctx: AnyCtx,
    opts: {
      x: number;
      y: number;
      text: string;
      fontFamily: string;
      size: number;
      color: string;
      align?: CanvasTextAlign;
      opacity: number;
    },
  ): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    ctx.fillStyle = opts.color;
    ctx.font = `${opts.size}px ${opts.fontFamily}`;
    ctx.textBaseline = "top";
    ctx.textAlign = opts.align ?? "left";
    ctx.fillText(opts.text, opts.x, opts.y);
    ctx.restore();
  }

  static setPixel(ctx: AnyCtx, x: number, y: number, color: string): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
    ctx.restore();
  }
}
