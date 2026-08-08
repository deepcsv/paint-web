---
name: sketch-foundations
description: Plan, construct, render, diagnose, and objectively validate observational graphite or pen-and-ink sketches made from genuine vector/native strokes. Use for 素描, 排线, 交叉排线, 铅笔画, observational drawing, value studies, form studies, reference-to-stroke drawing, paint-web sketching, plotter-style hatching, or when a prior drawing looks hairy, mechanical, flat, muddy, poorly proportioned, or unlike its reference. Use especially when raster generation/import is forbidden and every mark must remain auditable.
---

# Sketch Foundations

Build the drawing from geometry and light, then use coherent stroke fields to
realize tone. Treat each accepted stage as a quality gate; undo failed stages
instead of hiding them under more marks.

## Route the task

- Use this skill with `paint-web` when the target is the local paint-web
  harness. Follow paint-web's branch, checkpoint, JSONL, analysis, and snapshot
  rules.
- Do not use image generation, raster import, `draw.image`, or
  `canvas.import` when the user requires genuine hand-built/native strokes.
- Use a supplied image for observation and measurement only. Record that
  boundary in the artwork manifest.
- Read `references/observational-sketch.md` before planning an observational
  or analytic-form sketch.
- Use `scripts/field-hatching.mjs` when a pass needs more than roughly 100
  hatching strokes or when spacing/direction coherence matters.

## Diagnose before drawing

Inspect the current image at full size and as a blurred thumbnail. Name the
largest failure in each category:

1. geometry and proportion;
2. five-value grouping and light consistency;
3. stroke direction, spacing, length, and clustering;
4. edge hierarchy and focal emphasis.

Stop local polishing if the silhouette or value masses fail. Preserve the old
state, start a new branch, and rebuild from the earliest failed gate.

## Required workflow

### 1. Preserve and plan

Create a checkpoint and experimental branch. Define:

- canvas and subject envelope;
- top/bottom/left/right anchors and 5–12 landmarks;
- explicit light vector and cast-shadow direction;
- five target value zones;
- bottom-to-top layers for paper, construction, shadow, broad values, primary
  hatch, cross-hatch, edges/details, and lights;
- measurable acceptance thresholds.

### 2. Construct without finish

Draw only the envelope, landmarks, axes, cross-contours, and cast-shadow
boundary. Snapshot this stage. Reject it if major landmarks miss by more than
about 3% of subject span or if the silhouette reads as a generic symbol.

### 3. Prove the value design

Establish broad light, halftone, core shadow, reflected light, and contact/cast
shadow before fine lines. Blur or downscale the snapshot. Reject the pass if:

- the form divides into arbitrary light/dark halves;
- there is no continuous halftone bridge;
- reflected light competes with the light side;
- the cast shadow contradicts the light;
- the contact patch is not the darkest local zone.

### 4. Generate coherent hatching

Model a subject mask, darkness field, and direction field. Generate the
primary family first. Use tone-dependent spacing and spatial rejection; do not
throw independent random short lines.

Add the second family only in halftone/shadow and the third family only in deep
accents. Keep each family internally even. Prefer long curved streamlines,
then segment them into tapered hand gestures. Cross families must meet the
primary family obliquely—normally about 25–55°, never as a near-90° mechanical
grid unless the observed reference explicitly requires it.

Run the bundled generator's self-test before first use in a session:

```bash
node skills/sketch-foundations/scripts/field-hatching.mjs --self-test
```

Generate a pass from a task-local config:

```bash
node skills/sketch-foundations/scripts/field-hatching.mjs \
  --config /absolute/path/sketch-config.mjs \
  --out /absolute/path/hatching.jsonl \
  --report /absolute/path/hatching.report.json
```

Apply the primary pass, snapshot, and inspect before applying cross-hatching.

### 5. Control edges

Classify edges as light silhouette, shadow silhouette, turning form,
occlusion/contact, or cast shadow. Strengthen only the edges justified by that
classification. Lose at least part of the light-facing contour. Keep the dark
external contour below roughly 65% of the perimeter.

### 6. Finish selectively

Add focal accents, stem/features, paper-coloured eraser lifts, and sparse fine
texture only after the first five gates pass. Hide construction guides but
keep their layer. Stop when the subject reads at thumbnail size.

## Validate every pass

Use three complementary checks:

1. **Geometry**: landmarks, aspect ratio, center, silhouette, clipping.
2. **Value**: blurred five-zone read, dynamic range, highlight reservation,
   contact/cast-shadow falloff.
3. **Stroke field**: median direction error <= 15°, 90th percentile <= 30°,
   same-family spacing coefficient of variation <= 0.35, cross-family median
   angle 25–55° with no near-orthogonal grid, and no visible clumps or
   needle-like fragments.

Use paint-web `analyze` for coverage/bounds/luminance and snapshots for visual
judgment. Measurements can reject failures; they cannot certify artistic
quality. Compare each new stage with the previous accepted checkpoint.

## Record provenance

Keep:

- deterministic seeds and hatching parameters;
- pass JSONL and per-pass operation counts;
- construction, value, hatch, and final snapshots;
- a manifest stating whether any raster was imported;
- document branch and checkpoint ids.

If a raster reference was analyzed but not imported, state that explicitly.

## Resources

- `references/observational-sketch.md`: first-principles drawing model,
  algorithms, quality gates, failure diagnosis, and source boundaries.
- `scripts/field-hatching.mjs`: dependency-free deterministic streamline
  placement and native `draw.stroke` JSONL generation.
