# Paint Web — JSON-RPC Protocol Reference

The paint-web harness speaks **JSON-RPC 2.0** over **WebSocket**. This document is the source of truth for agents.

## Connection

```
ws://127.0.0.1:8080[/?token=<token>]
```

### Handshake (mandatory)

The first frame a client sends must be `sync.hello`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sync.hello",
  "params": {
    "role": "browser" | "agent",
    "clientId": "<uuid>",
    "lastEventSeq": 42      // optional; on reconnect, server replays events after this seq
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "clientId": "<server-confirmed>",
    "isPrimary": true,
      "serverEventSeq": 123,
      "state": { /* CanvasGetInfoResult */ },
      "document": { /* optional DocumentReplaySnapshot for browser recovery */ }
  }
}
```

- **`role: "browser"`** makes the client a primary candidate. First browser wins. On primary disconnect, the next browser is promoted automatically.
- **`role: "agent"`** never becomes primary; it can only send RPCs that the server proxies to the primary.
- **`clientId`** should be persistent across reconnects (browser: localStorage; CLI: per-session UUID).

Until `sync.hello` succeeds, only `sync.hello` and `heartbeat.ping` are accepted.

## Heartbeat

Send every 30s:

```json
{ "jsonrpc": "2.0", "method": "heartbeat.ping" }
```

Server disconnects after 60s of silence.

## Standard error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (invalid JSON) |
| `-32600` | Invalid request (not JSON-RPC 2.0) |
| `-32601` | Method not found |
| `-32602` | Invalid params (zod validation failed) |
| `-32603` | Internal error |
| `-32001` | `NO_PRIMARY` — no primary browser is connected; retry later |
| `-32002` | `PRIMARY_TIMEOUT` — primary didn't respond within 15s |
| `-32003` | `FONT_NOT_LOADED` — fontFamily not in whitelist |
| `-32004` | `LAYER_NOT_FOUND` |
| `-32005` | `OUT_OF_BOUNDS` — coordinate outside canvas |
| `-32006` | `SNAPSHOT_TOO_LARGE` — payload over 5MB; use URL |
| `-32007` | `NOT_AUTHORIZED` — bad token |
| `-32008` | `DOCUMENT_CONFLICT` — stale version, duplicate ref, or idempotency-key conflict |
| `-32009` | `TRANSACTION_ABORTED` — an atomic edit failed and was rolled back |
| `-32010` | `VERSION_NOT_FOUND` — commit, branch, or checkpoint does not exist |
| `-32011` | `ASSET_NOT_FOUND` — immutable asset id is unknown or its blob is missing |
| `-32012` | `ASSET_TOO_LARGE` — decoded asset exceeds 20 MiB |
| `-32013` | `INVALID_ASSET` — malformed base64, media signature, dimensions, or checksum |

---

## Methods

### `canvas.*`

| Method | Params | Result | Pixel? | Description |
|---|---|---|---|---|
| `canvas.getInfo` | — | `CanvasGetInfoResult` | no | Returns metadata: width, height, layers, activeLayerId, historyLength |
| `canvas.resize` | `{ width, height, mode }` | `{ ok: true }` | yes | Resize canvas. `mode`: `crop`/`scale`/`anchor` |
| `canvas.clear` | `{ layerId? }` | `{ ok: true }` | yes | Clear one layer (or all if `layerId` omitted) |
| `canvas.fill` | `{ color, layerId? }` | `{ ok: true }` | yes | Fill entire canvas/layer with color |
| `canvas.export` | `{ format, layerId?, bounds?, quality? }` | `{ url, size, expiresAt }` | yes | Returns temporary URL (30s TTL). Use `curl $URL` to download PNG/JPEG bytes |
| `canvas.import` | `{ url, layerId? }` or `{ assetId, layerId? }` | `{ ok: true }` | yes | Load exactly one external URL or immutable asset into a layer |
| `canvas.getRegion` | `{ x, y, w, h, layerId? }` | `{ url, expiresAt }` | yes | Region screenshot |
| `canvas.analyze` | `{ layerId?, stride?, alphaThreshold?, histogramBins?, dominantColors?, includeBackground? }` | `CanvasAnalyzeResult` | yes | Quantitative coverage, bounds, color and luminance analysis |
| `canvas.sample` | `{ layerId?, points: [{x,y}, ...] }` | `{ samples }` | yes | Read exact RGBA at up to 512 integer coordinates |

> "Pixel? = yes" means the RPC requires a primary browser; otherwise returns `-32001 NO_PRIMARY`.

### `layer.*`

| Method | Params | Result | Description |
|---|---|---|---|
| `layer.create` | `{ name? }` | `{ layerId }` | Create new layer above current |
| `layer.delete` | `{ layerId }` | `{ ok }` | Delete layer |
| `layer.list` | — | `{ layers: Layer[] }` | List all layers |
| `layer.setActive` | `{ layerId }` | `{ ok }` | Set active layer (where drawing goes) |
| `layer.setVisible` | `{ layerId, visible }` | `{ ok }` | Toggle visibility |
| `layer.setOpacity` | `{ layerId, opacity: 0..1 }` | `{ ok }` | Set opacity |
| `layer.setBlendMode` | `{ layerId, blendMode }` | `{ ok }` | Set blend mode (see `BlendMode` enum) |
| `layer.rename` | `{ layerId, name }` | `{ ok }` | Rename |
| `layer.reorder` | `{ layerIds }` | `{ ok }` | Reorder all layers (bottom-to-top) |
| `layer.merge` | `{ fromId, intoId }` | `{ ok }` | Merge `fromId` into `intoId`; deletes `fromId` |
| `layer.flatten` | `{ layerId? }` | `{ id, name }` | Merge all visible layers into one; server supplies a deterministic id |
| `layer.transform` | `{ layerId, translateX?, translateY?, scaleX?, scaleY?, rotate?, pivotX?, pivotY?, smoothing? }` | `{ ok }` | Bake an affine transform into the layer; rotation is in degrees |

`BlendMode` enum: `source-over`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`.

