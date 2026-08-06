import { describe, expect, it } from "vitest";
import { ServerState, StateInvariantError } from "../server/state.js";

describe("ServerState invariants", () => {
  it("never permits deleting the final layer", () => {
    const state = new ServerState();
    const onlyLayer = state.activeLayerId;

    expect(() => state.deleteLayer(onlyLayer)).toThrow(StateInvariantError);
    expect(state.layers).toHaveLength(1);
    expect(state.activeLayerId).toBe(onlyLayer);
  });

  it("selects a valid active layer after deleting the active layer", () => {
    const state = new ServerState();
    const first = state.activeLayerId;
    const second = state.createLayer("Second", "L_second");
    state.setActive(second.id);

    state.deleteLayer(second.id);

    expect(state.layers.map((layer) => layer.id)).toEqual([first]);
    expect(state.activeLayerId).toBe(first);
    expect(() => state.assertInvariants()).not.toThrow();
  });

  it("rolls back a failed structural transaction", () => {
    const state = new ServerState();
    const before = state.snapshot();

    expect(() =>
      state.transact(() => {
        state.createLayer("Temporary", "L_temporary");
        state.reorder([before.activeLayerId]);
      }),
    ).toThrow(StateInvariantError);

    expect(state.snapshot()).toEqual(before);
  });

  it("repairs a legacy empty or stale state on load", () => {
    const state = new ServerState();
    state.fromJSON({ width: 640, height: 480, layers: [], activeLayerId: "L_missing" });

    expect(state.width).toBe(640);
    expect(state.height).toBe(480);
    expect(state.layers).toHaveLength(1);
    expect(state.activeLayerId).toBe(state.layers[0]!.id);
  });

  it("requires a complete, duplicate-free reorder", () => {
    const state = new ServerState();
    const first = state.activeLayerId;
    state.createLayer("Second", "L_second");

    expect(() => state.reorder([first])).toThrow(StateInvariantError);
    expect(() => state.reorder([first, first])).toThrow(StateInvariantError);
    expect(() => state.reorder(["L_second", first])).not.toThrow();
    expect(state.layers.map((layer) => layer.id)).toEqual(["L_second", first]);
  });
});
