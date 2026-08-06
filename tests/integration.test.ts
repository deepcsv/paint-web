/**
 * Integration test: start a real WS server on a random port, then run a
 * sequence of RPCs through the JSON-RPC protocol to verify the harness
 * works end-to-end with a fake primary.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../server/rpc/router.js";
import { ServerState } from "../server/state.js";
import { EventBus } from "../server/event-bus.js";
import { PrimaryClient } from "../server/primary-client.js";
import { attachWsServer } from "../server/ws-server.js";
import { registerHandlers } from "../server/handlers/index.js";
import { registerTempSnapshot } from "../server/http-server.js";
import { saveSnapshotPng } from "../server/persistence.js";
import { DocumentStore } from "../server/document-store.js";
import { AssetStore } from "../server/asset-store.js";

let httpServer: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let primary: PrimaryClient;
let state: ServerState;
let assetStore: AssetStore;
let assetDirectory: string;

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

  state = new ServerState();
  assetDirectory = await mkdtemp(join(tmpdir(), "paint-web-integration-assets-"));
  assetStore = new AssetStore(assetDirectory);
  await assetStore.init();
  const events = new EventBus(wss);
  primary = new PrimaryClient();
  const opLog = new (await import("../server/op-log.js")).OpLog({ persist: false });
  const router = new Router();
  const documentStore = new DocumentStore(state.snapshot());

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

  registerHandlers({
    router,
    state,
    events,
    primary,
    opLog,
    documentStore,
    assetStore,
    registerTempSnapshot,
    saveSnapshotPng,
  });

  attachWsServer({ wss, router, state, events, primary, opLog, documentStore });

  console.log("[test] server listening on", port);
});

afterAll(async () => {
  for (const c of wss.clients) c.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await rm(assetDirectory, { recursive: true });
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
            const params = msg.params as { requestId: number; origMethod: string; origParams: unknown };
            const result =
              params.origMethod === "canvas.getState"
                ? {
                    layers: state.layers.map((layer) => ({
                      ...layer,
                      png: "dGVzdA==",
                    })),
                  }
                : params.origMethod === "canvas.analyze"
                  ? {
                      width: state.width,
                      height: state.height,
                      stride: 1,
                      sampledPixels: 1,
                      opaquePixels: 1,
                      coverage: 1,
                      bounds: { x: 0, y: 0, w: 1, h: 1 },
                      average: { r: 255, g: 0, b: 0, a: 255, hex: "#ff0000ff" },
                      luminance: { min: 0.2126, max: 0.2126, mean: 0.2126, histogram: [1, 0, 0, 0] },
                      dominant: [
                        {
                          color: { r: 255, g: 0, b: 0, a: 255, hex: "#ff0000ff" },
                          count: 1,
                          ratio: 1,
                        },
                      ],
                    }
                : { fake: true, method: params.origMethod };
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "internal.execResult",
                params: { requestId: params.requestId, result },
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
    const document = await c.rpc<{ replayable: boolean; baseRaster: { id: string }[] }>("doc.get", {});
    expect(info.width).toBe(1280);
    expect(info.layers.length).toBe(1);
    expect(document.replayable).toBe(true);
    expect(document.baseRaster.map((layer) => layer.id)).toEqual(
      info.layers.map((layer) => layer.id),
    );
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
      layerId: state.activeLayerId,
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
        layerId: state.activeLayerId,
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
      layerId: state.activeLayerId,
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

  it("executes idempotent atomic transactions as one document commit", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    const agent = makeClient("agent");
    await agent.connect();

    const params = {
      idempotencyKey: "integration-transaction-1",
      message: "Create ink layer",
      operations: [
        { method: "layer.create", params: { name: "Ink", layerId: "L_transaction_ink" } },
        {
          method: "draw.line",
          params: {
            layerId: "L_transaction_ink",
            from: { x: 0, y: 0 },
            to: { x: 10, y: 10 },
            color: "#000000",
            size: 2,
            opacity: 1,
          },
        },
      ],
    };
    const first = await agent.rpc<{ commitId: string; revision: number; replayed: boolean }>(
      "transaction.execute",
      params,
    );
    const second = await agent.rpc<{ commitId: string; revision: number; replayed: boolean }>(
      "transaction.execute",
      params,
    );
    const info = await agent.rpc<{ layers: { id: string }[] }>("canvas.getInfo");

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      commitId: first.commitId,
      revision: first.revision,
      replayed: true,
    });
    expect(info.layers.filter((layer) => layer.id === "L_transaction_ink")).toHaveLength(1);

    await agent.close();
    await browser.close();
  });

  it("rolls back renderer and metadata when an atomic transaction fails", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    const agent = makeClient("agent");
    await agent.connect();
    const before = await agent.rpc<{ layers: { id: string }[] }>("canvas.getInfo");

    await expect(
      agent.rpc("transaction.execute", {
        idempotencyKey: "integration-rollback-1",
        operations: [
          { method: "layer.create", params: { name: "Temporary", layerId: "L_temporary_tx" } },
          { method: "layer.delete", params: { layerId: "L_does_not_exist" } },
        ],
      }),
    ).rejects.toMatchObject({ code: -32009 });

    const after = await agent.rpc<{ layers: { id: string }[] }>("canvas.getInfo");
    expect(after.layers).toEqual(before.layers);

    await agent.close();
    await browser.close();
  });

  it("restores exact document versions through doc.undo and doc.redo", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    const agent = makeClient("agent");
    await agent.connect();
    const before = await agent.rpc<{ layers: { id: string }[] }>("canvas.getInfo");

    await agent.rpc("transaction.execute", {
      idempotencyKey: "integration-history-1",
      operations: [
        { method: "layer.create", params: { name: "History", layerId: "L_history_tx" } },
      ],
    });
    await agent.rpc("doc.undo", { steps: 1 });
    const undone = await agent.rpc<{ layers: { id: string }[] }>("canvas.getInfo");
    expect(undone.layers).toEqual(before.layers);

    await agent.rpc("doc.redo", { steps: 1 });
    const redone = await agent.rpc<{ layers: { id: string }[] }>("canvas.getInfo");
    expect(redone.layers.some((layer) => layer.id === "L_history_tx")).toBe(true);

    await agent.close();
    await browser.close();
  });

  it("archives raster keyframes for imported assets", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    const agent = makeClient("agent");
    await agent.connect();

    await agent.rpc("canvas.import", {
      url: "https://example.test/import.png",
      layerId: state.activeLayerId,
    });
    const document = await agent.rpc<{
      replayable: boolean;
      operations: unknown[];
      baseRaster: { id: string; png: string }[];
    }>("doc.get", {});

    expect(document.replayable).toBe(true);
    expect(document.operations).toEqual([]);
    expect(document.baseRaster).toEqual(
      state.layers.map((layer) => ({ id: layer.id, png: "dGVzdA==" })),
    );

    await agent.close();
    await browser.close();
  });

  it("persists server-generated layer ids in canonical replay params", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    const agent = makeClient("agent");
    await agent.connect();

    const created = await agent.rpc<{ layerId: string }>("layer.create", {
      name: "Generated",
    });
    const document = await agent.rpc<{
      operations: { method: string; params?: unknown }[];
    }>("doc.get", {});
    const operation = document.operations.at(-1);

    expect(operation).toMatchObject({
      method: "layer.create",
      params: { layerId: created.layerId, name: "Generated" },
    });

    await agent.close();
    await browser.close();
  });

  it("composes P1 assets, advanced primitives and visual analysis", async () => {
    const browser = makeClient("browser");
    await browser.connect();
    const agent = makeClient("agent");
    await agent.connect();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const asset = await agent.rpc<{ id: string; existing: boolean }>("asset.put", {
      data: png,
      mimeType: "image/png",
      name: "integration pixel",
    });

    const transaction = await agent.rpc<{ transactionId: string; revision: number }>(
      "transaction.execute",
      {
        idempotencyKey: "integration-p1-primitives-1",
        message: "P1 primitives",
        operations: [
          {
            method: "draw.path",
            params: {
              layerId: state.activeLayerId,
              commands: [
                { op: "M", x: 0, y: 0 },
                { op: "L", x: 20, y: 20 },
              ],
              stroke: "#ff0000",
            },
          },
          {
            method: "draw.image",
            params: {
              layerId: state.activeLayerId,
              assetId: asset.id,
              x: 4,
              y: 5,
              width: 12,
              height: 12,
            },
          },
          {
            method: "layer.transform",
            params: { layerId: state.activeLayerId, translateX: 3, translateY: 2 },
          },
        ],
      },
    );
    const analysis = await agent.rpc<{ average: { hex: string }; coverage: number }>(
      "canvas.analyze",
      {},
    );
    const assets = await agent.rpc<{ assets: { id: string }[] }>("asset.list", {});
    const document = await agent.rpc<{
      operations: { method: string; transactionId?: string }[];
    }>("doc.get", {});
    const rendered = await agent.rpc<{ digest: string; warnings: string[] }>("doc.render", {
      format: "svg",
    });

    expect(asset.existing).toBe(false);
    expect(assets.assets).toContainEqual(expect.objectContaining({ id: asset.id }));
    expect(analysis).toMatchObject({ average: { hex: "#ff0000ff" }, coverage: 1 });
    expect(
      document.operations
        .filter((operation) => operation.transactionId === transaction.transactionId)
        .map((operation) => operation.method),
    ).toEqual(["draw.path", "draw.image", "layer.transform"]);
    expect(rendered.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(rendered.warnings).toEqual([]);

    await agent.close();
    await browser.close();
  });
});
