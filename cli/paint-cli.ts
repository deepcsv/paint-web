#!/usr/bin/env node
/**
 * paint-cli — command-line interface to the paint-web harness.
 *
 * Usage:
 *   paint-cli [global options] <command> [command options]
 *
 * Global options:
 *   --url <ws>           WebSocket URL (env: PAINT_WS_URL, default: ws://127.0.0.1:8080)
 *   --token <tok>        Auth token (env: PAINT_TOKEN)
 *   --timeout <ms>       RPC timeout in ms (default: 15000)
 *   --json               Output raw JSON-RPC response
 *
 * Examples:
 *   paint-cli info
 *   paint-cli stroke --brush --color red --size 5 --points "0,0;100,100"
 *   paint-cli rect --x 10 --y 10 --w 50 --h 30 --fill blue
 *   paint-cli export --out canvas.png
 *   paint-cli subscribe --types stroke.committed,layer.changed
 */

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { WebSocket } from "ws";
import {
  JSONRPC_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcId,
} from "../shared/protocol.js";

interface CliOpts {
  url?: string;
  token?: string;
  timeout: string;
  json: boolean;
}

const program = new Command();
program
  .name("paint-cli")
  .description("CLI for the paint-web agent harness")
  .option("--url <ws>", "WebSocket URL", process.env.PAINT_WS_URL ?? "ws://127.0.0.1:8080")
  .option("--token <tok>", "Auth token", process.env.PAINT_TOKEN)
  .option("--timeout <ms>", "RPC timeout", "15000")
  .option("--json", "Output raw JSON-RPC response", false);

// Helper to make an RPC and disconnect
async function rpc<T = unknown>(
  opts: CliOpts,
  method: string,
  params?: unknown,
  onEvent?: (evt: { type: string; data: unknown; seq: number }) => void,
): Promise<T> {
  const url = (opts.url ?? process.env.PAINT_WS_URL ?? "ws://127.0.0.1:8080") + (opts.token ? `/?token=${encodeURIComponent(opts.token)}` : "");
  const timeoutMs = parseInt(opts.timeout, 10);
  const ws = new WebSocket(url);
  const clientId = "A_" + randomUUID().slice(0, 8);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as JsonRpcResponse | JsonRpcRequest;
    // Response (has id, no method). Per JSON-RPC 2.0, must have result or error.
    // Be defensive: if neither present (legacy server bug), treat as null result.
    if (msg.id !== undefined && !(msg as JsonRpcRequest).method) {
      const r = msg as JsonRpcResponse;
      const p = pending.get(r.id as number);
      if (!p) return;
      pending.delete(r.id as number);
      if (r.error) p.reject(r.error);
      else p.resolve(r.result ?? null);
      return;
    }
    if ((msg as JsonRpcRequest).method?.startsWith("event.") && onEvent) {
      const reqMsg = msg as JsonRpcRequest;
      const params = (reqMsg.params ?? {}) as { type: string; data: unknown; seq: number };
      onEvent({ type: params.type, data: params.data, seq: params.seq });
    }
  });

  // Hello
  const helloId = nextId++;
  const hello = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(helloId);
      reject(new Error("hello timeout"));
    }, timeoutMs);
    pending.set(helloId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: helloId,
        method: "sync.hello",
        params: { role: "agent", clientId },
      } satisfies JsonRpcRequest),
    );
  });
  void hello;

  try {
    const id = nextId++ as RpcId;
    const result = await new Promise<T>((resolve, reject) => {
      const key = id as number;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id,
          method,
          params,
        } satisfies JsonRpcRequest),
      );
    });
    return result;
  } finally {
    // If event subscription requested, keep the socket open until Ctrl+C
    if (!onEvent) {
      ws.close();
    }
  }
}

function parseColor(v: string): string {
  if (!/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
    throw new Error(`Invalid color: ${v} (expected #rrggbb or #rrggbbaa)`);
  }
  return v.startsWith("#") ? v : "#" + v;
}

function parsePoints(s: string): { x: number; y: number; pressure?: number }[] {
  return s.split(";").map((pair) => {
    const [x, y, p] = pair.split(",").map((n) => parseFloat(n.trim()));
    if (isNaN(x) || isNaN(y)) throw new Error(`Invalid point: ${pair}`);
    return { x, y, pressure: !isNaN(p) ? p : undefined };
  });
}