### `draw.*`

| Method | Params | Notes |
|---|---|---|
| `draw.stroke` | `{ layerId, tool, color, size, opacity, points, seed?, strokeVersion?, brushPresetId?, brush? }` | Deterministic pressure-aware centerline + legacy or immutable stamp brush; points ≥ 1 |
| `draw.line` | `{ layerId, from, to, color, size, opacity, dash? }` | Straight line |
| `draw.rect` | `{ layerId, x, y, w, h, stroke?, fill?, strokeWidth }` | Rectangle |
| `draw.circle` | `{ layerId, cx, cy, r, stroke?, fill?, strokeWidth }` | Circle |
| `draw.ellipse` | `{ layerId, cx, cy, rx, ry, stroke?, fill?, strokeWidth }` | Ellipse |
| `draw.fill` | `{ layerId, x, y, color, tolerance? }` | Flood fill (BFS, 0..64 tolerance) |
| `draw.text` | `{ layerId, x, y, text, fontFamily, size, color, align? }` | `fontFamily`: `noto-sans` \| `source-han-sans` \| `monospace` |
| `draw.setPixel` | `{ layerId, x, y, color }` | Single pixel |
| `draw.path` | `{ layerId, commands, stroke?, fill?, strokeWidth?, opacity?, fillRule?, lineCap?, lineJoin? }` | Native M/L/Q/C/Z path; starts with M and requires stroke or fill |
| `draw.gradient` | `{ layerId, gradient, shape, stops, opacity? }` | Ordered linear/radial gradient over a rect, circle, or ellipse |
| `draw.image` | `{ layerId, assetId, x, y, width?, height?, opacity?, rotate?, smoothing? }` | Place a verified immutable asset; omitted size uses source dimensions |
| `draw.batch` | `{ operations: [{ method, params }] }` | Up to 2000 ops in one call; **preferred for many small mutations** |

Color format: `#rrggbb` or `#rrggbbaa` (8-digit with alpha). No 3-digit shorthand.

Point format: `{ x: number, y: number, pressure?: 0..1 }`. Explicit tablet
pressure is preserved. When omitted, stamp brushes derive a restrained,
deterministic pressure curve from path spacing; legacy strokes retain their
original behavior.

New validated strokes always carry `strokeVersion: 2` and an unsigned 32-bit
`seed`. A missing seed is deterministically derived from the stroke input.
First-party UI/CLI brush strokes include both `brushPresetId` and the complete
immutable `brush` rendering snapshot. This makes operation replay independent
of later edits to the named preset; old ID-only operations remain supported.

Path commands are `{op:"M"|"L",x,y}`, `{op:"Q",cx,cy,x,y}`,
`{op:"C",c1x,c1y,c2x,c2y,x,y}`, and `{op:"Z"}`. Gradient definitions
are either `{type:"linear",from:{x,y},to:{x,y}}` or
`{type:"radial",inner:{x,y,r},outer:{x,y,r}}`; stops use
`{offset:0..1,color}` and must be ordered.

### `canvas.analyze` result

The result contains canvas `width`/`height`, actual `stride`,
`sampledPixels`, `opaquePixels`, painted `coverage`, nullable painted `bounds`,
alpha-aware `average`, a normalized luminance summary with histogram, and
quantized `dominant` colors. Every returned color includes integer `r/g/b/a`
and `hex` in `#rrggbbaa` form. The operation is read-only and never creates a
document commit.

### `history.*`

