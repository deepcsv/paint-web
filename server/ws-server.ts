import { randomUUID } from "node:crypto";
import type { WebSocketServer, WebSocket } from "ws";
import {
  JSONRPC_VERSION,
  JsonRpcRequest,
  METHODS,
  SyncHelloParams,
  type JsonRpcResponse,
  type RpcId,
} from "../shared/protocol.js";
import { RpcError } from "./rpc/errors.js";
import { Router, errorResponse, type RpcContext } from "./rpc/router.js";
import { ServerState } from "./state.js";
import { EventBus } from "./event-bus.js";
import { PrimaryClient } from "./primary-client.js";
import { OpLog } from "./op-log.js";
import { scheduleStateWrite } from "./persistence.js";
import { DocumentStore } from "./document-store.js";
import {
  isDocumentMutationMethod,
  needsRasterKeyframe,
  validateDrawBatchOperations,
} from "./document-operations.js";

export interface WsServerDeps {
  wss: WebSocketServer;
  router: Router;
  state: ServerState;
  events: EventBus;
  opLog: OpLog;
  documentStore: DocumentStore;
  primary: PrimaryClient;
  token?: string;
}

interface ConnMeta {
  clientId: string;
  role: "browser" | "agent" | "unknown";
  lastMsgAt: number;
  helloDone: boolean;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;

class SerialExecutor {
  private tail = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function attachWsServer(deps: WsServerDeps): void {
  const { wss, router, state, events, primary, opLog, documentStore, token } = deps;
  const mutations = new SerialExecutor();

  async function ensureBaseline(): Promise<void> {
    if (documentStore.baselineCaptured) return;
    const result = (await primary.exec("canvas.getState", {})) as {
      layers?: { id: string; png: string }[];
    };
    documentStore.captureBaseline(
      (result.layers ?? []).map((layer) => ({ id: layer.id, png: layer.png })),
    );
  }

  async function dispatchWithEffects(
    rpcReq: JsonRpcRequest,
    ctx: RpcContext,
    clientId: string,
  ): Promise<JsonRpcResponse | null> {
    const definition = METHODS[rpcReq.method];
    const execute = async (): Promise<JsonRpcResponse | null> => {
      // Canonical mutations must be requests so success/failure is observable.
      // Silently executing a JSON-RPC notification would bypass commit effects.
      if (definition?.emitsEvent && rpcReq.id === undefined) return null;

      try {
        if (isDocumentMutationMethod(rpcReq.method) || rpcReq.method === "transaction.execute") {
          await ensureBaseline();
        }
      } catch (error) {
        return errorResponse(rpcReq.id, error);
      }

      const response = await router.dispatch(rpcReq, ctx);
      if (!definition?.emitsEvent || !response || response.error) return response;

      const execResult = response.result;
      let canonicalParams = rpcReq.params;
      if (definition.params) {
        const parsed = definition.params.safeParse(rpcReq.params);
        if (parsed.success) canonicalParams = parsed.data;
      }
      if (rpcReq.method === "draw.batch") {
        const operations = (canonicalParams as { operations: { method: string; params?: unknown }[] })
          .operations;
        canonicalParams = { operations: validateDrawBatchOperations(operations) };
      }
      if (rpcReq.method === "layer.create") {
        const layerId = (execResult as { layerId?: string } | undefined)?.layerId;
        const layer = layerId ? state.getLayer(layerId) : undefined;
        if (layerId) {
          canonicalParams = {
            ...((canonicalParams ?? {}) as object),
            layerId,
            ...(layer ? { name: layer.name } : {}),
          };
        }
      } else if (rpcReq.method === "layer.flatten") {
        const layerId = (execResult as { id?: string } | undefined)?.id;
        if (layerId) canonicalParams = { layerId };
      }
      if (
        rpcReq.method === "transaction.execute" &&
        (execResult as { replayed?: boolean } | undefined)?.replayed
      ) {
        return response;
      }
      if (isDocumentMutationMethod(rpcReq.method)) {
        try {
          const raster = needsRasterKeyframe(rpcReq.method, canonicalParams)
            ? ((await primary.exec("canvas.getState", {})) as {
                layers?: { id: string; png: string }[];
              }).layers?.map(({ id, png }) => ({ id, png }))
            : undefined;
          documentStore.recordOperation(
            rpcReq.method,
            canonicalParams,
            execResult,
            state.snapshot(),
            clientId,
            raster,
          );
        } catch (error) {
          let rollbackError: unknown;
          try {
            const previous = documentStore.getReplaySnapshot();
            await primary.exec("document.replay", previous);
            state.restore(previous.state);
          } catch (rollbackFailure) {
            rollbackError = rollbackFailure;
          }
          return errorResponse(
            rpcReq.id,
            RpcError.documentConflict("Canonical commit failed; renderer restored", {
              failure: error instanceof Error ? error.message : error,
              ...(rollbackError
                ? {
                    rollbackError:
                      rollbackError instanceof Error ? rollbackError.message : rollbackError,
                  }
                : {}),
            }),
          );
        }
      }

      events.emit(definition.emitsEvent as never, {
        clientId,
        method: rpcReq.method,
        params: canonicalParams,
        result: execResult,
        documentRevision: documentStore.revision,
        documentCommitId: documentStore.currentCommitId,
      });
      opLog.append({
        clientId,
        method: rpcReq.method,
        params: canonicalParams,
        result: execResult,
      });

      if (
        rpcReq.method.startsWith("layer.") ||
        rpcReq.method === "canvas.resize" ||
        rpcReq.method === "transaction.execute" ||
        rpcReq.method === "doc.undo" ||
        rpcReq.method === "doc.redo" ||
        rpcReq.method === "history.undo" ||
        rpcReq.method === "history.redo" ||
        rpcReq.method === "doc.branch.switch" ||
        rpcReq.method === "doc.checkpoint.restore"
      ) {
        scheduleStateWrite(JSON.stringify(state.toJSON()));
      }
      return response;
    };

    // All external reads queue behind mutations, so transaction intermediates
    // are never observable. Internal primary responses must bypass the queue
    // or a mutation waiting on the browser would deadlock.
    return rpcReq.method.startsWith("internal.") ? execute() : mutations.run(execute);
  }

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

    const conn = ws as WebSocket & { __paintMeta?: ConnMeta; __paintClientId?: string };
    const meta: ConnMeta = {
      clientId: randomUUID(),
      role: "unknown",
      lastMsgAt: Date.now(),
      helloDone: false,
    };
    conn.__paintMeta = meta;
    conn.__paintClientId = meta.clientId;

    const ctx: RpcContext = {
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
        } catch {
          // ignore
        }
      },
    };

