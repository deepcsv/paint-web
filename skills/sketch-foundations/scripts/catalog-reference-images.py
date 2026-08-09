#!/usr/bin/env python3
"""Catalog ordered sketch-reference images and build visual QA contact sheets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageStat
except ImportError as exc:  # pragma: no cover - depends on the host runtime
    raise SystemExit("Pillow is required: python3 -m pip install Pillow") from exc


SUPPORTED = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


def natural_key(path: Path) -> tuple[object, ...]:
    return tuple(int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", path.name))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def image_metrics(path: Path) -> tuple[dict[str, object], Image.Image]:
    with Image.open(path) as source:
        rgb = ImageOps.exif_transpose(source).convert("RGB")
        source_format = source.format or path.suffix.lstrip(".").upper()

    gray = ImageOps.grayscale(rgb)
    stat = ImageStat.Stat(gray)
    histogram = gray.histogram()
    total = max(1, sum(histogram))
    dark_ratio = sum(histogram[:96]) / total
    light_ratio = sum(histogram[224:]) / total

    edge = gray.filter(ImageFilter.FIND_EDGES)
    edge_histogram = edge.histogram()
    edge_ratio = sum(edge_histogram[36:]) / max(1, sum(edge_histogram))

    metrics: dict[str, object] = {
        "filename": path.name,
        "width": rgb.width,
        "height": rgb.height,
        "aspectRatio": round(rgb.width / rgb.height, 6),
        "format": source_format,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "luminanceMean": round(stat.mean[0] / 255, 6),
        "luminanceStdDev": round(stat.stddev[0] / 255, 6),
        "darkPixelRatio": round(dark_ratio, 6),
        "lightPixelRatio": round(light_ratio, 6),
        "edgePixelRatio": round(edge_ratio, 6),
    }
    return metrics, rgb


def contain(image: Image.Image, width: int, height: int) -> Image.Image:
    copy = image.copy()
    copy.thumbnail((width, height), Image.Resampling.LANCZOS)
    return copy


def diagnostic_variant(image: Image.Image, variant: str) -> Image.Image:
    if variant == "source":
        return image
    gray = ImageOps.grayscale(image)
    if variant == "blur":
        radius = max(2.0, min(image.size) / 80)
        return gray.filter(ImageFilter.GaussianBlur(radius=radius)).convert("RGB")
    if variant == "edges":
        edges = gray.filter(ImageFilter.FIND_EDGES)
        return ImageOps.autocontrast(edges).convert("RGB")
    raise ValueError(f"Unknown variant: {variant}")


def build_sheet(
    items: list[tuple[dict[str, object], Image.Image]],
    output: Path,
    variant: str,
    columns: int,
    rows: int,
    cell_width: int,
    cell_height: int,
) -> None:
    label_height = 42
    gutter = 18
    sheet_width = gutter + columns * (cell_width + gutter)
    sheet_height = gutter + rows * (cell_height + label_height + gutter)
    sheet = Image.new("RGB", (sheet_width, sheet_height), "#d8d3ca")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=22)

    for index, (metrics, source) in enumerate(items):
        column = index % columns
        row = index // columns
        x = gutter + column * (cell_width + gutter)
        y = gutter + row * (cell_height + label_height + gutter)
        draw.rectangle((x, y, x + cell_width, y + label_height), fill="#282725")
        label = f"{metrics['filename']}  {metrics['width']}x{metrics['height']}  {variant}"
        draw.text((x + 10, y + 9), label, fill="#f7f3ea", font=font)
        panel = Image.new("RGB", (cell_width, cell_height), "white")
        rendered = contain(diagnostic_variant(source, variant), cell_width, cell_height)
        px = (cell_width - rendered.width) // 2
        py = (cell_height - rendered.height) // 2
        panel.paste(rendered, (px, py))
        sheet.paste(panel, (x, y + label_height))

    sheet.save(output, quality=92, optimize=True)


def contiguous_numeric_ids(paths: list[Path]) -> dict[str, object]:
    numeric = [int(path.stem) for path in paths if path.stem.isdigit()]
    if len(numeric) != len(paths) or not numeric:
        return {"numeric": False, "contiguous": False, "missing": []}
    expected = set(range(min(numeric), max(numeric) + 1))
    missing = sorted(expected - set(numeric))
    return {
        "numeric": True,
        "first": min(numeric),
        "last": max(numeric),
        "contiguous": not missing and len(numeric) == len(set(numeric)),
        "missing": missing,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--cell-width", type=int, default=600)
    parser.add_argument("--cell-height", type=int, default=680)
    parser.add_argument(
        "--source-label",
        help="Stable provenance label written to catalog.json instead of the input directory path",
    )
    args = parser.parse_args()

    paths = sorted(
        (path for path in args.input_dir.iterdir() if path.is_file() and path.suffix.casefold() in SUPPORTED),
        key=natural_key,
    )
    if not paths:
        raise SystemExit(f"No supported images found in {args.input_dir}")
    if args.columns < 1 or args.rows < 1:
        raise SystemExit("--columns and --rows must be positive")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    items: list[tuple[dict[str, object], Image.Image]] = []
    for sequence, path in enumerate(paths, start=1):
        metrics, image = image_metrics(path)
        metrics["sequence"] = sequence
        items.append((metrics, image))

    per_sheet = args.columns * args.rows
    sheets: list[dict[str, object]] = []
    for offset in range(0, len(items), per_sheet):
        group = items[offset : offset + per_sheet]
        first = Path(str(group[0][0]["filename"])).stem
        last = Path(str(group[-1][0]["filename"])).stem
        sheet_index = offset // per_sheet + 1
        for variant in ("source", "blur", "edges"):
            filename = f"{variant}-{sheet_index:02d}-{first}-{last}.jpg"
            build_sheet(
                group,
                args.output_dir / filename,
                variant,
                args.columns,
                args.rows,
                args.cell_width,
                args.cell_height,
            )
            sheets.append({"variant": variant, "first": first, "last": last, "filename": filename})

    catalog = {
        "schemaVersion": 1,
        "source": args.source_label or str(args.input_dir.resolve()),
        "imageCount": len(items),
        "sequenceAudit": contiguous_numeric_ids(paths),
        "contactSheets": sheets,
        "images": [metrics for metrics, _ in items],
    }
    (args.output_dir / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"images": len(items), "sheets": len(sheets), "audit": catalog["sequenceAudit"]}))


if __name__ == "__main__":
    main()
