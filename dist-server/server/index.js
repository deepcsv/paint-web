import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { createHttpServer, registerTempSnapshot } from "./http-server.js";
import { attachWsServer } from "./ws-server.js";
import { Router } from "./rpc/router.js";
import { ServerState } from "./state.js";
import { EventBus } from "./event-bus.js";
import { PrimaryClient } from "./primary-client.js";
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
    let vite;
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
    const router = new Router();
    // Wire primary-exec responses back to the router's pending RPCs.
    // When primary returns a result for an internal.exec, we resolve the promise
    // held by the originating handler.
    router.registerInternal("internal.execResult", (params, _ctx) => {
        const p = params;
        primary.resolveExec(p.requestId, p.result, p.error);
        return undefined;
    });
    router.registerInternal("internal.snapshotResult", (params, _ctx) => {
        const p = params;
        // png is a base64 string from the browser
        const png = Buffer.from(p.png, "base64");
        primary.resolveExec(p.requestId, { png, width: p.width, height: p.height });
        return undefined;
    });
    // Register all RPC handlers
    registerHandlers({
        router,
        state,
        events,
        primary,
        registerTempSnapshot,
        saveSnapshotPng,
    });
    attachWsServer({ wss, router, state, events, primary, token: TOKEN });
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
    const shutdown = (sig) => {
        console.log(`\n[shutdown] ${sig} received, closing...`);
        for (const client of wss.clients) {
            try {
                client.close(1001, "server shutting down");
            }
            catch {
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
