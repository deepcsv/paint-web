import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PrimaryClient } from "../server/primary-client.js";

class FakeSocket {
  readyState = 1;
  readonly sent: unknown[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }
}

describe("PrimaryClient", () => {
  it("evicts an unresponsive primary and promotes the next browser", async () => {
    vi.useFakeTimers();
    try {
      const primary = new PrimaryClient();
      const stalled = new FakeSocket();
      const replacement = new FakeSocket();
      primary.setCandidate(stalled as unknown as WebSocket, true);
      primary.setCandidate(replacement as unknown as WebSocket, true);

      const request = primary.exec("canvas.getInfo", {});
      const rejection = expect(request).rejects.toMatchObject({ code: -32002 });
      await vi.advanceTimersByTimeAsync(primary.proxyTimeoutMs);
      await rejection;

      expect(primary.isPrimary(stalled as unknown as WebSocket)).toBe(false);
      expect(primary.isPrimary(replacement as unknown as WebSocket)).toBe(true);
      expect(replacement.sent).toContainEqual(
        expect.objectContaining({ method: "internal.primaryPromotion" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("also evicts a primary when a snapshot request times out", async () => {
    vi.useFakeTimers();
    try {
      const primary = new PrimaryClient();
      const stalled = new FakeSocket();
      const replacement = new FakeSocket();
      primary.setCandidate(stalled as unknown as WebSocket, true);
      primary.setCandidate(replacement as unknown as WebSocket, true);

      const request = primary.snapshot();
      const rejection = expect(request).rejects.toMatchObject({ code: -32002 });
      await vi.advanceTimersByTimeAsync(primary.proxyTimeoutMs);
      await rejection;

      expect(primary.isPrimary(replacement as unknown as WebSocket)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows long document replay work without weakening normal RPC failover", async () => {
    vi.useFakeTimers();
    try {
      const primary = new PrimaryClient();
      const stalled = new FakeSocket();
      const replacement = new FakeSocket();
      primary.setCandidate(stalled as unknown as WebSocket, true);
      primary.setCandidate(replacement as unknown as WebSocket, true);

      const request = primary.exec("document.replay", {});
      const rejection = expect(request).rejects.toMatchObject({ code: -32002 });
      await vi.advanceTimersByTimeAsync(primary.proxyTimeoutMs);
      expect(primary.isPrimary(stalled as unknown as WebSocket)).toBe(true);
      await vi.advanceTimersByTimeAsync(primary.longProxyTimeoutMs - primary.proxyTimeoutMs);
      await rejection;

      expect(primary.isPrimary(replacement as unknown as WebSocket)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a connected renderer that lacks a routed method", async () => {
    const primary = new PrimaryClient();
    const outdated = new FakeSocket();
    const replacement = new FakeSocket();
    primary.setCandidate(outdated as unknown as WebSocket, true);
    primary.setCandidate(replacement as unknown as WebSocket, true);

    const request = primary.exec("draw.batch", { operations: [] });
    const sent = outdated.sent.at(-1) as { params: { requestId: string } };
    primary.resolveExec(sent.params.requestId, undefined, {
      code: -32601,
      message: "No handler for draw.batch",
    });

    await expect(request).rejects.toMatchObject({ code: -32601 });
    expect(primary.isPrimary(outdated as unknown as WebSocket)).toBe(false);
    expect(primary.isPrimary(replacement as unknown as WebSocket)).toBe(true);
  });
});
