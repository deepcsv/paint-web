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
    "state": { /* CanvasGetInfoResult */ }
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
| `canvas.import` | `{ url, layerId? }` | `{ ok: true }` | yes | Load PNG from URL into a layer |
| `canvas.getRegion` | `{ x, y, w, h, layerId? }` | `{ url, expiresAt }` | yes | Region screenshot |

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
| `layer.flatten` | — | `{ id, name }` | Merge all visible layers into one |

`BlendMode` enum: `source-over`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`.

### `draw.*`

| Method | Params | Notes |
|---|---|---|
| `draw.stroke` | `{ layerId, tool: "brush"\|"eraser", color, size, opacity, points }` | Bezier-smoothed freehand; points ≥ 1 |
| `draw.line` | `{ layerId, from, to, color, size, opacity, dash? }` | Straight line |
| `draw.rect` | `{ layerId, x, y, w, h, stroke?, fill?, strokeWidth }` | Rectangle |
| `draw.circle` | `{ layerId, cx, cy, r, stroke?, fill?, strokeWidth }` | Circle |
| `draw.ellipse` | `{ layerId, cx, cy, rx, ry, stroke?, fill?, strokeWidth }` | Ellipse |
| `draw.fill` | `{ layerId, x, y, color, tolerance? }` | Flood fill (BFS, 0..64 tolerance) |
| `draw.text` | `{ layerId, x, y, text, fontFamily, size, color, align? }` | `fontFamily`: `noto-sans` \| `source-han-sans` \| `monospace` |
| `draw.setPixel` | `{ layerId, x, y, color }` | Single pixel |
| `draw.batch` | `{ operations: [{ method, params }] }` | Up to 2000 ops in one call; **preferred for many small mutations** |

Color format: `#rrggbb` or `#rrggbbaa` (8-digit with alpha). No 3-digit shorthand.

Point format: `{ x: number, y: number, pressure?: 0..1 }`. `pressure` defaults to 0.5; mapped to `size * (0.3 + 0.7 * pressure)`.

### `history.*`

| Method | Params | Description |
|---|---|---|
| `history.undo` | `{ steps?: 1 }` | Undo N steps on the active layer |
| `history.redo` | `{ steps?: 1 }` | Redo N steps |
| `history.goto` | `{ index }` | Jump to absolute history index (v2; approximate in v1) |
| `history.getLength` | — | `{ undo, redo, total }` aggregated across all layers |
| `history.clear` | — | Drop all undo/redo stacks |

> History is **per-layer** and stored on the primary browser (full ImageData snapshots, depth 30). v1 does not sync undo across browsers — each browser maintains its own. Calling `history.undo` as an agent only affects the primary.

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
| `layer.created` / `layer.deleted` / `layer.changed` / `layer.reordered` / `layer.merged` / `layer.flattened` | Layer operations |
| `canvas.resized` / `canvas.cleared` / `canvas.filled` | Canvas mutations |
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
```

---

## Internal protocol (server ↔ primary)

These methods are not part of the public API but appear on the wire:

- `internal.exec` — server → primary, carries `{ origMethod, origParams, requestId }`. Primary returns result via `internal.execResult`.
- `internal.snapshot` — server → primary, requests `{ png, width, height }` of the composited canvas.
- `internal.primaryPromotion` — server → browser, "you're now primary".
- `internal.execResult` / `internal.snapshotResult` — primary → server, response carriers.

Agents should never send these.
