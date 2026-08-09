# Bull Skull Wall Study — Native Graphite Copy

Date: 2026-08-09  
Canvas: 900 × 938  
Reference: 1206 × 1477  
Paint branch: `art/codex-bull-skull-copy-20260809`  
Final paint commit: `C_3915_642a1a506795`  
Final checkpoint: `bull-skull-native-final-20260809`

## Intent and constraints

This is an observational copy of the supplied graphite bull-skull study. The
reference was used only for landmark, proportion, value, and edge observation.
It was never imported into paint-web, traced as a canvas asset, or flattened
into the document. No generated bitmap was used.

The drawing is built from **1,385 native `draw.stroke` marks**, supported by
native path, gradient, and rectangle underpainting. The bitmap export is the
result of those recorded operations, not the source of the picture.

The existing cone was protected at checkpoint
`before-bull-skull-copy-20260809` (`C_3876_4f4367eb163f`). A separate paint
branch was created for this work, and all eight cone layers were removed from
the bull-skull branch before the ten bull-skull layers were created.

## Observed composition

- A dark carved frieze anchors the top edge.
- Two large horns rise into the frieze and descend toward a suspended skull.
- A single wall pin and two cords create the hanging triangle.
- The skull is organized around a central suture, paired eye sockets, paired
  nasal cavities, and tapering maxillae.
- Six round wall studs establish the vertical field around the skull.
- The strongest cast shadow falls to the left; the central nasal ridge and
  upper bone planes retain the lightest values.

The source is taller than the existing 900 × 938 canvas, so the lower wall was
compressed while the skull, horn span, frieze, pin, cords, studs, and left cast
shadow were retained.

## Construction and value plan

- Pin: `(450, 170)`
- Skull top: approximately `(450, 270)`
- Skull bottom: approximately `(456, 831)`
- Left horn tip: approximately `(111, 58)`
- Right horn tip: approximately `(809, 55)`
- Light: broad upper-right/front
- Darkest accents: cavities, horn roots/tips, right horn underside, frieze
  recesses, and left contact shadow
- Construction layer: retained but hidden in the final state

The broad bone mass was established before detail. Primary hatching follows
the long axis and local turn of the skull. The subordinate family crosses at a
median separation of `39.534°`; the wall-shadow families separate by
`33.232°`. Neither family forms a perpendicular X.

## Pass ledger

| Pass | Purpose | Result |
| --- | --- | --- |
| 00 | Protect cone state, delete inherited cone layers on the new branch, create ten bull-skull layers | accepted |
| 01 | Centerline, skull envelope, horn centerlines, sockets, nasal cavities, cords, and studs | structure checkpoint `C_3878` |
| 02–02c | Wall grain, dark frieze, carving mass, and frieze consolidation | accepted |
| 02d | Remove the first weak/flat value stack and rebuild six value/detail layers | accepted correction |
| 02e | Remove the second comb-like value stack and rebuild clean value/detail layers | accepted correction |
| 03–03a | Broad cast-shadow underpainting plus two non-perpendicular hatch families | accepted |
| 04 | Horn silhouettes, longitudinal grain, and turn | accepted |
| 05a–05d | Bone underpainting, broad value passes, review, and opacity balance | value checkpoint `C_3903` |
| 06 | Primary form-following skull hatch | accepted |
| 07 | Oblique secondary hatch | angle-audited |
| 08–08b | Sockets, nasal cavities, sutures, cracks, pits, and cavity depth | accepted |
| 09 | Carved frieze, pin, cords, and six wall studs | accepted |
| 10–11 | Bone lifts and final layer hierarchy | accepted |
| 12 | Dark horn roots/tips and renewed horn edges | accepted |
| 13 | Layered cavity depth and brow/cheek anatomy | accepted |
| 14 | Volumetric studs and cavity-rim lights | accepted |
| 15 | Final value and edge hierarchy | accepted |
| 16 | Reference-convergence pass: stronger left shadow, horn growth rings, broken side-plane hatch, irregular brow, added sutures, and rim lights | final `C_3915` |

Two rejected value attempts remain recoverable for comparison:

- `bull-skull-values-rejected-v1-20260809` at `C_3883`
- `bull-skull-values-rejected-v2-20260809` at `C_3889`

They are not present in the current layer stack.

## Layer ledger

| Layer | Role | Final state |
| --- | --- | --- |
| `L_bs9_paper01` | warm graphite paper | visible, 100% |
| `L_bs9_ground01` | wall tone and grain | visible, 100%, multiply |
| `L_bs9_ornament01` | carved top frieze | visible, 100%, multiply |
| `L_bs9_construct01` | landmark construction | hidden, 58%, multiply |
| `L_bs9_shadow01` | wall/contact shadow | visible, 58%, multiply |
| `L_bs9_horns01` | horn masses and rings | visible, 100%, multiply |
| `L_bs9_skull01` | broad bone values | visible, 62%, multiply |
| `L_bs9_hatch01` | primary and oblique form hatch | visible, 82%, multiply |
| `L_bs9_details01` | cavities, sutures, cracks, studs, cords | visible, 84%, multiply; active |
| `L_bs9_lights01` | bone, rim, horn, and stud lifts | visible, 100% |

## Verification

- Independent bull-skull layer count: 10
- Inherited cone layers on this branch: 0
- Construction hidden: yes
- Native stroke count: 1,385
- Raster imports / generated images: 0 / 0
- Skull hatch-angle audit: pass (`39.534°` median)
- Shadow hatch-angle audit: pass (`33.232°` median)
- Sketch-foundations tests: 7/7 passed
- Field-hatching determinism/mask/angle self-test: passed
- JSONL validation: passed
- `git diff --check` for the artwork directory: passed
- Final native PNG SHA-256:
  `b702c4c01af47ea3a84ce6d67583dda838046d3b90d5a223756adb31aad0b19d`
- Deterministic SVG digest:
  `4e53d8ccc14859a39d9cbbeececb2858c7ffe19c3891f086b2dfeaefe9b99a3b`

The final checkpoint was created at the exact final commit. A destructive
restore was not re-run inside the live 3,148-operation session; instead, the
exact commit was rendered headlessly and its digest recorded. The SVG renderer
approximates textured brush stamps as polylines and does not reproduce every
raster-canvas blend, so `bull-skull-final-native.png` is the authoritative
visual result. `bull-skull-final.svg` and `bull-skull-final-audit.png` are
structural audit artifacts.

## Reproduction

Run `node generate.mjs` to regenerate the validated JSONL passes, manifest, and
hatching report. Apply `pass-00` through `pass-16` in order from the protected
cone parent state, or restore `bull-skull-native-final-20260809` for the exact
canonical paint document.
