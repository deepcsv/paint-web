import { randomUUID } from "node:crypto";
import { JSONRPC_VERSION, } from "../shared/protocol.js";
import { RpcError } from "./rpc/errors.js";
/**
 * PrimaryClient — manages election of the "primary browser" (pixel authority)
 * and proxies pixel-level RPCs to it with a 15s timeout.
 *
 * Each browser connection tags itself as a candidate via sync.hello.
 * First connected browser is primary. On primary disconnect, the next
 * eligible browser (by connect time) is promoted.
 */
export class PrimaryClient {
    primaryConn = null;
    candidates = []; // in promotion order
    pending = new Map();
    proxyTimeoutMs = 15_000;
    setCandidate(conn, isBrowser) {
        if (!isBrowser)
            return;
        if (!this.candidates.includes(conn))
            this.candidates.push(conn);
        if (this.primaryConn === null)
            this.electPrimary();
    }
    drop(conn) {
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
    current() {
        return this.primaryConn;
    }
    hasPrimary() {
        return this.primaryConn !== null && this.primaryConn.readyState === 1 /* OPEN */;
    }
    /** Whether the given connection is the primary. */
    isPrimary(conn) {
        return this.primaryConn === conn;
    }
    /**
     * Proxy a pixel-level RPC to the primary. Resolves with the primary's
     * result; rejects on timeout or primary loss.
     */
    exec(origMethod, origParams) {
        if (!this.hasPrimary() || !this.primaryConn) {
            return Promise.reject(RpcError.noPrimary());
        }
        const requestId = randomUUID();
        const execId = String(requestId);
        const params = { origMethod, origParams, requestId };
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
            conn.send(JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                id: requestId,
                method: "internal.exec",
                params,
            }));
        });
    }
    /** Called when a response to an `internal.exec` arrives from the primary. */
    resolveExec(requestId, result, error) {
        const execId = String(requestId);
        const p = this.pending.get(execId);
        if (!p)
            return;
        clearTimeout(p.timer);
        this.pending.delete(execId);
        if (error !== undefined)
            p.reject(error);
        else
            p.resolve(result);
    }
    /** Request a snapshot PNG from the primary. */
    snapshot() {
        if (!this.hasPrimary() || !this.primaryConn) {
            return Promise.reject(RpcError.noPrimary());
        }
        const requestId = randomUUID();
        const execId = String(requestId);
        const params = { requestId, metadataOnly: false };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(execId);
                reject(RpcError.primaryTimeout());
            }, this.proxyTimeoutMs);
            this.pending.set(execId, {
                resolve: (v) => resolve(v),
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
            conn.send(JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                id: requestId,
                method: "internal.snapshot",
                params,
            }));
        });
    }
    electPrimary() {
        // Remove stale candidates (closed)
        this.candidates = this.candidates.filter((c) => c.readyState === 1);
        const next = this.candidates[0];
        if (!next) {
            this.primaryConn = null;
            return;
        }
        this.primaryConn = next;
        // Notify the new primary (its app.ts will register handlers accordingly)
        next.send(JSON.stringify({
            jsonrpc: JSONRPC_VERSION,
            method: "internal.primaryPromotion",
            params: {},
        }));
    }
}