    ws.on("message", async (raw) => {
      meta.lastMsgAt = Date.now();
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify(errorResponse(0, RpcError.parseError())));
        return;
      }

      // Batch?
      if (Array.isArray(payload)) {
        if (payload.length === 0) {
          ws.send(JSON.stringify(errorResponse(0, RpcError.invalidRequest())));
          return;
        }
        if (!meta.helloDone) {
          ws.send(JSON.stringify(errorResponse(0, RpcError.invalidRequest("sync.hello must be sent first"))));
          return;
        }
        const responses: JsonRpcResponse[] = [];
        for (const item of payload) {
          const parsed = JsonRpcRequest.safeParse(item);
          if (!parsed.success) {
            responses.push(errorResponse(0, RpcError.invalidRequest(parsed.error.issues)));
            continue;
          }
          const response = await dispatchWithEffects(parsed.data, ctx, meta.clientId);
          if (response) responses.push(response);
        }
        if (responses.length > 0) ws.send(JSON.stringify(responses));
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
        ws.send(
          JSON.stringify(
            errorResponse(rpcReq.id, RpcError.invalidRequest("sync.hello must be sent first")),
          ),
        );
        return;
      }

      // Special handling: sync.hello
      if (rpcReq.method === "sync.hello") {
        const parsed = SyncHelloParams.safeParse(rpcReq.params);
        if (!parsed.success) {
          ws.send(
            JSON.stringify(errorResponse(rpcReq.id, RpcError.invalidParams(parsed.error.issues))),
          );
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
          if (primary.isPrimary(ws) && !documentStore.baselineCaptured) {
            try {
              await mutations.run(async () => {
                if (documentStore.baselineCaptured) return;
                // Reconcile the fresh browser's layer ids before capturing its
                // pixels. Matching layers preserve pixels across a server
                // restart; a fresh page simply contributes blank layers.
                await primary.exec("document.prepareBaseline", {
                  state: documentStore.currentState(),
                });
                await ensureBaseline();
              });
            } catch (error) {
              console.warn("[document] initial baseline capture deferred:", error);
            }
          }
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
          /** Whether any browser currently holds pixel authority (agents may gate draw work on this). */
          primaryAvailable: primary.hasPrimary(),
          serverEventSeq: events.currentSeq(),
          state: state.getInfo({ undo: 0, redo: 0 }),
          ...(meta.role === "browser" && documentStore.baselineCaptured
            ? { document: documentStore.getReplaySnapshot(undefined, { compactActiveLayers: true }) }
            : {}),
        };
        if (rpcReq.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: rpcReq.id, result }));
        }
        return;
      }

      // Standard dispatch + canonical document effects.
      const response = await dispatchWithEffects(rpcReq, ctx, meta.clientId);
      if (response !== null) ws.send(JSON.stringify(response));
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
      const conn = client as WebSocket & { __paintMeta?: ConnMeta };
      const meta = conn.__paintMeta;
      if (!meta) continue;
      if (now - meta.lastMsgAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          conn.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, HEARTBEAT_TIMEOUT_MS).unref();
}

export type { RpcId };
