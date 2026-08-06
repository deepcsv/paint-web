import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  JSONRPC_VERSION,
  type InternalExecParams,
  type InternalSnapshotParams,
  type RpcId,
} from "../shared/protocol.js";
import { RpcError } from "./rpc/errors.js";

interface PendingExec {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * PrimaryClient — manages election of the "primary browser" (pixel authority)
 * and proxies pixel-level RPCs to it with a 15s timeout.
 *
 * Each browser connection tags itself as a candidate via sync.hello.
 * First connected browser is primary. On primary disconnect, the next
 * eligible browser (by connect time) is promoted.
 */
export class PrimaryClient {
  private primaryConn: WebSocket | null = null;
  private candidates: WebSocket[] = []; // in promotion order
  private pending: Map<string, PendingExec> = new Map();
  readonly proxyTimeoutMs = 15_000;

  setCandidate(conn: WebSocket, isBrowser: boolean): void {
    if (!isBrowser) return;
    if (!this.candidates.includes(conn)) this.candidates.push(conn);
    if (this.primaryConn === null) this.electPrimary();
  }

  drop(conn: WebSocket): void {
    this.candidates = this.candidates.filter((c) => c !== conn);
    if (this.primaryConn === conn) {
      this.primaryConn = null;
      // Fail all pending RPCs
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(RpcError.noPrimary());
        this.pending.delete(id);
      }
      this.electPrimary();
    }
  }

  current(): WebSocket | null {
    return this.primaryConn;
  }

  hasPrimary(): boolean {
    return this.primaryConn !== null && this.primaryConn.readyState === 1 /* OPEN */;
  }

  /** Whether the given connection is the primary. */
  isPrimary(conn: WebSocket): boolean {
    return this.primaryConn === conn;
  }

  /**
   * Proxy a pixel-level RPC to the primary. Resolves with the primary's
   * result; rejects on timeout or primary loss.
   */
  exec(origMethod: string, origParams: unknown): Promise<unknown> {
    if (!this.hasPrimary() || !this.primaryConn) {
      return Promise.reject(RpcError.noPrimary());
    }
    const requestId = randomUUID() as unknown as RpcId;
    const execId = String(requestId);
    const params: InternalExecParams = { origMethod, origParams, requestId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(execId);
        reject(RpcError.primaryTimeout());
      }, this.proxyTimeoutMs);

      this.pending.set(execId, { resolve, reject, timer });

      const conn = this.primaryConn;
      if (!conn) {
        clearTimeout(timer);
        this.pending.delete(execId);
        reject(RpcError.noPrimary());
        return;
      }
      conn.send(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          method: "internal.exec",
          params,
        }),
      );
    });
  }

  /** Called when a response to an `internal.exec` arrives from the primary. */
  resolveExec(requestId: RpcId, result: unknown, error?: unknown): void {
    const execId = String(requestId);
    const p = this.pending.get(execId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(execId);
    if (error !== undefined) p.reject(error);
    else p.resolve(result);
  }

  /** Request a snapshot PNG from the primary. */
  snapshot(): Promise<{ png: Buffer; width: number; height: number }> {
    if (!this.hasPrimary() || !this.primaryConn) {
      return Promise.reject(RpcError.noPrimary());
    }
    const requestId = randomUUID() as unknown as RpcId;
    const execId = String(requestId);
    const params: InternalSnapshotParams = { requestId, metadataOnly: false };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(execId);
        reject(RpcError.primaryTimeout());
      }, this.proxyTimeoutMs);

      this.pending.set(execId, {
        resolve: (v) => resolve(v as { png: Buffer; width: number; height: number }),
        reject,
        timer,
      });

      const conn = this.primaryConn;
      if (!conn) {
        clearTimeout(timer);
        this.pending.delete(execId);
        reject(RpcError.noPrimary());
        return;
      }
      conn.send(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          method: "internal.snapshot",
          params,
        }),
      );
    });
  }

  private electPrimary(): void {
    // Remove stale candidates (closed)
    this.candidates = this.candidates.filter((c) => c.readyState === 1);
    const next = this.candidates[0];
    if (!next) {
      this.primaryConn = null;
      return;
    }
    this.primaryConn = next;
    // Notify the new primary (its app.ts will register handlers accordingly)
    next.send(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        method: "internal.primaryPromotion",
        params: {},
      }),
    );
  }
}
