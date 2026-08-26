#!/usr/bin/env python3
"""Generate the deterministic JPG used by the Core33 Lightroom write probe."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts" / "core33" / "core33-test-chart.jpg"
MANIFEST = ROOT / "artifacts" / "core33" / "core33-test-chart.json"
WIDTH, HEIGHT = 1800, 1200


def main() -> None:
    image = Image.new("RGB", (WIDTH, HEIGHT), "#202020")
    pixels = image.load()
    for y in range(0, 300):
        for x in range(WIDTH):
            level = round(255 * x / (WIDTH - 1))
            pixels[x, y] = (level, level, level)

    draw = ImageDraw.Draw(image)
    for index in range(12):
        level = round(index * 255 / 11)
        left = index * WIDTH // 12
        right = (index + 1) * WIDTH // 12
        draw.rectangle((left, 310, right, 500), fill=(level, level, level))

    colors = [
        (220, 35, 45), (235, 115, 30), (235, 210, 35), (45, 175, 70),
        (25, 180, 190), (40, 85, 220), (135, 65, 195), (220, 45, 150),
    ]
    for index, color in enumerate(colors):
        left = index * WIDTH // 8
        right = (index + 1) * WIDTH // 8
        for band, blend in enumerate((0.25, 0.5, 0.75, 1.0)):
            top = 520 + band * 115
            fill = tuple(round(128 * (1.0 - blend) + channel * blend) for channel in color)
            draw.rectangle((left, top, right, top + 105), fill=fill)

    for x in range(0, WIDTH // 2):
        for y in range(990, HEIGHT):
            value = 65 if ((x // 8 + y // 8) % 2) else 195
            pixels[x, y] = (value, value, value)
    for x in range(WIDTH // 2, WIDTH):
        for y in range(990, HEIGHT):
            wave = round(128 + 90 * (((x - WIDTH // 2) % 160) / 159.0 - 0.5) * 2)
            pixels[x, y] = (wave, wave, wave)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUTPUT, "JPEG", quality=95, subsampling=0, optimize=False, progressive=False)
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    MANIFEST.write_text(json.dumps({
        "file": OUTPUT.name,
        "sha256": digest,
        "width": WIDTH,
        "height": HEIGHT,
        "purpose": "JPG Core33 Lightroom write/readback/rollback probe",
        "required_import_filename": OUTPUT.name,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "path": str(OUTPUT), "sha256": digest}))


if __name__ == "__main__":
    main()
