// PortraitEngine — 程序化人像: 五轴人格 → 原型 → quirk 传导 → 特征派生
// 移植自 a-dude 的 casting 系统, 配合 HandEngine v2 笔物理.
// 核心哲学: "A distribution sampled forty times has a texture,
//            and a person deciding forty times does not."
// 所以: 先决定人格, 一切特征从五个决策派生.

import { handStroke, PEN_PRESETS, HandStrokeOptions } from "./HandEngine.js";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Pt = [number, number];

// ---------- 确定性 RNG (mulberry32 + hash32 子流) ----------
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(seed: number, label: string, idx = 0): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 2654435761);
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ ((idx | 0) + 0x85ebca6b), 2246822519);
  return (h ^ (h >>> 13)) >>> 0;
}

class Rng {
  readonly seed: number;
  private _n: () => number;
  constructor(seed: number) { this.seed = seed >>> 0; this._n = mulberry32(this.seed); }
  f(a = 0, b = 1) { return a + (b - a) * this._n(); }
  i(a: number, b: number) { return Math.floor(this.f(a, b + 1)); }
  chance(p: number) { return this._n() < p; }
  pick<T>(arr: T[]): T { return arr[this.i(0, arr.length - 1)]; }
  sign() { return this.chance(0.5) ? 1 : -1; }
}
const rngFor = (seed: number, label: string, idx?: number) => new Rng(hash32(seed, label, idx));

// ---------- 3D 头骨 ----------
interface SkullShape {
  ratio: number; jaw: number; chin: number; crown: number; cheek: number;
  wide: number; pinch: number; skewW: number;
  brow?: number; jawAngle?: number; jawTaper?: number;
  lobeA?: number; lobeB?: number; lobeAmp?: number; lobePh?: number;
}

class Skull {
  readonly cx: number; readonly cy: number; readonly s: number;
  readonly yaw: number; readonly pitch: number; readonly roll: number;
  readonly rx: number; readonly ry: number; readonly depth: number;
  readonly shape: SkullShape;
  private _refA = 0; private _refB = 0;

  constructor(cx: number, cy: number, s: number, yaw: number, pitch: number, roll: number, ratio: number, depth: number, shape: SkullShape) {
    this.cx = cx; this.cy = cy; this.s = s;
    this.yaw = yaw; this.pitch = pitch; this.roll = roll;
    this.rx = s * ratio; this.ry = s; this.depth = depth; this.shape = shape;
  }

  warp(l: { x: number; y: number; z: number }) {
    const p = { x: l.x, y: l.y, z: l.z };
    const d = p.y - this.shape.wide;
    const k = Math.max(0.42, 1 - this.shape.pinch * d * d - this.shape.skewW * d);
    p.x *= k * this.shape.cheek;
    p.z *= 0.5 + 0.5 * k;
    if (p.y > 0.22) {
      const t = (p.y - 0.22) / 0.78;
      p.x *= 1 + (this.shape.jaw - 1) * t;
      p.y += this.shape.chin * t;
    } else if (p.y < -0.35) {
      const t = (-0.35 - p.y) / 0.65;
      p.y *= 1 + (this.shape.crown - 1) * t * 0.55;
    }
    return p;
  }

