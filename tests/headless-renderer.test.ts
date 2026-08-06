import { describe, expect, it } from "vitest";
import { DocumentStore } from "../server/document-store.js";
import { renderDocumentToSvg } from "../server/headless-renderer.js";
import { ServerState } from "../server/state.js";

describe("headless SVG renderer", () => {
  it("renders native document operations deterministically without a browser", () => {
    const state = new ServerState();
    const store = new DocumentStore(state.snapshot());
    store.captureBaseline([{ id: state.activeLayerId, png: "" }]);
    store.recordOperation(
      "draw.rect",
      {
        layerId: state.activeLayerId,
        x: 10,
        y: 20,
        w: 100,
        h: 60,
        fill: "#ff00aa",
        stroke: "#000000",
        strokeWidth: 2,
        opacity: 1,
      },
      null,
      state.snapshot(),
      "agent",
    );
    store.recordOperation(
      "draw.text",
      {
        layerId: state.activeLayerId,
        x: 30,
        y: 40,
        text: "AHA & <signal>",
        fontFamily: "monospace",
        size: 24,
        color: "#ffffff",
        align: "left",
        opacity: 1,
      },
      null,
      state.snapshot(),
      "agent",
    );

    const first = renderDocumentToSvg(store.getReplaySnapshot());
    const second = renderDocumentToSvg(store.getReplaySnapshot());

    expect(first).toEqual(second);
    expect(first.svg).toContain('<rect x="10" y="20" width="100" height="60"');
    expect(first.svg).toContain("AHA &amp; &lt;signal&gt;");
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.warnings).toEqual([]);
  });

  it("reports unsupported pixel algorithms instead of silently approximating them", () => {
    const state = new ServerState();
    const store = new DocumentStore(state.snapshot());
    store.captureBaseline([{ id: state.activeLayerId, png: "" }]);
    store.recordOperation(
      "draw.fill",
      { layerId: state.activeLayerId, x: 1, y: 1, color: "#ffffff", tolerance: 16 },
      null,
      state.snapshot(),
      "agent",
    );

    const rendered = renderDocumentToSvg(store.getReplaySnapshot());

    expect(rendered.warnings).toContain("draw.fill flood-fill is not represented in SVG preview");
  });

  it("renders P1 paths, gradients, immutable images and affine transforms", () => {
    const state = new ServerState();
    const store = new DocumentStore(state.snapshot());
    const layerId = state.activeLayerId;
    const assetId = `A_${"a".repeat(64)}`;
    store.captureBaseline([{ id: layerId, png: "" }]);
    store.recordOperation(
      "draw.path",
      {
        layerId,
        commands: [
          { op: "M", x: 10, y: 10 },
          { op: "C", c1x: 20, c1y: 0, c2x: 30, c2y: 20, x: 40, y: 10 },
          { op: "Z" },
        ],
        fill: "#ff00aa",
        strokeWidth: 1,
        opacity: 1,
        fillRule: "nonzero",
        lineCap: "round",
        lineJoin: "round",
      },
      null,
      state.snapshot(),
      "agent",
    );
    store.recordOperation(
      "draw.gradient",
      {
        layerId,
        gradient: { type: "linear", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
        shape: { type: "rect", x: 0, y: 20, w: 100, h: 40 },
        stops: [
          { offset: 0, color: "#000000" },
          { offset: 1, color: "#ffffff" },
        ],
        opacity: 1,
      },
      null,
      state.snapshot(),
      "agent",
    );
    store.recordOperation(
      "draw.image",
      { layerId, assetId, x: 4, y: 5, width: 12, height: 8, opacity: 1, rotate: 15 },
      null,
      state.snapshot(),
      "agent",
    );
    store.recordOperation(
      "layer.transform",
      {
        layerId,
        translateX: 5,
        translateY: 7,
        scaleX: 1,
        scaleY: 1,
        rotate: 0,
        smoothing: true,
      },
      null,
      state.snapshot(),
      "agent",
    );

    const rendered = renderDocumentToSvg(store.getReplaySnapshot(), {
      assets: new Map([[assetId, { dataUrl: "data:image/png;base64,AAAA", width: 1, height: 1 }]]),
    });

    expect(rendered.svg).toContain('<path d="M 10 10 C 20 0 30 20 40 10 Z"');
    expect(rendered.svg).toContain("<linearGradient");
    expect(rendered.svg).toContain("data:image/png;base64,AAAA");
    expect(rendered.svg).toContain('transform="matrix(1 0 0 1 5 7)"');
    expect(rendered.warnings).toEqual([]);
  });
});
