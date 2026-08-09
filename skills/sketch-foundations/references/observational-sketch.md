# Observational sketch foundations

## Contents

1. First-principles model
2. Required construction order
3. Value and lighting model
4. Coherent hatching field
5. Edge hierarchy
6. Quantitative quality gates
7. Reference-image workflow
8. Analytic-form workflow
9. Failure diagnosis
10. Sources and borrowing boundaries

## 1. First-principles model

Treat a graphite sketch as four coupled representations, not as a pile of dark
marks:

1. **Geometry**: silhouette, landmarks, axes, cross-contours, overlaps, and
   depth ordering.
2. **Illumination**: light direction, large value masses, terminator, core
   shadow, reflected light, occlusion, and cast shadow.
3. **Stroke field**: direction, spacing, length, pressure, and grain that reveal
   geometry while realizing the value design.
4. **Edge hierarchy**: where a boundary is hard, soft, lost, found, thick,
   thin, or absent.

Do not use contour darkness to compensate for uncertain geometry. Do not use
stroke count as a proxy for finish. A blurred thumbnail must read before fine
texture is added.

For a tonal drawing, model the desired darkness field `D(x,y)` first. The
rendered strokes are a sampling strategy for that field:

```text
geometry + light -> target darkness D
D + surface direction -> hatch density, direction, width, pressure
hatches + selective contours -> rendered drawing
```

## 2. Required construction order

Use separate, named layers and checkpoint every accepted gate.

### Gate A — observation and envelope

- Mark top, bottom, left, right, center, major axes, and 5–12 distinctive
  landmarks.
- Compare negative spaces and asymmetry; do not default to a symbol such as a
  perfect circle or generic apple icon.
- Draw the envelope and internal axes with low-opacity strokes.
- Reject the pass if proportion errors exceed roughly 3% of subject width or
  height at a major landmark.

### Gate B — silhouette and planes

- Build the contour from long curves through landmarks.
- Add only the cross-contours needed to explain turning planes.
- Keep the construction contour light enough that it can be hidden later.
- Inspect at thumbnail size; the silhouette should identify the subject before
  shading.

### Gate C — five-value design

- Group the subject into paper/highlight, light, halftone, core shadow, and
  accent/contact shadow.
- Establish the terminator and cast-shadow direction before detail.
- Verify the value masses with a 12–24 px blur or by viewing the snapshot at
  10–15% scale.
- Undo and rebuild the pass if the subject splits into arbitrary halves or if
  the cast shadow contradicts the light.

### Gate D — coherent hatching

- Place a primary family along a surface-aware direction field.
- Change tone mainly with spacing and the number of line families; use opacity
  and width only as secondary controls.
- Add the second family only in halftone and shadow. Add a third family only in
  the deepest zones.
- Cross the primary family at a changing oblique angle, typically 25–55°.
  Reject near-90° intersections: they produce a rigid mesh instead of wrapping
  the form.
- Keep a single family evenly spaced. Avoid random clumps and isolated needles.

### Gate E — edge control and finish

- Strengthen contours only where occlusion, contact, or local contrast warrants
  it.
- Lose part of the light-facing contour into the paper.
- Keep contact shadow darkest and let the cast shadow soften with distance.
- Add accents and eraser lifts last. Stop when the large design reads; do not
  polish every square centimetre equally.

## 3. Value and lighting model

For analytic forms, compute a surface normal `N` from geometry and use a simple
light model as the target—not as a final raster:

```text
diffuse = max(0, dot(N, L))
lightness = ambient + key * diffuse + reflectedLight - occlusion
darkness D = clamp(1 - lightness)
```

Use a broad source for beginner studies so the terminator and cast-shadow edge
can be soft. Add concavity or ambient occlusion at dimples, overlaps, and the
contact patch. Reflected light must stay weaker than the light-side halftone.

For an apple, avoid a perfect sphere. Include:

- unequal left and right lobes;
- a top dimple that changes both silhouette and local normals;
- slight center-axis lean;
- a wider shoulder and subtly tapered lower form;
- an off-centre stem with its own cylinder lighting;
- a compressed contact patch rather than a tangent point.

## 4. Coherent hatching field

Use `scripts/field-hatching.mjs` to create evenly spaced, mask-clipped
streamlines. Supply these functions in a config module:

