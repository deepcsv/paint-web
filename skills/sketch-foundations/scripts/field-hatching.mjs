#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TAU = Math.PI * 2;

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function createRng(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shortestAngleDelta(a, b) {
  let delta = (a - b) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

// Hatching direction is an unoriented axis: theta and theta + PI are equal.
function alignAxis(angle, reference) {
  let aligned = angle;
  while (aligned - reference > Math.PI / 2) aligned -= Math.PI;
  while (aligned - reference < -Math.PI / 2) aligned += Math.PI;
  return aligned;
}

export function axisSeparation(a, b) {
  let separation = Math.abs(a - b) % Math.PI;
  if (separation > Math.PI / 2) separation = Math.PI - separation;
  return separation;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}

function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

class SpatialHash {
  constructor(cellSize) {
    this.cellSize = Math.max(0.5, cellSize);
    this.cells = new Map();
  }

  key(cx, cy) {
    return `${cx},${cy}`;
  }

  add(point) {
    const cx = Math.floor(point.x / this.cellSize);
    const cy = Math.floor(point.y / this.cellSize);
    const key = this.key(cx, cy);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(point);
    else this.cells.set(key, [point]);
  }

  hasNearby(x, y, distance) {
    const radius = Math.max(0, distance);
    const range = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const distanceSquared = radius * radius;
    for (let yy = cy - range; yy <= cy + range; yy++) {
      for (let xx = cx - range; xx <= cx + range; xx++) {
        const bucket = this.cells.get(this.key(xx, yy));
        if (!bucket) continue;
        for (const point of bucket) {
          const dx = point.x - x;
          const dy = point.y - y;
          if (dx * dx + dy * dy < distanceSquared) return true;
        }
      }
    }
    return false;
  }
}

function spacingForTone(family, tone) {
  const dark = family.spacingDark ?? family.spacing ?? 6;
  const light = family.spacingLight ?? family.spacing ?? dark;
  const normalized = clamp((tone - (family.minTone ?? 0)) / Math.max(0.001, 1 - (family.minTone ?? 0)));
  const eased = normalized * normalized * (3 - 2 * normalized);
  return light + (dark - light) * eased;
}

function sampleField(config, family, x, y) {
  if (!config.mask(x, y)) return null;
  const tone = clamp(config.tone(x, y));
  if (tone < (family.minTone ?? 0)) return null;
  const angle = config.direction(x, y, family);
  if (!Number.isFinite(angle)) return null;
  return { tone, angle };
}

function inferredReferenceFamily(family, families) {
  if (family.angleAgainst) {
    const explicit = families.find((candidate) => candidate.name === family.angleAgainst);
    if (!explicit) {
      throw new Error(`Unknown angleAgainst family ${family.angleAgainst} for ${family.name ?? "cross"}`);
    }
    return explicit;
  }
  const name = String(family.name ?? "");
  const isCrossFamily = family.role === "cross" || /cross$/i.test(name);
  if (!isCrossFamily) return null;
  const baseName = name.replace(/cross$/i, "");
  if (baseName) {
    const base = families.find(
      (candidate) => String(candidate.name ?? "").toLowerCase() === baseName.toLowerCase(),
    );
    if (base) return base;
  }
  return families.find((candidate) => candidate.name === "primary")
    ?? families.find(
      (candidate) => candidate !== family
        && candidate.role !== "cross"
        && !/cross$/i.test(String(candidate.name ?? "")),
    )
    ?? null;
}

export function auditCrossFamilyAngles(config) {
  const policy = config.anglePolicy ?? {};
  const columns = Math.max(2, Math.floor(policy.sampleColumns ?? 9));
  const rows = Math.max(2, Math.floor(policy.sampleRows ?? 9));
  const medianMinDeg = policy.medianMinDeg ?? 25;
  const medianMaxDeg = policy.medianMaxDeg ?? 55;
  const localMaxDeg = policy.localMaxDeg ?? 70;
  const audits = [];

  for (const family of config.families) {
    const reference = inferredReferenceFamily(family, config.families);
    if (!reference) continue;
    const separations = [];
    for (let row = 0; row < rows; row++) {
      const y = config.bounds.y + config.bounds.height * (row + 0.5) / rows;
      for (let column = 0; column < columns; column++) {
        const x = config.bounds.x + config.bounds.width * (column + 0.5) / columns;
        const referenceSample = sampleField(config, reference, x, y);
        const familySample = sampleField(config, family, x, y);
        if (!referenceSample || !familySample) continue;
        separations.push(axisSeparation(referenceSample.angle, familySample.angle) * 180 / Math.PI);
      }
    }
    separations.sort((a, b) => a - b);
    const medianDeg = percentile(separations, 0.5);
    const p95Deg = percentile(separations, 0.95);
    const maxDeg = separations.length > 0 ? separations[separations.length - 1] : null;
    const pass = separations.length === 0
      || (medianDeg >= medianMinDeg && medianDeg <= medianMaxDeg && maxDeg <= localMaxDeg);
    audits.push({
      family: family.name ?? "cross",
      against: reference.name ?? "primary",
      sampleCount: separations.length,
      medianDeg: medianDeg === null ? null : Number(medianDeg.toFixed(3)),
      p95Deg: p95Deg === null ? null : Number(p95Deg.toFixed(3)),
      maxDeg: maxDeg === null ? null : Number(maxDeg.toFixed(3)),
      required: { medianMinDeg, medianMaxDeg, localMaxDeg },
      pass,
    });
  }
  return audits;
}

function traceHalf(config, family, seed, sign, occupancy) {
  const step = family.step ?? 3;
  const maxSteps = Math.ceil((family.maxLength ?? 180) / step);
  const maxTurn = family.maxTurn ?? 0.42;
  const clearanceFactor = family.clearanceFactor ?? 0.78;
  const points = [];
  let current = { ...seed };
  const initial = sampleField(config, family, current.x, current.y);
  if (!initial) return points;
  let previousAngle = initial.angle + (sign < 0 ? Math.PI : 0);

  for (let index = 0; index < maxSteps; index++) {
    const atCurrent = sampleField(config, family, current.x, current.y);
    if (!atCurrent) break;
    const angle0 = alignAxis(atCurrent.angle, previousAngle);
    const midX = current.x + Math.cos(angle0) * step * 0.5;
    const midY = current.y + Math.sin(angle0) * step * 0.5;
    const atMid = sampleField(config, family, midX, midY);
    if (!atMid) break;
    const angleMid = alignAxis(atMid.angle, angle0);
    if (Math.abs(shortestAngleDelta(angleMid, previousAngle)) > maxTurn) break;

    const next = {
      x: current.x + Math.cos(angleMid) * step,
      y: current.y + Math.sin(angleMid) * step,
      tone: atMid.tone,
    };
    const atNext = sampleField(config, family, next.x, next.y);
    if (!atNext) break;
    const clearance = spacingForTone(family, atNext.tone) * clearanceFactor;
    if (index > 1 && occupancy.hasNearby(next.x, next.y, clearance)) break;
    points.push(next);
    current = next;
    previousAngle = angleMid;
  }
  return points;
}

function makeSeedCandidates(config, family, rng) {
  const { x, y, width, height } = config.bounds;
  const seedStep = family.seedStep ?? Math.max(2, (family.spacingDark ?? family.spacing ?? 6) * 0.72);
  const jitter = family.seedJitter ?? 0.34;
  const candidates = [];
  let row = 0;
  for (let yy = y + seedStep * 0.5; yy < y + height; yy += seedStep) {
    const rowOffset = (row++ % 2) * seedStep * 0.5;
    for (let xx = x + seedStep * 0.5 + rowOffset; xx < x + width; xx += seedStep) {
      const px = xx + (rng() * 2 - 1) * seedStep * jitter;
      const py = yy + (rng() * 2 - 1) * seedStep * jitter;
      const sample = sampleField(config, family, px, py);
      if (!sample) continue;
      candidates.push({
        x: px,
        y: py,
        tone: sample.tone,
        priority: sample.tone + rng() * (family.priorityJitter ?? 0.08),
      });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

export function generateHatchFamily(config, family, rng = createRng(config.seed ?? 1)) {
  const smallestSpacing = Math.min(
    family.spacingDark ?? family.spacing ?? 6,
    family.spacingLight ?? family.spacing ?? 6,
  );
  const occupancy = new SpatialHash(Math.max(1, smallestSpacing));
  const candidates = makeSeedCandidates(config, family, rng);
  const streamlines = [];
  const maxLines = family.maxLines ?? 10_000;
  const minLength = family.minLength ?? 18;

  for (const seed of candidates) {
    if (streamlines.length >= maxLines) break;
    const desiredSpacing = spacingForTone(family, seed.tone);
    if (occupancy.hasNearby(seed.x, seed.y, desiredSpacing * 0.9)) continue;

    const backward = traceHalf(config, family, seed, -1, occupancy).reverse();
    const forward = traceHalf(config, family, seed, 1, occupancy);
    const points = [...backward, { x: seed.x, y: seed.y, tone: seed.tone }, ...forward];
    const length = polylineLength(points);
    if (points.length < 3 || length < minLength) continue;

    const meanTone = points.reduce((sum, point) => sum + point.tone, 0) / points.length;
    const line = { family: family.name ?? "hatch", points, length, meanTone };
    streamlines.push(line);
    for (const point of points) occupancy.add(point);
  }

  return streamlines;
}

export function generateFieldHatching(config) {
  if (!config || typeof config !== "object") throw new Error("A hatching config object is required");
  if (!config.bounds || typeof config.mask !== "function" || typeof config.tone !== "function" || typeof config.direction !== "function") {
    throw new Error("Config must define bounds, mask(x,y), tone(x,y), and direction(x,y,family)");
  }
  if (!Array.isArray(config.families) || config.families.length === 0) {
    throw new Error("Config must define at least one hatch family");
  }

  const angleAudit = auditCrossFamilyAngles(config);
  const failedAngleAudit = angleAudit.find((audit) => !audit.pass);
  if (failedAngleAudit) {
    throw new Error(
      `Cross-family angle policy failed for ${failedAngleAudit.family} against ${failedAngleAudit.against}: `
      + `median ${failedAngleAudit.medianDeg}°, max ${failedAngleAudit.maxDeg}°; `
      + `required median ${failedAngleAudit.required.medianMinDeg}–${failedAngleAudit.required.medianMaxDeg}° `
      + `and local max <= ${failedAngleAudit.required.localMaxDeg}°`,
    );
  }

  const rootRng = createRng(config.seed ?? 1);
  const byFamily = {};
  const all = [];
  for (const family of config.families) {
    const familySeed = Math.floor(rootRng() * 0xffffffff) >>> 0;
    const lines = generateHatchFamily(config, family, createRng(familySeed));
    byFamily[family.name ?? `family-${Object.keys(byFamily).length + 1}`] = lines;
    all.push(...lines);
  }
  return { lines: all, byFamily, angleAudit };
}

function splitIntoGestures(line, style, rng) {
  const minGesture = style.gestureMin ?? 34;
  const maxGesture = style.gestureMax ?? 100;
  const gestures = [];
  let current = [];
  let accumulated = 0;
  let target = minGesture + (maxGesture - minGesture) * rng();

  for (let index = 0; index < line.points.length; index++) {
    const point = line.points[index];
    if (current.length > 0) {
      const previous = current[current.length - 1];
      accumulated += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    current.push(point);
    if (accumulated >= target && current.length >= 4) {
      gestures.push(current);
      current = [point];
      accumulated = 0;
      target = minGesture + (maxGesture - minGesture) * rng();
    }
  }
  if (current.length >= 3) gestures.push(current);
  return gestures;
}

function addHandVariation(points, style, rng) {
  const wobble = style.wobble ?? 0.45;
  const phaseA = rng() * TAU;
  const phaseB = rng() * TAU;
  let running = 0;
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    if (index > 0) running += Math.hypot(point.x - previous.x, point.y - previous.y);
    const tx = next.x - previous.x;
    const ty = next.y - previous.y;
    const length = Math.hypot(tx, ty) || 1;
    const nx = -ty / length;
    const ny = tx / length;
    const offset = wobble * (Math.sin(running * 0.09 + phaseA) * 0.62 + Math.sin(running * 0.027 + phaseB) * 0.38);
    return { ...point, x: point.x + nx * offset, y: point.y + ny * offset };
  });
}

export function streamlinesToStrokeOperations(lines, familyStyles, options = {}) {
  const rng = createRng(options.seed ?? 1);
  let strokeSeed = options.strokeSeed ?? 1;
  const operations = [];

  for (const line of lines) {
    const style = familyStyles[line.family] ?? familyStyles.default;
    if (!style) throw new Error(`Missing style for hatch family ${line.family}`);
    const gestures = splitIntoGestures(line, style, rng);
    for (const rawGesture of gestures) {
      const gesture = addHandVariation(rawGesture, style, rng);
      const meanTone = gesture.reduce((sum, point) => sum + point.tone, 0) / gesture.length;
      const size = clamp(
        (style.size ?? 1.15) + meanTone * (style.toneSize ?? 0.35) + (rng() * 2 - 1) * (style.sizeJitter ?? 0.08),
        style.minSize ?? 0.35,
        style.maxSize ?? 8,
      );
      const opacity = clamp(
        (style.opacity ?? 0.14) + meanTone * (style.toneOpacity ?? 0.16) + (rng() * 2 - 1) * (style.opacityJitter ?? 0.018),
        style.minOpacity ?? 0.02,
        style.maxOpacity ?? 0.75,
      );
      const points = gesture.map((point, index) => {
        const unit = index / Math.max(1, gesture.length - 1);
        const taperFloor = clamp(style.taperFloor ?? 0.24, 0, 1);
        const taper = taperFloor + Math.sin(unit * Math.PI) * (1 - taperFloor);
        const grain = 0.92 + Math.sin(unit * 11.7 + rng() * 0.35) * 0.08;
        return {
          x: point.x,
          y: point.y,
          pressure: clamp(taper * grain * (style.pressure ?? 0.74), 0.06, 1),
        };
      });
      operations.push({
        method: "draw.stroke",
        params: {
          layerId: style.layerId,
          tool: style.tool ?? "brush",
          color: style.color ?? "#4d4a45",
          size,
          opacity,
          points,
          ...(style.brush ? { brushPresetId: style.brush.id, brush: style.brush } : {}),
          ...(!style.brush && style.brushPresetId ? { brushPresetId: style.brushPresetId } : {}),
          seed: strokeSeed++ >>> 0,
          strokeVersion: 2,
        },
      });
    }
  }
  return operations;
}

export function batchOperations(operations, batchSize = 200) {
  const safeBatchSize = Math.max(1, Math.min(2000, Math.floor(batchSize)));
  const batches = [];
  for (let index = 0; index < operations.length; index += safeBatchSize) {
    batches.push({
      method: "draw.batch",
      params: { operations: operations.slice(index, index + safeBatchSize) },
    });
  }
  return batches;
}

function validateStrokeOperations(operations) {
  for (const operation of operations) {
    if (operation.method !== "draw.stroke") throw new Error("Only native draw.stroke operations may be emitted");
    const { points, opacity, size } = operation.params;
    if (!Array.isArray(points) || points.length < 2) throw new Error("Every stroke needs at least two points");
    if (!(opacity > 0 && opacity <= 1) || !(size > 0)) throw new Error("Stroke opacity and size must be positive");
    for (const point of points) {
      if (![point.x, point.y, point.pressure].every(Number.isFinite)) throw new Error("Stroke points must be finite");
      if (point.pressure < 0 || point.pressure > 1) throw new Error("Pressure must be within [0,1]");
    }
  }
}

async function runSelfTest() {
  const config = {
    seed: 4242,
    bounds: { x: 0, y: 0, width: 160, height: 140 },
    mask: (x, y) => ((x - 80) / 63) ** 2 + ((y - 70) / 54) ** 2 < 1,
    tone: (x, y) => clamp(0.18 + x / 220 + y / 460),
    direction: (x, y, family) => (family.angle ?? Math.PI / 2) + (x - 80) * 0.0028 + (y - 70) * 0.0009,
    families: [
      { name: "primary", minTone: 0.18, spacingLight: 11, spacingDark: 6, step: 2.5, minLength: 16, maxLength: 170 },
      { name: "cross", angleAgainst: "primary", minTone: 0.48, angle: Math.PI / 2 - 0.72, spacingLight: 10, spacingDark: 6.5, step: 2.5, minLength: 14, maxLength: 150 },
    ],
  };
  const first = generateFieldHatching(config);
  const second = generateFieldHatching(config);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Determinism self-test failed");
  if (first.lines.length < 8) throw new Error("Coverage self-test failed");
  if (first.angleAudit.length !== 1 || !first.angleAudit[0].pass) throw new Error("Cross-angle self-test failed");
  for (const line of first.lines) {
    if (line.length < 14) throw new Error("Minimum length self-test failed");
    for (const point of line.points) {
      if (!config.mask(point.x, point.y)) throw new Error("Mask clipping self-test failed");
    }
  }
  const operations = streamlinesToStrokeOperations(first.lines, {
    primary: { layerId: "L_selftest01", color: "#4d4a45" },
    cross: { layerId: "L_selftest01", color: "#4d4a45" },
  }, { seed: 99, strokeSeed: 1000 });
  validateStrokeOperations(operations);
  return {
    lines: first.lines.length,
    strokes: operations.length,
    batches: batchOperations(operations, 50).length,
    angleAudit: first.angleAudit,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    console.log(JSON.stringify(await runSelfTest(), null, 2));
    return;
  }
  const configIndex = args.indexOf("--config");
  const outIndex = args.indexOf("--out");
  if (configIndex < 0 || outIndex < 0 || !args[configIndex + 1] || !args[outIndex + 1]) {
    throw new Error("Usage: field-hatching.mjs --config <config.mjs> --out <operations.jsonl> [--report <report.json>]");
  }
  const configPath = resolve(args[configIndex + 1]);
  const outputPath = resolve(args[outIndex + 1]);
  const module = await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`);
  const config = module.default;
  const result = generateFieldHatching(config);
  const operations = streamlinesToStrokeOperations(result.lines, config.styles, {
    seed: config.strokeStyleSeed ?? config.seed ?? 1,
    strokeSeed: config.strokeSeed ?? 1,
  });
  validateStrokeOperations(operations);
  const batches = batchOperations(operations, config.batchSize ?? 200);
  await writeFile(outputPath, `${batches.map((operation) => JSON.stringify(operation)).join("\n")}\n`);
  const report = {
    seed: config.seed ?? 1,
    lineCount: result.lines.length,
    strokeCount: operations.length,
    batchCount: batches.length,
    familyCounts: Object.fromEntries(Object.entries(result.byFamily).map(([name, lines]) => [name, lines.length])),
    angleAudit: result.angleAudit,
  };
  const reportIndex = args.indexOf("--report");
  if (reportIndex >= 0 && args[reportIndex + 1]) {
    await writeFile(resolve(args[reportIndex + 1]), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
