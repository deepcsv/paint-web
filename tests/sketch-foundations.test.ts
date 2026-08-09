import { describe, expect, it } from "vitest";

import {
  auditCrossFamilyAngles,
  axisSeparation,
  batchOperations,
  clamp,
  generateFieldHatching,
  streamlinesToStrokeOperations,
} from "../skills/sketch-foundations/scripts/field-hatching.mjs";

function axisError(actual: number, expected: number): number {
  let error = Math.abs(actual - expected) % Math.PI;
  if (error > Math.PI / 2) error = Math.PI - error;
  return error;
}

function makeConfig() {
  return {
    seed: 10_824,
    bounds: { x: 0, y: 0, width: 240, height: 210 },
    mask: (x: number, y: number) => ((x - 120) / 94) ** 2 + ((y - 105) / 82) ** 2 < 1,
    tone: (x: number, y: number) => clamp(0.12 + x / 280 + y / 900),
    direction: (x: number, y: number, family: { offset?: number }) =>
      Math.PI / 2 + (family.offset ?? 0) + (x - 120) * 0.0023 + (y - 105) * 0.0007,
    families: [
      {
        name: "primary",
        minTone: 0.14,
        spacingLight: 13,
        spacingDark: 7,
        step: 2.5,
        minLength: 18,
        maxLength: 220,
      },
      {
        name: "cross",
        angleAgainst: "primary",
        offset: -0.62,
        minTone: 0.56,
        spacingLight: 12,
        spacingDark: 7.5,
        step: 2.5,
        minLength: 16,
        maxLength: 180,
      },
    ],
  };
}

describe("sketch-foundations field hatching", () => {
  it("is deterministic for a fixed seed", () => {
    const first = generateFieldHatching(makeConfig());
    const second = generateFieldHatching(makeConfig());
    expect(second).toEqual(first);
    expect(first.lines.length).toBeGreaterThan(20);
  });

  it("keeps every streamline inside its mask and tone band", () => {
    const config = makeConfig();
    const result = generateFieldHatching(config);
    const families = new Map(config.families.map((family) => [family.name, family]));
    for (const line of result.lines) {
      const family = families.get(line.family)!;
      expect(line.length).toBeGreaterThanOrEqual(family.minLength);
      for (const point of line.points) {
        expect(config.mask(point.x, point.y)).toBe(true);
        expect(config.tone(point.x, point.y)).toBeGreaterThanOrEqual(family.minTone - 1e-9);
      }
    }
  });

  it("tracks the unoriented direction field coherently", () => {
    const config = makeConfig();
    const result = generateFieldHatching(config);
    const families = new Map(config.families.map((family) => [family.name, family]));
    const errors: number[] = [];
    for (const line of result.lines) {
      const family = families.get(line.family)!;
      for (let index = 1; index < line.points.length; index++) {
        const previous = line.points[index - 1];
        const current = line.points[index];
        const actual = Math.atan2(current.y - previous.y, current.x - previous.x);
        const expected = config.direction(
          (current.x + previous.x) * 0.5,
          (current.y + previous.y) * 0.5,
          family,
        );
        errors.push(axisError(actual, expected));
      }
    }
    errors.sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length * 0.5)]).toBeLessThan(0.08);
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(0.18);
  });

  it("keeps the cross family oblique rather than perpendicular", () => {
    const config = makeConfig();
    const primary = config.families[0];
    const cross = config.families[1];
    for (const [x, y] of [[80, 80], [120, 105], [165, 135]]) {
      const separation = axisSeparation(
        config.direction(x, y, primary),
        config.direction(x, y, cross),
      );
      expect(separation * 180 / Math.PI).toBeGreaterThanOrEqual(25);
      expect(separation * 180 / Math.PI).toBeLessThanOrEqual(55);
    }
    const [audit] = auditCrossFamilyAngles(config);
    expect(audit.pass).toBe(true);
    expect(audit.medianDeg).toBeGreaterThanOrEqual(25);
    expect(audit.medianDeg).toBeLessThanOrEqual(55);
    expect(audit.maxDeg).toBeLessThanOrEqual(70);
  });

  it("rejects a near-perpendicular cross family before generating strokes", () => {
    const config = makeConfig();
    config.families[1].offset = Math.PI / 2;
    expect(() => generateFieldHatching(config)).toThrow(/Cross-family angle policy failed/);
  });

  it("rejects an unknown cross-family reference", () => {
    const config = makeConfig();
    config.families[1].angleAgainst = "missing-family";
    expect(() => generateFieldHatching(config)).toThrow(/Unknown angleAgainst family/);
  });

  it("emits finite, pressure-tapered native strokes in bounded batches", () => {
    const result = generateFieldHatching(makeConfig());
    const operations = streamlinesToStrokeOperations(result.lines, {
      primary: { layerId: "L_primary01", color: "#514e48" },
      cross: { layerId: "L_cross01", color: "#45423e" },
    }, { seed: 77, strokeSeed: 9_000 });
    expect(operations.length).toBeGreaterThan(result.lines.length);
    for (const operation of operations) {
      expect(operation.method).toBe("draw.stroke");
      expect(operation.params.opacity).toBeGreaterThan(0);
      expect(operation.params.opacity).toBeLessThanOrEqual(1);
      expect(operation.params.points.length).toBeGreaterThanOrEqual(2);
      expect(operation.params.points.every((point: { x: number; y: number; pressure: number }) =>
        Number.isFinite(point.x) && Number.isFinite(point.y)
        && point.pressure >= 0 && point.pressure <= 1)).toBe(true);
      expect(operation.params.points[0].pressure).toBeLessThan(
        operation.params.points[Math.floor(operation.params.points.length / 2)].pressure,
      );
    }
    const batches = batchOperations(operations, 17);
    expect(batches.every((batch: { params: { operations: unknown[] } }) => batch.params.operations.length <= 17)).toBe(true);
  });
});
