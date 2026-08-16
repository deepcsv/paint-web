// HandEngine — 手绘误差分层合成引擎（五层人手误差模型：摆动/压感/颗粒/起收笔/复笔）
// 核心洞见: 手绘感 = 五种独立的"人手误差"叠加:
//   1. 手臂摆动(三频正弦法向偏移)  2. 压力起伏(线宽独立正弦)
//   3. 笔尖颗粒(石墨碎屑+纸色回咬) 4. 起收笔 overshoot+taper 包络
//   5. 断笔 lift (笔偶尔离纸)
// 全部确定性: 同 seed 同输出。

export interface HandStrokeOptions {
  /** 法向摆动幅度 (px). default 按线宽自适应 */
  amp?: number;
  /** 端部收笔包络比例 0..0.5 (default .22) */
  taper?: number;
  /** ghost 复笔概率 0..1 (default .3, 更淡更飘的重笔层) */
  ghost?: number;
  /** 破段重描: 拆 2-3 段独立宽浓 (default false) */
  broken?: boolean;
  /** 石墨碎屑+纸色回咬 (default true, w>=1.2) */
  crumbs?: boolean;
  /** 楔形(单增宽度, 发丝用) */
  wedge?: boolean;
  /** 起收笔过头长度 (px) */
  over?: number;
  /** 透明度基值 */
  alpha?: number;
  /** 颜色 [r,g,b] */
  color?: [number, number, number];
  /** 纸色 [r,g,b] (回咬碎屑用) */
  paper?: [number, number, number];
  seed?: number;
}

// ---------- 确定性 rng (mulberry32) ----------
function rng(seed: number) {
  let a = (seed | 0) >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const rr = (R: R, a: number, b: number) => a + R() * (b - a);
const ri = (R: R, a: number, b: number) => Math.floor(rr(R, a, b + 1));
const chance = (R: R, p: number) => R() < p;
const smooth = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));

// ---------- 几何 ----------
type Pt = [number, number];

function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [[pts[0][0], pts[0][1]]];
  let need = step;
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    let d = Math.hypot(x1 - x0, y1 - y0);
    while (d >= need && d > 0) {
      const t = need / d;
      x0 += (x1 - x0) * t;
      y0 += (y1 - y0) * t;
      out.push([x0, y0]);
      d = Math.hypot(x1 - x0, y1 - y0);
      need = step;
    }
    need -= d;
  }
  const last = pts[pts.length - 1];
  const le = out[out.length - 1];
  if (Math.hypot(last[0] - le[0], last[1] - le[1]) > step * 0.25) out.push([last[0], last[1]]);
  return out;
}

function chaikin(pts: Pt[], closed: boolean, it: number): Pt[] {
  while (it-- > 0) {
    const out: Pt[] = [];
    const n = pts.length;
    if (!closed) out.push(pts[0]);
    const end = closed ? n : n - 1;
    for (let i = 0; i < end; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) out.push(pts[n - 1]);
    pts = out;
  }
  return pts;
}

function poly(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pts: Pt[], close: boolean): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
}

