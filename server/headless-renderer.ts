import { createHash } from "node:crypto";
import type {
  BlendMode,
  DocumentOperation,
  DocumentReplaySnapshot,
  Layer,
} from "../shared/protocol.js";

interface RenderLayer extends Layer {
  elements: string[];
}

export interface HeadlessRenderResult {
  svg: string;
  digest: string;
  warnings: string[];
}

export interface HeadlessAsset {
  dataUrl: string;
  width: number;
  height: number;
}

export interface HeadlessRenderOptions {
  assets?: ReadonlyMap<string, HeadlessAsset>;
}

export function collectDocumentAssetIds(snapshot: DocumentReplaySnapshot): string[] {
  return [
    ...new Set(
      snapshot.operations
        .map((operation) => operationParams(operation).assetId)
        .filter((assetId): assetId is string => typeof assetId === "string"),
    ),
  ].sort();
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function attr(name: string, value: unknown): string {
  return value === undefined ? "" : ` ${name}="${escapeXml(value)}"`;
}

function paintAttrs(params: Record<string, unknown>): string {
  return [
    attr("fill", params.fill ?? "none"),
    attr("stroke", params.stroke),
    attr("stroke-width", params.strokeWidth),
    attr("opacity", params.opacity),
  ].join("");
}

function operationParams(operation: DocumentOperation): Record<string, unknown> {
  return operation.params && typeof operation.params === "object"
    ? (operation.params as Record<string, unknown>)
    : {};
}

/**
 * Deterministic SVG renderer for canonical native paint-web operations.
 *
 * It is deliberately dependency-free and can run without a browser. Raster
 * baselines are embedded as data URLs. Unsupported pixel algorithms are
 * reported as warnings instead of silently producing nondeterministic output.
 */
export function renderDocumentToSvg(
  snapshot: DocumentReplaySnapshot,
  options: HeadlessRenderOptions = {},
): HeadlessRenderResult {
  let width = snapshot.baseState.width;
  let height = snapshot.baseState.height;
  const warnings: string[] = [];
  const defs: string[] = [];
  const raster = new Map(snapshot.baseRaster.map((layer) => [layer.id, layer.png]));
  const layers = new Map<string, RenderLayer>();
  let order: string[] = [];

  for (const layer of snapshot.baseState.layers) {
    const png = raster.get(layer.id);
    layers.set(layer.id, {
      ...structuredClone(layer),
      elements: png
        ? [
            `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${png}"/>`,
          ]
        : [],
    });
    order.push(layer.id);
  }

  const targetLayers = (layerId?: unknown): RenderLayer[] => {
    if (typeof layerId === "string") {
      const layer = layers.get(layerId);
      return layer ? [layer] : [];
    }
    return order.map((id) => layers.get(id)).filter((layer): layer is RenderLayer => Boolean(layer));
  };

  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  snapshot.operations.forEach((operation, operationIndex) => {
    const params = operationParams(operation);
    const layerId = params.layerId;
    const layer = typeof layerId === "string" ? layers.get(layerId) : undefined;
    const suffix = `${operationIndex + 1}`;

    switch (operation.method) {
      case "canvas.resize": {
        const nextWidth = number(params.width, width);
        const nextHeight = number(params.height, height);
        if (params.mode === "scale" && width > 0 && height > 0) {
          const scaleX = nextWidth / width;
          const scaleY = nextHeight / height;
          for (const item of layers.values()) {
            item.elements = [
              `<g transform="scale(${scaleX} ${scaleY})">${item.elements.join("")}</g>`,
            ];
          }
        }
        width = nextWidth;
        height = nextHeight;
        break;
      }
      case "canvas.clear":
        for (const item of targetLayers(layerId)) item.elements = [];
        break;
      case "canvas.fill":
        for (const item of targetLayers(layerId)) {
          item.elements.push(
            `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(params.color)}"/>`,
          );
        }
        break;
      case "canvas.import":
        if (layer && typeof params.assetId === "string") {
          const asset = options.assets?.get(params.assetId);
          if (asset) {
            layer.elements = [
              `<image x="0" y="0" width="${asset.width}" height="${asset.height}" href="${escapeXml(asset.dataUrl)}"/>`,
            ];
          } else {
            warn(`Missing headless asset: ${params.assetId}`);
          }
        } else if (layer && typeof params.url === "string") {
          layer.elements = [
            `<image x="0" y="0" width="${width}" height="${height}" href="${escapeXml(params.url)}"/>`,
          ];
          warn("canvas.import references an external URL; raster keyframe is recommended");
        }
        break;
      case "layer.create": {
        if (typeof layerId !== "string") {
          warn("layer.create without a canonical layerId was skipped");
          break;
        }
        if (!layers.has(layerId)) {
          layers.set(layerId, {
            id: layerId,
            name: typeof params.name === "string" ? params.name : `Layer ${order.length + 1}`,
            visible: true,
            opacity: 1,
            blendMode: "source-over",
            elements: [],
          });
          order.push(layerId);
        }
        break;
      }
      case "layer.delete":
        if (typeof layerId === "string") {
          layers.delete(layerId);
          order = order.filter((id) => id !== layerId);
        }
        break;
      case "layer.setVisible":
        if (layer) layer.visible = Boolean(params.visible);
        break;
      case "layer.setOpacity":
        if (layer) layer.opacity = number(params.opacity, 1);
        break;
      case "layer.setBlendMode":
        if (layer && typeof params.blendMode === "string") {
          layer.blendMode = params.blendMode as BlendMode;
        }
        break;
      case "layer.rename":
        if (layer && typeof params.name === "string") layer.name = params.name;
        break;
      case "layer.setActive":
        break;
      case "layer.reorder": {
        const ids = Array.isArray(params.layerIds)
          ? params.layerIds.filter((id): id is string => typeof id === "string" && layers.has(id))
          : [];
        if (ids.length === layers.size) order = ids;
        else warn("Incomplete layer.reorder was ignored by the headless renderer");
        break;
      }
      case "layer.merge": {
        const fromId = typeof params.fromId === "string" ? params.fromId : "";
        const intoId = typeof params.intoId === "string" ? params.intoId : "";
        const from = layers.get(fromId);
        const into = layers.get(intoId);
        if (from && into) {
          into.elements.push(
            `<g opacity="${from.opacity}" style="mix-blend-mode:${escapeXml(from.blendMode)}">${from.elements.join("")}</g>`,
          );
          layers.delete(fromId);
          order = order.filter((id) => id !== fromId);
        }
        break;
      }
      case "layer.flatten": {
        const flattenedId = typeof layerId === "string" ? layerId : `flattened-${suffix}`;
        const content = order
          .map((id) => layers.get(id))
          .filter((item): item is RenderLayer => Boolean(item?.visible))
          .map(
            (item) =>
              `<g opacity="${item.opacity}" style="mix-blend-mode:${escapeXml(item.blendMode)}">${item.elements.join("")}</g>`,
          )
          .join("");
        layers.clear();
        layers.set(flattenedId, {
          id: flattenedId,
          name: "Flattened",
          visible: true,
          opacity: 1,
          blendMode: "source-over",
          elements: [content],
        });
        order = [flattenedId];
        break;
      }
      case "layer.transform": {
        if (!layer) break;
        const translateX = number(params.translateX);
        const translateY = number(params.translateY);
        const scaleX = number(params.scaleX, 1);
        const scaleY = number(params.scaleY, 1);
        const radians = (number(params.rotate) * Math.PI) / 180;
        const pivotX = number(params.pivotX, width / 2);
        const pivotY = number(params.pivotY, height / 2);
        const cosine = Math.cos(radians);
        const sine = Math.sin(radians);
        const a = cosine * scaleX;
        const b = sine * scaleX;
        const c = -sine * scaleY;
        const d = cosine * scaleY;
        const e = pivotX + translateX - a * pivotX - c * pivotY;
        const f = pivotY + translateY - b * pivotX - d * pivotY;
        layer.elements = [
          `<g transform="matrix(${a} ${b} ${c} ${d} ${e} ${f})">${layer.elements.join("")}</g>`,
        ];
        break;
      }
      case "draw.line":
        if (layer) {
          const from = (params.from ?? {}) as Record<string, unknown>;
          const to = (params.to ?? {}) as Record<string, unknown>;
          const dash = Array.isArray(params.dash) ? attr("stroke-dasharray", params.dash.join(" ")) : "";
          layer.elements.push(
            `<line x1="${number(from.x)}" y1="${number(from.y)}" x2="${number(to.x)}" y2="${number(to.y)}" stroke="${escapeXml(params.color)}" stroke-width="${number(params.size, 1)}" stroke-linecap="round"${attr("opacity", params.opacity)}${dash}/>` ,
          );
        }
        break;
      case "draw.rect":
        if (layer) {
          layer.elements.push(
            `<rect x="${number(params.x)}" y="${number(params.y)}" width="${number(params.w)}" height="${number(params.h)}"${paintAttrs(params)}/>` ,
          );
        }
        break;
      case "draw.circle":
        if (layer) {
          layer.elements.push(
            `<circle cx="${number(params.cx)}" cy="${number(params.cy)}" r="${number(params.r)}"${paintAttrs(params)}/>` ,
          );
        }
        break;
      case "draw.ellipse":
        if (layer) {
          layer.elements.push(
            `<ellipse cx="${number(params.cx)}" cy="${number(params.cy)}" rx="${number(params.rx)}" ry="${number(params.ry)}"${paintAttrs(params)}/>` ,
          );
        }
        break;
      case "draw.stroke": {
        if (!layer) break;
        const points = Array.isArray(params.points)
          ? params.points
              .map((point) => point as Record<string, unknown>)
              .map((point) => `${number(point.x)},${number(point.y)}`)
              .join(" ")
          : "";
        const embeddedBrush = params.brush && typeof params.brush === "object"
          ? params.brush as Record<string, unknown>
          : undefined;
        const brushId = embeddedBrush?.id ?? params.brushPresetId;
        const brushAttrs = [
          attr("data-brush", brushId),
          attr("data-seed", params.seed),
          attr("data-stroke-version", params.strokeVersion),
        ].join("");
        // Eraser: represent as dashed white line so it's visible in SVG preview
        const isEraser = params.tool === "eraser";
        if (isEraser) warn("draw.stroke eraser is approximated in SVG preview");
        if (brushId) warn(`draw.stroke brush ${String(brushId)} is approximated as an SVG polyline`);
        const strokeColor = isEraser ? "#ffffff" : escapeXml(params.color);
        const dashAttr = isEraser ? ` stroke-dasharray="${number(params.size, 4)},${number(params.size, 2)}"` : "";
        const opacityVal = isEraser ? 0.6 : params.opacity;
        layer.elements.push(
          `<polyline points="${points}" fill="none" stroke="${strokeColor}" stroke-width="${number(params.size, 1)}" stroke-linecap="round" stroke-linejoin="round"${attr("opacity", opacityVal)}${dashAttr} data-eraser="${isEraser}"${brushAttrs}/>` ,
        );
        break;
      }
      case "draw.text":
        if (layer) {
          const anchor = params.align === "center" ? "middle" : params.align === "right" ? "end" : "start";
          layer.elements.push(
            `<text x="${number(params.x)}" y="${number(params.y)}" fill="${escapeXml(params.color)}" font-size="${number(params.size, 16)}" font-family="${escapeXml(params.fontFamily ?? "sans-serif")}" text-anchor="${anchor}" dominant-baseline="hanging"${attr("opacity", params.opacity)}>${escapeXml(params.text ?? "")}</text>`,
          );
        }
        break;
      case "draw.setPixel":
        if (layer) {
          layer.elements.push(
            `<rect x="${Math.floor(number(params.x))}" y="${Math.floor(number(params.y))}" width="1" height="1" fill="${escapeXml(params.color)}"/>`,
          );
        }
        break;
      case "draw.path": {
        if (!layer) break;
        const commands = Array.isArray(params.commands)
          ? params.commands.map((command) => command as Record<string, unknown>)
          : [];
        const d = commands
          .map((command) => {
            switch (command.op) {
              case "M":
              case "L":
                return `${command.op} ${number(command.x)} ${number(command.y)}`;
              case "Q":
                return `Q ${number(command.cx)} ${number(command.cy)} ${number(command.x)} ${number(command.y)}`;
              case "C":
                return `C ${number(command.c1x)} ${number(command.c1y)} ${number(command.c2x)} ${number(command.c2y)} ${number(command.x)} ${number(command.y)}`;
              case "Z":
                return "Z";
              default:
                return "";
            }
          })
          .filter(Boolean)
          .join(" ");
        layer.elements.push(
          `<path d="${escapeXml(d)}"${attr("fill", params.fill ?? "none")}${attr("stroke", params.stroke)}${attr("stroke-width", params.strokeWidth)}${attr("opacity", params.opacity)}${attr("fill-rule", params.fillRule)}${attr("stroke-linecap", params.lineCap)}${attr("stroke-linejoin", params.lineJoin)}/>` ,
        );
        break;
      }
      case "draw.gradient": {
        if (!layer) break;
        const gradient = (params.gradient ?? {}) as Record<string, unknown>;
        const shape = (params.shape ?? {}) as Record<string, unknown>;
        const stops = Array.isArray(params.stops)
          ? params.stops.map((stop) => stop as Record<string, unknown>)
          : [];
        const id = `gradient-${suffix}`;
        const stopMarkup = stops
          .map(
            (stop) =>
              `<stop offset="${number(stop.offset) * 100}%" stop-color="${escapeXml(stop.color)}"/>`,
          )
          .join("");
        if (gradient.type === "radial") {
          const inner = (gradient.inner ?? {}) as Record<string, unknown>;
          const outer = (gradient.outer ?? {}) as Record<string, unknown>;
          defs.push(
            `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${number(outer.x)}" cy="${number(outer.y)}" r="${number(outer.r)}" fx="${number(inner.x)}" fy="${number(inner.y)}" fr="${number(inner.r)}">${stopMarkup}</radialGradient>`,
          );
        } else {
          const from = (gradient.from ?? {}) as Record<string, unknown>;
          const to = (gradient.to ?? {}) as Record<string, unknown>;
          defs.push(
            `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${number(from.x)}" y1="${number(from.y)}" x2="${number(to.x)}" y2="${number(to.y)}">${stopMarkup}</linearGradient>`,
          );
        }
        const fill = `url(#${id})`;
        const opacity = attr("opacity", params.opacity);
        if (shape.type === "circle") {
          layer.elements.push(
            `<circle cx="${number(shape.cx)}" cy="${number(shape.cy)}" r="${number(shape.r)}" fill="${fill}"${opacity}/>` ,
          );
        } else if (shape.type === "ellipse") {
          layer.elements.push(
            `<ellipse cx="${number(shape.cx)}" cy="${number(shape.cy)}" rx="${number(shape.rx)}" ry="${number(shape.ry)}" fill="${fill}"${opacity}/>` ,
          );
        } else {
          layer.elements.push(
            `<rect x="${number(shape.x)}" y="${number(shape.y)}" width="${number(shape.w)}" height="${number(shape.h)}" fill="${fill}"${opacity}/>` ,
          );
        }
        break;
      }
      case "draw.image": {
        if (!layer || typeof params.assetId !== "string") break;
        const asset = options.assets?.get(params.assetId);
        if (!asset) {
          warn(`Missing headless asset: ${params.assetId}`);
          break;
        }
        const imageWidth = number(params.width, asset.width);
        const imageHeight = number(params.height, asset.height);
        const x = number(params.x);
        const y = number(params.y);
        const rotation = number(params.rotate);
        const transform = rotation
          ? ` transform="rotate(${rotation} ${x + imageWidth / 2} ${y + imageHeight / 2})"`
          : "";
        layer.elements.push(
          `<image x="${x}" y="${y}" width="${imageWidth}" height="${imageHeight}" href="${escapeXml(asset.dataUrl)}"${attr("opacity", params.opacity)}${transform}/>` ,
        );
        break;
      }
      case "draw.fill":
        warn("draw.fill flood-fill is not represented in SVG preview");
        break;
      case "filter.blur": {
        const id = `filter-blur-${suffix}`;
        defs.push(`<filter id="${id}"><feGaussianBlur stdDeviation="${number(params.radius)}"/></filter>`);
        for (const item of targetLayers(layerId)) {
          item.elements = [`<g filter="url(#${id})">${item.elements.join("")}</g>`];
        }
        break;
      }
      case "filter.grayscale":
      case "filter.invert":
      case "filter.brightness":
      case "filter.contrast": {
        const id = `filter-color-${suffix}`;
        let body = '<feColorMatrix type="saturate" values="0"/>';
        if (operation.method === "filter.invert") {
          body = '<feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>';
        } else if (operation.method === "filter.brightness") {
          const slope = 1 + number(params.amount);
          body = `<feComponentTransfer><feFuncR type="linear" slope="${slope}"/><feFuncG type="linear" slope="${slope}"/><feFuncB type="linear" slope="${slope}"/></feComponentTransfer>`;
        } else if (operation.method === "filter.contrast") {
          const slope = 1 + number(params.amount);
          const intercept = 0.5 - 0.5 * slope;
          body = `<feComponentTransfer><feFuncR type="linear" slope="${slope}" intercept="${intercept}"/><feFuncG type="linear" slope="${slope}" intercept="${intercept}"/><feFuncB type="linear" slope="${slope}" intercept="${intercept}"/></feComponentTransfer>`;
        }
        defs.push(`<filter id="${id}">${body}</filter>`);
        for (const item of targetLayers(layerId)) {
          item.elements = [`<g filter="url(#${id})">${item.elements.join("")}</g>`];
        }
        break;
      }
      case "snapshot.load":
        warn("snapshot.load requires archived raster assets and was skipped");
        break;
      default:
        warn(`Unsupported headless operation: ${operation.method}`);
    }
  });

  // Canonical metadata wins over any approximation in the SVG operation pass.
  order = snapshot.state.layers.map((layer) => layer.id);
  for (const metadata of snapshot.state.layers) {
    const existing = layers.get(metadata.id);
    if (existing) Object.assign(existing, metadata);
    else {
      layers.set(metadata.id, { ...structuredClone(metadata), elements: [] });
      warn(`Final layer ${metadata.id} had no renderable operation history`);
    }
  }

  const body = order
    .map((id) => layers.get(id))
    .filter((layer): layer is RenderLayer => Boolean(layer?.visible))
    .map(
      (layer) =>
        `<g id="${escapeXml(layer.id)}" data-name="${escapeXml(layer.name)}" opacity="${layer.opacity}" style="mix-blend-mode:${escapeXml(layer.blendMode)}">${layer.elements.join("")}</g>`,
    )
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-document-id="${escapeXml(snapshot.documentId)}" data-revision="${snapshot.revision}">`,
    defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "",
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    body,
    "</svg>",
  ].join("");
  return {
    svg,
    digest: createHash("sha256").update(svg).digest("hex"),
    warnings,
  };
}