function parsePoint2(s: string): { x: number; y: number } {
  const [x, y] = s.split(",").map((n) => parseFloat(n.trim()));
  if (isNaN(x) || isNaN(y)) throw new Error(`Invalid point: ${s}`);
  return { x, y };
}

async function activeLayerId(opts: CliOpts): Promise<string | null> {
  return (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read JSON from ${file}: ${(error as Error).message}`);
  }
}

function inferAssetMimeType(file: string, data: Buffer): "image/png" | "image/jpeg" {
  const extension = extname(file).toLowerCase();
  const isPng = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (extension === ".png" && isPng) return "image/png";
  if ((extension === ".jpg" || extension === ".jpeg") && isJpeg) return "image/jpeg";
  if (isPng) return "image/png";
  if (isJpeg) return "image/jpeg";
  throw new Error(`Unsupported asset ${file}: expected a PNG or JPEG file`);
}

function httpBaseUrl(opts: CliOpts): string {
  return (opts.url ?? process.env.PAINT_WS_URL ?? "ws://127.0.0.1:8080")
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/$/, "");
}

function getOpts(): CliOpts {
  return program.opts();
}

function output(opts: CliOpts, value: unknown): void {
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

program.command("info").action(async () => {
  const opts = getOpts();
  const info = await rpc(opts, "canvas.getInfo");
  output(opts, info);
});

program
  .command("analyze")
  .description("Measure coverage, bounds, luminance and dominant colors")
  .option("--layer <lid>", "Analyze one layer instead of the composite")
  .option("--stride <n>", "Sample every Nth pixel", "1")
  .option("--alpha-threshold <n>", "Minimum alpha counted as painted", "1")
  .option("--bins <n>", "Luminance histogram bins", "16")
  .option("--colors <n>", "Dominant color count", "5")
  .option("--background", "Composite the canvas background", false)
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "canvas.analyze", {
      ...(cmdOpts.layer ? { layerId: cmdOpts.layer } : {}),
      stride: parseInt(cmdOpts.stride, 10),
      alphaThreshold: parseInt(cmdOpts.alphaThreshold, 10),
      histogramBins: parseInt(cmdOpts.bins, 10),
      dominantColors: parseInt(cmdOpts.colors, 10),
      includeBackground: Boolean(cmdOpts.background),
    });
    output(opts, result);
  });

program
  .command("sample")
  .description("Read exact RGBA values at canvas coordinates")
  .requiredOption("--points <list>", 'Points "x,y[;x,y...]"')
  .option("--layer <lid>", "Sample one layer instead of the composite")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const points = parsePoints(cmdOpts.points).map(({ x, y }) => ({ x: Math.trunc(x), y: Math.trunc(y) }));
    const result = await rpc(opts, "canvas.sample", {
      ...(cmdOpts.layer ? { layerId: cmdOpts.layer } : {}),
      points,
    });
    output(opts, result);
  });

program
  .command("stroke")
  .option("--brush", "Use brush tool")
  .option("--eraser", "Use eraser tool")
  .requiredOption("--color <c>", "Stroke color", "#000000")
  .requiredOption("--size <n>", "Stroke size", "8")
  .option("--opacity <n>", "Opacity 0..1", "1")
  .requiredOption("--points <list>", 'Points "x,y[;x,y...]"')
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const tool = cmdOpts.eraser ? "eraser" : "brush";
    const result = await rpc(opts, "draw.stroke", {
      layerId: (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId,
      tool,
      color: parseColor(cmdOpts.color),
      size: parseFloat(cmdOpts.size),
      opacity: parseFloat(cmdOpts.opacity),
      points: parsePoints(cmdOpts.points),
    });
    output(opts, result);
  });

program
  .command("line")
  .requiredOption("--from <p>", "Start point 'x,y'", "0,0")
  .requiredOption("--to <p>", "End point 'x,y'")
  .option("--color <c>", "Color", "#000000")
  .option("--size <n>", "Size", "2")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const layerId = (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId;
    const result = await rpc(opts, "draw.line", {
      layerId,
      from: parsePoint2(cmdOpts.from),
      to: parsePoint2(cmdOpts.to),
      color: parseColor(cmdOpts.color),
      size: parseFloat(cmdOpts.size),
    });
    output(opts, result);
  });

program
  .command("rect")
  .requiredOption("--x <n>", "X", "0")
  .requiredOption("--y <n>", "Y", "0")
  .requiredOption("--w <n>", "Width")
  .requiredOption("--h <n>", "Height")
  .option("--stroke <c>", "Stroke color")
  .option("--fill <c>", "Fill color")
  .option("--stroke-width <n>", "Stroke width", "1")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const layerId = (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId;
    const result = await rpc(opts, "draw.rect", {
      layerId,
      x: parseFloat(cmdOpts.x),
      y: parseFloat(cmdOpts.y),
      w: parseFloat(cmdOpts.w),
      h: parseFloat(cmdOpts.h),
      stroke: cmdOpts.stroke ? parseColor(cmdOpts.stroke) : undefined,
      fill: cmdOpts.fill ? parseColor(cmdOpts.fill) : undefined,
      strokeWidth: parseFloat(cmdOpts.strokeWidth),
    });
    output(opts, result);
  });

program
  .command("circle")
  .requiredOption("--cx <n>", "Center X")
  .requiredOption("--cy <n>", "Center Y")
  .requiredOption("--r <n>", "Radius")
  .option("--stroke <c>", "Stroke color")
  .option("--fill <c>", "Fill color")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const layerId = (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId;
    const result = await rpc(opts, "draw.circle", {
      layerId,
      cx: parseFloat(cmdOpts.cx),
      cy: parseFloat(cmdOpts.cy),
      r: parseFloat(cmdOpts.r),
      stroke: cmdOpts.stroke ? parseColor(cmdOpts.stroke) : undefined,
      fill: cmdOpts.fill ? parseColor(cmdOpts.fill) : undefined,
    });
    output(opts, result);
  });

program
  .command("path")
  .description("Draw a native path from a JSON file")
  .argument("<file>", "JSON array of commands, or a draw.path params object")
  .option("--layer <lid>", "Layer ID (default: active)")
  .option("--stroke <c>", "Stroke color")
  .option("--fill <c>", "Fill color")
  .option("--stroke-width <n>", "Stroke width")
  .option("--opacity <n>", "Opacity 0..1")
  .action(async (file, cmdOpts) => {
    const opts = getOpts();
    const value = await readJson(file);
    const fromFile = Array.isArray(value) ? { commands: value } : (value as Record<string, unknown>);
    if (!fromFile || typeof fromFile !== "object") throw new Error("Path JSON must be an array or object");
    const result = await rpc(opts, "draw.path", {
      ...fromFile,
      layerId: cmdOpts.layer ?? fromFile.layerId ?? (await activeLayerId(opts)),
      ...(cmdOpts.stroke ? { stroke: parseColor(cmdOpts.stroke) } : {}),
      ...(cmdOpts.fill ? { fill: parseColor(cmdOpts.fill) } : {}),
      ...(cmdOpts.strokeWidth ? { strokeWidth: parseFloat(cmdOpts.strokeWidth) } : {}),
      ...(cmdOpts.opacity ? { opacity: parseFloat(cmdOpts.opacity) } : {}),
    });
    output(opts, result);
  });

program
  .command("gradient")
  .description("Draw a native gradient from a JSON params file")
  .argument("<file>", "JSON object with gradient, shape and stops")
  .option("--layer <lid>", "Layer ID (default: active)")
  .action(async (file, cmdOpts) => {
    const opts = getOpts();
    const value = await readJson(file);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Gradient JSON must be an object");
    }
    const fromFile = value as Record<string, unknown>;
    const result = await rpc(opts, "draw.gradient", {
      ...fromFile,
      layerId: cmdOpts.layer ?? fromFile.layerId ?? (await activeLayerId(opts)),
    });
    output(opts, result);
  });

program
  .command("image")
  .description("Place an immutable raster asset on a layer")
  .requiredOption("--asset <id>", "Asset ID returned by asset add")
  .requiredOption("--x <n>", "X")
  .requiredOption("--y <n>", "Y")
  .option("--layer <lid>", "Layer ID (default: active)")
  .option("--width <n>", "Rendered width")
  .option("--height <n>", "Rendered height")
  .option("--opacity <n>", "Opacity 0..1", "1")
  .option("--rotate <degrees>", "Clockwise rotation in degrees", "0")
  .option("--no-smoothing", "Disable image smoothing")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "draw.image", {
      layerId: cmdOpts.layer ?? (await activeLayerId(opts)),
      assetId: cmdOpts.asset,
      x: parseFloat(cmdOpts.x),
      y: parseFloat(cmdOpts.y),
      ...(cmdOpts.width ? { width: parseFloat(cmdOpts.width) } : {}),
      ...(cmdOpts.height ? { height: parseFloat(cmdOpts.height) } : {}),
      opacity: parseFloat(cmdOpts.opacity),
      rotate: parseFloat(cmdOpts.rotate),
      smoothing: cmdOpts.smoothing,
    });
    output(opts, result);
  });

program
  .command("fill")
  .requiredOption("--x <n>", "X")
  .requiredOption("--y <n>", "Y")
  .requiredOption("--color <c>", "Fill color")
  .option("--tolerance <n>", "Tolerance 0..64", "16")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const layerId = (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId;
    const result = await rpc(opts, "draw.fill", {
      layerId,
      x: parseInt(cmdOpts.x, 10),
      y: parseInt(cmdOpts.y, 10),
      color: parseColor(cmdOpts.color),
      tolerance: parseInt(cmdOpts.tolerance, 10),
    });
    output(opts, result);
  });

program
  .command("text")
  .requiredOption("--x <n>", "X")
  .requiredOption("--y <n>", "Y")
  .requiredOption("--content <text>", "Text to draw")
  .option("--font <name>", "Font family (noto-sans|source-han-sans|monospace)", "noto-sans")
  .option("--size <n>", "Font size", "24")
  .option("--color <c>", "Color", "#000000")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const layerId = (await rpc<{ activeLayerId: string | null }>(opts, "canvas.getInfo")).activeLayerId;
    const result = await rpc(opts, "draw.text", {
      layerId,
      x: parseFloat(cmdOpts.x),
      y: parseFloat(cmdOpts.y),
      text: cmdOpts.content,
      fontFamily: cmdOpts.font,
      size: parseFloat(cmdOpts.size),
      color: parseColor(cmdOpts.color),
    });
    output(opts, result);
  });

const layer = program.command("layer").description("Layer operations");
layer
  .command("create")
  .option("--name <s>", "Layer name")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc<{ layerId: string }>(opts, "layer.create", { name: cmdOpts.name });
    output(opts, result);
  });
layer.command("list").action(async () => {
  const opts = getOpts();
  const result = await rpc(opts, "layer.list");
  output(opts, result);
});
layer
  .command("active")
  .requiredOption("--id <lid>", "Layer ID")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "layer.setActive", { layerId: cmdOpts.id });
    output(opts, result);
  });
layer
  .command("visible")
  .requiredOption("--id <lid>", "Layer ID")
  .requiredOption("--on <bool>", "true|false")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "layer.setVisible", {
      layerId: cmdOpts.id,
      visible: cmdOpts.on === "true",
    });
    output(opts, result);
  });
layer
  .command("opacity")
  .requiredOption("--id <lid>", "Layer ID")
  .requiredOption("--value <n>", "0..1")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "layer.setOpacity", {
      layerId: cmdOpts.id,
      opacity: parseFloat(cmdOpts.value),
    });
    output(opts, result);
  });
layer
  .command("merge")
  .requiredOption("--from <lid>", "From layer ID")
  .requiredOption("--into <lid>", "Into layer ID")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "layer.merge", { fromId: cmdOpts.from, intoId: cmdOpts.into });
    output(opts, result);
  });
layer
  .command("transform")
  .description("Bake an affine transform into a layer")
  .requiredOption("--id <lid>", "Layer ID")
  .option("--translate-x <n>", "Horizontal translation", "0")
  .option("--translate-y <n>", "Vertical translation", "0")
  .option("--scale-x <n>", "Horizontal scale", "1")
  .option("--scale-y <n>", "Vertical scale", "1")
  .option("--rotate <degrees>", "Clockwise rotation", "0")
  .option("--pivot-x <n>", "Transform pivot X")
  .option("--pivot-y <n>", "Transform pivot Y")
  .option("--no-smoothing", "Disable image smoothing")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "layer.transform", {
      layerId: cmdOpts.id,
      translateX: parseFloat(cmdOpts.translateX),
      translateY: parseFloat(cmdOpts.translateY),
      scaleX: parseFloat(cmdOpts.scaleX),
      scaleY: parseFloat(cmdOpts.scaleY),
      rotate: parseFloat(cmdOpts.rotate),
      ...(cmdOpts.pivotX ? { pivotX: parseFloat(cmdOpts.pivotX) } : {}),
      ...(cmdOpts.pivotY ? { pivotY: parseFloat(cmdOpts.pivotY) } : {}),
      smoothing: cmdOpts.smoothing,
    });
    output(opts, result);
  });
layer.command("flatten").action(async () => {
  const opts = getOpts();
  const result = await rpc(opts, "layer.flatten");
  output(opts, result);
});

const asset = program.command("asset").description("Immutable PNG/JPEG asset library");

asset
  .command("add")
  .argument("<file>", "PNG or JPEG file")
  .option("--name <name>", "Human-readable asset name")
  .action(async (file, cmdOpts) => {
    const opts = getOpts();
    const data = await readFile(file);
    const result = await rpc(opts, "asset.put", {
      data: data.toString("base64"),
      mimeType: inferAssetMimeType(file, data),
      ...(cmdOpts.name ? { name: cmdOpts.name } : {}),
    });
    output(opts, result);
  });

asset
  .command("list")
  .option("--limit <n>", "Maximum assets", "100")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    output(opts, await rpc(opts, "asset.list", { limit: parseInt(cmdOpts.limit, 10) }));
  });

asset
  .command("get")
  .requiredOption("--id <id>", "Asset ID")
  .option("--out <path>", "Download the immutable asset")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const metadata = await rpc<{ url: string; size: number }>(opts, "asset.get", {
      assetId: cmdOpts.id,
    });
    if (!cmdOpts.out) return output(opts, metadata);
    const response = await fetch(httpBaseUrl(opts) + metadata.url);
    if (!response.ok) throw new Error(`Asset download failed: HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    await writeFile(cmdOpts.out, Buffer.from(data));
    output(opts, { saved: cmdOpts.out, size: data.byteLength });
  });