| Method | Params | Description |
|---|---|---|
| `history.undo` | `{ steps?: 1 }` | Compatibility alias for canonical `doc.undo` |
| `history.redo` | `{ steps?: 1 }` | Compatibility alias for canonical `doc.redo` |
| `history.goto` | `{ index }` | Jump to absolute history index (v2; approximate in v1) |
| `history.getLength` | — | Canonical `{ undo, redo, total }` for the checked-out branch |
| `history.clear` | — | Drop the primary renderer's transient ImageData cache |

`history.undo` and `history.redo` now use the same exact, persistent,
cross-browser commit history as `doc.undo` and `doc.redo`. The renderer keeps a
small transient per-layer ImageData cache only for implementation compatibility.

### `filter.*`

All accept `layerId?` (default: all layers).

| Method | Params |
|---|---|
| `filter.blur` | `{ radius: 1..50 }` |
| `filter.invert` | — |
| `filter.grayscale` | — |
| `filter.brightness` | `{ amount: -1..1 }` |
| `filter.contrast` | `{ amount: -1..1 }` |

### `snapshot.*`

| Method | Params | Result | Description |
|---|---|---|---|
| `snapshot.save` | `{ name }` | `{ id, path, size, width, height }` | Composite all visible layers → PNG saved to `data/<name>.png` |
| `snapshot.load` | `{ name }` | `{ width, height, layers }` | Load `data/<name>.png` into the active layer |

`name` regex: `^[a-zA-Z0-9_-]+$`, max 64 chars (path-traversal-proof).

### `asset.*`

Assets are immutable PNG/JPEG blobs addressed by `A_<sha256>`. They are
server-side resources and therefore do not require a primary browser.

| Method | Params | Result |
|---|---|---|
| `asset.put` | `{ data: "<canonical base64>", mimeType: "image/png"\|"image/jpeg", name? }` | metadata plus `{ existing }` |
| `asset.get` | `{ assetId }` | metadata |
| `asset.list` | `{ limit?: 100 }` | `{ assets: metadata[] }` |

Metadata includes `id`, `sha256`, verified `mimeType`, byte `size`, decoded
`width`/`height`, optional `name`, `createdAt`, and a read-only `/asset/<id>`
URL. Uploads are capped at 20 MiB and 8192×8192. The server checks media
signatures on upload and SHA-256 again when reading a blob. Re-uploading the
same bytes returns the original metadata with `existing: true`.

### `transaction.*`

`transaction.execute` validates every operation before execution, serializes it
against all other mutations, and commits the entire edit once. On failure it
restores both structural metadata and every layer's PNG pixels.

```json
{
  "idempotencyKey": "portrait-pass-03",
  "message": "Add eyes and highlights",
  "operations": [
    { "method": "layer.create", "params": { "layerId": "L_eyes", "name": "eyes" } },
    { "method": "draw.circle", "params": { "layerId": "L_eyes", "cx": 400, "cy": 260, "r": 24, "fill": "#ffffff" } }
  ]
}
```

Retries with the same key and operations return the original result with
`replayed: true`; reusing a key with different operations returns `-32008`.

### `doc.*`

| Method | Params | Purpose |
|---|---|---|
| `doc.get` | `{ commitId? }` | Canonical metadata, baseline rasters and deterministic operation ancestry |
| `doc.history` | `{ limit? }` | Commit history and undo/redo availability |
| `doc.undo` / `doc.redo` | `{ steps }` | Restore exact document commits by rebuilding the primary renderer |
| `doc.branch.create` | `{ name }` | Create a branch pointer at the current commit |
| `doc.branch.list` | — | List branch heads |
| `doc.branch.switch` | `{ name }` | Restore and switch to another branch |
| `doc.checkpoint.create` | `{ name, message? }` | Name the current immutable commit |
| `doc.checkpoint.list` | — | List named checkpoints |
| `doc.checkpoint.restore` | `{ name }` | Restore a named checkpoint |
| `doc.render` | `{ format: "svg", commitId? }` | Deterministic headless SVG render; no primary browser required |

The first primary browser captures a per-layer PNG baseline before interaction.
Native paint-web operations are replayable after crashes or browser reconnects.
External-URL `canvas.import` and `snapshot.load` additionally capture exact
per-layer raster keyframes, so branches remain restorable when the original
source disappears. Asset-backed `canvas.import` and `draw.image` instead replay
from their immutable content hashes. `doc.render` embeds referenced asset bytes
as data URLs, producing a self-contained SVG.

### `event.*`

| Method | Params | Description |
|---|---|---|
| `event.subscribe` | `{ types?: string[] }` | Subscribe to event types; omit for all |
| `event.unsubscribeAll` | — | Stop receiving events |

---

## Events

Events are server-pushed notifications (no `id`). Carry a monotonic `seq` for replay-on-reconnect.