  rotate(p: { x: number; y: number; z: number }) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    let q = { x: p.x * cy - p.z * sy, y: p.y, z: p.x * sy + p.z * cy };
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    q = { x: q.x, y: q.y * cp - q.z * sp, z: q.y * sp + q.z * cp };
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    return { x: q.x * cr - q.y * sr, y: q.x * sr + q.y * cr, z: q.z };
  }

  project(l: { x: number; y: number; z: number }) {
    const p = this.rotate(this.warp(l));
    const k = 1 + p.z * 0.22 * this.depth;
    return { x: this.cx + p.x * this.rx * k, y: this.cy + p.y * this.ry * k, z: p.z };
  }

  /** 轮廓 = 投影点云的径向极坐标包络 + 谐波 lobe (可内凹 = 土豆非蛋) */
  silhouette(): Pt[] {
    const NA = 60;
    const rad = new Array(NA).fill(0);
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 18; j++) {
        const u = (i / 30) * Math.PI * 2;
        const v = -Math.PI / 2 + (j / 17) * Math.PI;
        const p = this.project({
          x: Math.cos(v) * Math.sin(u),
          y: Math.sin(v),
          z: Math.cos(v) * Math.cos(u),
        });
        const dx = p.x - this.cx, dy = p.y - this.cy;
        const r = Math.hypot(dx, dy);
        const k = ((Math.round(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * NA) % NA) + NA) % NA;
        if (r > rad[k]) rad[k] = r;
      }
    }
    // 平滑
    const sm = rad.map((_, i) =>
      (rad[(i - 1 + NA) % NA] + rad[i] * 2 + rad[(i + 1) % NA]) / 4
    );
    const sh = this.shape;
    const lobeA = sh.lobeA ?? 3, lobeB = sh.lobeB ?? 7, lobeAmp = sh.lobeAmp ?? 0.04, lobePh = sh.lobePh ?? 0;
    const out: Pt[] = [];
    for (let i = 0; i < NA; i++) {
      const a = -Math.PI + (i / NA) * Math.PI * 2;
      const k = 1 + Math.sin(a * lobeA + lobePh) * lobeAmp + Math.sin(a * lobeB + lobePh * 1.7) * lobeAmp * 0.55;
      out.push([this.cx + Math.cos(a) * sm[i] * k, this.cy + Math.sin(a) * sm[i] * k]);
    }
    return out;
  }
}

// ---------- 标志点: 位置+表面局部坐标系 (每轴自参考归一化) ----------
interface Landmark {
  x: number; y: number; z: number;
  ax: number; ay: number; bx: number; by: number;
  ra: number; rb: number;
}

function landmark(skull: Skull, lx: number, ly: number, lz: number): Landmark {
  const pin = (p: { x: number; y: number; z: number }) => skull.project(p);
  const e = 0.06;
  const p0 = pin({ x: lx, y: ly, z: lz });
  const pu = pin({ x: lx + e, y: ly, z: lz });
  const pv = pin({ x: lx, y: ly + e, z: lz });
  // 每轴自参考: 在面向观者处取参考长度
  if (skull["_refA"] === 0) {
    const f0a = pin({ x: e, y: 0, z: 1 });
    const f0b = pin({ x: 0, y: e, z: 1 });
    skull["_refA"] = Math.max(1e-3, Math.hypot(f0a.x - skull.cx, f0a.y - skull.cy));
    skull["_refB"] = Math.max(1e-3, Math.hypot(f0b.x - skull.cx, f0b.y - skull.cy));
  }
  return {
    x: p0.x, y: p0.y, z: p0.z,
    ax: (pu.x - p0.x) / e, ay: (pu.y - p0.y) / e,
    bx: (pv.x - p0.x) / e, by: (pv.y - p0.y) / e,
    ra: skull["_refA"], rb: skull["_refB"],
  };
}

/** 在标志点局部坐标系中画特征 — 透视/旋转自动被携带 */
function onSurface(L: Landmark, a: number, b: number): Pt {
  const ka = Math.hypot(L.ax, L.ay) || 1;
  const kb = Math.hypot(L.bx, L.by) || 1;
  const sa = Math.max(0.12, Math.min(1.6, ka / (L.ra || ka)));
  const sb = Math.max(0.12, Math.min(1.6, kb / (L.rb || kb)));
  return [L.x + (L.ax / ka) * a * sa + (L.bx / kb) * b * sb,
          L.y + (L.ay / ka) * a * sa + (L.by / kb) * b * sb];
}

// ---------- Portrait Casting ----------
export interface PersonTraits {
  age: "young" | "mid" | "old";
  build: "slight" | "ordinary" | "heavy";
  bearing: "slumped" | "neutral" | "upright" | "cocky";
  mood: "dour" | "blank" | "wary" | "pleased" | "amused";
  care: "unkempt" | "plain" | "groomed";
}

