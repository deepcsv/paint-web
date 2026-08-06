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
});
