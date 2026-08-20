// HandEngine — 手绘误差分层合成引擎
// v1: 五层人手误差模型（摆动/压感/颗粒/起收笔/复笔）
// v2 (a-dude 移植): fbm 值噪声场 · 笔物理(press/dry/pool/split/bite) · 拐角积墨
//     · 连续场断墨 · 侧絮带 · 压力波长按笔画缩放 · 落笔收笔包络 · 局部纸咬
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
  // ---- v2: 笔物理 (0=关, 1=正常; 从 a-dude 干笔尖引擎移植) ----
  /** 压力呼吸量 (0=恒宽 fineliner, 1=全波) */
  press?: number;
  /** 断墨率 (0=不断, 1=正常干尖) */
  dry?: number;
  /** 拐角积墨 (0=不积, 1=正常) */
  pool?: number;
  /** 侧絮分裂阈值倍率 (0=不裂) */
  split?: number;
  /** 纸咬量 (0=纸不咬, 1=正常) */
  bite?: number;
  /** 启用 v2 fbm 引擎 (default false = 保持 v1 正弦兼容) */
  fbm?: boolean;
}

// v2: 8 支笔的物理预设 (从 a-dude PENS 表移植)
export const PEN_PRESETS: Record<string, Required<Pick<HandStrokeOptions,
  "press" | "dry" | "pool" | "split" | "bite">>> = {
  house:      { press: 1.0, dry: 1.0, pool: 1.0, split: 1.0, bite: 1.0 },
  fountain:   { press: 1.3, dry: 0.3, pool: 1.6, split: 0.5, bite: 0.2 },
  biro:       { press: 0.3, dry: 1.5, pool: 0.0, split: 0.0, bite: 0.6 },
  blackBiro:  { press: 0.3, dry: 1.5, pool: 0.0, split: 0.0, bite: 0.6 },
  fineliner:  { press: 0.0, dry: 0.2, pool: 0.0, split: 0.0, bite: 0.1 },
  brown:      { press: 0.8, dry: 1.2, pool: 0.7, split: 0.8, bite: 0.9 },
  greenBlack: { press: 0.9, dry: 1.1, pool: 0.8, split: 0.9, bite: 0.8 },
  graphite:   { press: 1.1, dry: 0.5, pool: 0.1, split: 1.6, bite: 1.8 },
};

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

