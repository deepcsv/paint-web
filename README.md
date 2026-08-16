# paint-web

A deterministic web painting runtime with a **native JSON-RPC harness for AI agents**. Open a browser to draw, or send versioned operations over WebSocket to drive the canvas programmatically. The production runtime remains a single Node.js process.

A single-player painting core (brush, shapes, fill, layers, filters, text) with a first-class agent interface over WebSocket JSON-RPC.

## Quickstart

```bash
# Install
npm install

# Dev server (HTTP + WS on one port, with Vite middleware)
npm run dev
# → http://127.0.0.1:8080

# Production build
npm run build
npm start
```

Open `http://127.0.0.1:8080` in your browser — you're now the primary client. Open a second tab and it'll be a secondary that mirrors the first.

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│ Browser A   │ ◀─────▶ │   Node.js    │ ◀─────▶ │   Agent     │
│  (primary)  │   WS    │  single proc │   WS    │  (CLI/SDK)  │
│  Canvas2D   │         │              │         │             │
│  Holds all  │         │  Metadata    │         │  Sends RPCs │
│  pixels     │         │  + history   │         │  Gets JSON  │
│             │         │  + events    │         │             │
└─────────────┘         └──────────────┘         └─────────────┘
                              │
                              ▼
                     data/<name>.png
                     data/state.json
                     data/document.json
                     data/assets/*
```

- **Browser is the high-fidelity raster renderer** — server has no native canvas dependency.
- **Server is authoritative for the artwork document** — structure, operations, versions, branches, baselines, and audit log.
- **`primary` browser** is elected by connect order; agent RPCs needing pixels are proxied to it.
- **Single process** — built-in HTTP + `ws` package + Vite middleware in dev.

## P0 canonical document foundation

The server now maintains an immutable, versioned artwork document in addition
to the compatibility operation log:

- every native mutation becomes a canonical commit;
- `transaction.execute` is serialized, idempotent, and restores all layer
  pixels plus metadata when any operation fails;
- exact `doc.undo` / `doc.redo`, named checkpoints, and branch switching are
  persistent across browser sessions;
- document persistence uses atomic replacement with a recoverable backup;
- the first primary browser captures the existing per-layer raster baseline,
  so the first brush stroke is independently undoable and an upgraded
  workspace is not flattened or discarded;
- external imports and loaded snapshots create exact raster keyframes instead
  of leaving non-replayable URLs in history;
- `doc.render` produces deterministic SVG without a primary browser.

The browser remains the high-fidelity PNG/JPEG renderer in P0, but it is now a
recoverable rendering terminal rather than the only holder of artwork history.

## P1 creative engine

P1 adds durable visual building blocks and machine-readable feedback on top of
the canonical document:

- PNG/JPEG files enter an immutable, content-addressed asset library through
  `asset.put`; repeated content is deduplicated by SHA-256;
- `draw.path`, `draw.gradient`, and `draw.image` provide native curves,
  reusable gradients, and deterministic image placement;
- `layer.transform` bakes translation, scaling, rotation, and pivoted affine
  transforms into a layer;
- `canvas.analyze` reports coverage, painted bounds, average/dominant colors,
  and a luminance histogram, while `canvas.sample` reads exact RGBA values;
- asset-backed imports and images participate in transactions, replay,
  branching, browser recovery, and headless SVG rendering without relying on
  an external URL.

The intended agent loop is now: upload stable assets, commit a coherent pass,
measure the canvas, inspect a snapshot when needed, then refine from the same
versioned document.

## Deterministic brush kernel

The current brush foundation is designed for genuine stroke-by-stroke drawing,
not image-filter imitation:

- `perfect-freehand` streamlines raw pointer/agent centerlines while preserving
  explicit pen pressure and deriving a restrained velocity curve when pressure
  is absent;
- every new `draw.stroke` carries an unsigned PRNG seed and brush engine version;
- first-party clients embed an immutable brush snapshot, so later preset tuning
  cannot change historical replay pixels;
- textured brushes fall back to deterministic procedural tooth/grain when an
  external tip asset is unavailable;
- stamp jitter, spacing, rotation, blend mode, erasing, and smearing are rendered
  in isolated buffers and covered by executable Skia-backed pixel tests.

## CLI

```bash
# Build the CLI
npm run cli:build

# Or run via tsx without building
npm run cli -- info
npm run cli -- stroke --brush --color "#ff0000" --size 8 --points "0,0;100,100"
npm run cli -- stroke --brush --seed 42 --color "#222222" --size 8 --points "0,0;100,100"
npm run cli -- brush apply --id "铅笔" --seed 42 --points "80,80;320,160"
npm run cli -- rect --x 10 --y 10 --w 80 --h 60 --stroke "#000000" --fill "#0099ff"
npm run cli -- text --x 50 --y 50 --content "hello" --size 32
npm run cli -- fill --x 50 --y 50 --color "#ffff00"
npm run cli -- export --out canvas.png
npm run cli -- save --name mywork
npm run cli -- load --name mywork
npm run cli -- history undo --steps 3
npm run cli -- filter blur --radius 3
npm run cli -- subscribe            # follow all events
npm run cli -- transaction pass.jsonl --idempotency-key pass-01
npm run cli -- doc history
npm run cli -- doc checkpoint create --name approved-v1
npm run cli -- doc branch create --name experiments/neon
npm run cli -- doc render --out artwork.svg
npm run cli -- asset add reference.png --name reference
npm run cli -- image --asset A_<sha256> --x 80 --y 60 --width 320
npm run cli -- path silhouette.json --fill "#151629"
npm run cli -- gradient glow.json
npm run cli -- layer transform --id L_subject --translate-x 24 --rotate -3
npm run cli -- analyze --stride 2 --colors 8
npm run cli -- sample --points "80,60;240,180"
```

Global options:

| Flag | Default | Description |
|---|---|---|
| `--url <ws>` | `ws://127.0.0.1:8080` (env `PAINT_WS_URL`) | WebSocket URL |
| `--token <tok>` | (env `PAINT_TOKEN`) | Auth token |
| `--timeout <ms>` | `15000` | RPC timeout |
| `--json` | off | Output raw JSON-RPC response |

## Configuration

Environment variables:

| Var | Default | Description |
|---|---|---|
| `PAINT_HOST` | `127.0.0.1` | Bind host (do NOT use `0.0.0.0` unless on a trusted network) |
| `PAINT_PORT` | `8080` | Bind port |
| `PAINT_TOKEN` | unset | If set, WS connections must pass `?token=...` |
| `PAINT_PRODUCTION` | unset | If set, skip Vite and serve `dist/` directly |

## Safety defaults

- Binds to `127.0.0.1` — local only.
- Optional token auth.
- Snapshot names are sanitized (regex `[a-zA-Z0-9_-]+`, max 64 chars).
- Temporary export URLs (`/snapshot/<id>`) auto-expire in 30s.
- Asset uploads accept verified PNG/JPEG bytes only, capped at 20 MiB and
  8192×8192 pixels.
- Assets are addressed by their SHA-256 digest and served read-only with
  immutable cache headers from `/asset/<id>`.

## Tech stack

- **Node.js 24.14+** with built-in `http`, Web Crypto, and `node:crypto`
- **ws 8.21** for the WebSocket server
- **Vite 8** (Rolldown-powered) for client bundling + dev middleware
- **TypeScript 7** strict mode throughout
- **vanilla TS** client (no React/Vue — keep it small)
- **Zod 4** for runtime RPC validation (shared between client/server/CLI)
- **Commander 15** for CLI argument parsing
- **Vitest 4 + @napi-rs/canvas** for unit and real Canvas2D pixel testing
- **perfect-freehand** for pressure-aware centerline planning

No production native modules, database, or message broker. The optional native
Skia binding is development-only and gives brush regressions a real pixel oracle.

## Project layout

```
paint-web/
├── server/             # Node.js backend
│   ├── index.ts        # Entry — starts HTTP + WS + Vite
│   ├── http-server.ts  # Static + /snapshot/* + /healthz
│   ├── asset-store.ts  # Immutable content-addressed PNG/JPEG library
│   ├── ws-server.ts    # Connection lifecycle + dispatch
│   ├── rpc/            # JSON-RPC router + errors
│   ├── handlers/       # canvas/layer/draw/history/filter/snapshot
│   ├── state.ts        # Metadata (no pixels)
│   ├── primary-client.ts   # Election + pixel proxy
│   ├── event-bus.ts    # Pub/sub with seq + ring buffer
│   └── persistence.ts  # PNG + state.json
├── shared/             # Shared between client/server/CLI
│   └── protocol.ts     # All RPC types + zod schemas + method registry
├── src/                # Browser client
│   ├── main.ts         # App entry
│   ├── brush/          # Presets, immutable brush types, stroke planner
│   ├── canvas/         # LayerStack, StampEngine, CanvasAnalyzer, ...
│   ├── input/          # PointerHandler
│   ├── ui/             # Toolbar, ColorPicker, LayerPanel, ...
│   └── net/            # WSClient
├── cli/                # paint-cli
│   └── paint-cli.ts
├── tests/              # vitest
└── data/               # runtime state, snapshots, document and asset blobs
```

## Full protocol reference

See [PROTOCOL.md](./PROTOCOL.md) for the complete RPC method list, event catalog, error codes, and end-to-end examples.

## License

MIT
