import { mkdir, writeFile } from "node:fs/promises";

import { METHODS } from "../../dist-cli/shared/protocol.js";
import { getByNameOrId } from "../../dist-cli/src/brush/BrushPresets.js";
import {
  axisSeparation,
  batchOperations,
  clamp,
  createRng,
  generateFieldHatching,
  streamlinesToStrokeOperations,
} from "../../skills/sketch-foundations/scripts/field-hatching.mjs";

const OUTPUT_DIR = new URL("./", import.meta.url).pathname;
await mkdir(OUTPUT_DIR, { recursive: true });

const W = 900;
const H = 938;
const PAPER = "#f2eee4";
const GRAPHITE = "#4b4b49";
const DARK = "#303030";
const BATCH_SIZE = 180;
const PENCIL = getByNameOrId("铅笔");
const TRADITIONAL_PENCIL = getByNameOrId("传统铅笔");
const ROUGH_PENCIL = getByNameOrId("粗糙铅笔");

const LAYERS = {
  paper: "L_ap4_paper01",
  shadow: "L_ap4_shadow01",
  construction: "L_ap4_construct01",
  mass: "L_ap4_mass01",
  primary: "L_ap4_primary01",
  cross: "L_ap4_cross01",
  edges: "L_ap4_edges02",
  lights: "L_ap4_lights02",
};

const cx = 448;
const cy = 472;
const rx = 218;
const ry = 214;

