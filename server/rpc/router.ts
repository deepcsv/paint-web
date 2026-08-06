import {
  JSONRPC_VERSION,
  METHODS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcId,
} from "../../shared/protocol.js";
import { RpcError } from "./errors.js";
import type { z } from "zod";

export type RpcContext = {
  clientId: string;
  role: "browser" | "agent" | "unknown";
  isPrimary: boolean;
  /** transport: send a message back to the originating client */
  send: (msg: object) => void;
};

export type RpcHandler = (
  params: unknown,
  ctx: RpcContext,
) => Promise<unknown> | unknown;

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
  private handlers = new Map<string, RpcHandler>();
  private internalHandlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  registerInternal(method: string, handler: RpcHandler): void {
    this.internalHandlers.set(method, handler);
  }

  /**
   * Dispatch a single RPC. Returns either a response (for request) or null
   * (for notification / handled internally).
   */
  async dispatch(req: JsonRpcRequest, ctx: RpcContext): Promise<JsonRpcResponse | null> {
    const id = req.id;
    const method = req.method;
    const isNotification = id === undefined;

    // Internal methods (server <-> primary browser, prefixed "internal.")
    if (method.startsWith("internal.")) {
      const h = this.internalHandlers.get(method);
      if (!h) {
        if (isNotification) return null;
        return errorResponse(id, RpcError.methodNotFound(method));
      }
      try {
        const result = await h(req.params, ctx);
        if (isNotification) return null;
        return { jsonrpc: JSONRPC_VERSION, id, result: result ?? null };
      } catch (err) {
        if (isNotification) return null;
        return errorResponse(id, err);
      }
    }

    // Public methods
    const def = METHODS[method];
    const handler = this.handlers.get(method);
    if (!def || !handler) {
      if (isNotification) return null;
      return errorResponse(id, RpcError.methodNotFound(method));
    }

    // Param validation
    let params: unknown = req.params;
    if (def.params) {
      const parsed = (def.params as z.ZodTypeAny).safeParse(req.params);
      if (!parsed.success) {
        if (isNotification) return null;
        return errorResponse(id, RpcError.invalidParams(parsed.error.issues));
      }
      params = parsed.data;
    }

    // Execute
    try {
      const raw = await handler(params, ctx);
      if (isNotification) return null;

      // Result validation (best-effort)
      let result: unknown = raw;
      if (def.result) {
        const parsed = (def.result as z.ZodTypeAny).safeParse(raw);
        if (parsed.success) result = parsed.data;
      }
      // JSON-RPC 2.0: response must contain either result or error.
      // JSON.stringify drops `undefined` fields, so coerce to null —
      // otherwise clients waiting on a response never match it and time out.
      return { jsonrpc: JSONRPC_VERSION, id, result: result ?? null };
    } catch (err) {
      if (isNotification) return null;
      return errorResponse(id, err);
    }
  }

  /**
   * Dispatch a batch of RPCs. Always returns a batch response (per JSON-RPC 2.0).
   */
  async dispatchBatch(reqs: JsonRpcRequest[], ctx: RpcContext): Promise<JsonRpcResponse[] | null> {
    const responses: JsonRpcResponse[] = [];
    for (const r of reqs) {
      const resp = await this.dispatch(r, ctx);
      if (resp !== null) responses.push(resp);
    }
    if (responses.length === 0) return null;
    return responses;
  }
}

export function errorResponse(id: RpcId | undefined, err: unknown): JsonRpcResponse {
  const e = err instanceof RpcError ? err : RpcError.internal(err instanceof Error ? err.message : String(err));
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? 0,
    error: e.toObject(),
  };
}
