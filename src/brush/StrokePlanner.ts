import { getStrokePoints } from "perfect-freehand";
import type { StrokePoint } from "./BrushTypes.js";

export interface StrokePlanOptions {
  /** Nominal brush diameter. Used to normalize velocity. */
  size: number;
  /** 0 keeps more raw motion; 1 strongly streamlines the center path. */
  streamline?: number;
  /** Infer pressure from velocity when the input has no pressure samples. */
  simulatePressure?: boolean;
  /** Whether the final sample is the committed end of the stroke. */
  last?: boolean;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Build a stable centerline for the stamp renderer.
 *
 * perfect-freehand supplies its battle-tested input streamlining and point
 * metrics. We retain the centerline rather than its outline because textured
 * brushes must place individual dabs. Mouse/agent strokes without pressure
 * receive a deterministic velocity-pressure curve; pen pressure is preserved.
 */
export function planStroke(
  points: StrokePoint[],
  options: StrokePlanOptions,
): StrokePoint[] {
  if (points.length === 0) return [];

  const hasExplicitPressure = points.some((point) => point.pressure !== undefined);
  const planned = getStrokePoints(points, {
    size: Math.max(1, options.size),
    streamline: options.streamline ?? 0.42,
    simulatePressure: false,
    last: options.last ?? true,
  });

  let rollingPressure = clamp01(points[0]?.pressure ?? 0.5);
  const size = Math.max(1, options.size);

  return planned.map((sample, index) => {
    let pressure: number;
    if (hasExplicitPressure) {
      pressure = sampleSourcePressure(sample.point[0], sample.point[1], points);
    } else if (options.simulatePressure !== false) {
      // Fast motion produces a lighter/narrower line. The rolling blend avoids
      // visible pressure steps at irregular pointer sampling intervals.
      // Coordinates do not carry timestamps, so distance is only a weak
      // velocity signal. Keep the modulation intentionally subtle: sparse
      // agent-authored paths must not collapse into hairlines.
      const normalizedVelocity = sample.distance / size;
      const target = clamp(0.64 - normalizedVelocity * 0.12, 0.3, 0.82);
      rollingPressure = index === 0
        ? rollingPressure
        : rollingPressure + (target - rollingPressure) * 0.32;
      pressure = Math.max(0.28, rollingPressure);
    } else {
      pressure = 0.5;
    }

    return {
      x: sample.point[0],
      y: sample.point[1],
      pressure,
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sampleSourcePressure(x: number, y: number, points: StrokePoint[]): number {
  if (points.length === 1) return clamp01(points[0]?.pressure ?? 0.5);
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestPressure = points[0]?.pressure ?? 0.5;

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0
      ? 0
      : clamp(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared, 0, 1);
    const projectedX = start.x + dx * t;
    const projectedY = start.y + dy * t;
    const distanceSquared = (x - projectedX) ** 2 + (y - projectedY) ** 2;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestPressure = (start.pressure ?? 0.5) + ((end.pressure ?? 0.5) - (start.pressure ?? 0.5)) * t;
    }
  }

  return clamp01(bestPressure);
}