function angleDistance(a, b) {
  let delta = (a - b) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

function gaussianAngle(theta, center, width) {
  const delta = angleDistance(theta, center);
  return Math.exp(-(delta * delta) / (2 * width * width));
}

function boundaryRadius(theta) {
  const topNotch = gaussianAngle(theta, -Math.PI / 2, 0.15);
  const leftLobe = gaussianAngle(theta, -2.03, 0.24);
  const rightLobe = gaussianAngle(theta, -1.08, 0.25);
  const bottomDimple = gaussianAngle(theta, Math.PI / 2, 0.24);
  return 1
    - topNotch * 0.165
    + leftLobe * 0.045
    + rightLobe * 0.06
    - bottomDimple * 0.026
    + Math.cos(theta + 0.38) * 0.012
    + Math.sin(theta * 3 - 0.35) * 0.008;
}

function normalizedAt(x, y) {
  const u = (x - cx) / rx;
  const v = (y - cy) / ry;
  const theta = Math.atan2(v, u);
  const rho = Math.hypot(u, v);
  const radius = boundaryRadius(theta);
  return { u, v, theta, rho, radius, q: rho / radius };
}

function appleMask(x, y) {
  return normalizedAt(x, y).q < 0.997;
}

function heightUv(u, v) {
  const theta = Math.atan2(v, u);
  const q = Math.hypot(u, v) / boundaryRadius(theta);
  if (q >= 1) return 0;
  let z = Math.sqrt(Math.max(0, 1 - q * q));
  const dimple = Math.exp(-(((u - 0.025) / 0.19) ** 2 + ((v + 0.765) / 0.105) ** 2));
  const bottomCompression = Math.exp(-((u / 0.5) ** 2 + ((v - 0.92) / 0.12) ** 2));
  z -= dimple * 0.17;
  z -= bottomCompression * 0.035;
  return Math.max(0, z);
}

function surfaceNormal(x, y) {
  const { u, v } = normalizedAt(x, y);
  const epsilon = 0.006;
  const dzdu = (heightUv(u + epsilon, v) - heightUv(u - epsilon, v)) / (2 * epsilon);
  const dzdv = (heightUv(u, v + epsilon) - heightUv(u, v - epsilon)) / (2 * epsilon);
  let nx = -dzdu * 0.58;
  let ny = -dzdv * 0.58;
  let nz = 1;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  return { nx, ny, nz };
}

function appleTone(x, y) {
  if (!appleMask(x, y)) return 0;
  const { u, v, q } = normalizedAt(x, y);
  const { nx, ny, nz } = surfaceNormal(x, y);
  let lx = -0.5;
  let ly = -0.62;
  let lz = 0.72;
  const lightLength = Math.hypot(lx, ly, lz);
  lx /= lightLength;
  ly /= lightLength;
  lz /= lightLength;
  const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
  const lightness = 0.18 + diffuse * 0.74;
  let tone = 1 - lightness;

  const dimple = Math.exp(-(((u - 0.025) / 0.22) ** 2 + ((v + 0.765) / 0.13) ** 2));
  const contact = Math.exp(-((u / 0.48) ** 2 + ((v - 0.91) / 0.11) ** 2));
  const highlight = Math.exp(-(((u + 0.37) / 0.25) ** 2 + ((v + 0.42) / 0.32) ** 2));
  const rim = Math.exp(-(((q - 0.91) / 0.075) ** 2)) * clamp((u - 0.35) / 0.55);
  tone += dimple * 0.15 + contact * 0.13;
  tone -= highlight * 0.13;
  tone -= rim * 0.075;
  return clamp(tone, 0.035, 0.9);
}

function blendAxis(a, b, amount) {
  const x = Math.cos(a * 2) * (1 - amount) + Math.cos(b * 2) * amount;
  const y = Math.sin(a * 2) * (1 - amount) + Math.sin(b * 2) * amount;
  return Math.atan2(y, x) * 0.5;
}

function appleDirection(x, y, family) {
  const { u, v, q } = normalizedAt(x, y);
  const primary = Math.PI / 2 - 0.08 + u * 0.5 - v * 0.09;
  const contourTangent = Math.atan2(u * ry, -v * rx || 1e-6);
  const boundaryBlend = clamp((q - 0.7) / 0.3) * 0.46;
  const formDirection = blendAxis(primary, contourTangent, boundaryBlend);
  const dimpleWeight = Math.exp(-(((u - 0.02) / 0.31) ** 2 + ((v + 0.73) / 0.2) ** 2));
  const dimpleTangent = Math.atan2(v + 0.77, u - 0.02) + Math.PI / 2;
  const dimpleAware = blendAxis(formDirection, dimpleTangent, dimpleWeight * 0.42);

  if (family.field === "cross") {
    const oblique = dimpleAware - 0.6;
    return blendAxis(oblique, contourTangent, 0.12 + boundaryBlend * 0.18);
  }
  if (family.field === "deep") return dimpleAware + 0.46;
  return dimpleAware;
}

const appleConfig = {
  seed: 0xa9920208,
  bounds: { x: cx - rx - 8, y: cy - ry - 8, width: rx * 2 + 16, height: ry * 2 + 16 },
  mask: appleMask,
  tone: appleTone,
  direction: appleDirection,
  families: [
    {
      name: "massing",
      field: "primary",
      minTone: 0.055,
      spacingLight: 8.6,
      spacingDark: 4.8,
      seedStep: 3.6,
      step: 2.8,
      minLength: 24,
      maxLength: 300,
      maxTurn: 0.31,
    },
    {
      name: "massingCross",
      field: "cross",
      minTone: 0.22,
      spacingLight: 10.5,
      spacingDark: 5.5,
      seedStep: 4,
      step: 2.7,
      minLength: 24,
      maxLength: 235,
      maxTurn: 0.31,
    },
    {
      name: "primary",
      field: "primary",
      minTone: 0.075,
      spacingLight: 14,
      spacingDark: 7.2,
      seedStep: 5.2,
      step: 2.45,
      minLength: 28,
      maxLength: 285,
      maxTurn: 0.29,
    },
    {
      name: "cross",
      field: "cross",
      minTone: 0.34,
      spacingLight: 13.5,
      spacingDark: 7.2,
      seedStep: 5.2,
      step: 2.4,
      minLength: 22,
      maxLength: 220,
      maxTurn: 0.31,
    },
    {
      name: "deep",
      field: "deep",
      minTone: 0.63,
      spacingLight: 10,
      spacingDark: 5.8,
      seedStep: 4.3,
      step: 2.25,
      minLength: 16,
      maxLength: 150,
      maxTurn: 0.33,
    },
  ],
};

function shadowSample(x, y) {
  const rotation = 0.08;
  const dx = x - 515;
  const dy = y - 697;
  const localX = dx * Math.cos(rotation) + dy * Math.sin(rotation);
  const localY = -dx * Math.sin(rotation) + dy * Math.cos(rotation);
  const radial = (localX / 270) ** 2 + (localY / 63) ** 2;
  return { localX, localY, radial };
}

const shadowConfig = {
  seed: 0x5ad0208,
  bounds: { x: 245, y: 630, width: 550, height: 145 },
  mask: (x, y) => shadowSample(x, y).radial < 1,
  tone: (x, y) => {
    const { localX, radial } = shadowSample(x, y);
    const falloff = Math.max(0, 1 - radial);
    const contactBias = Math.exp(-(((localX + 62) / 125) ** 2));
    return clamp(0.11 + falloff ** 1.45 * (0.5 + contactBias * 0.38), 0, 0.88);
  },
  direction: (x, y, family) => (family.field === "contact" ? -0.17 : 0.045) + (y - 697) * 0.0006,
  families: [
    {
      name: "shadow",
      field: "ground",
      minTone: 0.12,
      spacingLight: 13,
      spacingDark: 6.5,
      seedStep: 5.2,
      step: 3,
      minLength: 24,
      maxLength: 270,
      maxTurn: 0.22,
    },
    {
      name: "contact",
      field: "contact",
      minTone: 0.56,
      spacingLight: 9,
      spacingDark: 5,
      seedStep: 4,
      step: 2.6,
      minLength: 18,
      maxLength: 170,
      maxTurn: 0.24,
    },
  ],
};

const appleHatching = generateFieldHatching(appleConfig);
const shadowHatching = generateFieldHatching(shadowConfig);

function summarizeAngles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
  return {
    samples: sorted.length,
    medianDegrees: at(0.5) * 180 / Math.PI,
    p95Degrees: at(0.95) * 180 / Math.PI,
    maxDegrees: (sorted.at(-1) ?? 0) * 180 / Math.PI,
  };
}

