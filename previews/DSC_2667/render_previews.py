from __future__ import annotations

import argparse
import colorsys
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


STYLES = {
    "A": {
        "exposure": -0.015,
        "contrast": 0.14,
        "shadows": 0.035,
        "highlights": -0.095,
        "black_lift": 0.006,
        "saturation": 1.02,
        "yellow_hue": -0.025,
        "yellow_sat": 1.12,
        "blue_sat": 0.92,
        "warmth": -0.010,
        "shadow_tint": (-0.012, 0.004, 0.018),
        "highlight_tint": (0.012, 0.006, -0.008),
        "sharpness": (2.0, 38, 3),
    },
    "B": {
        "exposure": 0.010,
        "contrast": -0.08,
        "shadows": 0.070,
        "highlights": -0.070,
        "black_lift": 0.025,
        "saturation": 0.90,
        "yellow_hue": -0.010,
        "yellow_sat": 0.96,
        "blue_sat": 0.88,
        "warmth": 0.014,
        "shadow_tint": (-0.004, 0.003, 0.008),
        "highlight_tint": (0.014, 0.008, -0.010),
        "sharpness": None,
    },
    "C": {
        "exposure": -0.010,
        "contrast": 0.20,
        "shadows": 0.018,
        "highlights": -0.115,
        "black_lift": 0.010,
        "saturation": 0.92,
        "yellow_hue": -0.015,
        "yellow_sat": 1.20,
        "blue_sat": 0.72,
        "warmth": -0.014,
        "shadow_tint": (-0.010, 0.003, 0.014),
        "highlight_tint": (0.004, 0.002, -0.002),
        "sharpness": (2.5, 62, 3),
    },
}


def clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def make_lut(style: dict) -> ImageFilter.Color3DLUT:
    def transform(r: float, g: float, b: float):
        y = 0.2126 * r + 0.7152 * g + 0.0722 * b
        y2 = 0.5 + (y - 0.5) * (1.0 + style["contrast"])
        y2 += style["exposure"]
        y2 += style["shadows"] * (1.0 - y) ** 2
        y2 += style["highlights"] * y**2
        y2 = style["black_lift"] + (1.0 - style["black_lift"]) * y2
        scale = clamp(y2) / max(y, 0.025)
        r1, g1, b1 = r * scale, g * scale, b * scale

        h, s, v = colorsys.rgb_to_hsv(clamp(r1), clamp(g1), clamp(b1))
        degrees = h * 360.0
        yellow_weight = max(0.0, 1.0 - abs(degrees - 55.0) / 55.0)
        blue_distance = min(abs(degrees - 205.0), 360.0 - abs(degrees - 205.0))
        blue_weight = max(0.0, 1.0 - blue_distance / 75.0)
        h = (h + style["yellow_hue"] * yellow_weight) % 1.0
        s *= style["saturation"]
        s *= 1.0 + (style["yellow_sat"] - 1.0) * yellow_weight
        s *= 1.0 + (style["blue_sat"] - 1.0) * blue_weight
        r2, g2, b2 = colorsys.hsv_to_rgb(h, clamp(s), clamp(v))

        warmth = style["warmth"]
        r2 += warmth
        b2 -= warmth
        shadow_weight = (1.0 - clamp(y2)) ** 2
        highlight_weight = clamp(y2) ** 2
        st = style["shadow_tint"]
        ht = style["highlight_tint"]
        return tuple(
            clamp(channel + st[i] * shadow_weight + ht[i] * highlight_weight)
            for i, channel in enumerate((r2, g2, b2))
        )

    return ImageFilter.Color3DLUT.generate(33, transform)


def render(source: Image.Image, style: dict) -> Image.Image:
    rendered = source.filter(make_lut(style))
    if style["sharpness"]:
        radius, percent, threshold = style["sharpness"]
        rendered = rendered.filter(
            ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold)
        )
    else:
        rendered = ImageEnhance.Sharpness(rendered).enhance(0.88)
    return rendered


def histogram_report(image: Image.Image) -> dict:
    pixels = image.width * image.height
    result = {}
    for name, band in zip("RGB", image.split()):
        hist = band.histogram()
        low = next((i for i, count in enumerate(hist) if count), 0)
        high = next((255 - i for i, count in enumerate(reversed(hist)) if count), 255)
        result[name] = {
            "min": low,
            "max": high,
            "zero_pct": round(hist[0] * 100.0 / pixels, 4),
            "full_pct": round(hist[255] * 100.0 / pixels, 4),
        }
    luminance_hist = image.convert("L").histogram()
    result["L"] = {
        "min": next((i for i, count in enumerate(luminance_hist) if count), 0),
        "max": next((255 - i for i, count in enumerate(reversed(luminance_hist)) if count), 255),
        "zero_pct": round(luminance_hist[0] * 100.0 / pixels, 4),
        "full_pct": round(luminance_hist[255] * 100.0 / pixels, 4),
    }
    return result


def contact_sheet(images: list[tuple[str, Image.Image]], path: Path) -> None:
    panel_width = 420
    label_height = 54
    panels = []
    font = ImageFont.load_default(size=22)
    for label, image in images:
        height = round(image.height * panel_width / image.width)
        resized = image.resize((panel_width, height), Image.Resampling.LANCZOS)
        panel = Image.new("RGB", (panel_width, height + label_height), (28, 28, 28))
        panel.paste(resized, (0, label_height))
        draw = ImageDraw.Draw(panel)
        draw.text((16, 15), label, fill=(245, 245, 245), font=font)
        panels.append(panel)
    sheet = Image.new(
        "RGB", (sum(panel.width for panel in panels), max(panel.height for panel in panels)), (18, 18, 18)
    )
    x = 0
    for panel in panels:
        sheet.paste(panel, (x, 0))
        x += panel.width
    sheet.save(path, quality=94, subsampling=0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("outdir", type=Path)
    args = parser.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)

    with Image.open(args.source) as opened:
        icc = opened.info.get("icc_profile")
        exif = opened.getexif()
        baseline = ImageOps.exif_transpose(opened).convert("RGB")

    save_kwargs = {"quality": 95, "subsampling": 0}
    if icc:
        save_kwargs["icc_profile"] = icc
    if exif:
        save_kwargs["exif"] = exif

    base_name = args.source.stem
    outputs = [("Original / Baseline", baseline)]
    baseline_path = args.outdir / f"{base_name}_BASELINE.jpg"
    baseline.save(baseline_path, **save_kwargs)

    report = {"source": str(args.source), "dimensions": list(baseline.size), "images": {}}
    report["images"]["BASELINE"] = histogram_report(baseline)
    for key, style in STYLES.items():
        result = render(baseline, style)
        output_path = args.outdir / f"{base_name}_PREVIEW-{key}.jpg"
        result.save(output_path, **save_kwargs)
        outputs.append((f"{key}  " + {"A": "Cold / Warm", "B": "Faded Documentary", "C": "Graphic"}[key], result))
        report["images"][key] = histogram_report(result)

    contact_sheet(outputs, args.outdir / f"{base_name}_CONTACT-SHEET.jpg")
    (args.outdir / "render-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