export interface PortraitSpec {
  seed: number;
  person: PersonTraits;
  quirk: string;
  skull: SkullShape;
  pen: string;
  yaw: number; pitch: number; roll: number;
  eyeType: string; eyeGap: number; noseHeavy: number;
  mouthStyle: string; browStyle: string;
  hairStyle: string;
  faceY: number;
}

/** 决策树: seed → 五轴人格 → 原型 → quirk → 特征派生 */
export function castPortrait(seed: number): PortraitSpec {
  const R = rngFor(seed, "person");
  const person: PersonTraits = {
    age: R.pick(["young", "young", "mid", "mid", "mid", "old", "old"]),
    build: R.pick(["slight", "ordinary", "ordinary", "heavy", "heavy"]),
    bearing: R.pick(["slumped", "neutral", "neutral", "upright", "cocky"]),
    mood: R.pick(["dour", "blank", "blank", "wary", "pleased", "amused"]),
    care: R.pick(["unkempt", "unkempt", "plain", "plain", "groomed"]),
  };

  // 原型 (剪影级差异, 非百分比微调)
  const kR = rngFor(seed, "skullKind");
  const kinds: Array<() => SkullShape> = [
    () => ({ ratio: kR.f(1.02, 1.3), jaw: kR.f(0.95, 1.15), chin: kR.f(-0.06, 0.02), crown: kR.f(0.86, 1.0), cheek: kR.f(1.0, 1.18), wide: kR.f(-0.1, 0.15), pinch: kR.f(0.1, 0.24), skewW: kR.f(-0.08, 0.08), lobeA: 3, lobeB: 7, lobeAmp: 0.04, lobePh: kR.f(0, 6) }),
    () => ({ ratio: kR.f(0.78, 0.95), jaw: kR.f(1.15, 1.5), chin: kR.f(0.08, 0.26), crown: kR.f(0.82, 0.98), cheek: kR.f(0.82, 0.95), wide: kR.f(0.3, 0.6), pinch: kR.f(0.3, 0.55), skewW: kR.f(-0.16, 0.16), lobeA: 4, lobeB: 9, lobeAmp: 0.05, lobePh: kR.f(0, 6) }),
    () => ({ ratio: kR.f(0.8, 0.98), jaw: kR.f(0.78, 0.98), chin: kR.f(-0.02, 0.1), crown: kR.f(1.16, 1.42), cheek: kR.f(0.86, 1.0), wide: kR.f(-0.5, -0.15), pinch: kR.f(0.22, 0.44), skewW: kR.f(-0.1, 0.1), lobeA: 2, lobeB: 5, lobeAmp: 0.03, lobePh: kR.f(0, 6) }),
    () => ({ ratio: kR.f(1.05, 1.32), jaw: kR.f(1.05, 1.28), chin: kR.f(-0.08, 0.04), crown: kR.f(0.76, 0.9), cheek: kR.f(1.0, 1.2), wide: kR.f(-0.4, -0.05), pinch: kR.f(0.08, 0.2), skewW: kR.f(-0.06, 0.06), lobeA: 5, lobeB: 11, lobeAmp: 0.06, lobePh: kR.f(0, 6) }),
    () => ({ ratio: kR.f(0.92, 1.14), jaw: kR.f(1.2, 1.48), chin: kR.f(0.0, 0.14), crown: kR.f(0.8, 0.96), cheek: kR.f(0.9, 1.05), wide: kR.f(0.35, 0.65), pinch: kR.f(0.32, 0.58), skewW: kR.f(-0.18, 0.18), lobeA: 3, lobeB: 8, lobeAmp: 0.05, lobePh: kR.f(0, 6) }),
  ];
  let skull = kR.pick(kinds)();

  // quirk: 一个决策传导到多个特征
  const qR = rngFor(seed, "quirk");
  const quirk = qR.pick(["none", "none", "closeSet", "wideSet", "longFace", "browHeavy", "jawHeavy", "tiny", "topHeavy"]);
  let eyeGap = 0.28;
  let noseHeavy = 1.0;
  let faceY = 0;
  if (quirk === "closeSet") { eyeGap *= qR.f(0.5, 0.68); noseHeavy *= qR.f(0.75, 0.9); faceY += 0.04; skull.pinch = Math.min(0.6, skull.pinch * 1.25); }
  else if (quirk === "wideSet") { eyeGap = Math.min(0.6, eyeGap * qR.f(1.3, 1.55)); noseHeavy *= qR.f(1.05, 1.25); skull.ratio *= qR.f(1.06, 1.16); skull.cheek *= 1.08; }
  else if (quirk === "longFace") { skull.ratio *= qR.f(0.76, 0.88); skull.chin += qR.f(0.08, 0.18); faceY -= qR.f(0.04, 0.1); noseHeavy *= qR.f(1.1, 1.3); }
  else if (quirk === "browHeavy") { skull.brow = qR.f(0.1, 0.17); }
  else if (quirk === "jawHeavy") { skull.jaw *= qR.f(1.15, 1.32); skull.wide = Math.min(0.6, skull.wide + 0.25); faceY -= 0.05; }
  else if (quirk === "tiny") { eyeGap *= 0.78; noseHeavy *= 0.7; faceY += qR.f(0.06, 0.13); skull.crown *= qR.f(1.08, 1.2); }
  else if (quirk === "topHeavy") { skull.crown *= qR.f(1.12, 1.28); faceY += qR.f(0.05, 0.12); skull.jaw *= 0.88; skull.chin -= 0.04; }

  // 年龄派生 (到达头骨/眉/发际线/嘴)
  if (person.age === "old") { skull.brow = (skull.brow ?? 0) + 0.06; faceY += 0.03; }
  else if (person.age === "young") { skull.crown *= 1.04; faceY -= 0.02; }

  // 姿态→头姿
  const pR = rngFor(seed, "pose");
  const yaw = pR.f(-0.4, 0.4) + (person.bearing === "cocky" ? 0.12 : 0);
  const pitch = pR.f(-0.15, 0.1) + (person.bearing === "slumped" ? 0.1 : person.bearing === "upright" ? -0.05 : 0);
  const roll = pR.f(-0.12, 0.12) + (person.bearing === "cocky" ? 0.08 : 0);

  // 笔
  const penR = rngFor(seed, "pen");
  const penNames = ["house", "house", "house", "fountain", "fountain", "biro", "fineliner", "fineliner", "brown", "brown", "greenBlack", "graphite"];
  const penName = penNames[penR.i(0, penNames.length - 1)];

  // 眼/嘴/眉/发 从人格派生
  const fR = rngFor(seed, "features");
  let eyeType = fR.pick(["sharp", "sharp", "big", "big", "narrow", "closed"]);
  if (person.mood === "wary") eyeType = "narrow";
  if (person.mood === "amused") eyeType = fR.chance(0.5) ? "closed" : "big";
  if (quirk === "browHeavy") eyeType = fR.pick(["half", "squint", "half"]);

  let mouthStyle = fR.pick(["flat", "flat", "frown", "smirk", "open", "grit"]);
  if (person.mood === "pleased" || person.mood === "amused") mouthStyle = fR.pick(["smirk", "smirk", "open"]);
  if (person.mood === "dour") mouthStyle = "frown";

  const browStyle = quirk === "browHeavy" ? "angry" : fR.pick(["flat", "raised", "angled"]);

  let hairStyle: string;
  if (person.care === "unkempt") hairStyle = fR.pick(["messy", "spiky", "curly", "side", "thatch"]);
  else if (person.care === "groomed") hairStyle = fR.pick(["comb", "side", "flat", "bowl"]);
  else hairStyle = fR.pick(["thatch", "comb", "bowl", "side"]);
  if (person.age === "old") hairStyle = fR.pick(["recede", "buzz", "comb", "bald"]);
  if (person.age === "young") hairStyle = fR.pick(["messy", "spiky", "curly", "side", "bowl", "thatch"]);

  return { seed, person, quirk, skull, pen: penName, yaw, pitch, roll, eyeType, eyeGap, noseHeavy, mouthStyle, browStyle, hairStyle, faceY };
}