const primaryCrossAngles = [];
const primaryDeepAngles = [];
const crossDeepAngles = [];
for (let y = cy - ry; y <= cy + ry; y += 12) {
  for (let x = cx - rx; x <= cx + rx; x += 12) {
    if (!appleMask(x, y)) continue;
    const tone = appleTone(x, y);
    if (tone >= 0.34) {
      primaryCrossAngles.push(axisSeparation(
        appleDirection(x, y, { field: "primary" }),
        appleDirection(x, y, { field: "cross" }),
      ));
    }
    if (tone >= 0.63) {
      const primary = appleDirection(x, y, { field: "primary" });
      const cross = appleDirection(x, y, { field: "cross" });
      const deep = appleDirection(x, y, { field: "deep" });
      primaryDeepAngles.push(axisSeparation(primary, deep));
      crossDeepAngles.push(axisSeparation(cross, deep));
    }
  }
}
const crossingAngleStats = {
  primaryCross: summarizeAngles(primaryCrossAngles),
  primaryDeep: summarizeAngles(primaryDeepAngles),
  crossDeep: summarizeAngles(crossDeepAngles),
};
for (const [pair, stats] of Object.entries(crossingAngleStats)) {
  if (stats.p95Degrees >= 70) {
    throw new Error(`${pair} hatching is too close to perpendicular: p95=${stats.p95Degrees.toFixed(1)} degrees`);
  }
}

