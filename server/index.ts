import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { createHttpServer, registerTempSnapshot } from "./http-server.js";
import { attachWsServer } from "./ws-server.js";
import { Router } from "./rpc/router.js";
import { ServerState } from "./state.js";
import { EventBus } from "./event-bus.js";
import { PrimaryClient } from "./primary-client.js";
import { OpLog } from "./op-log.js";
import { ensureDataDir, loadState, saveSnapshotPng } from "./persistence.js";
import { registerHandlers } from "./handlers/index.js";

const HOST = process.env.PAINT_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.PAINT_PORT ?? "8080", 10);
const TOKEN = process.env.PAINT_TOKEN;

async function main() {
  await ensureDataDir();

  const state = new ServerState();
  const saved = await loadState();
  if (saved) {
    state.fromJSON(saved);
    console.log("[state] loaded metadata:", state.width, "x", state.height, ", layers:", state.layers.length);
  }

  // Vite dev server in dev mode; undefined in prod (serves dist/ directly)
  const isDev = process.env.NODE_ENV !== "production" && !process.env.PAINT_PRODUCTION;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  if (isDev) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "info",
    });
  }

  const httpServer = createHttpServer(vite);
  const wss = new WebSocketServer({ server: httpServer });
  const events = new EventBus(wss);
  const primary = new PrimaryClient();
  const opLog = new OpLog();
  const router = new Router();

  // Wire primary-exec responses back to the router's pending RPCs.
  // When primary returns a result for an internal.exec, we resolve the promise
  // held by the originating handler.
  router.registerInternal("internal.execResult", (params, _ctx) => {
    const p = params as { requestId: unknown; result?: unknown; error?: unknown };
    primary.resolveExec(p.requestId as never, p.result, p.error);
    return undefined;
  });
  router.registerInternal("internal.snapshotResult", (params, _ctx) => {
    const p = params as { requestId: unknown; png: string; width: number; height: number };
    // png is a base64 string from the browser
    const png = Buffer.from(p.png, "base64");
    primary.resolveExec(p.requestId as never, { png, width: p.width, height: p.height });
    return undefined;
  });

  // Register all RPC handlers
  registerHandlers({
    router,
    state,
    events,
    primary,
    opLog,
    registerTempSnapshot,
    saveSnapshotPng,
  });

  attachWsServer({ wss, router, state, events, primary, opLog, token: TOKEN });

  // Handle in-use port cleanly instead of throwing an uncaught EADDRINUSE.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  ✗ Port ${PORT} is already in use.`);
      console.error(`    Find and stop the process:`);
      console.error(`      lsof -ti :${PORT} | xargs kill -9`);
      console.error(`    Or pick a different port:`);
      console.error(`      PAINT_PORT=${PORT + 1} npm run dev\n`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`\n  Paint Web`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  HTTP : http://${HOST}:${PORT}`);
    console.log(`  WS   : ws://${HOST}:${PORT}`);
    console.log(`  Mode : ${isDev ? "dev (Vite middleware)" : "production (dist/)"}`);
    console.log(`  Auth : ${TOKEN ? "token required" : "none (local only)"}`);
    console.log(`  ─────────────────────────────────────────────\n`);
  });

  // Graceful shutdown
  const shutdown = (sig: string) => {
    console.log(`\n[shutdown] ${sig} received, closing...`);
    for (const client of wss.clients) {
      try {
        client.close(1001, "server shutting down");
      } catch {
        // ignore
      }
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
