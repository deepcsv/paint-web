import { JSONRPC_VERSION, METHODS, } from "../../shared/protocol.js";
import { RpcError } from "./errors.js";
/**
 * Router — maps RPC method names to handlers and validates params/results.
 *
 * Two modes:
 *  1. User-facing methods (defined in METHODS registry) get param validation
 *     and result validation automatically.
 *  2. Internal methods (internal.*) bypass the registry and are routed
 *     via internalHandlers.
 */
export class Router {
    handlers = new Map();
    internalHandlers = new Map();
    register(method, handler) {
        this.handlers.set(method, handler);
    }
    registerInternal(method, handler) {
        this.internalHandlers.set(method, handler);
    }
    /**
     * Dispatch a single RPC. Returns either a response (for request) or null
     * (for notification / handled internally).
     */
    async dispatch(req, ctx) {
        const id = req.id;
        const method = req.method;
        const isNotification = id === undefined;
        // Internal methods (server <-> primary browser, prefixed "internal.")
        if (method.startsWith("internal.")) {
            const h = this.internalHandlers.get(method);
            if (!h) {
                if (isNotification)
                    return null;
                return errorResponse(id, RpcError.methodNotFound(method));
            }
            try {
                const result = await h(req.params, ctx);
                if (isNotification)
                    return null;
                return { jsonrpc: JSONRPC_VERSION, id, result };
            }
            catch (err) {
                if (isNotification)
                    return null;
                return errorResponse(id, err);
            }
        }
        // Public methods
        const def = METHODS[method];
        const handler = this.handlers.get(method);
        if (!def || !handler) {
            if (isNotification)
                return null;
            return errorResponse(id, RpcError.methodNotFound(method));
        }
        // Param validation
        let params = req.params;
        if (def.params) {
            const parsed = def.params.safeParse(req.params);
            if (!parsed.success) {
                if (isNotification)
                    return null;
                return errorResponse(id, RpcError.invalidParams(parsed.error.issues));
            }
            params = parsed.data;
        }
        // Execute
        try {
            const raw = await handler(params, ctx);
            if (isNotification)
                return null;
            // Result validation (best-effort)
            let result = raw;
            if (def.result) {
                const parsed = def.result.safeParse(raw);
                if (parsed.success)
                    result = parsed.data;
            }
            return { jsonrpc: JSONRPC_VERSION, id, result };
        }
        catch (err) {
            if (isNotification)
                return null;
            return errorResponse(id, err);
        }
    }
    /**
     * Dispatch a batch of RPCs. Always returns a batch response (per JSON-RPC 2.0).
     */
    async dispatchBatch(reqs, ctx) {
        const responses = [];
        for (const r of reqs) {
            const resp = await this.dispatch(r, ctx);
            if (resp !== null)
                responses.push(resp);
        }
        if (responses.length === 0)
            return null;
        return responses;
    }
}
export function errorResponse(id, err) {
    const e = err instanceof RpcError ? err : RpcError.internal(err instanceof Error ? err.message : String(err));
    return {
        jsonrpc: JSONRPC_VERSION,
        id: id ?? 0,
        error: e.toObject(),
    };
}