const familyStyles = {
  massing: {
    layerId: LAYERS.mass,
    color: "#625e57",
    brush: ROUGH_PENCIL,
    size: 14,
    toneSize: 4,
    opacity: 0.25,
    toneOpacity: 0.23,
    minOpacity: 0.22,
    maxOpacity: 0.5,
    gestureMin: 1000,
    gestureMax: 1000,
    wobble: 0.38,
    pressure: 0.74,
    taperFloor: 0.68,
  },
  massingCross: {
    layerId: LAYERS.mass,
    color: "#625e57",
    brush: ROUGH_PENCIL,
    size: 10,
    toneSize: 3,
    opacity: 0.12,
    toneOpacity: 0.2,
    minOpacity: 0.1,
    maxOpacity: 0.34,
    gestureMin: 1000,
    gestureMax: 1000,
    wobble: 0.34,
    pressure: 0.7,
    taperFloor: 0.55,
  },
  primary: {
    layerId: LAYERS.primary,
    color: GRAPHITE,
    brush: TRADITIONAL_PENCIL,
    size: 5.5,
    toneSize: 1.5,
    opacity: 0.5,
    toneOpacity: 0.24,
    minOpacity: 0.46,
    maxOpacity: 0.76,
    gestureMin: 44,
    gestureMax: 112,
    wobble: 0.32,
    pressure: 0.76,
  },
  cross: {
    layerId: LAYERS.cross,
    color: "#47443f",
    brush: PENCIL,
    size: 4.2,
    toneSize: 1,
    opacity: 0.34,
    toneOpacity: 0.24,
    minOpacity: 0.3,
    maxOpacity: 0.62,
    gestureMin: 34,
    gestureMax: 86,
    wobble: 0.27,
    pressure: 0.76,
  },
  deep: {
    layerId: LAYERS.cross,
    color: "#383632",
    brush: TRADITIONAL_PENCIL,
    size: 6.5,
    toneSize: 1.4,
    opacity: 0.52,
    toneOpacity: 0.26,
    minOpacity: 0.48,
    maxOpacity: 0.82,
    gestureMin: 25,
    gestureMax: 65,
    wobble: 0.23,
    pressure: 0.8,
  },
  shadow: {
    layerId: LAYERS.shadow,
    color: "#55514b",
    brush: ROUGH_PENCIL,
    size: 9.5,
    toneSize: 3,
    opacity: 0.24,
    toneOpacity: 0.22,
    minOpacity: 0.2,
    maxOpacity: 0.5,
    gestureMin: 55,
    gestureMax: 150,
    wobble: 0.42,
    pressure: 0.72,
    taperFloor: 0.48,
  },
  contact: {
    layerId: LAYERS.shadow,
    color: "#393733",
    brush: TRADITIONAL_PENCIL,
    size: 5.5,
    toneSize: 1.5,
    opacity: 0.5,
    toneOpacity: 0.24,
    minOpacity: 0.46,
    maxOpacity: 0.76,
    gestureMin: 36,
    gestureMax: 95,
    wobble: 0.28,
    pressure: 0.79,
    taperFloor: 0.42,
  },
};

function nativeStroke(layerId, points, {
  color = GRAPHITE,
  size = 1.2,
  opacity = 0.28,
  brush = TRADITIONAL_PENCIL,
  seed = 20_800_000,
} = {}) {
  return {
    method: "draw.stroke",
    params: {
      layerId,
      tool: "brush",
      color,
      size: size * 4.2,
      opacity,
      points: points.map((point, index) => ({
        x: point.x,
        y: point.y,
        pressure: clamp(point.pressure ?? (0.24 + Math.sin((index / Math.max(1, points.length - 1)) * Math.PI) * 0.7), 0.06, 1),
      })),
      brushPresetId: brush.id,
      brush,
      seed,
      strokeVersion: 2,
    },
  };
}

let manualSeed = 20_800_000;

function outlinePoint(theta, inset = 0) {
  const radius = boundaryRadius(theta) - inset;
  return { x: cx + Math.cos(theta) * rx * radius, y: cy + Math.sin(theta) * ry * radius };
}

function outlineArc(start, end, count = 32, inset = 0) {
  const points = [];
  for (let index = 0; index <= count; index++) {
    const theta = start + (end - start) * (index / count);
    points.push(outlinePoint(theta, inset));
  }
  return points;
}

function quadratic(start, control, end, count = 18) {
  const points = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const inv = 1 - t;
    points.push({
      x: inv * inv * start[0] + 2 * inv * t * control[0] + t * t * end[0],
      y: inv * inv * start[1] + 2 * inv * t * control[1] + t * t * end[1],
    });
  }
  return points;
}

function crossContour(y, bow, count = 34) {
  let left = cx;
  let right = cx;
  for (let x = cx; x > cx - rx * 1.15; x -= 1) {
    if (!appleMask(x, y)) { left = x + 1; break; }
  }
  for (let x = cx; x < cx + rx * 1.15; x += 1) {
    if (!appleMask(x, y)) { right = x - 1; break; }
  }
  const points = [];
  for (let index = 0; index <= count; index++) {
    const unit = index / count;
    points.push({ x: left + (right - left) * unit, y: y + Math.sin(unit * Math.PI) * bow });
  }
  return points;
}

