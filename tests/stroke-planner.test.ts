import { describe, expect, it } from "vitest";
import { planStroke } from "../src/brush/StrokePlanner.js";

describe("StrokePlanner", () => {
  it("streamlines sparse paths without dropping their committed endpoint", () => {
    const planned = planStroke(
      [{ x: 0, y: 0 }, { x: 100, y: 20 }, { x: 200, y: 0 }],
      { size: 20, last: true },
    );

    expect(planned.length).toBeGreaterThan(2);
    expect(planned.at(-1)).toMatchObject({ x: 200, y: 0 });
  });

  it("keeps simulated pressure useful for sparse agent-authored points", () => {
    const planned = planStroke(
      [{ x: 0, y: 0 }, { x: 300, y: 0 }],
      { size: 12, simulatePressure: true },
    );

    expect(Math.min(...planned.map((point) => point.pressure ?? 0))).toBeGreaterThanOrEqual(0.28);
  });

  it("preserves explicit pen pressure", () => {
    const planned = planStroke(
      [{ x: 0, y: 0, pressure: 0.2 }, { x: 20, y: 0, pressure: 0.8 }],
      { size: 10, simulatePressure: true },
    );

    expect(planned[0]?.pressure).toBeCloseTo(0.2);
    expect(planned.at(-1)?.pressure).toBeCloseTo(0.8);
  });

  it("is deterministic", () => {
    const points = [{ x: 4, y: 8 }, { x: 40, y: 22 }, { x: 90, y: 10 }];
    expect(planStroke(points, { size: 14 })).toEqual(planStroke(points, { size: 14 }));
  });
});
