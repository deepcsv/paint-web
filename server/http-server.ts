import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { ViteDevServer } from "vite";
import { randomSnapshotId } from "./sanitize.js";
import type { AssetStore } from "./asset-store.js";

// In dev, this file is at server/http-server.ts → ../dist = project-root/dist.
// In prod (after tsc), this file is at dist-server/server/http-server.js →
// ../dist = dist-server/dist (wrong). So we resolve to project root via cwd.
function findDistDir(): string {
  // Try several candidate locations
  const candidates = [
    resolve(process.cwd(), "dist"),
    new URL("../dist/", import.meta.url).pathname,
    new URL("../../dist/", import.meta.url).pathname,
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  // Fall back to last candidate even if not present (for clearer error)
  return candidates[0]!;
}

const DIST_DIR = findDistDir();
const TMP_DIR = resolve(process.cwd(), "data", "tmp");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** In-memory registry of temporary snapshot files served at /snapshot/<id> */
const tempFiles = new Map<string, { buffer: Buffer; mime: string; expiresAt: number }>();

/** Register a temporary snapshot. Returns the URL path. */
export function registerTempSnapshot(buffer: Buffer, mime = "image/png", ttlMs = 30_000): string {
  const id = randomSnapshotId();
  void mkdir(TMP_DIR, { recursive: true }); // ensure dir exists
  tempFiles.set(id, { buffer, mime, expiresAt: Date.now() + ttlMs });
  setTimeout(() => tempFiles.delete(id), ttlMs + 100).unref();
  return `/snapshot/${id}`;
}

export function registerTempJson(json: string, ttlMs = 30_000): string {
  const id = randomSnapshotId();
  tempFiles.set(id, { buffer: Buffer.from(json, "utf8"), mime: "application/json", expiresAt: Date.now() + ttlMs });
  setTimeout(() => tempFiles.delete(id), ttlMs + 100).unref();
  return `/snapshot/${id}`;
}

/**
 * Create the HTTP server. In dev, Vite middleware handles /assets/* and HMR.
 * In prod, we serve files from dist/.
 */
export function createHttpServer(devServer?: ViteDevServer, assetStore?: AssetStore): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    // Health check
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }

    // Temporary snapshot files (PNG exports, etc.)
    if (url.startsWith("/snapshot/")) {
      const id = url.slice("/snapshot/".length).split("?")[0]!;
      const entry = tempFiles.get(id);
      if (!entry) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": entry.mime,
        "content-length": entry.buffer.byteLength,
        "cache-control": "no-store",
      });
      res.end(entry.buffer);
      return;
    }

    // Immutable content-addressed P1 assets. This route must run before Vite's
    // own /assets/* handling and intentionally uses the singular /asset/ path.
    if (url.startsWith("/asset/") && assetStore) {
      try {
        const assetId = decodeURIComponent(url.slice("/asset/".length).split("?")[0]!);
        const { metadata, buffer } = await assetStore.read(assetId);
        res.writeHead(200, {
          "content-type": metadata.mimeType,
          "content-length": buffer.byteLength,
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"${metadata.sha256}"`,
          "x-content-type-options": "nosniff",
        });
        res.end(buffer);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("asset not found");
      }
      return;
    }

    // Dev: let Vite handle everything else (HTML, JS modules, HMR, etc.)
    if (devServer) {
      // For HTML navigation requests, use Vite's transformIndexHtml so HMR
      // client + script injection work properly.
      if (url === "/" || url.endsWith(".html")) {
        try {
          const file = url === "/" ? "index.html" : url.replace(/^\//, "");
          const src = await readFile(file);
          const html = await devServer.transformIndexHtml(url, src.toString("utf8"));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
          return;
        }
      }
      devServer.middlewares(req, res, () => {
        res.writeHead(404);
        res.end("not found");
      });
      return;
    }

    // Prod: serve from dist/
    await serveStatic(req, res, url);
  });

  return server;
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<void> {
  // Strip query, normalize
  let path = urlPath.split("?")[0]!;
  if (path === "/") path = "/index.html";

  // Prevent path traversal
  const filePath = join(DIST_DIR, path);
  const fileUrl = new URL("file://" + filePath);
  const distUrl = new URL("file://" + DIST_DIR);
  if (!fileURLToPath(fileUrl).startsWith(fileURLToPath(distUrl))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    // SPA fallback
    const indexPath = join(DIST_DIR, "index.html");
    if (existsSync(indexPath)) {
      const html = await readFile(indexPath);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
}