const setup = [
  { method: "layer.create", params: { layerId: LAYERS.paper, name: "APPLE V4 00 // FRESH PAPER" } },
  { method: "draw.rect", params: { layerId: LAYERS.paper, x: 0, y: 0, w: W, h: H, fill: PAPER, stroke: PAPER, strokeWidth: 1 } },
  { method: "layer.create", params: { layerId: LAYERS.shadow, name: "APPLE V4 01 // CAST SHADOW STREAMLINES" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.shadow, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.construction, name: "APPLE V4 02 // LANDMARKS AND CROSS-CONTOURS" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.construction, blendMode: "multiply" } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.construction, opacity: 0.44 } },
  { method: "layer.create", params: { layerId: LAYERS.mass, name: "APPLE V4 03 // COARSE VALUE MASS" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.mass, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.primary, name: "APPLE V4 04 // EVEN PRIMARY STREAMLINES" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.primary, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.cross, name: "APPLE V4 05 // VALUE-GATED CROSSHATCH" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.cross, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.edges, name: "APPLE V4 06 // EDGE HIERARCHY AND STEM" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.edges, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.lights, name: "APPLE V4 07 // ERASER LIGHTS" } },
];

const construction = [
  nativeStroke(LAYERS.construction, outlineArc(-Math.PI, Math.PI, 220), { color: "#777168", size: 1.05, opacity: 0.2, seed: manualSeed++ }),
  nativeStroke(LAYERS.construction, quadratic([449, 292], [438, 465], [442, 679], 30), { color: "#817a71", size: 0.85, opacity: 0.13, seed: manualSeed++ }),
  nativeStroke(LAYERS.construction, crossContour(374, 18), { color: "#817a71", size: 0.8, opacity: 0.12, seed: manualSeed++ }),
  nativeStroke(LAYERS.construction, crossContour(486, 22), { color: "#817a71", size: 0.8, opacity: 0.11, seed: manualSeed++ }),
  nativeStroke(LAYERS.construction, crossContour(595, 16), { color: "#817a71", size: 0.8, opacity: 0.1, seed: manualSeed++ }),
  nativeStroke(LAYERS.construction, quadratic([451, 296], [460, 248], [471, 209], 18), { color: "#6d6861", size: 0.95, opacity: 0.2, seed: manualSeed++ }),
  nativeStroke(LAYERS.construction, outlineArc(-0.05, Math.PI * 1.98, 70).map((point, index) => ({
    x: 515 + (point.x - cx) * 1.22,
    y: 697 + (point.y - cy) * 0.29 + Math.sin(index / 70 * Math.PI) * 3,
  })), { color: "#817a71", size: 0.75, opacity: 0.09, seed: manualSeed++ }),
];

const massOps = streamlinesToStrokeOperations([
  ...appleHatching.byFamily.massing,
  ...appleHatching.byFamily.massingCross,
], familyStyles, { seed: 0x3101, strokeSeed: 21_000_000 });
const primaryOps = streamlinesToStrokeOperations(appleHatching.byFamily.primary, familyStyles, { seed: 0x3102, strokeSeed: 21_100_000 });
const crossOps = streamlinesToStrokeOperations(appleHatching.byFamily.cross, familyStyles, { seed: 0x3103, strokeSeed: 21_200_000 });
const deepOps = streamlinesToStrokeOperations(appleHatching.byFamily.deep, familyStyles, { seed: 0x3104, strokeSeed: 21_300_000 });
const shadowOps = streamlinesToStrokeOperations([
  ...shadowHatching.byFamily.shadow,
  ...shadowHatching.byFamily.contact,
], familyStyles, { seed: 0x3201, strokeSeed: 21_400_000 });