```js
export default {
  seed: 42,
  bounds: { x: 100, y: 80, width: 600, height: 700 },
  mask: (x, y) => insideSubject(x, y),
  tone: (x, y) => targetDarkness(x, y),
  direction: (x, y, family) => surfaceDirection(x, y, family),
  families: [
    {
      name: "primary",
      minTone: 0.10,
      spacingLight: 13,
      spacingDark: 7,
      step: 2.5,
      minLength: 24,
      maxLength: 220,
    },
    {
      name: "cross",
      angleAgainst: "primary",
      minTone: 0.42,
      spacingLight: 11,
      spacingDark: 6,
      step: 2.5,
      minLength: 18,
      maxLength: 170,
    },
  ],
  styles: {
    primary: {
      layerId: "L_form01",
      color: "#514e48",
      size: 1.0,
      toneSize: 0.25,
      opacity: 0.10,
      toneOpacity: 0.13,
      gestureMin: 40,
      gestureMax: 105,
      wobble: 0.35,
    },
    cross: {
      layerId: "L_cross01",
      color: "#47443f",
      size: 0.9,
      toneSize: 0.22,
      opacity: 0.11,
      toneOpacity: 0.15,
      gestureMin: 28,
      gestureMax: 75,
      wobble: 0.28,
    },
  },
};
```

Mark every secondary crossing family with `angleAgainst`. The generator audits
the shared direction field before drawing: median separation must remain within
25–55°, and no sampled local separation may exceed 70°. A failing configuration
throws before any JSONL is written.

Generate JSONL with:

```bash
node skills/sketch-foundations/scripts/field-hatching.mjs \
  --config /absolute/path/apple-config.mjs \
  --out /absolute/path/pass-hatching.jsonl \
  --report /absolute/path/pass-hatching.report.json
```

The script uses midpoint streamline integration, an unoriented axis field,
tone-dependent spacing, a spatial hash to reject nearby lines, deterministic
seed jitter, gesture segmentation, pressure taper, and low-frequency hand
variation. It emits only native `draw.stroke` operations inside `draw.batch`.

### Direction-field rules

- Define the primary field from surface parameter lines or projected principal
  curvature when geometry is known.
- For a reference image, derive a structure tensor from blurred luminance and
  follow its tangent direction where coherence is high.
- Blend toward silhouette tangents near the boundary.
- Treat direction as modulo `PI`; prevent 180° flips between samples.
- Stop a streamline when it exits the mask, falls below the family's tone
  threshold, turns too sharply, or approaches an existing line.

### Density rules

- Use larger spacing in the light and smaller spacing in shadow.
- Prefer 6–16 px spacing at a 900 px canvas for a basic graphite study.
- Avoid spacing under 4 px until the large value masses pass inspection.
- Use family count to deepen tone: one family for light/halftone, two for
  shadow, three only for accents.

## 5. Edge hierarchy

Classify every important edge:

| Edge type | Treatment |
|---|---|
| Light-facing silhouette | broken, thin, sometimes absent |
| Turning form edge | expressed by value/hatch direction, not outline |
| Shadow-side silhouette | firmer but variable |
| Occlusion/contact | darkest and sharpest local edge |
| Cast shadow near contact | hard/dark |
| Cast shadow far from subject | soft, sparse, lower contrast |
| Internal dimple/fold | short accents that converge into the form |

Keep the strengthened external contour to roughly 35–65% of the perimeter.
Do not draw a uniform dark ring.

## 6. Quantitative quality gates

Numbers do not certify beauty, but they can reject obvious failures.

### Geometry

- Major landmark error: <= 3% of subject span.
- Silhouette remains inside the intended envelope with no accidental clipping.
- Subject aspect ratio and center shift match the plan.

### Value masses

Measure relative darkness against paper after blurring 12–24 px:

- highlight: 0–12% darkness;
- light: 10–28%;
- halftone: 25–48%;
- core shadow: 45–70%;
- contact/accent: 70–92%.

Reject crushed drawings where more than 3% of subject pixels are near pure
black. Preserve paper in the highlight.

### Stroke field

- Median direction error to the target field: <= 15°.
- 90th-percentile direction error: <= 30°.
- Same-family nearest-line spacing coefficient of variation: <= 0.35.
- Cross-family median intersection angle: 25–55°; keep the 95th percentile
  below 70° unless the observed reference explicitly contains orthogonal
  construction.
- Fewer than 5% of strokes may be shorter than the configured minimum gesture.
- No hatch operation may leave the subject mask by more than the intended
  hand-wobble tolerance.

### Edge hierarchy

- Dark contour coverage: <= 65% of perimeter.
- Light-facing lost edge: at least 15% of perimeter.
- Cast-shadow mean darkness must decrease away from contact.

