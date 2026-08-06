import {
  JSONRPC_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcId,
} from "../../shared/protocol.js";

export type RpcResult<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: number; message: string; data?: unknown } };

const BACKOFF = [1000, 2000, 5000, 10000, 30000];

interface PendingReq {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WSClientOptions {
  url?: string;
  clientId: string;
  token?: string;
  role: "browser" | "agent";
  onEvent?: (type: string, data: unknown, seq: number) => void;
  onPrimaryChange?: (isPrimary: boolean) => void;
  /** Called after sync.hello succeeds, with the server's view of state. */
  onConnect?: (state: {
    isPrimary: boolean;
    serverEventSeq: number;
    state: unknown;
    document?: import("../../shared/protocol.js").DocumentReplaySnapshot;
  }) => void;
  onDisconnect?: () => void;
  /** lastEventSeq to resume from (persisted across reconnects) */
  getLastEventSeq?: () => number | undefined;
  setLastEventSeq?: (seq: number) => void;
  /** Internal RPC handlers — used when this client is the primary. */
  internalHandlers?: Map<string, (params: unknown) => Promise<unknown> | unknown>;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingReq>();
  private isPrimary = false;
  private nextReqId = 1;
  private disposed = false;
  private lastPrimaryPromotionSeq = 0;

  constructor(private opts: WSClientOptions) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get primary(): boolean {
    return this.isPrimary;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const url = this.opts.url ?? defaultWsUrl(this.opts.token);
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => this.handleOpen();
      ws.onmessage = (e) => this.handleMessage(e.data);
      ws.onclose = () => this.handleClose();
      ws.onerror = () => {
        /* close handler will fire */
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Send a request and await its response. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WS not connected");
    }
    const id = this.nextReqId++ as RpcId;
    const idStr = String(id);
    const req: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idStr);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(idStr, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws!.send(JSON.stringify(req));
      } catch (err) {
        this.pending.delete(idStr);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Fire-and-forget notification. */
  notify(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const req: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, method, params };
    this.ws.send(JSON.stringify(req));
  }

  /** Internal: respond to an `internal.exec` request from server. */
  respondInternal(requestId: RpcId, result: unknown, error?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      method: "internal.execResult",
      params: { requestId, result, error },
    };
    this.ws.send(JSON.stringify(msg));
  }

  respondSnapshot(requestId: RpcId, png: string, width: number, height: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      method: "internal.snapshotResult",
      params: { requestId, png, width, height },
    };
    this.ws.send(JSON.stringify(msg));
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------

  private async handleOpen(): Promise<void> {
    this.reconnectAttempt = 0;
    // Start heartbeat
    this.startHeartbeat();

    // Handshake: sync.hello
    const lastSeq = this.opts.getLastEventSeq?.();
    try {
      const hello = await this.request<{
        isPrimary: boolean;
        serverEventSeq: number;
        state: unknown;
        document?: import("../../shared/protocol.js").DocumentReplaySnapshot;
      }>("sync.hello", {
        role: this.opts.role,
        clientId: this.opts.clientId,
        ...(lastSeq !== undefined ? { lastEventSeq: lastSeq } : {}),
      });
      this.isPrimary = hello.isPrimary;
      this.opts.setLastEventSeq?.(hello.serverEventSeq);
      this.opts.onPrimaryChange?.(this.isPrimary);
      this.opts.onConnect?.(hello);
    } catch (err) {
      console.error("[ws] sync.hello failed:", err);
    }
  }

  private handleMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (Array.isArray((data as Blob[]).length) === false && typeof data === "object") {
      // Blob
      (data as Blob).text().then((t) => this.handleMessage(t));
      return;
    } else text = String(data);

    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (Array.isArray(msg)) {
      for (const m of msg) this.handleSingle(m as JsonRpcResponse | JsonRpcRequest);
      return;
    }
    this.handleSingle(msg as JsonRpcResponse | JsonRpcRequest);
  }

  private handleSingle(msg: JsonRpcResponse | JsonRpcRequest): void {
    // Response to one of our requests
    if ("result" in msg || "error" in msg) {
      const resp = msg as JsonRpcResponse;
      if (resp.id === undefined || resp.id === null) return;
      const idStr = String(resp.id);
      const p = this.pending.get(idStr);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(idStr);
      if (resp.error) p.reject(resp.error);
      else p.resolve(resp.result);
      return;
    }

    // Notification or server-initiated request
    const req = msg as JsonRpcRequest;
    if (!req.method) return;

    if (req.method.startsWith("event.")) {
      const params = (req.params ?? {}) as { type?: string; data?: unknown; seq?: number };
      if (typeof params.seq === "number") {
        this.opts.setLastEventSeq?.(params.seq);
      }
      if (params.type) {
        this.opts.onEvent?.(params.type, params.data, params.seq ?? 0);
      }
      return;
    }

    if (req.method === "internal.exec") {
      void this.handleInternalExec(req);
      return;
    }

    if (req.method === "internal.snapshot") {
      void this.handleInternalSnapshot(req);
      return;
    }

    if (req.method === "internal.primaryPromotion") {
      this.lastPrimaryPromotionSeq++;
      const wasPrimary = this.isPrimary;
      this.isPrimary = true;
      if (!wasPrimary) this.opts.onPrimaryChange?.(true);
      return;
    }

    // Unknown notification — ignore
  }

  private async handleInternalExec(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as { origMethod: string; origParams: unknown; requestId: RpcId };
    const handler = this.opts.internalHandlers?.get(params.origMethod);
    if (!handler) {
      this.respondInternal(params.requestId, undefined, {
        code: -32601,
        message: `No handler for ${params.origMethod}`,
      });
      return;
    }
    try {
      const result = await handler(params.origParams);
      this.respondInternal(params.requestId, result);
    } catch (err) {
      const e =
        err instanceof Error
          ? { code: -32603, message: err.message }
          : { code: -32603, message: String(err) };
      this.respondInternal(params.requestId, undefined, e);
    }
  }

  private async handleInternalSnapshot(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as { requestId: RpcId };
    const snap = this.opts.internalHandlers?.get("internal.snapshot");
    if (!snap) {
      this.respondSnapshot(params.requestId, "", 0, 0);
      return;
    }
    try {
      const result = (await snap(undefined)) as { png: string; width: number; height: number };
      this.respondSnapshot(params.requestId, result.png, result.width, result.height);
    } catch {
      this.respondSnapshot(params.requestId, "", 0, 0);
    }
  }

  private handleClose(): void {
    this.opts.onDisconnect?.();
    if (this.isPrimary) {
      this.isPrimary = false;
      this.opts.onPrimaryChange?.(false);
    }
    // Fail all pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WS disconnected"));
    }
    this.pending.clear();
    if (!this.disposed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempt, BACKOFF.length - 1);
    const delay = BACKOFF[idx]!;
    this.reconnectAttempt++;
    console.log(`[ws] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.notify("heartbeat.ping");
    }, 30_000);
  }
}

export function defaultWsUrl(token?: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}`;
  return token ? `${url}/?token=${encodeURIComponent(token)}` : url;
}