// ---------- v2: fbm 值噪声场 (a-dude 移植) ----------
function hash2(ix: number, iy: number, seed: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm2(x: number, y: number, seed: number): number {
  return valueNoise(x, y, seed) * 0.66 + valueNoise(x * 2.13, y * 2.13, seed + 17) * 0.34;
}

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
  // v2: 笔物理缺省 (0=v1 兼容, 1=正常干尖)
  const press = opts.press ?? 0;
  const dryK = opts.dry ?? 0;
  const pool = opts.pool ?? 0;
  const split = opts.split ?? 0;
  const bite = opts.bite ?? 0;
  const useFbm = opts.fbm ?? false;
  // v2: 笔画弧长 (压力波长按此缩放——"比线还长的噪声给恒定宽")
  let arcL = 0;
  for (let i = 1; i < n; i++) arcL += Math.hypot(rs[i][0] - rs[i - 1][0], rs[i][1] - rs[i - 1][1]);
  const sd = (seed * 7919) >>> 0;

  const L: Pt[] = [], Rt: Pt[] = [], C: Array<[number, number, number, number, number]> = [];
  const W: number[] = [];
  const live: boolean[] = [];
  const P: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = rs[Math.max(0, i - 1)], b = rs[Math.min(n - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const d = Math.hypot(nx, ny) || 1;
    nx /= d; ny /= d;
    // 层1: 手臂摆动 — v2 fbm 或 v1 三频正弦
    let off: number;
    if (useFbm) {
      const u = t * arcL;
      off = (fbm2(u * 0.019, sd * 0.013, sd) - 0.5) * 2 * amp
          + (fbm2(u * 0.105, sd * 0.007, sd + 31) - 0.5) * 2 * amp * 0.3;
    } else {
      off = amp * (0.55 * Math.sin(t * f1 * 2 + p1) + 0.3 * Math.sin(t * f2 + p2) + 0.15 * Math.sin(t * f3 + p3));
    }
    const px = rs[i][0] + nx * off + rr(R, -0.35, 0.35);
    const py = rs[i][1] + ny * off + rr(R, -0.35, 0.35);
    P.push([px, py]);

    // 层2: 压力起伏 + 层4b: 端部 taper 包络
    let half = (w / 2)
      * (opts.wedge ? (0.25 + 0.95 * t) : (0.3 + 0.7 * smooth(Math.min(t, 1 - t) / taper)))
      * (1 + 0.38 * Math.sin(t * 7.3 + p4) + 0.14 * Math.sin(t * 19 + p2))
      * rr(R, 0.88, 1.14);

    // v2: 压力波长按笔画缩放 (a-dude: 恒宽是 plotted 的第一破绽)
    if (press > 0) {
      const u = t * arcL;
      const cyc = 1.3 + ((sd >>> 3) % 9) * 0.42;
      const slow = (fbm2(t * cyc * 2 + 7, sd * 0.011, sd + 5) - 0.5);
      const slow2 = (fbm2(t * cyc * 5.5 + 3, sd * 0.017, sd + 211) - 0.5);
      const fast = (fbm2(u * 0.185, sd * 0.005, sd + 61) - 0.5);
      let pr = 1 + (slow * 1.7 + slow2 * 0.62 + fast * 0.26) * press;
      // 落笔包络: 前 3 点 press × (1 + (0.3 - i*0.09)*press)
      if (i < 3) pr *= 1 + (0.3 - i * 0.09) * press;
      // 收笔包络: 末 6 点递减
      const tail = n - 1 - i;
      if (tail < 6) pr *= 1 - (0.48 - (tail / 6) * 0.48) * press;

      // v2: 拐角积墨 — 5 点跨度测转角, 真弯才积 (0.35-1.25 rad)
      const span = 5;
      const ca = P[Math.max(0, i - span)];
      const cb = P[Math.min(P.length - 1, i + span)];
      let ang = Math.atan2(cb[1] - py, cb[0] - px) - Math.atan2(py - ca[1], px - ca[0]);
      while (ang > Math.PI) ang -= Math.PI * 2;
      while (ang < -Math.PI) ang += Math.PI * 2;
      const turn = Math.abs(ang);
      if (pool > 0 && turn > 0.35 && turn < 1.25) pr *= 1 + Math.min(0.55, (turn - 0.35) * 0.95) * pool;

      half *= Math.min(2.6, Math.max(0.08, pr));
    }

    half = Math.max(half, 0.28);
    W.push(half * 2);
    L.push([px + nx * half, py + ny * half]);
    Rt.push([px - nx * half, py - ny * half]);
    C.push([px, py, nx, ny, half]);

    // v2: 连续场断墨 (a-dude: fbm 阈值, 细线更易断)
    if (dryK > 0) {
      const u = t * arcL;
      const dry = fbm2(u * 0.19 + 11, sd * 0.02, sd + 137);
      const thr = 0.125 * dryK * (w < 1.3 ? 1.4 : w > 2.6 ? 0.5 : 1);
      live[i] = !(dry < thr && i > 1 && i < n - 2);
    } else {
      live[i] = true;
    }
  }

  // v2: live 段绘制 (断墨时只画活段, 跳过死段)
  const drawLiveSegment = (i0: number, i1: number) => {
    ctx.beginPath();
    ctx.moveTo(L[i0][0], L[i0][1]);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(L[i][0], L[i][1]);
    for (let i = i1; i >= i0; i--) ctx.lineTo(Rt[i][0], Rt[i][1]);
    ctx.closePath();
    ctx.fillStyle = inkA(alpha * 0.62);
    ctx.fill();
  };

  if (dryK > 0) {
    let i = 0;
    while (i < n) {
      if (!live[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && live[j + 1]) j++;
      if (j > i) drawLiveSegment(i, j);
      else if (i > 0 && i < n - 1) {
        // 单活点: 画小圆
        ctx.beginPath();
        ctx.arc(P[i][0], P[i][1], W[i] * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = inkA(alpha * 0.62);
        ctx.fill();
      }
      i = j + 1;
    }
  } else {
    // v1: 整段
    drawLiveSegment(0, n - 1);
  }

  // v2: 侧絮带 (a-dude: 中带湿+两侧毛边, 圆珠笔不裂软笔全裂)
  if (split > 0 && w * split > 1.7) {
    const bands: Array<[number, number, number, number]> = [
      [-0.32, 0.3 * split, sd + 401, 0.45],
      [0.32, 0.3 * split, sd + 733, 0.47],
    ];
    for (const [off2, wk, dseed, dthr] of bands) {
      let i = 0;
      while (i < n) {
        const okAt = (k: number) =>
          live[k] && fbm2(k * 2.2 * 0.26 + 3, dseed * 0.02, dseed) > dthr;
        if (!okAt(i)) { i++; continue; }
        let j = i;
        while (j + 1 < n && okAt(j + 1)) j++;
        if (j > i) {
          ctx.beginPath();
          for (let k = i; k <= j; k++) {
            const o = off2 * W[k] * 0.5;
            const hw = Math.max(0.16, wk * W[k]) * 0.5;
            const [px, py, , , ] = C[k];
            const nx2 = k > 0 ? -(P[Math.min(n - 1, k + 1)][1] - P[Math.max(0, k - 1)][1]) : 0;
            const ny2 = k > 0 ? P[Math.min(n - 1, k + 1)][0] - P[Math.max(0, k - 1)][0] : 1;
            const dn = Math.hypot(nx2, ny2) || 1;
            ctx.lineTo(px + (nx2 / dn) * (o + hw), py + (ny2 / dn) * (o + hw));
          }
          for (let k = j; k >= i; k--) {
            const o = off2 * W[k] * 0.5;
            const hw = Math.max(0.16, wk * W[k]) * 0.5;
            const [px, py, , , ] = C[k];
            const nx2 = k > 0 ? -(P[Math.min(n - 1, k + 1)][1] - P[Math.max(0, k - 1)][1]) : 0;
            const ny2 = k > 0 ? P[Math.min(n - 1, k + 1)][0] - P[Math.max(0, k - 1)][0] : 1;
            const dn = Math.hypot(nx2, ny2) || 1;
            ctx.lineTo(px + (nx2 / dn) * (o - hw), py + (ny2 / dn) * (o - hw));
          }
          ctx.closePath();
          ctx.fillStyle = inkA(alpha * 0.5);
          ctx.fill();
        }
        i = j + 1;
      }
    }
  }

  // v2: 拐角积墨点 (pool 高时在真弯处点椭圆)
  if (pool > 0.5) {
    for (let k = 3; k < n - 3; k += 2) {
      if (!live[k] || W[k] < w * 0.65) continue;
      if (!chance(R, 0.14 * pool)) continue;
      ctx.beginPath();
      ctx.ellipse(P[k][0], P[k][1], W[k] * 0.58, W[k] * 0.46, k * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = inkA(alpha * 0.62);
      ctx.fill();
    }
  }

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
      // v2: 局部纸咬 (bite > 0 时, 按笔物理提高纸色回咬密度)
      const paperChance = 0.45 + (bite > 0 ? bite * 0.3 : 0);
      if (chance(R, paperChance)) {
        const u = (chance(R, 0.5) ? 1 : -1) * rr(R, 0.8, 1.15);
        const sz = rr(R, 0.9, 2) * (bite > 0 ? 1 + bite * 0.3 : 1);
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