function bbox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ---------- 核心: 变宽多边形笔画 (五层误差) ----------
export function handStroke(ctx: Ctx2D, ptsIn: Pt[], w: number, opts: HandStrokeOptions = {}): void {
  const seed = opts.seed ?? 1;
  const R = rng(seed);
  const ink = opts.color ?? [31, 29, 26];
  const paper = opts.paper ?? [246, 241, 229];
  const alpha = opts.alpha ?? rr(R, 0.68, 0.97);
  const amp = opts.amp ?? (w * 0.5 + 0.9);
  const taper = opts.taper ?? 0.22;
  const inkA = (a: number) => `rgba(${ink[0]},${ink[1]},${ink[2]},${Math.min(1, a)})`;
  const paperA = (a: number) => `rgba(${paper[0]},${paper[1]},${paper[2]},${a})`;

  let pts = ptsIn;
  // 层4: 起收笔 overshoot — 首尾沿方向延长并随机偏向法向
  if (opts.over && pts.length >= 2) {
    pts = pts.slice();
    const a = pts[0], b = pts[1];
    const d0 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const f0 = opts.over * rr(R, -0.5, 0.5);
    pts[0] = [
      a[0] - ((b[0] - a[0]) / d0) * opts.over - ((b[1] - a[1]) / d0) * f0,
      a[1] - ((b[1] - a[1]) / d0) * opts.over + ((b[0] - a[0]) / d0) * f0,
    ];
    const y = pts[pts.length - 1], z = pts[pts.length - 2];
    const d1 = Math.hypot(y[0] - z[0], y[1] - z[1]) || 1;
    const f1 = opts.over * rr(R, -0.5, 0.5);
    pts[pts.length - 1] = [
      y[0] + ((y[0] - z[0]) / d1) * opts.over - ((y[1] - z[1]) / d1) * f1,
      y[1] + ((y[1] - z[1]) / d1) * opts.over + ((y[0] - z[0]) / d1) * f1,
    ];
  }

  const rs = resample(pts, Math.max(2.2, w * 0.9));
  const n = rs.length;
  if (n < 3) {
    ctx.strokeStyle = inkA(alpha);
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    poly(ctx, pts, false);
    ctx.stroke();
    return;
  }

  // 层1: 三频摆动相位 | 层2: 压力独立相位
  const p1 = rr(R, 0, 7), p2 = rr(R, 0, 7), p3 = rr(R, 0, 7), p4 = rr(R, 0, 7);
  const f1 = rr(R, 1.5, 3.5), f2 = rr(R, 5, 9), f3 = rr(R, 11, 17);
  const L: Pt[] = [], Rt: Pt[] = [], C: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = rs[Math.max(0, i - 1)], b = rs[Math.min(n - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const d = Math.hypot(nx, ny) || 1;
    nx /= d; ny /= d;
    // 层1: 手臂摆动 — 三频正弦法向偏移 (臂 .55 / 腕 .3 / 指 .15)
    const off = amp * (0.55 * Math.sin(t * f1 * 2 + p1) + 0.3 * Math.sin(t * f2 + p2) + 0.15 * Math.sin(t * f3 + p3));
    const px = rs[i][0] + nx * off + rr(R, -0.35, 0.35);
    const py = rs[i][1] + ny * off + rr(R, -0.35, 0.35);
    // 层2: 压力起伏 + 层4b: 端部 taper 包络
    let half = (w / 2)
      * (opts.wedge ? (0.25 + 0.95 * t) : (0.3 + 0.7 * smooth(Math.min(t, 1 - t) / taper)))
      * (1 + 0.38 * Math.sin(t * 7.3 + p4) + 0.14 * Math.sin(t * 19 + p2))
      * rr(R, 0.88, 1.14);
    half = Math.max(half, 0.28);
    L.push([px + nx * half, py + ny * half]);
    Rt.push([px - nx * half, py - ny * half]);
    C.push([px, py, nx, ny, half]);
  }

  // 石墨芯
  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(Rt[i][0], Rt[i][1]);
  ctx.closePath();
  ctx.fillStyle = inkA(alpha * 0.62);
  ctx.fill();

  // 层3: 干颗粒 — 石墨碎屑 + 纸色回咬 (纸咬回来)
  if (opts.crumbs !== false && w >= 1.2) {
    for (const [px, py, nx, ny, half] of C) {
      const nd = Math.min(4, Math.max(1, Math.round(half * 1.5)));
      for (let k = 0; k < nd; k++) {
        if (chance(R, 0.3)) continue;
        const u = rr(R, -1.05, 1.05);
        const sz = rr(R, 0.7, 1.5) + (half > 2 ? 0.4 : 0);
        ctx.fillStyle = inkA(alpha * rr(R, 0.2, 0.55));
        ctx.fillRect(px + nx * half * u + rr(R, -0.7, 0.7) - sz / 2, py + ny * half * u + rr(R, -0.7, 0.7) - sz / 2, sz, sz);
      }
      if (chance(R, 0.45)) {
        const u = (chance(R, 0.5) ? 1 : -1) * rr(R, 0.8, 1.15);
        const sz = rr(R, 0.9, 2);
        ctx.fillStyle = paperA(rr(R, 0.4, 0.8));
        ctx.fillRect(px + nx * half * u - sz / 2, py + ny * half * u - sz / 2, sz, sz);
      }
    }
  }

  // ghost 复笔: 更淡更飘的重笔层
  if (opts.ghost && chance(R, opts.ghost)) {
    handStroke(ctx, pts, w * 0.45, { ...opts, alpha: alpha * 0.2, amp: amp * 1.9, ghost: 0, seed: seed + 7, crumbs: false });
    if (chance(R, 0.3)) {
      handStroke(ctx, pts, w * 0.35, { ...opts, alpha: alpha * 0.12, amp: amp * 2.6, ghost: 0, seed: seed + 13, crumbs: false });
    }
  }
}

/** 破段重描: 拆 2-3 段独立宽浓+首尾 overshoot — 犹豫重描的痕迹 */
export function handBroken(ctx: Ctx2D, pts: Pt[], w: number, opts: HandStrokeOptions = {}): void {
  const R = rng((opts.seed ?? 1) * 31 + 17);
  const n = pts.length;
  if (n < 10) { handStroke(ctx, pts, w, opts); return; }
  const segs = ri(R, 2, 3);
  for (let i = 0; i < segs; i++) {
    const a = Math.max(0, Math.floor((n * i) / segs - n * 0.05));
    const b = Math.min(n, Math.floor((n * (i + 1)) / segs + n * 0.09));
    if (b - a < 2) continue;
    handStroke(ctx, pts.slice(a, b), w * rr(R, 0.6, 1.3), {
      ...opts,
      alpha: (opts.alpha ?? rr(R, 0.68, 0.97)) * rr(R, 0.75, 1.05),
      over: i === 0 || i === segs - 1 ? opts.over : w * rr(R, 0, 2),
      seed: (opts.seed ?? 1) + i * 101,
    });
  }
}

/** 铅笔芯单线: 摆动+断墨+碎屑 (填充的基本单元 — 填充也有手) */
export function handLine(ctx: Ctx2D, ptsIn: Pt[], w: number, alpha: number, opts: HandStrokeOptions = {}): void {
  const R = rng((opts.seed ?? 1) * 53 + 29);
  const ink = opts.color ?? [31, 29, 26];
  const inkA = (a: number) => `rgba(${ink[0]},${ink[1]},${ink[2]},${Math.min(1, a)})`;
  const rs = resample(ptsIn, 3);
  const p1 = rr(R, 0, 7), p2 = rr(R, 0, 7), f = rr(R, 4, 9);
  ctx.beginPath();
  let lift = false;
  for (let i = 0; i < rs.length; i++) {
    const t = i / (rs.length - 1 || 1);
    const a = rs[Math.max(0, i - 1)], b = rs[Math.min(rs.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const d = Math.hypot(nx, ny) || 1;
    const off = (w * 0.55 + 0.5) * (0.6 * Math.sin(t * f + p1) + 0.4 * Math.sin(t * f * 2.7 + p2));
    // 层5: 断笔 — 笔偶尔离纸
    const x = rs[i][0] + (nx / d) * off + rr(R, -0.45, 0.45);
    const y = rs[i][1] + (ny / d) * off + rr(R, -0.45, 0.45);
    if (!i || lift) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    lift = chance(R, 0.035);
  }
  ctx.strokeStyle = inkA(Math.min(1, alpha * 1.3));
  ctx.lineWidth = w * rr(R, 0.75, 1.3);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  if (opts.crumbs !== false && w >= 1.3) {
    const paper = opts.paper ?? [246, 241, 229];
    const paperA = (a: number) => `rgba(${paper[0]},${paper[1]},${paper[2]},${a})`;
    for (let i = 0; i < rs.length; i += 2) {
      if (chance(R, 0.55)) continue;
      const sz = rr(R, 0.6, 1.2);
      ctx.fillStyle = chance(R, 0.7) ? inkA(alpha * rr(R, 0.2, 0.4)) : paperA(rr(R, 0.4, 0.7));
      ctx.fillRect(rs[i][0] + rr(R, -w * 0.8 - 0.6, w * 0.8 + 0.6) - sz / 2, rs[i][1] + rr(R, -w * 0.8 - 0.6, w * 0.8 + 0.6) - sz / 2, sz, sz);
    }
  }
}

/** 排线填充 (clip 内扫描线, 每条带手) */
export function handHatchFill(ctx: Ctx2D, region: Pt[], spacing: number, ang: number, alpha: number, w = 1.1, opts: HandStrokeOptions = {}): void {
  const R = rng((opts.seed ?? 1) * 71 + 3);
  const [x0, y0, x1, y1] = bbox(region);
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  ctx.save();
  poly(ctx, region, true);
  ctx.clip();
  const px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const n = Math.ceil(diag / spacing);
  for (let i = -n; i <= n; i++) {
    const t = i * spacing + rr(R, -0.2, 0.2) * spacing;
    handLine(ctx, [
      [cx + px * t - dx * diag * 0.6, cy + py * t - dy * diag * 0.6],
      [cx + px * t + dx * diag * 0.6, cy + py * t + dy * diag * 0.6],
    ], w, alpha * rr(R, 0.6, 1.1), { ...opts, seed: (opts.seed ?? 1) * 7 + i });
  }
  ctx.restore();
}

/** 乱涂填充 (水平波浪线, 全局统一斜率=同一遍涂方向一致) */
export function handScribbleFill(ctx: Ctx2D, region: Pt[], spacing: number, alpha: number, opts: HandStrokeOptions = {}): void {
  const R = rng((opts.seed ?? 1) * 97 + 11);
  const [x0, y0, x1, y1] = bbox(region);
  ctx.save();
  poly(ctx, region, true);
  ctx.clip();
  const slope = rr(R, -0.25, 0.25);
  for (let y = y0 - spacing; y < y1 + spacing; y += spacing * rr(R, 0.8, 1.2)) {
    const line: Pt[] = [];
    const ph = rr(R, 0, 7);
    for (let x = x0; x <= x1; x += 5) {
      line.push([x, y + (x - x0) * slope + Math.sin(x * 0.55 + ph) * spacing * 0.42 + rr(R, -1, 1)]);
    }
    if (line.length > 1) {
      handLine(ctx, line, 1, alpha * rr(R, 0.6, 1.05), { ...opts, seed: (opts.seed ?? 1) * 13 + Math.round(y) });
    }
  }
  ctx.restore();
}

/** 铅笔块填充: 底涂+两遍斜率交叉手绘线+纸色提白 blob */
export function handPencilFill(ctx: Ctx2D, region: Pt[], darkness: number, opts: HandStrokeOptions = {}): void {
  const R = rng((opts.seed ?? 1) * 131 + 7);
  const ink = opts.color ?? [31, 29, 26];
  const paper = opts.paper ?? [246, 241, 229];
  const [x0, y0, x1, y1] = bbox(region);
  ctx.save();
  poly(ctx, region, true);
  ctx.clip();
  ctx.fillStyle = `rgba(${ink[0]},${ink[1]},${ink[2]},${Math.min(1, darkness * 0.48)})`;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  for (let pass = 0; pass < 2; pass++) {
    const slope = rr(R, -0.5, 0.5), sp = rr(R, 2.6, 3.8);
    for (let y = y0 - sp; y < y1 + sp; y += sp * rr(R, 0.8, 1.25)) {
      const line: Pt[] = [];
      const ph = rr(R, 0, 7);
      for (let x = x0; x <= x1; x += 5) {
        line.push([x, y + (x - x0) * slope + Math.sin(x * 0.5 + ph) * sp * 0.4 + rr(R, -1, 1)]);
      }
      if (line.length > 1) {
        handLine(ctx, line, rr(R, 1.4, 2.2), darkness * rr(R, 0.42, 0.62), { ...opts, seed: (opts.seed ?? 1) * 17 + pass * 997 + Math.round(y) });
      }
    }
  }
  // 提白 blob (反光/橡皮)
  for (let k = 0; k < ri(R, 2, 3); k++) {
    const bx = rr(R, x0, x1), by = rr(R, y0, y1);
    const brx = (x1 - x0) * rr(R, 0.1, 0.22), bry = (y1 - y0) * rr(R, 0.1, 0.2);
    const rot = rr(R, 0, Math.PI * 2), ph2 = rr(R, 0, 7);
    const bp: Pt[] = [];
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      const m = 1 + 0.17 * Math.sin(t * 2 + ph2) + 0.1 * Math.sin(t * 5 + ph2 * 2.3);
      const ex = Math.cos(t) * brx * m, ey = Math.sin(t) * bry * m;
      bp.push([bx + ex * Math.cos(rot) - ey * Math.sin(rot), by + ex * Math.sin(rot) + ey * Math.cos(rot)]);
    }
    poly(ctx, chaikin(bp, true, 1), true);
    ctx.fillStyle = `rgba(${paper[0]},${paper[1]},${paper[2]},${rr(R, 0.06, 0.14)})`;
    ctx.fill();
  }
  ctx.restore();
}

/** 点阵填充 */
export function handStippleFill(ctx: Ctx2D, region: Pt[], spacing: number, alpha: number, opts: HandStrokeOptions = {}): void {
  const R = rng((opts.seed ?? 1) * 151 + 13);
  const ink = opts.color ?? [31, 29, 26];
  const [x0, y0, x1, y1] = bbox(region);
  const n = ((x1 - x0) * (y1 - y0)) / (spacing * spacing);
  ctx.save();
  poly(ctx, region, true);
  ctx.clip();
  for (let i = 0; i < n; i++) {
    const sz = rr(R, 0.8, 1.8);
    ctx.fillStyle = `rgba(${ink[0]},${ink[1]},${ink[2]},${alpha * rr(R, 0.5, 1)})`;
    ctx.fillRect(rr(R, x0, x1) - sz / 2, rr(R, y0, y1) - sz / 2, sz, sz);
  }
  ctx.restore();
}

export const HAND_STYLES = ["graphite", "broken", "ghost", "wedge", "clean"] as const;
export type HandStyle = (typeof HAND_STYLES)[number];
