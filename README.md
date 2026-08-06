# paint-web

A monolithic web painting app with a **native JSON-RPC harness for AI agents**. Open a browser to draw, or send commands over WebSocket to drive the canvas programmatically. Built as a single Node.js process.

Inspired by reverse-engineering the 画世界 Android app — this project keeps only the single-player painting core (brush, shapes, fill, layers, filters, text) and adds a first-class agent interface.

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
```

- **Browser is authoritative for pixels** — server has no native canvas dependency.
- **Server is authoritative for metadata** — canvas size, layers, history summary, event log.
- **`primary` browser** is elected by connect order; agent RPCs needing pixels are proxied to it.
- **Single process** — built-in HTTP + `ws` package + Vite middleware in dev.

## CLI

```bash
# Build the CLI
npm run cli:build

# Or run via tsx without building
npm run cli -- info
npm run cli -- stroke --brush --color "#ff0000" --size 8 --points "0,0;100,100"
npm run cli -- rect --x 10 --y 10 --w 80 --h 60 --stroke "#000000" --fill "#0099ff"
npm run cli -- text --x 50 --y 50 --content "hello" --size 32
npm run cli -- fill --x 50 --y 50 --color "#ffff00"
npm run cli -- export --out canvas.png
npm run cli -- save --name mywork
npm run cli -- load --name mywork
npm run cli -- history undo --steps 3
npm run cli -- filter blur --radius 3
npm run cli -- subscribe            # follow all events
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

## Tech stack

- **Node.js 22+** with built-in `http` and `node:crypto`
- **ws** for WebSocket server
- **Vite 5** for client bundling + dev middleware
- **TypeScript 5** strict mode throughout
- **vanilla TS** client (no React/Vue — keep it small)
- **zod** for runtime RPC validation (shared between client/server/CLI)
- **commander** for CLI argument parsing
- **vitest** for testing

No native modules. No database. No message broker. Single process.

## Project layout

```
paint-web/
├── server/             # Node.js backend
│   ├── index.ts        # Entry — starts HTTP + WS + Vite
│   ├── http-server.ts  # Static + /snapshot/* + /healthz
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
│   ├── canvas/         # LayerStack, StrokeEngine, FillEngine, ...
│   ├── input/          # PointerHandler
│   ├── ui/             # Toolbar, ColorPicker, LayerPanel, ...
│   └── net/            # WSClient
├── cli/                # paint-cli
│   └── paint-cli.ts
├── tests/              # vitest
└── data/               # gitignored — PNG snapshots + state.json
```

## Full protocol reference

See [PROTOCOL.md](./PROTOCOL.md) for the complete RPC method list, event catalog, error codes, and end-to-end examples.

## License

MIT
