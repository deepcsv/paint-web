import { describe, expect, it, vi } from "vitest";
import { DocumentConflictError, DocumentStore, transactionFingerprint } from "../server/document-store.js";
import { ServerState } from "../server/state.js";

function createStore() {
  const state = new ServerState();
  const onChange = vi.fn();
  const store = new DocumentStore(state.snapshot(), onChange);
  store.captureBaseline(state.layers.map((layer) => ({ id: layer.id, png: "base64" })));
  return { state, store, onChange };
}

describe("DocumentStore", () => {
  it("records deterministic commits and replay snapshots", () => {
    const { state, store } = createStore();
    const layer = state.createLayer("Ink", "L_ink");

    const commit = store.recordOperation(
      "layer.create",
      { name: "Ink" },
      { layerId: layer.id },
      state.snapshot(),
      "agent",
    );
    const replay = store.getReplaySnapshot();

    expect(commit.revision).toBe(1);
    expect(replay.replayable).toBe(true);
    expect(replay.operations).toHaveLength(1);
    expect(replay.operations[0]).toMatchObject({
      method: "layer.create",
      params: { name: "Ink", layerId: "L_ink" },
    });
    expect(replay.state.layers).toHaveLength(2);
  });

  it("supports exact undo and redo plans", () => {
    const { state, store } = createStore();
    state.createLayer("One", "L_one");
    const one = store.recordOperation("layer.create", {}, { layerId: "L_one" }, state.snapshot(), "agent");
    state.createLayer("Two", "L_two");
    const two = store.recordOperation("layer.create", {}, { layerId: "L_two" }, state.snapshot(), "agent");

    const undo = store.planUndo(2);
    store.applyUndo(undo);
    expect(store.revision).toBe(0);
    expect(store.history().canRedo).toBe(true);

    const redoOne = store.planRedo(1);
    store.applyRedo(redoOne);
    expect(store.currentCommitId).toBe(one.id);

    const redoTwo = store.planRedo(1);
    store.applyRedo(redoTwo);
    expect(store.currentCommitId).toBe(two.id);
  });

  it("creates independent branch pointers and checkpoints", () => {
    const { state, store } = createStore();
    state.createLayer("Ink", "L_ink");
    const commit = store.recordOperation("layer.create", {}, { layerId: "L_ink" }, state.snapshot(), "agent");

    store.createBranch("experiments/neon");
    store.createCheckpoint("approved-v1");

    expect(store.listBranches().branches).toContainEqual({
      name: "experiments/neon",
      commitId: commit.id,
    });
    expect(store.listCheckpoints().checkpoints).toContainEqual({
      name: "approved-v1",
      commitId: commit.id,
      revision: 1,
    });
  });

  it("replays an idempotent transaction without creating another commit", () => {
    const { state, store } = createStore();
    const operations = [{ method: "draw.line", params: { layerId: state.activeLayerId } }];
    const fingerprint = transactionFingerprint(operations);
    const first = store.recordTransaction({
      idempotencyKey: "tx-1",
      fingerprint,
      message: "line",
      operations,
      results: [{ ok: true }],
      state: state.snapshot(),
      clientId: "agent",
    });
    const replayed = store.lookupTransaction("tx-1", fingerprint);

    expect(replayed).toMatchObject({
      transactionId: first.transactionId,
      commitId: first.commitId,
      revision: first.revision,
      replayed: true,
    });
    expect(store.revision).toBe(1);
  });

  it("rejects reuse of an idempotency key with different operations", () => {
    const { state, store } = createStore();
    const firstOps = [{ method: "canvas.clear", params: {} }];
    const firstFingerprint = transactionFingerprint(firstOps);
    store.recordTransaction({
      idempotencyKey: "same-key",
      fingerprint: firstFingerprint,
      message: "clear",
      operations: firstOps,
      results: [{ ok: true }],
      state: state.snapshot(),
      clientId: "agent",
    });

    expect(() =>
      store.lookupTransaction(
        "same-key",
        transactionFingerprint([{ method: "canvas.fill", params: { color: "#ffffff" } }]),
      ),
    ).toThrow(DocumentConflictError);
  });

  it("loads a persisted canonical document", () => {
    const { state, store } = createStore();
    state.createLayer("Ink", "L_ink");
    store.recordOperation("layer.create", {}, { layerId: "L_ink" }, state.snapshot(), "agent");

    const loaded = new DocumentStore(state.snapshot(), () => {}, JSON.parse(store.serialize()));

    expect(loaded.documentId).toBe(store.documentId);
    expect(loaded.currentCommitId).toBe(store.currentCommitId);
    expect(loaded.getReplaySnapshot()).toEqual(store.getReplaySnapshot());
  });

  it("uses the newest raster keyframe as the replay baseline", () => {
    const { state, store } = createStore();
    const active = state.activeLayerId;
    store.recordOperation(
      "draw.line",
      { layerId: active },
      { ok: true },
      state.snapshot(),
      "agent",
    );
    store.recordOperation(
      "canvas.import",
      { url: "https://example.test/art.png", layerId: active },
      { ok: true },
      state.snapshot(),
      "agent",
      [{ id: active, png: "imported-raster" }],
    );

    const replay = store.getReplaySnapshot();

    expect(replay.replayable).toBe(true);
    expect(replay.baseRaster).toEqual([{ id: active, png: "imported-raster" }]);
    expect(replay.operations).toEqual([]);
  });

  it("reports the checked-out branch even when its head commit was created elsewhere", () => {
    const { store } = createStore();
    store.createBranch("experiment");
    store.applyBranchSwitch("experiment");

    expect(store.getReplaySnapshot().branch).toBe("experiment");
  });

  it("records only successful operations from a compatibility draw.batch", () => {
    const { state, store } = createStore();
    store.recordOperation(
      "draw.batch",
      {
        operations: [
          { method: "draw.setPixel", params: { layerId: state.activeLayerId } },
          { method: "draw.line", params: { layerId: state.activeLayerId } },
        ],
      },
      {
        results: [
          { ok: true },
          { code: -32004, message: "Layer not found" },
        ],
      },
      state.snapshot(),
      "agent",
    );

    expect(store.getReplaySnapshot().operations).toHaveLength(1);
    expect(store.getReplaySnapshot().operations[0]?.method).toBe("draw.setPixel");
  });
});