### Review sequence

1. Inspect silhouette only.
2. Inspect a blurred value thumbnail.
3. Inspect hatch-direction and spacing diagnostics.
4. Inspect full-resolution texture.
5. Accept or undo the whole pass. Do not hide a failed gate with more detail.

## 7. Reference-image workflow

Use the reference for analysis only when the user forbids raster import.

1. Convert to luminance and normalize exposure.
2. Build Gaussian levels for coarse value, mid-scale structure, and fine edge
   information.
3. Segment the subject mask manually or with assisted thresholding; inspect it.
4. Compute Sobel gradients on a blurred level.
5. Build a structure tensor:

   ```text
   J = Gaussian([Ix², IxIy; IxIy, Iy²])
   theta = 0.5 * atan2(2 Jxy, Jxx - Jyy)
   ```

6. Use the tangent/eigenvector direction only where tensor coherence is high;
   interpolate from anatomical or geometric priors elsewhere.
7. Use FDoG/ETF-style processing only to propose coherent feature edges. Keep
   or reject them by semantic importance.
8. Render native strokes, snapshot, and compare at multiple blur scales.

Never draw the reference image with `draw.image`, `canvas.import`, a data URL,
or a hidden raster layer when the user requested genuine strokes.

## 8. Analytic-form workflow

For cubes, spheres, cylinders, cones, apples, and other teaching forms:

1. Define a 2D silhouette and a depth/height field.
2. Compute normals numerically or analytically.
3. Set one explicit light vector and broadness.
4. Derive target darkness and cast-shadow geometry.
5. Define primary and cross direction fields from surface parameter lines.
6. Generate evenly spaced streamlines.
7. Add selective contours, concavity accents, stem/details, and eraser lifts.
8. Keep construction, value, hatch, edge, shadow, and light layers separate.

## 9. Failure diagnosis

| Symptom | Root cause | Corrective action |
|---|---|---|
| White half / black half | tone thresholds too hard; no halftone bridge | rebuild the value field and primary family |
| Hairy or furry surface | independent short random strokes | replace with coherent long streamlines |
| Dark ring | contour used to define uncertain shape | return to landmarks and value-based edge control |
| Muddy dark | too many families or opacity before value grouping | undo; increase spacing and restore family hierarchy |
| Mechanical mesh | constant global angles, near-90° crossing, or rigid spacing | use oblique surface fields, low-frequency variation, and tone spacing |
| Floating subject | no contact compression or inconsistent cast shadow | rebuild contact and light geometry |
| Detail without likeness | landmarks/silhouette failed before rendering | discard detail pass and reconstruct |

## 10. Sources and borrowing boundaries

Borrow concepts and equations, not incompatible source code.

- Lu, Xu, Jia, *Combining Sketch and Tone for Pencil Drawing Production*
  separates structural stroke generation from tone rendering:
  <https://github.com/taldatech/image2pencil-drawing>
- Hertzmann, *Painterly Rendering with Curved Brush Strokes of Multiple Sizes*
  motivates coarse-to-fine error-driven curved strokes:
  <https://mrl.cs.nyu.edu/publications/painterly98/>
- Kang et al., *Coherent Line Drawing* motivates edge-tangent flow and FDoG:
  <https://www.cs.umd.edu/~aagrawal/sig07/>
- Jobard and Lefer, *Creating Evenly-Spaced Streamlines of Arbitrary Density*
  motivates spatial rejection for coherent line placement.
- `p5.brush` (MIT) demonstrates shape-clipped hatching, vector fields, seeded
  brush variation, and pressure-aware curves:
  <https://github.com/acamposuribe/p5.brush>
- `linedraw` (MIT) demonstrates polyline-only contour/hatch output and stroke
  ordering, but its coarse fixed thresholds are insufficient for tonal study:
  <https://github.com/LingDong-/linedraw>
- DrawingBotV3 (GPL-3.0) demonstrates configurable path-finding modules,
  per-pen layers, versioning, and flow-field families. Study architecture only;
  do not copy GPL implementation into paint-web:
  <https://github.com/SonarSonic/DrawingBotV3>
- `perfect-freehand` (MIT, already used by paint-web) provides smoothed,
  pressure-sensitive stroke outlines:
  <https://github.com/steveruizok/perfect-freehand>

The bundled streamline implementation is original, dependency-free code based
on the published algorithmic ideas above. It does not copy source from the
referenced repositories.