const history = program.command("history").description("History operations");
history
  .command("undo")
  .option("--steps <n>", "Steps to undo", "1")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "history.undo", { steps: parseInt(cmdOpts.steps, 10) });
    output(opts, result);
  });
history
  .command("redo")
  .option("--steps <n>", "Steps to redo", "1")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "history.redo", { steps: parseInt(cmdOpts.steps, 10) });
    output(opts, result);
  });
history.command("length").action(async () => {
  const opts = getOpts();
  const result = await rpc(opts, "history.getLength");
  output(opts, result);
});

const filter = program.command("filter").description("Filters");
filter
  .command("blur")
  .requiredOption("--radius <n>", "Radius")
  .option("--layer <lid>", "Layer ID (default: active)")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "filter.blur", {
      layerId: cmdOpts.layer,
      radius: parseFloat(cmdOpts.radius),
    });
    output(opts, result);
  });
filter
  .command("invert")
  .option("--layer <lid>", "Layer ID")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "filter.invert", { layerId: cmdOpts.layer });
    output(opts, result);
  });
filter
  .command("grayscale")
  .option("--layer <lid>", "Layer ID")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "filter.grayscale", { layerId: cmdOpts.layer });
    output(opts, result);
  });

program
  .command("export")
  .requiredOption("--format <f>", "png|jpeg", "png")
  .option("--out <path>", "Output file (default: print URL)")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc<{ url: string; size: number }>(opts, "canvas.export", {
      format: cmdOpts.format,
    });
    if (cmdOpts.out) {
      const baseUrl = (opts.url ?? "").replace(/^ws/, "http");
      const data = await fetch(baseUrl + result.url).then((r) => r.arrayBuffer());
      await writeFile(cmdOpts.out, Buffer.from(data));
      output(opts, { saved: cmdOpts.out, size: data.byteLength });
    } else {
      output(opts, result);
    }
  });

