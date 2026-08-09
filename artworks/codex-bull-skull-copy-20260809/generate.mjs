import { mkdir, writeFile } from "node:fs/promises";

import { METHODS } from "../../dist-cli/shared/protocol.js";
import { getByNameOrId } from "../../dist-cli/src/brush/BrushPresets.js";
import {
  axisSeparation,
  clamp,
  createRng,
  generateFieldHatching,
  streamlinesToStrokeOperations,
} from "../../skills/sketch-foundations/scripts/field-hatching.mjs";

const OUTPUT_DIR = new URL("./", import.meta.url).pathname;
await mkdir(OUTPUT_DIR, { recursive: true });

const W = 900;
const H = 938;
const PAPER = "#ddd9d1";
const PAPER_LIGHT = "#eeeae2";
const GRAPHITE = "#4b4945";
const MID = "#67635d";
const DARK = "#2d2c2a";
const DEEP = "#1f1e1d";

const PENCIL = getByNameOrId("铅笔");
const CHARCOAL = getByNameOrId("木炭") ?? PENCIL;
const GRAPHITE_BRUSH = getByNameOrId("石墨") ?? PENCIL;

const LAYERS = {
  paper: "L_bs9_paper01",
  ground: "L_bs9_ground01",
  ornament: "L_bs9_ornament01",
  construction: "L_bs9_construct01",
  shadow: "L_bs9_shadow01",
  horns: "L_bs9_horns01",
  skull: "L_bs9_skull01",
  hatch: "L_bs9_hatch01",
  details: "L_bs9_details01",
  lights: "L_bs9_lights01",
};

const CONE_LAYERS = [
  "L_cn8_paper01",
  "L_cn8_construct01",
  "L_cn8_shadow01",
  "L_cn8_values01",
  "L_cn8_primary01",
  "L_cn8_cross01",
  "L_cn8_edges01",
  "L_cn8_lights01",
];

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(1e-9, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      (pi.y > y) !== (pj.y > y)
      && x < ((pj.x - pi.x) * (y - pi.y)) / ((pj.y - pi.y) || 1e-9) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function gaussian(x, y, cx, cy, rx, ry) {
  return Math.exp(-(
    ((x - cx) * (x - cx)) / (2 * rx * rx)
    + ((y - cy) * (y - cy)) / (2 * ry * ry)
  ));
}

function ellipsePoints(cx, cy, rx, ry, start = 0, end = Math.PI * 2, count = 64) {
  const points = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const angle = start + (end - start) * t;
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return points;
}

function cubicPoints(p0, p1, p2, p3, count = 48) {
  const points = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const mt = 1 - t;
    points.push({
      x: mt ** 3 * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * p3.y,
    });
  }
  return points;
}

function joinCurves(...curves) {
  return curves.flatMap((curve, index) => index === 0 ? curve : curve.slice(1));
}

function handPolyline(points, seed, wobble = 0.28) {
  const rng = createRng(seed);
  const phase = rng() * Math.PI * 2;
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    const t = points.length <= 1 ? 0 : index / (points.length - 1);
    const taper = 0.2 + Math.sin(t * Math.PI) * 0.72;
    const displacement = (
      Math.sin(t * 9.3 + phase) * wobble
      + Math.sin(t * 3.1 + phase * 0.63) * wobble * 0.42
      + (rng() - 0.5) * wobble * 0.22
    );
    return {
      x: point.x + nx * displacement,
      y: point.y + ny * displacement,
      pressure: clamp(taper, 0.1, 0.94),
    };
  });
}

function handLine(a, b, seed, count = 28, bow = 0.3) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.max(1e-9, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  const rng = createRng(seed);
  const phase = rng() * Math.PI * 2;
  const points = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const taper = 0.18 + Math.sin(t * Math.PI) * 0.74;
    const displacement = Math.sin(t * Math.PI) * (
      Math.sin(t * 7.2 + phase) * bow
      + Math.sin(t * 2.4 + phase * 0.7) * bow * 0.35
    );
    points.push({
      x: a.x + dx * t + nx * displacement,
      y: a.y + dy * t + ny * displacement,
      pressure: clamp(taper, 0.08, 0.95),
    });
  }
  return points;
}

let manualSeed = 90_900_000;
function stroke(layerId, points, {
  color = GRAPHITE,
  size = 0.9,
  opacity = 0.35,
  brush = null,
} = {}) {
  const seed = manualSeed++;
  return {
    method: "draw.stroke",
    params: {
      layerId,
      tool: "brush",
      color,
      size,
      opacity,
      points,
      ...(brush ? { brushPresetId: brush.id, brush } : {}),
      seed,
      strokeVersion: 2,
    },
  };
}

function lineStroke(layerId, a, b, options = {}) {
  return stroke(
    layerId,
    handLine(a, b, manualSeed, options.count ?? 28, options.bow ?? 0.28),
    options,
  );
}

function curveStroke(layerId, points, options = {}) {
  return stroke(
    layerId,
    handPolyline(points, manualSeed, options.wobble ?? 0.28),
    options,
  );
}

function scalePolygon(polygon, cx, cy, scaleX, scaleY = scaleX) {
  return polygon.map((point) => ({
    x: cx + (point.x - cx) * scaleX,
    y: cy + (point.y - cy) * scaleY,
  }));
}

function polygonCommands(polygon) {
  return [
    { op: "M", x: polygon[0].x, y: polygon[0].y },
    ...polygon.slice(1).map((point) => ({ op: "L", x: point.x, y: point.y })),
    { op: "Z" },
  ];
}

const skullOutline = [
  { x: 450, y: 270 },
  { x: 411, y: 277 },
  { x: 371, y: 289 },
  { x: 335, y: 306 },
  { x: 305, y: 333 },
  { x: 294, y: 367 },
  { x: 302, y: 405 },
  { x: 319, y: 438 },
  { x: 329, y: 480 },
  { x: 340, y: 523 },
  { x: 354, y: 566 },
  { x: 369, y: 611 },
  { x: 382, y: 657 },
  { x: 386, y: 702 },
  { x: 386, y: 750 },
  { x: 398, y: 798 },
  { x: 420, y: 824 },
  { x: 447, y: 830 },
  { x: 456, y: 808 },
  { x: 465, y: 831 },
  { x: 491, y: 824 },
  { x: 508, y: 794 },
  { x: 514, y: 748 },
  { x: 516, y: 699 },
  { x: 528, y: 654 },
  { x: 541, y: 612 },
  { x: 553, y: 565 },
  { x: 567, y: 519 },
  { x: 575, y: 475 },
  { x: 593, y: 435 },
  { x: 604, y: 397 },
  { x: 607, y: 360 },
  { x: 593, y: 329 },
  { x: 565, y: 305 },
  { x: 531, y: 288 },
  { x: 493, y: 277 },
];

const leftSocket = [
  { x: 324, y: 421 }, { x: 344, y: 404 }, { x: 373, y: 405 },
  { x: 392, y: 427 }, { x: 389, y: 458 }, { x: 372, y: 486 },
  { x: 346, y: 482 }, { x: 329, y: 460 },
];
const rightSocket = [
  { x: 514, y: 418 }, { x: 535, y: 399 }, { x: 561, y: 397 },
  { x: 583, y: 418 }, { x: 581, y: 450 }, { x: 563, y: 477 },
  { x: 537, y: 477 }, { x: 519, y: 453 },
];
const leftNasal = [
  { x: 397, y: 628 }, { x: 421, y: 647 }, { x: 435, y: 686 },
  { x: 433, y: 742 }, { x: 421, y: 793 }, { x: 402, y: 780 },
  { x: 394, y: 728 },
];
const rightNasal = [
  { x: 476, y: 645 }, { x: 500, y: 625 }, { x: 510, y: 681 },
  { x: 506, y: 740 }, { x: 492, y: 792 }, { x: 473, y: 807 },
  { x: 465, y: 742 },
];

function skullMask(x, y) {
  return pointInPolygon(x, y, skullOutline);
}

function skullTone(x, y) {
  if (!skullMask(x, y)) return 0;
  const v = clamp((y - 270) / 560);
  const u = clamp((x - 451) / (165 - v * 85), -1.2, 1.2);
  let darkness = 0.2 + Math.abs(u) * 0.23 + v * 0.06;
  darkness += gaussian(x, y, 341, 448, 48, 55) * 0.42;
  darkness += gaussian(x, y, 554, 445, 46, 53) * 0.38;
  darkness += gaussian(x, y, 412, 710, 28, 88) * 0.48;
  darkness += gaussian(x, y, 490, 710, 27, 88) * 0.52;
  darkness += gaussian(x, y, 310, 375, 38, 75) * 0.16;
  darkness += gaussian(x, y, 596, 372, 34, 72) * 0.19;
  darkness -= gaussian(x, y, 457, 495, 46, 230) * 0.2;
  darkness -= gaussian(x, y, 395, 355, 53, 72) * 0.08;
  darkness += smoothstep(0.78, 1, v) * 0.09;
  return clamp(darkness, 0.1, 0.9);
}

