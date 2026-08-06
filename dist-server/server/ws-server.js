import { randomUUID } from "node:crypto";
import { JSONRPC_VERSION, JsonRpcRequest, METHODS, SyncHelloParams, } from "../shared/protocol.js";
import { RpcError } from "./rpc/errors.js";
import { errorResponse } from "./rpc/router.js";
import { scheduleStateWrite } from "./persistence.js";
const HEARTBEAT_TIMEOUT_MS = 60_000;
export function attachWsServer(deps) {
    const { wss, router, state, events, primary, token } = deps;
    wss.on("connection", (ws, req) => {
        // Token check (optional)
        if (token) {
            const url = new URL(req.url ?? "", "http://x");
            const t = url.searchParams.get("token");
            if (t !== token) {
                ws.close(4001, "unauthorized");
                return;
            }
        }
        const conn = ws;
        const meta = {
            clientId: randomUUID(),
            role: "unknown",
            lastMsgAt: Date.now(),
            helloDone: false,
        };
        conn.__paintMeta = meta;
        conn.__paintClientId = meta.clientId;
        const ctx = {
            get clientId() {
                return meta.clientId;
            },
            get role() {
                return meta.role;
            },
            get isPrimary() {
                return primary.isPrimary(ws);
            },
            send: (msg) => {
                try {
                    ws.send(JSON.stringify(msg));
                }
                catch {
                    // ignore
                }
            },
        };
        ws.on("message", async (raw) => {
            meta.lastMsgAt = Date.now();
            let payload;
            try {
                payload = JSON.parse(raw.toString());
            }
            catch {
                ws.send(JSON.stringify(errorResponse(0, RpcError.parseError())));
                return;
            }
            // Batch?
            if (Array.isArray(payload)) {
                if (payload.length === 0) {
                    ws.send(JSON.stringify(errorResponse(0, RpcError.invalidRequest())));
                    return;
                }
                const reqs = payload;
                const responses = await router.dispatchBatch(reqs, ctx);
                if (responses !== null)
                    ws.send(JSON.stringify(responses));
                return;
            }
            const parsedReq = JsonRpcRequest.safeParse(payload);
            if (!parsedReq.success) {
                ws.send(JSON.stringify(errorResponse(0, RpcError.invalidRequest(parsedReq.error.issues))));
                return;
            }
            const rpcReq = parsedReq.data;
            // Enforce handshake: first message must be sync.hello (except heartbeat)
            if (!meta.helloDone && rpcReq.method !== "sync.hello" && rpcReq.method !== "heartbeat.ping") {
                ws.send(JSON.stringify(errorResponse(rpcReq.id, RpcError.invalidRequest("sync.hello must be sent first"))));
                return;
            }
            // Special handling: sync.hello
            if (rpcReq.method === "sync.hello") {
                const parsed = SyncHelloParams.safeParse(rpcReq.params);
                if (!parsed.success) {
                    ws.send(JSON.stringify(errorResponse(rpcReq.id, RpcError.invalidParams(parsed.error.issues))));
                    return;
                }
                // Adopt the client-provided id (sticky across reconnects)
                meta.clientId = parsed.data.clientId;
                conn.__paintClientId = meta.clientId;
                meta.role = parsed.data.role;
                meta.helloDone = true;
                // For browsers, become a primary candidate
                if (meta.role === "browser") {
                    primary.setCandidate(ws, true);
                }
                // Replay missed events
                if (parsed.data.lastEventSeq !== undefined) {
                    events.replay(parsed.data.lastEventSeq, meta.clientId);
                }
                // Notify all subscribers of new connection
                events.emit("client.connected", { clientId: meta.clientId, role: meta.role });
                const isPrimary = primary.isPrimary(ws);
                const result = {
                    clientId: meta.clientId,
                    isPrimary,
                    serverEventSeq: events.currentSeq(),
                    state: state.getInfo({ undo: 0, redo: 0 }),
                };
                if (rpcReq.id !== undefined) {
                    ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: rpcReq.id, result }));
                }
                return;
            }
            // Standard dispatch
            const response = await router.dispatch(rpcReq, ctx);
            if (response !== null)
                ws.send(JSON.stringify(response));
            // For mutate methods, emit event + persist state (after dispatch)
            const def = METHODS[rpcReq.method];
            if (def?.emitsEvent && response && !("error" in response)) {
                const execResult = response.result;
                events.emit(def.emitsEvent, {
                    clientId: meta.clientId,
                    method: rpcReq.method,
                    params: rpcReq.params,
                    result: execResult,
                });
                // If the state changed structurally, persist
                if (rpcReq.method.startsWith("layer.") ||
                    rpcReq.method.startsWith("canvas.resize")) {
                    scheduleStateWrite(JSON.stringify(state.toJSON()));
                }
            }
        });
        ws.on("close", () => {
            events.emit("client.disconnected", { clientId: meta.clientId, role: meta.role });
            events.drop(meta.clientId);
            primary.drop(ws);
        });
        ws.on("error", (err) => {
            console.error("[ws] error from", meta.clientId, err.message);
        });
    });
    // Heartbeat sweep
    setInterval(() => {
        const now = Date.now();
        for (const client of wss.clients) {
            const conn = client;
            const meta = conn.__paintMeta;
            if (!meta)
                continue;
            if (now - meta.lastMsgAt > HEARTBEAT_TIMEOUT_MS) {
                try {
                    conn.terminate();
                }
                catch {
                    // ignore
                }
            }
        }
    }, HEARTBEAT_TIMEOUT_MS).unref();
}
