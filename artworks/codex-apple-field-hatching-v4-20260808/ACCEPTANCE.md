# Apple V4 acceptance record

## Accepted document state

- Document branch: `art/codex-apple-oblique-hatching-v4-20260808`
- Checkpoint: `apple-oblique-hatching-v4-final-20260808`
- Checkpoint commit: `C_3485_d5b4231ca22d`
- Final PNG: `apple-v4-final.png`
- No raster image was imported into paint-web. The paper is one native rectangle;
  every graphite mark is a native `draw.stroke` operation.

## Direction gate

- Primary/cross median: 33.76°; p95: 38.81°.
- Primary/deep median: 26.36°; p95: 26.36°.
- Cross/deep median: 57.98°; p95: 65.85°.
- The generator aborts when any sampled family pair reaches a 70° p95, well
  before a perpendicular 90° mesh.

## Accepted visible layers

- V4 warm paper.
- Ground/contact shadow streamlines.
- Continuous rough-pencil value mass, including oblique secondary strokes.
- Primary form streamlines at 42% layer opacity.
- Neutral traditional-pencil edge/stem replacement.
- Paper-coloured light lifts.

## Rejected or hidden layers

- V3 mass attempt: too sparse and broken under blur.
- V3 perpendicular mass attempt: mechanical near-90° mesh.
- V4 fine cross layer: direction passed, but the standard-pencil preset shifted
  olive on warm paper under multiply blending.
- V4 first edge layer: same colour-shift failure.
- Deep third-family pass: not applied; the image already had sufficient value
  structure and another family would add mesh without improving form.
- Construction guides: preserved but hidden in the final state.

`process-audit-timelapse.mp4` includes both rejected checkpoints and accepted
corrections so the evolution is inspectable rather than presented as a single
opaque result.