function skullPrimaryAngle(x, y) {
  const v = clamp((y - 270) / 560);
  const halfWidth = Math.max(65, 165 - v * 82);
  const u = clamp((x - 451) / halfWidth, -1, 1);
  return Math.PI / 2 - u * (0.18 + v * 0.1);
}

const skullCrossOffset = 0.69;
const skullConfig = {
  seed: 0xb5110001,
  bounds: { x: 287, y: 266, width: 326, height: 572 },
  mask: skullMask,
  tone: skullTone,
  direction: (x, y, family) => {
    const primary = skullPrimaryAngle(x, y);
    return family.name === "skullCross" ? primary - skullCrossOffset : primary;
  },
  families: [
    {
      name: "skullPrimary",
      angle: Math.PI / 2,
      minTone: 0.1,
      spacingLight: 12.2,
      spacingDark: 5.6,
      seedStep: 4.8,
      step: 2.4,
      minLength: 28,
      maxLength: 250,
      maxLines: 92,
      maxTurn: 0.18,
      clearanceFactor: 0.76,
    },
    {
      name: "skullCross",
      role: "cross",
      angleAgainst: "skullPrimary",
      minTone: 0.44,
      spacingLight: 11.5,
      spacingDark: 5.9,
      seedStep: 5.1,
      step: 2.4,
      minLength: 22,
      maxLength: 150,
      maxLines: 58,
      maxTurn: 0.2,
      clearanceFactor: 0.78,
    },
  ],
  anglePolicy: {
    medianMinDeg: 25,
    medianMaxDeg: 55,
    localMaxDeg: 70,
    sampleColumns: 13,
    sampleRows: 15,
  },
};

const shadowPolygon = [
  { x: 20, y: 245 }, { x: 318, y: 246 }, { x: 347, y: 324 },
  { x: 330, y: 420 }, { x: 367, y: 548 }, { x: 402, y: 748 },
  { x: 375, y: 850 }, { x: 18, y: 850 },
];

function shadowMask(x, y) {
  return pointInPolygon(x, y, shadowPolygon) && !skullMask(x, y);
}

const shadowPrimaryAngle = 0.14;
const shadowCrossAngle = 0.72;
const shadowConfig = {
  seed: 0xb5110002,
  bounds: { x: 16, y: 240, width: 390, height: 618 },
  mask: shadowMask,
  tone: (x, y) => {
    const near = clamp(1 - Math.abs(x - (340 + (y - 420) * 0.09)) / 330);
    const lowerFade = 1 - smoothstep(700, 860, y) * 0.22;
    return clamp(0.23 + near * 0.42, 0.2, 0.74) * lowerFade;
  },
  direction: (_x, _y, family) => family.angle,
  families: [
    {
      name: "shadowPrimary",
      angle: shadowPrimaryAngle,
      minTone: 0.2,
      spacingLight: 13.5,
      spacingDark: 7.2,
      seedStep: 5.4,
      step: 2.8,
      minLength: 45,
      maxLength: 290,
      maxLines: 58,
      maxTurn: 0.12,
      clearanceFactor: 0.78,
    },
    {
      name: "shadowCross",
      role: "cross",
      angleAgainst: "shadowPrimary",
      angle: shadowCrossAngle,
      minTone: 0.56,
      spacingLight: 12.5,
      spacingDark: 7.2,
      seedStep: 5.5,
      step: 2.8,
      minLength: 32,
      maxLength: 190,
      maxLines: 20,
      maxTurn: 0.12,
      clearanceFactor: 0.8,
    },
  ],
  anglePolicy: {
    medianMinDeg: 25,
    medianMaxDeg: 55,
    localMaxDeg: 70,
    sampleColumns: 11,
    sampleRows: 11,
  },
};

const skullField = generateFieldHatching(skullConfig);
const shadowField = generateFieldHatching(shadowConfig);

const leftHornCenter = joinCurves(
  cubicPoints({ x: 323, y: 327 }, { x: 253, y: 330 }, { x: 151, y: 302 }, { x: 104, y: 220 }, 34),
  cubicPoints({ x: 104, y: 220 }, { x: 78, y: 171 }, { x: 85, y: 103 }, { x: 111, y: 58 }, 30),
);
const rightHornCenter = joinCurves(
  cubicPoints({ x: 579, y: 326 }, { x: 661, y: 329 }, { x: 758, y: 292 }, { x: 804, y: 219 }, 34),
  cubicPoints({ x: 804, y: 219 }, { x: 832, y: 165 }, { x: 829, y: 102 }, { x: 809, y: 55 }, 30),
);

function hornRadius(t, side) {
  const base = side === "left" ? 39 : 37;
  return 4 + base * Math.pow(1 - t, 0.72);
}