// ---------- 绘制 ----------
export function drawPortrait(ctx: Ctx2D, seed: number, cx: number, cy: number, s: number, opt: { ink?: string; paper?: string } = {}): void {
  const spec = castPortrait(seed);
  const pen = PEN_PRESETS[spec.pen] ?? PEN_PRESETS.house;
  const inkColor = opt.ink ?? "#232019";
  const hOpt: Partial<HandStrokeOptions> = {
    color: [35, 32, 25],
    press: pen.press, dry: pen.dry, pool: pen.pool, split: pen.split, bite: pen.bite,
    fbm: true, alpha: 0.88,
  };

  const skull = new Skull(cx, cy, s, spec.yaw, spec.pitch, spec.roll, spec.skull.ratio, 0.8, spec.skull);

  const H = (pts: Pt[], w: number, extra: Partial<HandStrokeOptions> = {}) => {
    handStroke(ctx, pts, w, { ...hOpt, ...extra, seed: (seed * 7919 + w * 131 + pts.length) | 0 });
  };

  // ── 轮廓 ──
  const sil = skull.silhouette();
  H(sil.concat([sil[0]]), Math.max(2, s * 0.035), { ghost: 0.35 });

  // ── 特征标志点 ──
  const ey = -0.05 + spec.faceY;
  const eyeGap = spec.eyeGap;

  // 眼
  for (const side of [-1, 1]) {
    const L = landmark(skull, side * eyeGap, ey, 0.82);
    const ew = s * 0.14;
    const eh = s * 0.08;
    if (spec.eyeType === "closed") {
      H([onSurface(L, -ew, eh * 0.2), onSurface(L, 0, eh * 0.8), onSurface(L, ew, eh * 0.1)], Math.max(1.5, s * 0.025));
    } else {
      H([
        onSurface(L, -ew * 0.95, eh * 0.1),
        onSurface(L, -ew * 0.05, -eh * 0.65),
        onSurface(L, ew * 0.95, -eh * (0.25 + (spec.eyeType === "narrow" ? 0.1 : 0))),
      ], Math.max(1.5, s * 0.03));
      // 瞳
      const pupil = onSurface(L, 0, eh * 0.25);
      ctx.beginPath();
      ctx.ellipse(pupil[0], pupil[1], ew * 0.3, eh * 0.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(35,32,25,0.85)";
      ctx.fill();
    }
    // 眉
    const bL = landmark(skull, side * eyeGap, ey - 0.14, 0.80);
    const bw = s * 0.16;
    const by = spec.browStyle === "angry" ? s * 0.03 : s * 0.01;
    H([
      onSurface(bL, -bw, by * 0.5),
      onSurface(bL, 0, by),
      onSurface(bL, bw, -by * 0.3),
    ], Math.max(2, s * 0.04), { wedge: true });
  }

  // 鼻
  const nL = landmark(skull, 0, ey + 0.12, 0.85);
  H([
    onSurface(nL, -s * 0.02, s * 0.06),
    onSurface(nL, 0, 0),
    onSurface(nL, s * 0.05, s * 0.02),
  ], Math.max(1.5, s * 0.022));

  // 嘴
  const mL = landmark(skull, 0, ey + 0.25, 0.80);
  const mw = s * 0.18;
  if (spec.mouthStyle === "frown") {
    H([onSurface(mL, -mw, -s * 0.015), onSurface(mL, 0, s * 0.02), onSurface(mL, mw * 0.9, -s * 0.015)], Math.max(1.5, s * 0.022));
  } else if (spec.mouthStyle === "smirk") {
    H([onSurface(mL, -mw * 0.7, s * 0.01), onSurface(mL, mw * 0.5, -s * 0.005), onSurface(mL, mw * 0.95, -s * 0.04)], Math.max(1.5, s * 0.022));
  } else if (spec.mouthStyle === "open") {
    H([onSurface(mL, -mw * 0.7, 0), onSurface(mL, mw * 0.7, 0)], Math.max(1.5, s * 0.022));
    ctx.beginPath();
    const m1 = onSurface(mL, -mw * 0.32, 0), m2 = onSurface(mL, mw * 0.32, 0), m3 = onSurface(mL, mw * 0.2, s * 0.03), m4 = onSurface(mL, -mw * 0.2, s * 0.03);
    ctx.moveTo(m1[0], m1[1]); ctx.lineTo(m2[0], m2[1]); ctx.lineTo(m3[0], m3[1]); ctx.lineTo(m4[0], m4[1]); ctx.closePath();
    ctx.fillStyle = "rgba(35,32,25,0.7)";
    ctx.fill();
  } else {
    H([onSurface(mL, -mw, 0), onSurface(mL, mw * 0.9, 0)], Math.max(1.5, s * 0.022));
  }

  // 耳
  for (const side of [-1, 1]) {
    const eL = landmark(skull, side * 0.92, ey, 0.05);
    H([
      onSurface(eL, 0, -s * 0.08),
      onSurface(eL, s * 0.03, 0),
      onSurface(eL, 0, s * 0.08),
    ], Math.max(1.5, s * 0.02));
  }

  // 发型 (简化: 几种基本形)
  const hR = rngFor(seed, "hairDraw");
  const hairL = landmark(skull, 0, ey - 0.32, 0.75);
  const hs = s;
  if (spec.hairStyle === "buzz" || spec.hairStyle === "bald") {
    // 极短/秃: 只画发际线
    H([onSurface(hairL, -hs * 0.5, 0), onSurface(hairL, 0, hs * 0.04), onSurface(hairL, hs * 0.5, 0)], Math.max(1.5, s * 0.02));
  } else if (spec.hairStyle === "messy" || spec.hairStyle === "spiky") {
    for (let k = 0; k < 8; k++) {
      const a = -Math.PI * 0.8 + k * (Math.PI * 0.6 / 7);
      const len = s * hR.f(0.15, 0.3);
      const p0 = onSurface(hairL, Math.cos(a) * hs * 0.4, Math.sin(a) * hs * 0.15);
      const p1 = onSurface(hairL, Math.cos(a) * hs * 0.4 + Math.cos(a) * len, Math.sin(a) * hs * 0.15 + Math.sin(a) * len * 0.5 - len * 0.3);
      H([p0, p1], Math.max(1, s * 0.018), { wedge: true });
    }
  } else if (spec.hairStyle === "curly") {
    for (let k = 0; k < 12; k++) {
      const a = -Math.PI + k * (Math.PI * 2 / 11);
      const p = onSurface(hairL, Math.cos(a) * hs * 0.42, Math.sin(a) * hs * 0.18 + hs * 0.05);
      ctx.beginPath();
      ctx.ellipse(p[0], p[1], s * 0.05, s * 0.04, a, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(35,32,25,${0.3 + hR.f(0, 0.3)})`;
      ctx.lineWidth = Math.max(1, s * 0.015);
      ctx.stroke();
    }
  } else {
    // comb/side/thatch/bowl/recede/flat: 帽状覆盖
    const capPts: Pt[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      capPts.push(onSurface(hairL, -hs * 0.5 + t * hs, Math.sin(t * Math.PI) * hs * 0.12));
    }
    H(capPts, Math.max(2, s * 0.03));
    // 侧发
    H([onSurface(hairL, -hs * 0.5, 0), onSurface(hairL, -hs * 0.52, -hs * 0.08)], Math.max(1.5, s * 0.02));
    H([onSurface(hairL, hs * 0.5, 0), onSurface(hairL, hs * 0.52, -hs * 0.08)], Math.max(1.5, s * 0.02));
  }
}