program
  .command("save")
  .requiredOption("--name <n>", "Snapshot name")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "snapshot.save", { name: cmdOpts.name });
    output(opts, result);
  });

program
  .command("load")
  .requiredOption("--name <n>", "Snapshot name")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "snapshot.load", { name: cmdOpts.name });
    output(opts, result);
  });

program
  .command("subscribe")
  .option("--types <list>", "Comma-separated event types (default: all)")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const types = cmdOpts.types ? cmdOpts.types.split(",").map((s: string) => s.trim()) : undefined;
    await rpc(
      opts,
      "event.subscribe",
      { types },
      (evt) => {
        console.log(JSON.stringify(evt));
      },
    );
    // Keep alive
    console.error("[subscribe] listening, Ctrl+C to exit");
    process.on("SIGINT", () => process.exit(0));
    // Keep the node process alive indefinitely
    setInterval(() => {}, 1 << 30);
  });

program
  .command("transaction")
  .description("Execute a JSONL edit file atomically as one canonical document commit")
  .argument("<file>", "JSONL file of mutation operations")
  .requiredOption("--idempotency-key <key>", "Stable retry key")
  .option("--message <text>", "Commit message", "Atomic edit")
  .action(async (file, cmdOpts) => {
    const opts = getOpts();
    const input = await readFile(file, "utf8");
    const operations: { method: string; params?: unknown }[] = [];
    for (const [index, raw] of input.split("\n").entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      try {
        operations.push(JSON.parse(line) as { method: string; params?: unknown });
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1}: ${(error as Error).message}`);
      }
    }
    const result = await rpc(opts, "transaction.execute", {
      idempotencyKey: cmdOpts.idempotencyKey,
      message: cmdOpts.message,
      operations,
    });
    output(opts, result);
  });

const doc = program.command("doc").description("Canonical document and version operations");

doc
  .command("get")
  .option("--commit <id>", "Read a specific commit")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    output(opts, await rpc(opts, "doc.get", cmdOpts.commit ? { commitId: cmdOpts.commit } : {}));
  });

doc
  .command("history")
  .option("--limit <n>", "Maximum commits", "100")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    output(opts, await rpc(opts, "doc.history", { limit: parseInt(cmdOpts.limit, 10) }));
  });

doc
  .command("undo")
  .option("--steps <n>", "Document commits", "1")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    output(opts, await rpc(opts, "doc.undo", { steps: parseInt(cmdOpts.steps, 10) }));
  });

doc
  .command("redo")
  .option("--steps <n>", "Document commits", "1")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    output(opts, await rpc(opts, "doc.redo", { steps: parseInt(cmdOpts.steps, 10) }));
  });

doc
  .command("branch")
  .argument("<action>", "list | create | switch")
  .option("--name <name>", "Branch name")
  .action(async (action, cmdOpts) => {
    const opts = getOpts();
    if (action === "list") return output(opts, await rpc(opts, "doc.branch.list"));
    if (!cmdOpts.name) throw new Error(`doc branch ${action} requires --name`);
    if (action === "create") {
      return output(opts, await rpc(opts, "doc.branch.create", { name: cmdOpts.name }));
    }
    if (action === "switch") {
      return output(opts, await rpc(opts, "doc.branch.switch", { name: cmdOpts.name }));
    }
    throw new Error(`Unknown doc branch action: ${action}`);
  });

doc
  .command("checkpoint")
  .argument("<action>", "list | create | restore")
  .option("--name <name>", "Checkpoint name")
  .option("--message <text>", "Checkpoint note")
  .action(async (action, cmdOpts) => {
    const opts = getOpts();
    if (action === "list") return output(opts, await rpc(opts, "doc.checkpoint.list"));
    if (!cmdOpts.name) throw new Error(`doc checkpoint ${action} requires --name`);
    if (action === "create") {
      return output(
        opts,
        await rpc(opts, "doc.checkpoint.create", {
          name: cmdOpts.name,
          ...(cmdOpts.message ? { message: cmdOpts.message } : {}),
        }),
      );
    }
    if (action === "restore") {
      return output(opts, await rpc(opts, "doc.checkpoint.restore", { name: cmdOpts.name }));
    }
    throw new Error(`Unknown doc checkpoint action: ${action}`);
  });

doc
  .command("render")
  .description("Render the canonical document headlessly as deterministic SVG")
  .option("--commit <id>", "Render a specific commit")
  .option("--out <path>", "Download SVG to a file")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc<{ url: string; size: number; digest: string; warnings: string[] }>(
      opts,
      "doc.render",
      { format: "svg", ...(cmdOpts.commit ? { commitId: cmdOpts.commit } : {}) },
    );
    if (!cmdOpts.out) return output(opts, result);
    const baseUrl = (opts.url ?? "").replace(/^ws/, "http");
    const data = await fetch(baseUrl + result.url).then((response) => response.arrayBuffer());
    await writeFile(cmdOpts.out, Buffer.from(data));
    output(opts, {
      saved: cmdOpts.out,
      size: data.byteLength,
      digest: result.digest,
      warnings: result.warnings,
    });
  });

// ---------------------------------------------------------------------------
// script — run many RPCs over ONE WebSocket connection.
//
// File format: JSONL, one RPC per line:
//   {"method": "draw.rect", "params": {"layerId": "L_x", "x": 10, ...}}
//   {"method": "layer.setActive", "params": {"layerId": "L_y"}}
//
// Lines starting with # or blank are ignored.
// Special: a line `{"eval": "canvas.getInfo"}` runs the RPC and uses its
// result.activeLayerId as the layerId for subsequent {{layerId}} templates.
//
// Usage:
//   paint-cli script ops.jsonl
//   cat ops.jsonl | paint-cli script -
program
  .command("script")
  .argument("<file>", "JSONL file (or - for stdin)")
  .option("--dry-run", "Print parsed ops without sending")
  .option("--stop-on-error", "Abort on first RPC error (default: continue)")
  .action(async (file, cmdOpts) => {
    const opts = getOpts();
    const url = (opts.url ?? "") + (opts.token ? `/?token=${encodeURIComponent(opts.token!)}` : "");
    const timeoutMs = parseInt(opts.timeout, 10);
    const ws = new WebSocket(url);
    const clientId = "A_" + randomUUID().slice(0, 8);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    // Context for {{layerId}} / {{layer:N}} templating
    const ctx: { activeLayerId?: string; layers: string[] } = { layers: [] };

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as JsonRpcResponse | JsonRpcRequest;
      if (msg.id !== undefined && !(msg as JsonRpcRequest).method) {
        const r = msg as JsonRpcResponse;
        const p = pending.get(r.id as number);
        if (!p) return;
        pending.delete(r.id as number);
        if (r.error) p.reject(r.error);
        else p.resolve(r.result ?? null);
      }
    });

    // Hello
    const helloId = nextId++;
    await new Promise<void>((resolve, reject) => {
      pending.set(helloId, { resolve: () => resolve(), reject });
      ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: helloId, method: "sync.hello", params: { role: "agent", clientId } }));
      setTimeout(() => reject(new Error("hello timeout")), timeoutMs);
    });

    // Helper: get current active layer id (cached, refresh on layer.setActive / layer.create)
    async function fetchActiveLayerId(): Promise<string | null> {
      const id = nextId++;
      const info = (await new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method: "canvas.getInfo" }));
        setTimeout(() => reject(new Error("timeout")), timeoutMs);
      })) as { activeLayerId: string | null } | null;
      ctx.activeLayerId = info?.activeLayerId ?? undefined;
      return info?.activeLayerId ?? null;
    }

    async function call(method: string, params?: unknown): Promise<unknown> {
      // Template substitution: replace "{{layerId}}" with current active layer id,
      // "{{layer:N}}" with ctx.layers[N].
      let p = params;
      if (p && typeof p === "object") {
        const s = JSON.stringify(p);
        if (s.includes("{{")) {
          if (!ctx.activeLayerId) await fetchActiveLayerId();
          const replaced = s
            .replace(/\{\{layerId\}\}/g, ctx.activeLayerId ?? "")
            .replace(/\{\{layer:(\d+)\}\}/g, (_m, idx) => ctx.layers[parseInt(idx, 10)] ?? "");
          p = JSON.parse(replaced);
        }
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params: p }));
        setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), timeoutMs);
      });
    }

    // Read ops
    let input: string;
    if (file === "-") {
      // Read all of stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      input = Buffer.concat(chunks).toString("utf8");
    } else {
      input = await readFile(file, "utf8");
    }
    const lines = input.split("\n");
    const stats = { ok: 0, err: 0, skip: 0 };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith("#")) { stats.skip++; continue; }
      let op: { method: string; params?: unknown };
      try {
        op = JSON.parse(line);
      } catch (e) {
        console.error(`[line ${i + 1}] invalid JSON: ${(e as Error).message}`);
        stats.err++;
        if (cmdOpts.stopOnError) break;
        continue;
      }
      if (cmdOpts.dryRun) {
        console.log(JSON.stringify(op));
        continue;
      }
      try {
        const result = await call(op.method, op.params);
        // Track side effects for templating
        if (op.method === "layer.create") {
          const r = result as { layerId?: string };
          if (r?.layerId) ctx.layers.push(r.layerId);
        }
        if (op.method === "layer.setActive") {
          const p = op.params as { layerId?: string };
          if (p?.layerId) ctx.activeLayerId = p.layerId;
        }
        stats.ok++;
      } catch (e) {
        stats.err++;
        const msg = e && typeof e === "object" && "message" in e ? (e as { message: string }).message : String(e);
        console.error(`[line ${i + 1}] ${op.method} failed: ${msg}`);
        if (cmdOpts.stopOnError) break;
      }
    }

    if (!cmdOpts.dryRun) {
      console.error(`\n[script] ok=${stats.ok} err=${stats.err} skip=${stats.skip}`);
    }
    ws.close();
    process.exit(stats.err > 0 && cmdOpts.stopOnError ? 1 : 0);
  });

// ---------------------------------------------------------------------------
// ops / state / snapshot — for multimodal agent workflows
// ---------------------------------------------------------------------------

program
  .command("ops")
  .argument("<action>", "list | clear | step")
  .option("--since <n>", "List ops since step N")
  .option("--prefix <s>", "Filter by method prefix (e.g. 'draw.')")
  .option("--limit <n>", "Limit to last N ops")
  .action(async (action, cmdOpts) => {
    const opts = getOpts();
    if (action === "step") {
      const result = await rpc<{ step: number }>(opts, "ops.getStep");
      output(opts, result);
      return;
    }
    if (action === "clear") {
      const result = await rpc(opts, "ops.clear");
      output(opts, result);
      return;
    }
    if (action === "list") {
      const filter: { sinceStep?: number; methodPrefix?: string; limit?: number } = {};
      if (cmdOpts.since) filter.sinceStep = parseInt(cmdOpts.since, 10);
      if (cmdOpts.prefix) filter.methodPrefix = cmdOpts.prefix;
      if (cmdOpts.limit) filter.limit = parseInt(cmdOpts.limit, 10);
      const result = await rpc<{ ops: unknown[] }>(opts, "ops.list", filter);
      output(opts, result);
      return;
    }
    throw new Error(`Unknown ops action: ${action}`);
  });

program
  .command("snapshot")
  .description("Take a current-canvas PNG snapshot, return its URL")
  .option("--out <path>", "Download to file instead of printing URL")
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc<{ url: string; size: number }>(opts, "canvas.snapshot");
    if (cmdOpts.out) {
      const baseUrl = (opts.url ?? "").replace(/^ws/, "http");
      const data = await fetch(baseUrl + result.url).then((r) => r.arrayBuffer());
      await writeFile(cmdOpts.out, Buffer.from(data));
      output(opts, { saved: cmdOpts.out, size: data.byteLength });
    } else {
      output(opts, result);
    }
  });

program
  .command("state")
  .description("Get full layer state JSON with per-layer thumbnail URLs")
  .action(async () => {
    const opts = getOpts();
    const result = await rpc(opts, "canvas.getState");
    output(opts, result);
  });

program
  .command("replay")
  .description("Replay ops 1..N on primary, optionally returning a snapshot")
  .requiredOption("--to-step <n>", "Replay up to step N (inclusive)")
  .option("--snapshot", "Also return a PNG snapshot URL after replay", true)
  .action(async (cmdOpts) => {
    const opts = getOpts();
    const result = await rpc(opts, "ops.replay", {
      toStep: parseInt(cmdOpts.toStep, 10),
      snapshot: cmdOpts.snapshot !== false,
    });
    output(opts, result);
  });

program.parseAsync(process.argv).catch((err) => {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: number; message: string; data?: unknown };
    console.error(`RPC error ${e.code}: ${e.message}`);
    if (e.data !== undefined) console.error(JSON.stringify(e.data, null, 2));
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