function offsetHorn(centerline, offset, side, startIndex = 0, endIndex = centerline.length - 1) {
  const points = [];
  for (let index = startIndex; index <= endIndex; index++) {
    const previous = centerline[Math.max(0, index - 1)];
    const next = centerline[Math.min(centerline.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    const t = index / (centerline.length - 1);
    const radius = hornRadius(t, side);
    points.push({
      x: centerline[index].x + nx * radius * offset,
      y: centerline[index].y + ny * radius * offset,
    });
  }
  return points;
}

const setup = [
  { method: "layer.create", params: { layerId: LAYERS.paper, name: "BULL SKULL 00 // GRAPHITE PAPER" } },
  { method: "draw.rect", params: { layerId: LAYERS.paper, x: 0, y: 0, w: W, h: H, fill: PAPER, stroke: PAPER, strokeWidth: 1 } },
  { method: "layer.create", params: { layerId: LAYERS.ground, name: "BULL SKULL 01 // WALL GRAIN" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.ground, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.ornament, name: "BULL SKULL 02 // CARVED FRIEZE" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.ornament, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.construction, name: "BULL SKULL 03 // LANDMARK CONSTRUCTION" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.construction, blendMode: "multiply" } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.construction, opacity: 0.58 } },
  { method: "layer.create", params: { layerId: LAYERS.shadow, name: "BULL SKULL 04 // WALL AND CONTACT SHADOW" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.shadow, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.horns, name: "BULL SKULL 05 // HORN MASSES" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.horns, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.skull, name: "BULL SKULL 06 // BONE VALUE MASSES" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.skull, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.hatch, name: "BULL SKULL 07 // FORM HATCHING" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.hatch, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.details, name: "BULL SKULL 08 // SOCKETS SUTURES AND STUDS" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.details, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.lights, name: "BULL SKULL 09 // BONE AND CARVING LIFTS" } },
  ...CONE_LAYERS.map((layerId) => ({ method: "layer.delete", params: { layerId } })),
  { method: "layer.setActive", params: { layerId: LAYERS.construction } },
];

const construction = [
  lineStroke(LAYERS.construction, { x: 450, y: 150 }, { x: 450, y: 860 }, { color: "#77736c", size: 0.7, opacity: 0.28, bow: 0.08 }),
  lineStroke(LAYERS.construction, { x: 42, y: 130 }, { x: 858, y: 130 }, { color: "#827d75", size: 0.62, opacity: 0.24, bow: 0.06 }),
  curveStroke(LAYERS.construction, skullOutline, { color: "#716c65", size: 0.76, opacity: 0.34, wobble: 0.12 }),
  curveStroke(LAYERS.construction, leftHornCenter, { color: "#77726b", size: 0.68, opacity: 0.3, wobble: 0.12 }),
  curveStroke(LAYERS.construction, rightHornCenter, { color: "#77726b", size: 0.68, opacity: 0.3, wobble: 0.12 }),
  curveStroke(LAYERS.construction, offsetHorn(leftHornCenter, -1, "left"), { color: "#8a857d", size: 0.55, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, offsetHorn(leftHornCenter, 1, "left"), { color: "#8a857d", size: 0.55, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, offsetHorn(rightHornCenter, -1, "right"), { color: "#8a857d", size: 0.55, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, offsetHorn(rightHornCenter, 1, "right"), { color: "#8a857d", size: 0.55, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, leftSocket, { color: "#858078", size: 0.56, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, rightSocket, { color: "#858078", size: 0.56, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, leftNasal, { color: "#858078", size: 0.56, opacity: 0.24, wobble: 0.1 }),
  curveStroke(LAYERS.construction, rightNasal, { color: "#858078", size: 0.56, opacity: 0.24, wobble: 0.1 }),
  lineStroke(LAYERS.construction, { x: 450, y: 171 }, { x: 331, y: 317 }, { color: "#8b867e", size: 0.5, opacity: 0.23, bow: 0.08 }),
  lineStroke(LAYERS.construction, { x: 450, y: 171 }, { x: 575, y: 316 }, { color: "#8b867e", size: 0.5, opacity: 0.23, bow: 0.08 }),
  ...[[73, 448], [70, 620], [72, 788], [827, 462], [824, 628], [820, 790]].map(([cx, cy]) =>
    curveStroke(LAYERS.construction, ellipsePoints(cx, cy, 24, 24, 0, Math.PI * 2, 30), { color: "#8d887f", size: 0.48, opacity: 0.2, wobble: 0.08 })
  ),
];

const backgroundRng = createRng(0xb5111001);
const background = [];
for (let index = 0; index < 78; index++) {
  const y = 135 + index * 10.1 + (backgroundRng() - 0.5) * 5;
  const start = { x: 8 + backgroundRng() * 22, y };
  const end = { x: 892 - backgroundRng() * 20, y: y + (backgroundRng() - 0.5) * 18 };
  background.push(lineStroke(LAYERS.ground, start, end, {
    color: backgroundRng() < 0.22 ? "#716e68" : "#8c8881",
    brush: GRAPHITE_BRUSH,
    size: 2.2 + backgroundRng() * 2.8,
    opacity: 0.015 + backgroundRng() * 0.025,
    bow: 0.45 + backgroundRng() * 0.4,
    count: 64,
  }));
}

const friezeRng = createRng(0xb5111002);
for (let index = 0; index < 42; index++) {
  const y = 4 + index * 2.9 + (friezeRng() - 0.5) * 2.5;
  background.push(lineStroke(LAYERS.ornament, { x: 0, y }, { x: 900, y: y + (friezeRng() - 0.5) * 5 }, {
    color: friezeRng() < 0.3 ? "#292826" : "#3a3936",
    brush: CHARCOAL,
    size: 8 + friezeRng() * 9,
    opacity: 0.1 + friezeRng() * 0.08,
    bow: 0.55,
    count: 72,
  }));
}
background.push(lineStroke(LAYERS.ornament, { x: 0, y: 126 }, { x: 900, y: 126 }, { color: DEEP, size: 4.2, opacity: 0.72, bow: 0.08, count: 72 }));
background.push(lineStroke(LAYERS.ornament, { x: 0, y: 132 }, { x: 900, y: 132 }, { color: "#5d5953", size: 1.1, opacity: 0.5, bow: 0.08, count: 72 }));

// Gate-C correction: the textured charcoal preset is intentionally airy, so
// a second native pass closes the top frieze into the reference's dark mass.
const backgroundDeepenRng = createRng(0xb5111003);
const backgroundDeepen = [];
for (let index = 0; index < 28; index++) {
  const y = 3 + index * 4.35 + (backgroundDeepenRng() - 0.5) * 2.6;
  backgroundDeepen.push(lineStroke(LAYERS.ornament,
    { x: -6, y },
    { x: 906, y: y + (backgroundDeepenRng() - 0.5) * 4 },
    {
      color: index % 5 === 0 ? "#252422" : "#34322f",
      size: 5.2 + backgroundDeepenRng() * 3.6,
      opacity: 0.16 + backgroundDeepenRng() * 0.1,
      bow: 0.42,
      count: 72,
    },
  ));
}

const backgroundConsolidate = [
  {
    method: "draw.rect",
    params: {
      layerId: LAYERS.ornament,
      x: 0,
      y: 0,
      w: W,
      h: 126,
      fill: "#403e3aff",
      stroke: "#403e3aff",
      strokeWidth: 1,
    },
  },
  lineStroke(LAYERS.ornament, { x: 0, y: 126 }, { x: 900, y: 126 }, { color: "#211f1e", size: 3.2, opacity: 0.74, bow: 0.08, count: 72 }),
];

const resetValueStack = [
  { method: "layer.delete", params: { layerId: LAYERS.shadow } },
  { method: "layer.delete", params: { layerId: LAYERS.horns } },
  { method: "layer.delete", params: { layerId: LAYERS.skull } },
  { method: "layer.delete", params: { layerId: LAYERS.hatch } },
  { method: "layer.delete", params: { layerId: LAYERS.details } },
  { method: "layer.delete", params: { layerId: LAYERS.lights } },
  { method: "layer.create", params: { layerId: LAYERS.shadow, name: "BULL SKULL 04 // WALL AND CONTACT SHADOW" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.shadow, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.horns, name: "BULL SKULL 05 // HORN MASSES" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.horns, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.skull, name: "BULL SKULL 06 // BONE VALUE MASSES" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.skull, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.hatch, name: "BULL SKULL 07 // FORM HATCHING" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.hatch, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.details, name: "BULL SKULL 08 // SOCKETS SUTURES AND STUDS" } },
  { method: "layer.setBlendMode", params: { layerId: LAYERS.details, blendMode: "multiply" } },
  { method: "layer.create", params: { layerId: LAYERS.lights, name: "BULL SKULL 09 // BONE AND CARVING LIFTS" } },
];

const shadowUnderpaint = [
  {
    method: "draw.gradient",
    params: {
      layerId: LAYERS.shadow,
      gradient: {
        type: "radial",
        inner: { x: 322, y: 485, r: 14 },
        outer: { x: 255, y: 535, r: 360 },
      },
      shape: { type: "ellipse", cx: 260, cy: 540, rx: 300, ry: 350 },
      stops: [
        { offset: 0, color: "#34312e8c" },
        { offset: 0.46, color: "#4e4a4558" },
        { offset: 0.78, color: "#6f6a6328" },
        { offset: 1, color: "#6f6a6300" },
      ],
      opacity: 0.88,
    },
  },
  {
    method: "draw.gradient",
    params: {
      layerId: LAYERS.shadow,
      gradient: {
        type: "radial",
        inner: { x: 442, y: 330, r: 12 },
        outer: { x: 450, y: 330, r: 350 },
      },
      shape: { type: "ellipse", cx: 420, cy: 338, rx: 360, ry: 105 },
      stops: [
        { offset: 0, color: "#37343070" },
        { offset: 0.6, color: "#5e59532d" },
        { offset: 1, color: "#5e595300" },
      ],
      opacity: 0.72,
    },
  },
];

const shadowStyles = {
  shadowPrimary: {
    layerId: LAYERS.shadow,
    color: "#4d4a45",
    brush: CHARCOAL,
    size: 9.2,
    toneSize: 5.8,
    opacity: 0.15,
    toneOpacity: 0.19,
    minOpacity: 0.14,
    maxOpacity: 0.38,
    gestureMin: 1000,
    gestureMax: 1000,
    wobble: 0.38,
    pressure: 0.7,
    taperFloor: 0.2,
  },
  shadowCross: {
    layerId: LAYERS.shadow,
    color: "#3d3a36",
    brush: PENCIL,
    size: 2.4,
    toneSize: 1.1,
    opacity: 0.11,
    toneOpacity: 0.16,
    minOpacity: 0.1,
    maxOpacity: 0.27,
    gestureMin: 1000,
    gestureMax: 1000,
    wobble: 0.3,
    pressure: 0.72,
    taperFloor: 0.2,
  },
};
const wallShadow = streamlinesToStrokeOperations(shadowField.byFamily.shadowPrimary, shadowStyles, {
  seed: 0xb5112001,
  strokeSeed: 91_200_000,
});
const contactShadow = [
  curveStroke(LAYERS.shadow, skullOutline.slice(4, 18), { color: DARK, size: 7.5, opacity: 0.13, brush: CHARCOAL, wobble: 0.22 }),
  curveStroke(LAYERS.shadow, skullOutline.slice(18), { color: DARK, size: 5.5, opacity: 0.09, brush: CHARCOAL, wobble: 0.22 }),
];
const shadow = [...wallShadow, ...contactShadow];

const hornRng = createRng(0xb5113001);
const horns = [];
for (const [side, centerline] of [["left", leftHornCenter], ["right", rightHornCenter]]) {
  const sideDarkness = side === "right" ? 1.16 : 0.96;
  for (let index = 0; index < 13; index++) {
    const offset = -0.88 + (index / 12) * 1.76;
    horns.push(curveStroke(LAYERS.horns, offsetHorn(centerline, offset, side), {
      color: index < 5 ? "#32312f" : "#4d4a46",
      brush: CHARCOAL,
      size: 8.5 + hornRng() * 6.5,
      opacity: (0.045 + hornRng() * 0.04) * sideDarkness,
      wobble: 0.32,
    }));
  }
  for (let index = 0; index < 28; index++) {
    const offset = -0.96 + (index / 27) * 1.92;
    const startIndex = Math.floor(hornRng() * 8);
    const endIndex = centerline.length - 1 - Math.floor(hornRng() * 3);
    horns.push(curveStroke(LAYERS.horns, offsetHorn(centerline, offset, side, startIndex, endIndex), {
      color: offset < -0.18 ? "#2d2c2a" : "#55514c",
      brush: PENCIL,
      size: 1.2 + hornRng() * 1.4,
      opacity: (0.18 + hornRng() * 0.19) * sideDarkness,
      wobble: 0.23,
    }));
  }
  horns.push(curveStroke(LAYERS.horns, offsetHorn(centerline, -1, side), { color: DEEP, size: 1.45, opacity: 0.64, wobble: 0.14 }));
  horns.push(curveStroke(LAYERS.horns, offsetHorn(centerline, 1, side), { color: "#34322f", size: 1.1, opacity: 0.5, wobble: 0.14 }));
  for (let band = 0; band < 5; band++) {
    const t = 0.055 + band * 0.082 + hornRng() * 0.016;
    const index = Math.min(centerline.length - 2, Math.floor(t * (centerline.length - 1)));
    const previous = centerline[Math.max(0, index - 1)];
    const next = centerline[Math.min(centerline.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    const radius = hornRadius(t, side) * (0.9 + hornRng() * 0.13);
    const center = centerline[index];
    const upperReach = 0.42 + hornRng() * 0.38;
    horns.push(lineStroke(LAYERS.horns,
      { x: center.x - nx * radius, y: center.y - ny * radius },
      { x: center.x + nx * radius * upperReach, y: center.y + ny * radius * upperReach },
      { color: "#292826", size: 0.65 + hornRng() * 0.48, opacity: 0.18 + hornRng() * 0.16, bow: 0.46, count: 16 },
    ));
  }
}

const broadStyles = {
  skullPrimary: {
    layerId: LAYERS.skull,
    color: "#514d48",
    brush: GRAPHITE_BRUSH,
    size: 9.4,
    toneSize: 5.2,
    opacity: 0.2,
    toneOpacity: 0.25,
    minOpacity: 0.18,
    maxOpacity: 0.5,
    gestureMin: 1000,
    gestureMax: 1000,
    wobble: 0.36,
    pressure: 0.7,
    taperFloor: 0.2,
  },
};
const skullBroad = streamlinesToStrokeOperations(
  skullField.byFamily.skullPrimary,
  broadStyles,
  { seed: 0xb5114001, strokeSeed: 91_400_000 },
);

const skullBroadCharcoal = skullBroad.map((operation, index) => ({
  method: "draw.stroke",
  params: {
    layerId: LAYERS.skull,
    tool: "brush",
    color: index % 5 === 0 ? "#3f3c38" : "#5a554f",
    size: 7.2 + (index % 4) * 1.15,
    opacity: clamp(0.13 + operation.params.opacity * 0.62, 0.16, 0.39),
    points: operation.params.points,
    brushPresetId: CHARCOAL.id,
    brush: CHARCOAL,
    seed: 91_410_000 + index,
    strokeVersion: 2,
  },
}));

const planeRng = createRng(0xb5114002);
const skullPlanes = [...skullBroad, ...skullBroadCharcoal];
const planeCurves = [
  [{ x: 448, y: 286 }, { x: 437, y: 380 }, { x: 440, y: 525 }, { x: 444, y: 690 }, { x: 447, y: 806 }],
  [{ x: 408, y: 300 }, { x: 384, y: 382 }, { x: 381, y: 500 }, { x: 398, y: 612 }],
  [{ x: 492, y: 294 }, { x: 518, y: 380 }, { x: 519, y: 505 }, { x: 500, y: 615 }],
  [{ x: 335, y: 335 }, { x: 351, y: 390 }, { x: 367, y: 500 }, { x: 389, y: 582 }],
  [{ x: 569, y: 329 }, { x: 555, y: 392 }, { x: 542, y: 498 }, { x: 521, y: 582 }],
];
for (const curve of planeCurves) {
  for (let repeat = 0; repeat < 7; repeat++) {
    const shifted = curve.map((point, index) => ({
      x: point.x + (repeat - 3) * 2.4 + (planeRng() - 0.5) * 1.8,
      y: point.y + (planeRng() - 0.5) * 5 + index * (planeRng() - 0.5) * 1.2,
    }));
    skullPlanes.push(curveStroke(LAYERS.skull, shifted, {
      color: repeat < 2 ? "#4a4742" : "#67625c",
      brush: GRAPHITE_BRUSH,
      size: 3.8 + planeRng() * 2.4,
      opacity: 0.14 + planeRng() * 0.14,
      wobble: 0.32,
    }));
  }
}

const skullValueBaseCount = skullBroad.length + skullBroadCharcoal.length;
const skullValueBase = skullPlanes.slice(0, skullValueBaseCount);
const skullValueRefine = skullPlanes.slice(skullValueBaseCount);

const leftBonePlane = [
  { x: 449, y: 274 }, { x: 408, y: 280 }, { x: 366, y: 294 }, { x: 329, y: 315 },
  { x: 299, y: 351 }, { x: 311, y: 425 }, { x: 336, y: 485 }, { x: 357, y: 564 },
  { x: 382, y: 657 }, { x: 389, y: 746 }, { x: 405, y: 802 }, { x: 423, y: 824 },
  { x: 445, y: 828 }, { x: 438, y: 690 }, { x: 425, y: 555 }, { x: 419, y: 422 },
  { x: 430, y: 322 },
];
const rightBonePlane = [
  { x: 454, y: 274 }, { x: 495, y: 279 }, { x: 535, y: 291 }, { x: 570, y: 311 },
  { x: 598, y: 342 }, { x: 603, y: 398 }, { x: 578, y: 476 }, { x: 553, y: 565 },
  { x: 528, y: 654 }, { x: 514, y: 748 }, { x: 503, y: 799 }, { x: 487, y: 823 },
  { x: 466, y: 830 }, { x: 472, y: 690 }, { x: 485, y: 555 }, { x: 491, y: 424 },
  { x: 477, y: 324 },
];
const centerBoneRidge = [
  { x: 429, y: 286 }, { x: 474, y: 282 }, { x: 487, y: 405 }, { x: 482, y: 575 },
  { x: 470, y: 710 }, { x: 458, y: 811 }, { x: 447, y: 811 }, { x: 434, y: 705 },
  { x: 421, y: 570 }, { x: 416, y: 405 },
];

const skullUnderpaint = [
  {
    method: "draw.path",
    params: {
      layerId: LAYERS.skull,
      commands: polygonCommands(skullOutline),
      fill: "#c7c3bbf2",
    },
  },
  {
    method: "draw.path",
    params: {
      layerId: LAYERS.skull,
      commands: polygonCommands(leftBonePlane),
      fill: "#5f5b5548",
    },
  },
  {
    method: "draw.path",
    params: {
      layerId: LAYERS.skull,
      commands: polygonCommands(rightBonePlane),
      fill: "#56524d38",
    },
  },
  {
    method: "draw.path",
    params: {
      layerId: LAYERS.skull,
      commands: polygonCommands(centerBoneRidge),
      fill: "#ebe7df78",
    },
  },
];

const primaryStyles = {
  skullPrimary: {
    layerId: LAYERS.hatch,
    color: "#4a4641",
    brush: PENCIL,
    size: 2.25,
    toneSize: 1.05,
    opacity: 0.15,
    toneOpacity: 0.23,
    minOpacity: 0.13,
    maxOpacity: 0.44,
    gestureMin: 90,
    gestureMax: 190,
    wobble: 0.3,
    pressure: 0.72,
    taperFloor: 0.18,
  },
};
const primaryPencil = streamlinesToStrokeOperations(
  skullField.byFamily.skullPrimary,
  primaryStyles,
  { seed: 0xb5115001, strokeSeed: 91_500_000 },
);
const primaryNative = primaryPencil.map((operation, index) => ({
  method: "draw.stroke",
  params: {
    layerId: LAYERS.hatch,
    tool: "brush",
    color: "#4a4641",
    size: 0.58,
    opacity: clamp(operation.params.opacity * 0.58, 0.1, 0.26),
    points: operation.params.points,
    seed: 91_510_000 + index,
    strokeVersion: 2,
  },
}));
const primaryHatch = [...primaryPencil, ...primaryNative];

const crossStyles = {
  skullCross: {
    layerId: LAYERS.hatch,
    color: "#373431",
    brush: PENCIL,
    size: 1.85,
    toneSize: 0.8,
    opacity: 0.16,
    toneOpacity: 0.24,
    minOpacity: 0.15,
    maxOpacity: 0.46,
    gestureMin: 60,
    gestureMax: 130,
    wobble: 0.27,
    pressure: 0.73,
    taperFloor: 0.16,
  },
};
const crossPencil = streamlinesToStrokeOperations(
  skullField.byFamily.skullCross,
  crossStyles,
  { seed: 0xb5116001, strokeSeed: 91_600_000 },
);
const crossNative = crossPencil.map((operation, index) => ({
  method: "draw.stroke",
  params: {
    layerId: LAYERS.hatch,
    tool: "brush",
    color: "#373431",
    size: 0.5,
    opacity: clamp(operation.params.opacity * 0.5, 0.1, 0.24),
    points: operation.params.points,
    seed: 91_610_000 + index,
    strokeVersion: 2,
  },
}));
const crossHatch = [...crossPencil, ...crossNative];

function darkHole(polygon, cx, cy, rngSeed) {
  const rng = createRng(rngSeed);
  const operations = [];
  for (let index = 0; index < 10; index++) {
    const scale = 1 - index * 0.055;
    operations.push(curveStroke(LAYERS.details, scalePolygon(polygon, cx, cy, scale), {
      color: index < 4 ? DEEP : DARK,
      brush: CHARCOAL,
      size: 3.2 + rng() * 2.4,
      opacity: 0.1 + rng() * 0.11,
      wobble: 0.24,
    }));
  }
  const minX = Math.min(...polygon.map((point) => point.x));
  const maxX = Math.max(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y));
  const maxY = Math.max(...polygon.map((point) => point.y));
  for (let index = 0; index < 22; index++) {
    const y = minY + (index + 0.5) / 22 * (maxY - minY);
    const widthFactor = Math.sin((index + 0.5) / 22 * Math.PI);
    const half = (maxX - minX) * 0.42 * widthFactor;
    operations.push(lineStroke(LAYERS.details,
      { x: cx - half, y },
      { x: cx + half, y: y + (rng() - 0.5) * 5 },
      { color: DEEP, brush: PENCIL, size: 1.1 + rng() * 1.3, opacity: 0.34 + rng() * 0.28, bow: 0.25, count: 14 },
    ));
  }
  operations.push(curveStroke(LAYERS.details, [...polygon, polygon[0]], { color: "#22211f", size: 1.5, opacity: 0.7, wobble: 0.14 }));
  return operations;
}

const details = [];
details.push(...darkHole(leftSocket, 359, 444, 0xb5117001));
details.push(...darkHole(rightSocket, 549, 440, 0xb5117002));
details.push(...darkHole(leftNasal, 416, 716, 0xb5117003));
details.push(...darkHole(rightNasal, 489, 715, 0xb5117004));

details.push(curveStroke(LAYERS.details, skullOutline.slice(3, 18), { color: "#373431", size: 1.2, opacity: 0.52, wobble: 0.16 }));
details.push(curveStroke(LAYERS.details, skullOutline.slice(18), { color: "#2c2a28", size: 1.35, opacity: 0.6, wobble: 0.16 }));
details.push(curveStroke(LAYERS.details, skullOutline.slice(0, 5), { color: "#55514b", size: 0.82, opacity: 0.35, wobble: 0.14 }));

const seamRng = createRng(0xb5117005);
const seam = [];
for (let index = 0; index <= 48; index++) {
  const t = index / 48;
  seam.push({
    x: 452 + Math.sin(t * 18.4) * (1.8 + t * 1.6) + (seamRng() - 0.5) * 1.2,
    y: 296 + t * 421,
  });
}
details.push(curveStroke(LAYERS.details, seam, { color: "#393633", size: 0.82, opacity: 0.54, wobble: 0.1 }));
details.push(curveStroke(LAYERS.details, seam.map((point) => ({ x: point.x + 3.5, y: point.y + 0.5 })), { color: "#77716a", size: 0.5, opacity: 0.28, wobble: 0.08 }));

const crackPaths = [
  [{ x: 367, y: 340 }, { x: 351, y: 360 }, { x: 359, y: 380 }, { x: 344, y: 398 }],
  [{ x: 392, y: 472 }, { x: 407, y: 490 }, { x: 401, y: 521 }, { x: 412, y: 547 }],
  [{ x: 507, y: 362 }, { x: 525, y: 380 }, { x: 519, y: 408 }, { x: 535, y: 425 }],
  [{ x: 536, y: 498 }, { x: 519, y: 520 }, { x: 525, y: 548 }, { x: 510, y: 570 }],
  [{ x: 389, y: 600 }, { x: 405, y: 617 }, { x: 400, y: 642 }],
  [{ x: 511, y: 598 }, { x: 496, y: 617 }, { x: 501, y: 641 }],
  [{ x: 423, y: 803 }, { x: 430, y: 781 }, { x: 426, y: 756 }],
  [{ x: 483, y: 807 }, { x: 478, y: 783 }, { x: 482, y: 758 }],
];
for (const path of crackPaths) {
  details.push(curveStroke(LAYERS.details, path, { color: "#3d3a37", size: 0.66, opacity: 0.44, wobble: 0.16 }));
}

const cavityDepth = [
  { method: "draw.path", params: { layerId: LAYERS.details, commands: polygonCommands(leftSocket), fill: "#242321ee" } },
  { method: "draw.path", params: { layerId: LAYERS.details, commands: polygonCommands(rightSocket), fill: "#242321ee" } },
  { method: "draw.path", params: { layerId: LAYERS.details, commands: polygonCommands(leftNasal), fill: "#1f1e1df2" } },
  { method: "draw.path", params: { layerId: LAYERS.details, commands: polygonCommands(rightNasal), fill: "#1f1e1df2" } },
  curveStroke(LAYERS.details, [...leftSocket, leftSocket[0]], { color: "#171615", size: 1.5, opacity: 0.82, wobble: 0.12 }),
  curveStroke(LAYERS.details, [...rightSocket, rightSocket[0]], { color: "#171615", size: 1.5, opacity: 0.82, wobble: 0.12 }),
  curveStroke(LAYERS.details, [...leftNasal, leftNasal[0]], { color: "#151413", size: 1.3, opacity: 0.8, wobble: 0.12 }),
  curveStroke(LAYERS.details, [...rightNasal, rightNasal[0]], { color: "#151413", size: 1.3, opacity: 0.8, wobble: 0.12 }),
];

const pitRng = createRng(0xb5117006);
for (const [cx, cy, count] of [[355, 355, 9], [549, 347, 8], [377, 537, 7], [526, 528, 6]]) {
  for (let index = 0; index < count; index++) {
    const x = cx + (pitRng() - 0.5) * 32;
    const y = cy + (pitRng() - 0.5) * 36;
    const r = 1.2 + pitRng() * 2.6;
    details.push(curveStroke(LAYERS.details, ellipsePoints(x, y, r, r * 0.72, 0, Math.PI * 2, 12), {
      color: "#3b3935", size: 0.72, opacity: 0.34 + pitRng() * 0.23, wobble: 0.08,
    }));
  }
}

function spiral(cx, cy, radius, turns, flip = 1) {
  const points = [];
  const count = 56;
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const angle = flip * turns * Math.PI * 2 * t;
    const r = radius * (1 - t * 0.78);
    points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r * 0.64 });
  }
  return points;
}

const ornamentDetails = [];
for (const cx of [104, 796]) {
  for (let ring = 0; ring < 4; ring++) {
    ornamentDetails.push(curveStroke(LAYERS.ornament, ellipsePoints(cx, 48, 47 - ring * 4.5, 42 - ring * 3.8, 0, Math.PI * 2, 50), {
      color: ring % 2 ? "#242321" : "#817b72", size: ring % 2 ? 2.1 : 1.2, opacity: ring % 2 ? 0.68 : 0.48, wobble: 0.2,
    }));
  }
  for (const y of [31, 48, 65]) {
    ornamentDetails.push(lineStroke(LAYERS.ornament, { x: cx - 34, y }, { x: cx + 34, y }, { color: "#8f887f", size: 1.6, opacity: 0.54, bow: 0.18, count: 22 }));
  }
  ornamentDetails.push(lineStroke(LAYERS.ornament, { x: cx, y: 19 }, { x: cx, y: 77 }, { color: "#878178", size: 1.4, opacity: 0.46, bow: 0.18, count: 20 }));
}

for (const [cx, cy, radius, turns, flip] of [
  [222, 77, 46, 1.45, 1], [300, 73, 38, 1.35, -1],
  [600, 72, 38, 1.35, 1], [678, 77, 46, 1.45, -1],
]) {
  ornamentDetails.push(curveStroke(LAYERS.ornament, spiral(cx, cy, radius, turns, flip), { color: "#8b857b", size: 1.8, opacity: 0.55, wobble: 0.22 }));
  ornamentDetails.push(curveStroke(LAYERS.ornament, spiral(cx, cy + 3, radius * 0.78, turns, flip), { color: "#242321", size: 1.35, opacity: 0.66, wobble: 0.18 }));
}

const crestTop = joinCurves(
  cubicPoints({ x: 348, y: 43 }, { x: 387, y: 8 }, { x: 414, y: 22 }, { x: 450, y: 38 }, 22),
  cubicPoints({ x: 450, y: 38 }, { x: 486, y: 22 }, { x: 518, y: 8 }, { x: 553, y: 43 }, 22),
);
const crestBottom = joinCurves(
  cubicPoints({ x: 354, y: 65 }, { x: 393, y: 98 }, { x: 422, y: 81 }, { x: 450, y: 69 }, 22),
  cubicPoints({ x: 450, y: 69 }, { x: 480, y: 82 }, { x: 511, y: 98 }, { x: 548, y: 65 }, 22),
);
ornamentDetails.push(curveStroke(LAYERS.ornament, crestTop, { color: "#989187", size: 2.0, opacity: 0.58, wobble: 0.2 }));
ornamentDetails.push(curveStroke(LAYERS.ornament, crestBottom, { color: "#1f1e1d", size: 2.4, opacity: 0.75, wobble: 0.2 }));
for (let index = 0; index < 14; index++) {
  const y = 40 + index * 3.2;
  ornamentDetails.push(lineStroke(LAYERS.ornament, { x: 386 + index * 2.4, y }, { x: 514 - index * 2.4, y: y + 6 }, {
    color: index % 3 === 0 ? "#8c857b" : "#33312e", size: 1.05, opacity: 0.42, bow: 0.35, count: 22,
  }));
}

ornamentDetails.push(lineStroke(LAYERS.details, { x: 450, y: 170 }, { x: 334, y: 315 }, { color: "#56524d", size: 0.75, opacity: 0.48, bow: 0.14, count: 40 }));
ornamentDetails.push(lineStroke(LAYERS.details, { x: 450, y: 170 }, { x: 574, y: 316 }, { color: "#56524d", size: 0.75, opacity: 0.48, bow: 0.14, count: 40 }));
ornamentDetails.push(lineStroke(LAYERS.details, { x: 452, y: 170 }, { x: 337, y: 316 }, { color: "#a19b91", size: 0.45, opacity: 0.34, bow: 0.14, count: 40 }));
ornamentDetails.push(lineStroke(LAYERS.details, { x: 452, y: 170 }, { x: 577, y: 316 }, { color: "#a19b91", size: 0.45, opacity: 0.34, bow: 0.14, count: 40 }));
for (let ring = 0; ring < 5; ring++) {
  ornamentDetails.push(curveStroke(LAYERS.details, ellipsePoints(450, 170, 7 - ring * 0.8, 7 - ring * 0.8, 0, Math.PI * 2, 18), {
    color: ring < 3 ? "#34322f" : "#918a80", size: 0.8, opacity: 0.48, wobble: 0.08,
  }));
}

const studRng = createRng(0xb5118001);
function drawStud(cx, cy, radius) {
  const operations = [];
  for (let ring = 0; ring < 8; ring++) {
    const scale = 1 - ring * 0.075;
    operations.push(curveStroke(LAYERS.details, ellipsePoints(cx, cy, radius * scale, radius * scale, 0, Math.PI * 2, 28), {
      color: ring < 3 ? "#3d3a36" : "#5d5953",
      brush: GRAPHITE_BRUSH,
      size: 2.3 + studRng() * 1.8,
      opacity: 0.08 + studRng() * 0.09,
      wobble: 0.18,
    }));
  }
  for (let index = 0; index < 22; index++) {
    const t = (index + 0.5) / 22;
    const y = cy - radius + t * radius * 2;
    const half = Math.sqrt(Math.max(0, radius * radius - (y - cy) * (y - cy)));
    const bias = (y - cy) / radius;
    operations.push(lineStroke(LAYERS.details,
      { x: cx - half * 0.9, y },
      { x: cx + half * 0.9, y: y + (studRng() - 0.5) * 2.5 },
      { color: bias > -0.15 ? DARK : "#77726a", size: 0.8 + studRng() * 0.7, opacity: 0.16 + (bias + 1) * 0.12, bow: 0.18, count: 14 },
    ));
  }
  operations.push(curveStroke(LAYERS.details, ellipsePoints(cx, cy, radius, radius, 0, Math.PI * 2, 32), { color: "#383633", size: 1.05, opacity: 0.52, wobble: 0.12 }));
  return operations;
}
for (const [cx, cy, radius] of [[72, 448, 24], [70, 620, 26], [73, 788, 27], [827, 462, 25], [824, 628, 27], [820, 790, 28]]) {
  ornamentDetails.push(...drawStud(cx, cy, radius));
}

const lightRng = createRng(0xb5119001);
const lights = [];
const boneLightCurves = [
  [{ x: 454, y: 300 }, { x: 457, y: 418 }, { x: 454, y: 560 }, { x: 452, y: 710 }, { x: 450, y: 812 }],
  [{ x: 390, y: 309 }, { x: 378, y: 348 }, { x: 381, y: 391 }],
  [{ x: 510, y: 304 }, { x: 523, y: 345 }, { x: 520, y: 388 }],
  [{ x: 397, y: 519 }, { x: 412, y: 565 }, { x: 420, y: 612 }],
  [{ x: 504, y: 515 }, { x: 492, y: 563 }, { x: 484, y: 617 }],
];
for (const curve of boneLightCurves) {
  for (let repeat = 0; repeat < 3; repeat++) {
    lights.push(curveStroke(LAYERS.lights, curve.map((point) => ({ x: point.x + repeat * 1.8, y: point.y + (lightRng() - 0.5) * 3 })), {
      color: repeat === 0 ? PAPER_LIGHT : PAPER,
      size: 1.4 + lightRng() * 1.8,
      opacity: 0.1 + lightRng() * 0.12,
      wobble: 0.2,
    }));
  }
}
for (const [cx, cy, radius] of [[72, 448, 24], [70, 620, 26], [73, 788, 27], [827, 462, 25], [824, 628, 27], [820, 790, 28]]) {
  lights.push(curveStroke(LAYERS.lights, ellipsePoints(cx - radius * 0.2, cy - radius * 0.18, radius * 0.48, radius * 0.36, Math.PI * 0.9, Math.PI * 1.72, 16), {
    color: PAPER_LIGHT, size: 2.4, opacity: 0.24, wobble: 0.14,
  }));
}
for (const [side, centerline] of [["left", leftHornCenter], ["right", rightHornCenter]]) {
  lights.push(curveStroke(LAYERS.lights, offsetHorn(centerline, 0.55, side, 8, centerline.length - 7), {
    color: PAPER, size: 1.9, opacity: side === "left" ? 0.2 : 0.13, wobble: 0.18,
  }));
}

const leftHornShape = [
  ...offsetHorn(leftHornCenter, -1, "left"),
  ...offsetHorn(leftHornCenter, 1, "left").reverse(),
];
const rightHornShape = [
  ...offsetHorn(rightHornCenter, -1, "right"),
  ...offsetHorn(rightHornCenter, 1, "right").reverse(),
];
const hornDepth = [
  { method: "draw.path", params: { layerId: LAYERS.horns, commands: polygonCommands(leftHornShape), fill: "#3a37345c" } },
  { method: "draw.path", params: { layerId: LAYERS.horns, commands: polygonCommands(rightHornShape), fill: "#29272470" } },
  curveStroke(LAYERS.horns, offsetHorn(leftHornCenter, -1, "left"), { color: "#1f1e1d", size: 1.45, opacity: 0.72, wobble: 0.14 }),
  curveStroke(LAYERS.horns, offsetHorn(leftHornCenter, 1, "left"), { color: "#403d39", size: 1.0, opacity: 0.5, wobble: 0.14 }),
  curveStroke(LAYERS.horns, offsetHorn(rightHornCenter, -1, "right"), { color: "#191817", size: 1.55, opacity: 0.78, wobble: 0.14 }),
  curveStroke(LAYERS.horns, offsetHorn(rightHornCenter, 1, "right"), { color: "#35322f", size: 1.05, opacity: 0.54, wobble: 0.14 }),
];

const cavityPolish = [];
for (const [polygon, cx, cy] of [
  [leftSocket, 359, 444], [rightSocket, 549, 440],
  [leftNasal, 416, 716], [rightNasal, 489, 715],
]) {
  cavityPolish.push({ method: "draw.path", params: { layerId: LAYERS.details, commands: polygonCommands(polygon), fill: "#4a4642f0" } });
  cavityPolish.push({ method: "draw.path", params: { layerId: LAYERS.details, commands: polygonCommands(scalePolygon(polygon, cx, cy, 0.77, 0.8)), fill: "#22211fe8" } });
}
const browAndCheekCurves = [
  [{ x: 310, y: 400 }, { x: 337, y: 377 }, { x: 379, y: 383 }, { x: 415, y: 415 }],
  [{ x: 592, y: 397 }, { x: 565, y: 374 }, { x: 525, y: 380 }, { x: 492, y: 413 }],
  [{ x: 319, y: 463 }, { x: 342, y: 504 }, { x: 375, y: 537 }],
  [{ x: 582, y: 460 }, { x: 558, y: 502 }, { x: 528, y: 538 }],
  [{ x: 401, y: 605 }, { x: 421, y: 625 }, { x: 438, y: 647 }],
  [{ x: 500, y: 604 }, { x: 484, y: 625 }, { x: 468, y: 649 }],
];
for (const curve of browAndCheekCurves) {
  cavityPolish.push(curveStroke(LAYERS.details, curve, { color: "#302e2b", size: 1.15, opacity: 0.56, wobble: 0.18 }));
}

const polishLights = [];
for (const [polygon, ranges] of [
  [leftSocket, [0, 4]], [rightSocket, [0, 4]],
  [leftNasal, [0, 3]], [rightNasal, [0, 3]],
]) {
  polishLights.push(curveStroke(LAYERS.lights, polygon.slice(ranges[0], ranges[1] + 1), {
    color: PAPER_LIGHT, size: 1.8, opacity: 0.28, wobble: 0.14,
  }));
}
for (const [cx, cy, radius] of [[72, 448, 24], [70, 620, 26], [73, 788, 27], [827, 462, 25], [824, 628, 27], [820, 790, 28]]) {
  polishLights.push({
    method: "draw.gradient",
    params: {
      layerId: LAYERS.lights,
      gradient: {
        type: "radial",
        inner: { x: cx - radius * 0.28, y: cy - radius * 0.3, r: 2 },
        outer: { x: cx, y: cy, r: radius },
      },
      shape: { type: "circle", cx, cy, r: radius },
      stops: [
        { offset: 0, color: "#eeeae2f2" },
        { offset: 0.28, color: "#b7b1a7e8" },
        { offset: 0.68, color: "#68635de8" },
        { offset: 1, color: "#2e2c29f2" },
      ],
      opacity: 0.86,
    },
  });
}

const finalBalance = [
  { method: "layer.setOpacity", params: { layerId: LAYERS.skull, opacity: 0.62 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.details, opacity: 0.86 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.hatch, opacity: 0.72 } },
  { method: "layer.setActive", params: { layerId: LAYERS.details } },
];

// Final reference-convergence pass.  This remains a collection of native
// marks: the only broad fields are transparent graphite underpainting; all
// readable anatomy, growth rings, sutures and rim lights are draw.stroke ops.
function hornSectionShape(centerline, side, startIndex, endIndex) {
  return [
    ...offsetHorn(centerline, -1, side, startIndex, endIndex),
    ...offsetHorn(centerline, 1, side, startIndex, endIndex).reverse(),
  ];
}

const referenceConvergence = [
  {
    method: "draw.rect",
    params: {
      layerId: LAYERS.ground,
      x: 0,
      y: 126,
      w: W,
      h: H - 126,
      fill: "#5b585312",
      stroke: "#5b585300",
      strokeWidth: 1,
    },
  },
  {
    method: "draw.gradient",
    params: {
      layerId: LAYERS.shadow,
      gradient: {
        type: "radial",
        inner: { x: 327, y: 500, r: 8 },
        outer: { x: 235, y: 555, r: 330 },
      },
      shape: { type: "ellipse", cx: 258, cy: 535, rx: 292, ry: 345 },
      stops: [
        { offset: 0, color: "#29272598" },
        { offset: 0.36, color: "#403d3968" },
        { offset: 0.72, color: "#625e582a" },
        { offset: 1, color: "#625e5800" },
      ],
      opacity: 0.7,
    },
  },
  { method: "draw.path", params: { layerId: LAYERS.horns, commands: polygonCommands(hornSectionShape(leftHornCenter, "left", 0, 15)), fill: "#27252280" } },
  { method: "draw.path", params: { layerId: LAYERS.horns, commands: polygonCommands(hornSectionShape(leftHornCenter, "left", 48, leftHornCenter.length - 1)), fill: "#24221f70" } },
  { method: "draw.path", params: { layerId: LAYERS.horns, commands: polygonCommands(hornSectionShape(rightHornCenter, "right", 0, 18)), fill: "#211f1d9a" } },
  { method: "draw.path", params: { layerId: LAYERS.horns, commands: polygonCommands(hornSectionShape(rightHornCenter, "right", 46, rightHornCenter.length - 1)), fill: "#1d1c1a90" } },
];

for (const [side, centerline] of [["left", leftHornCenter], ["right", rightHornCenter]]) {
  for (let index = 4; index < centerline.length - 5; index += 4) {
    const outer = offsetHorn(centerline, -0.88, side, index, index)[0];
    const inner = offsetHorn(centerline, 0.88, side, index, index)[0];
    referenceConvergence.push(lineStroke(LAYERS.horns, outer, inner, {
      color: side === "right" ? "#22201e" : "#34312e",
      size: index < 20 || index > 45 ? 1.05 : 0.72,
      opacity: index < 20 || index > 45 ? 0.42 : 0.24,
      bow: 0.22,
      count: 12,
    }));
  }
}

// Broad but broken side-plane hatch, with a shallow-angle family added to
// the vertical construction family.  The two directions never form a 90° X.
for (let index = 0; index < 22; index++) {
  const y = 306 + index * 13.2;
  referenceConvergence.push(lineStroke(LAYERS.hatch,
    { x: 315 + index * 1.9, y },
    { x: 392 + index * 0.9, y: y + 47 },
    { color: "#47433f", size: 0.58, opacity: 0.17 + (index % 4) * 0.018, bow: 0.38, count: 22 },
  ));
}
for (let index = 0; index < 18; index++) {
  const y = 326 + index * 15.1;
  referenceConvergence.push(lineStroke(LAYERS.hatch,
    { x: 585 - index * 1.55, y },
    { x: 512 - index * 0.65, y: y + 43 },
    { color: "#4c4844", size: 0.54, opacity: 0.14 + (index % 3) * 0.018, bow: 0.34, count: 22 },
  ));
}

for (const offset of [-10, -6, -2, 2, 6]) {
  referenceConvergence.push(curveStroke(LAYERS.lights, [
    { x: 451 + offset, y: 302 },
    { x: 453 + offset * 0.7, y: 420 },
    { x: 452 + offset * 0.45, y: 560 },
    { x: 450 + offset * 0.3, y: 690 },
    { x: 451 + offset * 0.15, y: 802 },
  ], { color: PAPER_LIGHT, size: 2.1, opacity: 0.115, wobble: 0.2 }));
}

const irregularBrow = [
  [{ x: 302, y: 355 }, { x: 319, y: 326 }, { x: 354, y: 303 }, { x: 395, y: 283 }, { x: 430, y: 278 }],
  [{ x: 430, y: 278 }, { x: 442, y: 266 }, { x: 451, y: 282 }, { x: 466, y: 272 }, { x: 494, y: 279 }],
  [{ x: 494, y: 279 }, { x: 533, y: 288 }, { x: 566, y: 307 }, { x: 593, y: 335 }, { x: 605, y: 361 }],
];
for (const curve of irregularBrow) {
  referenceConvergence.push(curveStroke(LAYERS.details, curve, { color: "#383532", size: 1.18, opacity: 0.54, wobble: 0.34 }));
}

const convergenceCracks = [
  [{ x: 448, y: 330 }, { x: 441, y: 348 }, { x: 449, y: 367 }, { x: 443, y: 391 }, { x: 451, y: 418 }],
  [{ x: 443, y: 390 }, { x: 429, y: 405 }, { x: 421, y: 427 }],
  [{ x: 452, y: 474 }, { x: 463, y: 492 }, { x: 456, y: 517 }, { x: 463, y: 540 }],
  [{ x: 363, y: 337 }, { x: 346, y: 350 }, { x: 350, y: 369 }, { x: 337, y: 383 }],
  [{ x: 536, y: 343 }, { x: 548, y: 359 }, { x: 542, y: 379 }, { x: 554, y: 392 }],
  [{ x: 392, y: 552 }, { x: 379, y: 571 }, { x: 386, y: 594 }, { x: 374, y: 615 }],
];
for (const curve of convergenceCracks) {
  referenceConvergence.push(curveStroke(LAYERS.details, curve, { color: "#302e2b", size: 0.7, opacity: 0.5, wobble: 0.2 }));
}

for (const [polygon, start, end] of [
  [leftSocket, 0, 4], [rightSocket, 0, 4], [leftNasal, 0, 3], [rightNasal, 0, 3],
]) {
  for (let repeat = 0; repeat < 2; repeat++) {
    referenceConvergence.push(curveStroke(LAYERS.lights, polygon.slice(start, end + 1).map((point) => ({
      x: point.x + repeat * 1.1,
      y: point.y - repeat * 0.7,
    })), { color: PAPER_LIGHT, size: 1.55 + repeat * 0.55, opacity: 0.19, wobble: 0.13 }));
  }
}

referenceConvergence.push(
  { method: "layer.setOpacity", params: { layerId: LAYERS.shadow, opacity: 0.58 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.hatch, opacity: 0.82 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.details, opacity: 0.84 } },
  { method: "layer.setActive", params: { layerId: LAYERS.details } },
);

const finish = [
  { method: "layer.setVisible", params: { layerId: LAYERS.construction, visible: false } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.hatch, opacity: 0.82 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.shadow, opacity: 0.42 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.skull, opacity: 0.52 } },
  { method: "layer.setActive", params: { layerId: LAYERS.details } },
];

const valueReview = [
  { method: "layer.setVisible", params: { layerId: LAYERS.construction, visible: false } },
];

const valueBalance = [
  { method: "layer.setOpacity", params: { layerId: LAYERS.skull, opacity: 0.52 } },
  { method: "layer.setOpacity", params: { layerId: LAYERS.shadow, opacity: 0.42 } },
];

function validate(operation) {
  const definition = METHODS[operation.method];
  if (!definition) throw new Error(`Unknown method ${operation.method}`);
  definition.params?.parse(operation.params);
}

async function writeJsonl(filename, operations) {
  for (const operation of operations) validate(operation);
  await writeFile(
    `${OUTPUT_DIR}${filename}`,
    `${operations.map((operation) => JSON.stringify(operation)).join("\n")}\n`,
  );
}

await writeJsonl("pass-00-isolate-setup.jsonl", setup);
await writeJsonl("pass-01-construction.jsonl", construction);
await writeJsonl("pass-02-background-frieze.jsonl", background);
await writeJsonl("pass-02b-background-deepen.jsonl", backgroundDeepen);
await writeJsonl("pass-02c-frieze-consolidate.jsonl", backgroundConsolidate);
await writeJsonl("pass-02d-reset-value-stack-v3.jsonl", resetValueStack);
await writeJsonl("pass-02e-reset-value-stack-v4.jsonl", resetValueStack);
await writeJsonl("pass-03a-shadow-underpaint-v4.jsonl", shadowUnderpaint);
await writeJsonl("pass-03-wall-shadow.jsonl", shadow);
await writeJsonl("pass-04-horns.jsonl", horns);
await writeJsonl("pass-05a-skull-underpaint-v4.jsonl", skullUnderpaint);
await writeJsonl("pass-05a-skull-values-base.jsonl", skullValueBase);
await writeJsonl("pass-05b-skull-values-refine.jsonl", skullValueRefine);
await writeJsonl("pass-05c-value-review.jsonl", valueReview);
await writeJsonl("pass-05d-value-balance-v4.jsonl", valueBalance);
await writeJsonl("pass-06-primary-hatch.jsonl", primaryHatch);
await writeJsonl("pass-07-oblique-cross.jsonl", crossHatch);
await writeJsonl("pass-08-anatomical-details.jsonl", details);
await writeJsonl("pass-08b-cavity-depth.jsonl", cavityDepth);
await writeJsonl("pass-09-ornament-studs-cords.jsonl", ornamentDetails);
await writeJsonl("pass-10-lights.jsonl", lights);
await writeJsonl("pass-11-finish.jsonl", finish);
await writeJsonl("pass-12-horn-depth.jsonl", hornDepth);
await writeJsonl("pass-13-cavity-anatomy-polish.jsonl", cavityPolish);
await writeJsonl("pass-14-stud-and-rim-lights.jsonl", polishLights);
await writeJsonl("pass-15-final-balance.jsonl", finalBalance);
await writeJsonl("pass-16-reference-convergence.jsonl", referenceConvergence);

const angleAudit = {
  skull: skullField.angleAudit,
  shadow: shadowField.angleAudit,
  explicit: {
    skullDegrees: axisSeparation(0, skullCrossOffset) * 180 / Math.PI,
    shadowDegrees: axisSeparation(shadowPrimaryAngle, shadowCrossAngle) * 180 / Math.PI,
  },
};

const passCounts = {
  setup: setup.length,
  construction: construction.length,
  background: background.length,
  backgroundDeepen: backgroundDeepen.length,
  backgroundConsolidate: backgroundConsolidate.length,
  resetValueStack: resetValueStack.length,
  shadowUnderpaint: shadowUnderpaint.length,
  shadow: shadow.length,
  horns: horns.length,
  skullUnderpaint: skullUnderpaint.length,
  skullValueBase: skullValueBase.length,
  skullValueRefine: skullValueRefine.length,
  valueReview: valueReview.length,
  valueBalance: valueBalance.length,
  primaryPencil: primaryPencil.length,
  primaryNative: primaryNative.length,
  crossPencil: crossPencil.length,
  crossNative: crossNative.length,
  details: details.length,
  cavityDepth: cavityDepth.length,
  ornamentStudsCords: ornamentDetails.length,
  lights: lights.length,
  finish: finish.length,
  hornDepth: hornDepth.length,
  cavityPolish: cavityPolish.length,
  polishLights: polishLights.length,
  finalBalance: finalBalance.length,
  referenceConvergence: referenceConvergence.length,
};

const nativeStrokeCount = construction.length
  + background.length
  + shadow.length
  + horns.length
  + skullPlanes.length
  + primaryHatch.length
  + crossHatch.length
  + details.length
  + ornamentDetails.length
  + lights.length
  + hornDepth.filter((operation) => operation.method === "draw.stroke").length
  + cavityPolish.filter((operation) => operation.method === "draw.stroke").length
  + polishLights.filter((operation) => operation.method === "draw.stroke").length
  + referenceConvergence.filter((operation) => operation.method === "draw.stroke").length;

const manifest = {
  title: "Bull Skull Wall Study — Native Graphite Copy",
  reference: {
    path: "/var/folders/bq/m7h7lbt92776192vcps9c_640000gn/T/codex-clipboard-c10e37fb-eb30-4122-bc8b-3c2f6fc90df3.png",
    use: "observation and landmark measurement only",
    importedToCanvas: false,
  },
  canvas: { width: W, height: H, paper: PAPER },
  paintBranch: "art/codex-bull-skull-copy-20260809",
  sourcePolicy: "no raster import or generated image; graphite rendering is built from native draw.stroke marks plus native path/gradient/rectangle underpainting",
  lightDirection: "upper-right/front, broad",
  landmarks: {
    friezeBottom: 130,
    pin: { x: 450, y: 170 },
    skullTop: { x: 450, y: 270 },
    skullBottom: { x: 456, y: 831 },
    leftHornTip: { x: 111, y: 58 },
    rightHornTip: { x: 809, y: 55 },
  },
  valuePlan: {
    darkest: "eye sockets, nasal cavities, horn undersides, left wall contact shadow, frieze recesses",
    halftone: "skull side planes and wall grain",
    light: "central nasal ridge, upper frontal planes, stud highlights",
  },
  passCounts,
  nativeStrokeCount,
  familyCounts: {
    skullPrimary: skullField.byFamily.skullPrimary.length,
    skullCross: skullField.byFamily.skullCross.length,
    shadowPrimary: shadowField.byFamily.shadowPrimary.length,
    shadowCross: shadowField.byFamily.shadowCross.length,
  },
  angleAudit,
  passes: [
    "pass-00-isolate-setup.jsonl",
    "pass-01-construction.jsonl",
    "pass-02-background-frieze.jsonl",
    "pass-02b-background-deepen.jsonl",
    "pass-02c-frieze-consolidate.jsonl",
    "pass-02d-reset-value-stack-v3.jsonl",
    "pass-02e-reset-value-stack-v4.jsonl",
    "pass-03a-shadow-underpaint-v4.jsonl",
    "pass-03-wall-shadow.jsonl",
    "pass-04-horns.jsonl",
    "pass-05a-skull-underpaint-v4.jsonl",
    "pass-05a-skull-values-base.jsonl",
    "pass-05b-skull-values-refine.jsonl",
    "pass-05c-value-review.jsonl",
    "pass-05d-value-balance-v4.jsonl",
    "pass-06-primary-hatch.jsonl",
    "pass-07-oblique-cross.jsonl",
    "pass-08-anatomical-details.jsonl",
    "pass-08b-cavity-depth.jsonl",
    "pass-09-ornament-studs-cords.jsonl",
    "pass-10-lights.jsonl",
    "pass-11-finish.jsonl",
    "pass-12-horn-depth.jsonl",
    "pass-13-cavity-anatomy-polish.jsonl",
    "pass-14-stud-and-rim-lights.jsonl",
    "pass-15-final-balance.jsonl",
    "pass-16-reference-convergence.jsonl",
  ],
};

await writeFile(`${OUTPUT_DIR}hatching-report.json`, `${JSON.stringify({
  seeds: { skull: skullConfig.seed, shadow: shadowConfig.seed },
  familyCounts: manifest.familyCounts,
  angleAudit,
}, null, 2)}\n`);
await writeFile(`${OUTPUT_DIR}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ passCounts, nativeStrokeCount, familyCounts: manifest.familyCounts, angleAudit }, null, 2));