```json
{
  "jsonrpc": "2.0",
  "method": "event.stroke.committed",
  "params": {
    "seq": 42,
    "type": "stroke.committed",
    "data": {
      "clientId": "B_abc123",
      "method": "draw.stroke",
      "params": { /* ... */ },
      "result": { /* ... */ }
    }
  }
}
```

### Event catalog

| Type | When |
|---|---|
| `stroke.started` | Pointer down (browser only; not emitted for RPC) |
| `stroke.committed` | Any `draw.*` RPC applied successfully |
| `draw.batched` | `draw.batch` completed |
| `layer.created` / `layer.deleted` / `layer.changed` / `layer.reordered` / `layer.merged` / `layer.flattened` / `layer.transformed` | Layer operations |
| `canvas.resized` / `canvas.cleared` / `canvas.filled` / `canvas.imported` | Canvas mutations |
| `transaction.committed` | One atomic transaction became a canonical commit |
| `document.restored` | Undo, redo, branch switch, or checkpoint restore completed |
| `history.undone` / `history.redone` / `history.cleared` | History operations |
| `filter.applied` | Any `filter.*` |
| `snapshot.saved` / `snapshot.loaded` | Persistence operations |
| `client.connected` / `client.disconnected` | Any client join/leave, `{ clientId, role }` |
| `primary.changed` | Primary browser switched, `{ clientId }` |
| `error` | Global non-RPC error |

### Reconnect replay

On `sync.hello`, pass `lastEventSeq` (the highest `seq` you've seen). Server replays any events after that from a 1000-entry ring buffer.

---

## End-to-end examples

### Example 1: Draw a red line, export it

```js
// agent.js (Node 22+)
import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:8080");
let id = 1;
const pending = new Map();

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if ("result" in m || "error" in m) pending.get(m.id)?.(m);
});

await new Promise((r) => ws.on("open", r));

function rpc(method, params) {
  return new Promise((resolve) => {
    const i = id++;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
  });
}

// Hello
await rpc("sync.hello", { role: "agent", clientId: "demo-agent" });

// Find active layer
const info = await rpc("canvas.getInfo", {});
const layerId = info.result.activeLayerId;

// Stroke
await rpc("draw.stroke", {
  layerId,
  tool: "brush",
  color: "#ff0000",
  size: 12,
  opacity: 1,
  points: [{ x: 100, y: 100 }, { x: 400, y: 300 }],
});

// Export
const { result } = await rpc("canvas.export", { format: "png" });
console.log("Exported to:", result.url);
ws.close();
```

### Example 2: Subscribe to events and react

```js
await rpc("sync.hello", { role: "agent", clientId: "watcher" });
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  method: "event.subscribe",
  params: { types: ["stroke.committed"] },
}));

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === "event.stroke.committed") {
    console.log("Someone drew:", m.params.data.method, "at seq", m.params.seq);
  }
});
```

### Example 3: Batch pixel-level ops

```js
const ops = [];
for (let x = 0; x < 100; x++) {
  for (let y = 0; y < 100; y++) {
    ops.push({ method: "draw.setPixel", params: { layerId, x, y, color: "#00ff00" } });
  }
}
await rpc("draw.batch", { operations: ops });
// One RPC roundtrip, one event broadcast.
```

---

## CLI equivalents

```bash
# Equivalent to Example 1
paint-cli stroke --brush --color "#ff0000" --size 12 --points "100,100;400,300"
paint-cli export --out out.png
paint-cli transaction pass.jsonl --idempotency-key portrait-pass-03 --message "eyes"
paint-cli doc history
paint-cli doc checkpoint create --name approved-v1
paint-cli doc branch create --name experiments/neon
paint-cli doc render --out document.svg
paint-cli asset add reference.png --name reference
paint-cli image --asset A_<sha256> --x 80 --y 60 --width 320
paint-cli path silhouette.json --fill "#151629"
paint-cli gradient glow.json
paint-cli layer transform --id L_subject --translate-x 24 --rotate -3
paint-cli analyze --stride 2 --colors 8
paint-cli sample --points "80,60;240,180"
```

---

## Internal protocol (server ↔ primary)

These methods are not part of the public API but appear on the wire:

- `internal.exec` — server → primary, carries `{ origMethod, origParams, requestId }`. Primary returns result via `internal.execResult`.
- `internal.snapshot` — server → primary, requests `{ png, width, height }` of the composited canvas.
- `internal.primaryPromotion` — server → browser, "you're now primary".
- `document.prepareBaseline` — reconcile server layer ids before the initial raster capture.
- `document.restoreRaster` — restore a transaction's captured per-layer pixels after failure.
- `document.replay` — rebuild a canonical commit from baseline rasters and operations.
- `internal.execResult` / `internal.snapshotResult` — primary → server, response carriers.

Agents should never send these.
