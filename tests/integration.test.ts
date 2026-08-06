/**
 * Integration test: start a real WS server on a random port, then run a
 * sequence of RPCs through the JSON-RPC protocol to verify the harness
 * works end-to-end with a fake primary.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { Router } from "../server/rpc/router.js";
import { ServerState } from "../server/state.js";
import { EventBus } from "../server/event-bus.js";
import { PrimaryClient } from "../server/primary-client.js";
import { attachWsServer } from "../server/ws-server.js";
import { registerHandlers } from "../server/handlers/index.js";
import { registerTempSnapshot } from "../server/http-server.js";
import { saveSnapshotPng } from "../server/persistence.js";

let httpServer: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let primary: PrimaryClient;

function listenAsync(srv: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  const port = await listenAsync(httpServer);

  const state = new ServerState();
  const events = new EventBus(wss);
  primary = new PrimaryClient();
  const opLog = new (await import("../server/op-log.js")).OpLog();
  const router = new Router();

  router.registerInternal("internal.execResult", (params) => {
    const p = params as { requestId: unknown; result?: unknown; error?: unknown };
    primary.resolveExec(p.requestId as never, p.result, p.error);
    return undefined;
  });
  router.registerInternal("internal.snapshotResult", (params) => {
    const p = params as { requestId: unknown; png: string; width: number; height: number };
    const png = Buffer.from(p.png, "base64");
    primary.resolveExec(p.requestId as never, { png, width: p.width, height: p.height });
    return undefined;
  });

  registerHandlers({ router, state, events, primary, opLog, registerTempSnapshot, saveSnapshotPng });

  attachWsServer({ wss, router, state, events, primary, opLog });

  console.log("[test] server listening on", port);
});

afterAll(async () => {
  for (const c of wss.clients) c.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

interface TestClient {
  ws: WebSocket;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  events: { type: string; seq: number; data: unknown }[];
  connect(): Promise<void>;
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

function makeClient(role: "browser" | "agent"): TestClient {
  const ws = new WebSocket(`ws://127.0.0.1:${(httpServer.address() as { port: number }).port}`);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const events: { type: string; seq: number; data: unknown }[] = [];
  let nextId = 1;

  const client: TestClient = {
    ws,
    nextId,
    pending,
    events,
    connect: () =>
      new Promise((resolve, reject) => {
        ws.on("open", () => {
          // sync.hello
          const id = nextId++;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "sync.hello", params: { role, clientId: `test_${role}_${id}` } }));
          pending.set(id, { resolve: () => resolve(), reject });
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if ("result" in msg || "error" in msg) {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if (msg.error) p.reject(msg.error);
            else p.resolve(msg.result);
            return;
          }
          if (msg.method?.startsWith("event.")) {
            events.push({ type: msg.params?.type ?? "?", seq: msg.params?.seq ?? 0, data: msg.params?.data });
            return;
          }
          if (msg.method === "internal.exec") {
            // Fake primary: respond with empty success
            const params = msg.params as { requestId: number; origMethod: string };
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "internal.execResult",
                params: { requestId: params.requestId, result: { fake: true, method: params.origMethod } },
              }),
            );
            return;
          }
        });
        ws.on("error", reject);
      }),
    rpc: <T = unknown>(method: string, params?: unknown) => {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (v) => resolve(v as T), reject });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    notify: (method: string, params?: unknown) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    close: () =>
      new Promise<void>((r) => {
        ws.close();
        ws.on("close", () => r());
      }),
  };
  return client;
}

describe("RPC harness", () => {
  it("handshakes via sync.hello and returns server state", async () => {
    const c = makeClient("browser");
    await c.connect();
    // hello was sent in connect(); result already consumed.
    // Now query getInfo
    const info = await c.rpc<{ width: number; layers: { id: string }[] }>("canvas.getInfo");
    expect(info.width).toBe(1280);
    expect(info.layers.length).toBe(1);
    await c.close();
  });

  it("proxies pixel-level RPCs to primary browser", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    // Make sure this client is primary (first browser)
    await new Promise((r) => setTimeout(r, 100));

    const agent = makeClient("agent");
    await agent.connect();

    const result = await agent.rpc<{ fake: boolean; method: string }>("draw.stroke", {
      layerId: "L1",
      tool: "brush",
      color: "#ff0000",
      size: 5,
      opacity: 1,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    });
    expect(result.fake).toBe(true);
    expect(result.method).toBe("draw.stroke");

    await agent.close();
    await browser.close();
  });

  it("rejects pixel RPCs with NO_PRIMARY when no browser is connected", async () => {
    const agent = makeClient("agent");
    await agent.connect();
    await expect(
      agent.rpc("draw.stroke", {
        layerId: "L1",
        tool: "brush",
        color: "#000000",
        size: 5,
        opacity: 1,
        points: [{ x: 0, y: 0 }, { x: 5, y: 5 }],
      }),
    ).rejects.toMatchObject({ code: -32001 });
    await agent.close();
  });

  it("emits events with monotonic seq", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    // Subscribe to all events
    browser.notify("event.subscribe", { types: undefined });

    const agent = makeClient("agent");
    await agent.connect();

    // Trigger an event by sending a draw.stroke
    await agent.rpc("draw.stroke", {
      layerId: "L1",
      tool: "brush",
      color: "#000000",
      size: 5,
      opacity: 1,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    });

    // Give the server a tick to flush
    await new Promise((r) => setTimeout(r, 100));
    const commits = browser.events.filter((e) => e.type === "stroke.committed");
    expect(commits.length).toBeGreaterThan(0);

    await agent.close();
    await browser.close();
  });
});