const edges = [
  nativeStroke(LAYERS.edges, outlineArc(-1.32, -0.28, 30), { color: "#444444", size: 1.05, opacity: 0.24, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, outlineArc(-0.2, 1.18, 42), { color: DARK, size: 1.45, opacity: 0.39, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, outlineArc(1.08, 2.18, 34), { color: "#353535", size: 1.3, opacity: 0.34, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, outlineArc(2.12, 2.78, 22), { color: "#555555", size: 0.95, opacity: 0.2, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, outlineArc(-2.78, -2.3, 16), { color: "#626262", size: 0.75, opacity: 0.12, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, outlineArc(-2.18, -1.79, 18), { color: "#4e4e4e", size: 0.92, opacity: 0.2, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, outlineArc(-1.4, -1.04, 17), { color: "#404040", size: 1.05, opacity: 0.25, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, quadratic([415, 286], [449, 315], [486, 282], 20), { color: "#373737", size: 1.35, opacity: 0.38, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, quadratic([432, 293], [451, 308], [473, 289], 16), { color: "#2d2d2d", size: 1.2, opacity: 0.42, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, quadratic([450, 296], [458, 249], [469, 209], 20), { color: "#343434", size: 3.7, opacity: 0.48, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, quadratic([455, 295], [465, 251], [476, 211], 20), { color: "#5d5d5d", size: 1.35, opacity: 0.45, seed: manualSeed++ }),
  nativeStroke(LAYERS.edges, quadratic([469, 209], [475, 202], [481, 209], 8), { color: "#303030", size: 1.25, opacity: 0.4, seed: manualSeed++ }),
];

const detailRng = createRng(0xed6e0208);
for (let index = 0; index < 72; index++) {
  const theta = -Math.PI / 2 + (detailRng() * 2 - 1) * 0.68;
  const radius = 20 + detailRng() * 68;
  const x = 452 + Math.cos(theta + Math.PI / 2) * radius;
  const y = 296 + Math.sin(theta + Math.PI / 2) * radius * 0.32;
  if (!appleMask(x, y)) continue;
  const direction = Math.atan2(y - 296, x - 452) + (detailRng() * 2 - 1) * 0.16;
  const length = 7 + detailRng() * 18;
  const points = [];
  for (let step = 0; step <= 5; step++) {
    const unit = step / 5;
    points.push({
      x: x + Math.cos(direction) * (unit - 0.5) * length,
      y: y + Math.sin(direction) * (unit - 0.5) * length,
    });
  }
  if (points.every((point) => appleMask(point.x, point.y))) {
    edges.push(nativeStroke(LAYERS.edges, points, {
      color: "#444444",
      size: 0.62 + detailRng() * 0.5,
      opacity: 0.12 + detailRng() * 0.19,
      seed: manualSeed++,
    }));
  }
}

const lights = [];
const lightRng = createRng(0x11a70208);
for (let index = 0; index < 52; index++) {
  const x = 342 + (lightRng() * 2 - 1) * 64;
  const y = 360 + (lightRng() * 2 - 1) * 92;
  if (!appleMask(x, y)) continue;
  const angle = appleDirection(x, y, { field: "primary" });
  const length = 18 + lightRng() * 48;
  const points = [];
  for (let step = 0; step <= 7; step++) {
    const unit = step / 7;
    points.push({
      x: x + Math.cos(angle) * (unit - 0.5) * length,
      y: y + Math.sin(angle) * (unit - 0.5) * length,
    });
  }
  if (points.every((point) => appleMask(point.x, point.y))) {
    lights.push(nativeStroke(LAYERS.lights, points, {
      color: lightRng() < 0.3 ? "#faf7ef" : PAPER,
      size: 1.6 + lightRng() * 2.6,
      opacity: 0.2 + lightRng() * 0.36,
      seed: manualSeed++,
    }));
  }
}

const finish = [
  { method: "layer.setVisible", params: { layerId: LAYERS.construction, visible: false } },
  { method: "layer.setActive", params: { layerId: LAYERS.edges } },
];

function validate(operation) {
  const definition = METHODS[operation.method];
  if (!definition) throw new Error(`Unknown method ${operation.method}`);
  definition.params?.parse(operation.params);
  if (operation.method === "draw.batch") {
    for (const nested of operation.params.operations) validate(nested);
  }
}

async function writeJsonl(filename, operations) {
  for (const operation of operations) validate(operation);
  await writeFile(`${OUTPUT_DIR}${filename}`, `${operations.map((operation) => JSON.stringify(operation)).join("\n")}\n`);
}

async function writeBatched(filename, operations) {
  const batches = batchOperations(operations, BATCH_SIZE);
  await writeJsonl(filename, batches);
  return batches.length;
}

await writeJsonl("pass-00-setup.jsonl", setup);
await writeJsonl("pass-01-construction.jsonl", construction);
const batchCounts = {
  shadow: await writeBatched("pass-02-shadow.jsonl", shadowOps),
  mass: await writeBatched("pass-03-mass.jsonl", massOps),
  primary: await writeBatched("pass-04-primary.jsonl", primaryOps),
  cross: await writeBatched("pass-05-cross.jsonl", crossOps),
  deep: await writeBatched("pass-06-deep.jsonl", deepOps),
  edges: await writeBatched("pass-07-edges.jsonl", edges),
  lights: await writeBatched("pass-08-lights.jsonl", lights),
};
await writeJsonl("pass-09-finish.jsonl", finish);

const passCounts = {
  setup: setup.length,
  construction: construction.length,
  shadow: shadowOps.length,
  mass: massOps.length,
  primary: primaryOps.length,
  cross: crossOps.length,
  deep: deepOps.length,
  edges: edges.length,
  lights: lights.length,
  finish: finish.length,
};
const nativeStrokeCount = construction.length + shadowOps.length + massOps.length + primaryOps.length + crossOps.length + deepOps.length + edges.length + lights.length;

const targetSamples = {
  highlight: appleTone(348, 350),
  light: appleTone(365, 430),
  halftone: appleTone(455, 430),
  coreShadow: appleTone(575, 470),
  reflectedRim: appleTone(635, 500),
  contact: appleTone(450, 665),
};

await writeFile(`${OUTPUT_DIR}manifest.json`, `${JSON.stringify({
  title: "Apple V4 — continuous textured field-hatching study",
  canvas: { width: W, height: H },
  deterministicSeeds: {
    appleField: "0xa9920208",
    shadowField: "0x05ad0208",
    edges: "0xed6e0208",
    lights: "0x11a70208",
  },
  method: [
    "asymmetric polar apple silhouette with top notch and unequal lobes",
    "deformed ellipsoid height field with numerical surface normals",
    "upper-left Lambertian key, dimple/contact occlusion and restrained reflected rim",
    "midpoint-integrated, spatially rejected streamlines with tone-dependent spacing",
    "coarse-to-fine massing, primary, cross and deep hatch families",
    "selective contour hierarchy, tapered pressure and paper-coloured eraser strokes",
  ],
  researchBorrowed: [
    "Lu-Xu-Jia sketch/tone separation",
    "Hertzmann coarse-to-fine curved strokes",
    "Jobard-Lefer evenly spaced streamline placement",
    "p5.brush vector-field and shape-clipped hatching concepts",
  ],
  provenance: "No raster or generated image is imported. The apple, hatching, cast shadow, stem, edges and lights are all auditable native draw.stroke operations; paper is one draw.rect.",
  hatchLineCounts: Object.fromEntries(Object.entries(appleHatching.byFamily).map(([name, lines]) => [name, lines.length])),
  shadowLineCounts: Object.fromEntries(Object.entries(shadowHatching.byFamily).map(([name, lines]) => [name, lines.length])),
  targetSamples,
  crossingAngleStats,
  passCounts,
  batchCounts,
  nativeStrokeCount,
}, null, 2)}\n`);

await writeFile(`${OUTPUT_DIR}PROCESS.md`, `# Apple V4 process\n\n- 00 Fresh paper and named layers.\n- 01 Landmarks, asymmetric silhouette, axis, cross-contours and shadow envelope.\n- 02 Even ground/contact shadow streamlines.\n- 03 Continuous rough-pencil side-strokes with a raised pressure floor, judged blurred before detail.\n- 04 Even traditional-pencil streamlines following the surface field.\n- 05 Value-gated pencil cross-hatch only above the halftone threshold.\n- 06 Third family only in deep shadow.\n- 07 Selective edges, dimple convergence and stem cylinder.\n- 08 Paper-coloured pencil lifts.\n- 09 Hide construction while preserving its layer.\n\nNo image generation or raster import is used. Every visible graphite mark is a native paint-web stroke with an embedded immutable brush preset.\n`);

console.log(JSON.stringify({
  hatchLineCounts: Object.fromEntries(Object.entries(appleHatching.byFamily).map(([name, lines]) => [name, lines.length])),
  shadowLineCounts: Object.fromEntries(Object.entries(shadowHatching.byFamily).map(([name, lines]) => [name, lines.length])),
  passCounts,
  batchCounts,
  nativeStrokeCount,
  targetSamples,
  crossingAngleStats,
}, null, 2));
