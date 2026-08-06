import type { DrawGradientParams, DrawPathParams } from "../../shared/protocol.js";

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

  static path(ctx: AnyCtx, opts: DrawPathParams): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    ctx.lineWidth = opts.strokeWidth;
    ctx.lineCap = opts.lineCap;
    ctx.lineJoin = opts.lineJoin;
    ctx.beginPath();
    for (const command of opts.commands) {
      switch (command.op) {
        case "M":
          ctx.moveTo(command.x, command.y);
          break;
        case "L":
          ctx.lineTo(command.x, command.y);
          break;
        case "Q":
          ctx.quadraticCurveTo(command.cx, command.cy, command.x, command.y);
          break;
        case "C":
          ctx.bezierCurveTo(
            command.c1x,
            command.c1y,
            command.c2x,
            command.c2y,
            command.x,
            command.y,
          );
          break;
        case "Z":
          ctx.closePath();
          break;
      }
    }
    if (opts.fill) {
      ctx.fillStyle = opts.fill;
      ctx.fill(opts.fillRule);
    }
    if (opts.stroke) {
      ctx.strokeStyle = opts.stroke;
      ctx.stroke();
    }
    ctx.restore();
  }

  static gradient(ctx: AnyCtx, opts: DrawGradientParams): void {
    ctx.save();
    ctx.globalAlpha = opts.opacity;
    const paint =
      opts.gradient.type === "linear"
        ? ctx.createLinearGradient(
            opts.gradient.from.x,
            opts.gradient.from.y,
            opts.gradient.to.x,
            opts.gradient.to.y,
          )
        : ctx.createRadialGradient(
            opts.gradient.inner.x,
            opts.gradient.inner.y,
            opts.gradient.inner.r,
            opts.gradient.outer.x,
            opts.gradient.outer.y,
            opts.gradient.outer.r,
          );
    for (const stop of opts.stops) paint.addColorStop(stop.offset, stop.color);
    ctx.fillStyle = paint;
    ctx.beginPath();
    if (opts.shape.type === "rect") {
      ctx.rect(opts.shape.x, opts.shape.y, opts.shape.w, opts.shape.h);
    } else if (opts.shape.type === "circle") {
      ctx.arc(opts.shape.cx, opts.shape.cy, opts.shape.r, 0, Math.PI * 2);
    } else {
      ctx.ellipse(
        opts.shape.cx,
        opts.shape.cy,
        opts.shape.rx,
        opts.shape.ry,
        0,
        0,
        Math.PI * 2,
      );
    }
    ctx.fill();
    ctx.restore();
  }
}
