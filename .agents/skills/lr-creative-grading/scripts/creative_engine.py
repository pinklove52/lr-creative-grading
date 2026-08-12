"""Photo-driven creative grading analysis, recipes, previews, and sessions.

The preview renderer is intentionally independent from Adobe's rendering
engine.  It gives deterministic, low-cost directions to audition; Lightroom
settings remain a separate, baseline-relative recipe and are verified by the
bridge after application.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps


SESSION_VERSION = "1.0.0"
LONG_EDGE_DEFAULT = 1800
ANALYSIS_LONG_EDGE = 1024
PREVIEW_RENDERER_VERSION = "offline-oklab-1.0.0"
STATE_ORDER = (
    "ACQUIRE",
    "ANALYZED",
    "PREVIEWED",
    "SELECTED",
    "SNAPSHOTTED",
    "APPLIED",
    "PERSON_PROTECTED",
    "VERIFIED",
    "DONE",
)
TERMINAL_STATES = {"DONE", "ROLLED_BACK"}

HARMONY_RULES: tuple[tuple[str, tuple[int, ...]], ...] = (
    ("monochromatic", (0,)),
    ("analogous", (-30, 0, 30)),
    ("analogous_complementary", (-30, 0, 30, 180)),
    ("complementary", (0, 180)),
    ("split_complementary", (0, 150, 210)),
    ("dyad", (-30, 30)),
    ("triad", (0, 120, 240)),
    ("tetrad", (-30, 30, 150, 210)),
    ("square", (0, 90, 180, 270)),
)


class SessionValidationError(ValueError):
    """Raised when a GradeSession is malformed or unsafe to use."""


@dataclass(frozen=True)
class PreviewResult:
    candidate_id: str
    path: str
    strength: float
    cache_key: str
    cache_hit: bool
    preview_recipe_hash: str
    qc: dict[str, Any]
    detected_risks: list[dict[str, Any]]


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_digest(path: str | Path) -> str:
    file_path = Path(path)
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def recipe_hash(candidate: Mapping[str, Any], strength: float) -> str:
    payload = {
        "candidate_id": candidate["candidate_id"],
        "strength": round(float(strength), 4),
        "offline_ops": candidate["offline_ops"],
        "lr_recipe": candidate["lr_recipe"],
        "people_protection": candidate["people_protection"],
    }
    return _sha256_bytes(_canonical_json(payload).encode("utf-8"))


def _parameter(
    operation: str,
    value: float,
    interpolation: str = "linear",
) -> dict[str, Any]:
    if operation not in {"delta", "target"}:
        raise ValueError(f"unsupported Lightroom parameter operation: {operation}")
    if interpolation not in {"linear", "circular_degrees"}:
        raise ValueError(f"unsupported Lightroom parameter interpolation: {interpolation}")
    return {"operation": operation, "value": float(value), "interpolation": interpolation}


def compile_lr_parameters(
    parameter_specs: Mapping[str, Mapping[str, Any]],
    baseline: Mapping[str, float],
    strength: float,
) -> dict[str, float]:
    """Compile canonical specs against pinned baseline values.

    This mirrors the bridge contract: 0% is the pinned baseline, 100% is the
    design value, and 200% extrapolates.  Runtime capability/range validation
    remains the bridge's responsibility and values are never silently clamped.
    """
    if not 0.0 <= strength <= 200.0:
        raise ValueError("strength must be between 0 and 200")
    factor = strength / 100.0
    compiled: dict[str, float] = {}
    for name, spec in parameter_specs.items():
        if name not in baseline:
            raise KeyError(f"baseline missing canonical Lightroom parameter: {name}")
        base = float(baseline[name])
        operation = spec.get("operation")
        interpolation = spec.get("interpolation", "linear")
        value = float(spec["value"])
        if operation == "delta":
            if interpolation != "linear":
                raise ValueError(f"delta parameter {name} must use linear interpolation")
            desired = base + value * factor
        elif operation == "target":
            if interpolation == "linear":
                desired = base + (value - base) * factor
            elif interpolation == "circular_degrees":
                shortest = (value - base + 180.0) % 360.0 - 180.0
                desired = (base + shortest * factor) % 360.0
            else:
                raise ValueError(f"unsupported interpolation for {name}: {interpolation}")
        else:
            raise ValueError(f"unsupported operation for {name}: {operation}")
        compiled[name] = round(float(desired), 8)
    return compiled


def _load_rgb(path: str | Path, long_edge: int | None = None) -> np.ndarray:
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        if long_edge and max(image.size) > long_edge:
            scale = long_edge / max(image.size)
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.Resampling.LANCZOS,
            )
        return np.asarray(image, dtype=np.float32) / 255.0


def _srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(rgb: np.ndarray) -> np.ndarray:
    rgb = np.maximum(rgb, 0.0)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Convert an (..., 3) sRGB array in 0..1 to OKLab."""
    linear = _srgb_to_linear(np.asarray(rgb, dtype=np.float32))
    r, g, b = np.moveaxis(linear, -1, 0)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    lab = np.stack(
        (
            0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
        ),
        axis=-1,
    )
    return lab.astype(np.float32)


def oklab_to_srgb(lab: np.ndarray) -> np.ndarray:
    """Convert an (..., 3) OKLab array to clipped sRGB in 0..1."""
    lab = np.asarray(lab, dtype=np.float32)
    light, a, b = np.moveaxis(lab, -1, 0)
    l_ = light + 0.3963377774 * a + 0.2158037573 * b
    m_ = light - 0.1055613458 * a - 0.0638541728 * b
    s_ = light - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    linear = np.stack(
        (
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
        ),
        axis=-1,
    )
    return np.clip(_linear_to_srgb(linear), 0.0, 1.0).astype(np.float32)


def _oklch(lab: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    light = lab[..., 0]
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    hue = np.mod(np.degrees(np.arctan2(lab[..., 2], lab[..., 1])), 360.0)
    return light, chroma, hue


def _circular_distance(a: np.ndarray | float, b: np.ndarray | float) -> np.ndarray:
    return np.abs((np.asarray(a) - np.asarray(b) + 180.0) % 360.0 - 180.0)


def _smooth_circular(values: np.ndarray, sigma: float = 7.0) -> np.ndarray:
    radius = max(1, int(math.ceil(sigma * 3)))
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(x**2) / (2 * sigma**2))
    kernel /= kernel.sum()
    padded = np.concatenate((values[-radius:], values, values[:radius]))
    return np.convolve(padded, kernel, mode="same")[radius:-radius]


def hue_histogram(lab: np.ndarray) -> tuple[np.ndarray, float]:
    _, chroma, hue = _oklch(lab)
    flat_c = chroma.reshape(-1)
    flat_h = hue.reshape(-1)
    valid = flat_c >= 0.018
    neutral_fraction = float(1.0 - np.count_nonzero(valid) / max(1, flat_c.size))
    if not np.any(valid):
        histogram = np.zeros(360, dtype=np.float64)
        histogram[0] = 1.0
        return histogram, neutral_fraction
    bins = np.floor(flat_h[valid]).astype(np.int32) % 360
    weights = np.clip(flat_c[valid] - 0.012, 0.0, None).astype(np.float64)
    histogram = np.bincount(bins, weights=weights, minlength=360).astype(np.float64)
    histogram = _smooth_circular(histogram)
    total = histogram.sum()
    if total > 0:
        histogram /= total
    return histogram, neutral_fraction


def detect_harmony(histogram: np.ndarray) -> dict[str, Any]:
    """Evaluate nine harmony rules at every integer hue anchor."""
    histogram = np.asarray(histogram, dtype=np.float64)
    if histogram.shape != (360,):
        raise ValueError("hue histogram must have exactly 360 bins")
    total = float(histogram.sum())
    if total <= 0:
        histogram = np.zeros(360, dtype=np.float64)
        histogram[0] = 1.0
    else:
        histogram = histogram / total
    hues = np.arange(360, dtype=np.float64)
    ranked: list[dict[str, Any]] = []
    sigma = 12.0
    for rule_index, (name, offsets) in enumerate(HARMONY_RULES):
        count = len(offsets)
        for anchor in range(360):
            targets = np.mod(anchor + np.asarray(offsets), 360)
            distances = np.min(
                np.stack([_circular_distance(hues, target) for target in targets], axis=0), axis=0
            )
            coverage = float(np.sum(histogram * np.exp(-(distances**2) / (2 * sigma**2))))
            local_masses = [
                float(np.sum(histogram[_circular_distance(hues, target) <= 15.0])) for target in targets
            ]
            utilization = sum(mass >= 0.06 for mass in local_masses) / count
            score = coverage - 0.02 * (count - 1) + 0.10 * utilization
            displacement = float(np.sum(histogram * distances))
            ranked.append(
                {
                    "rule": name,
                    "anchor_hue": anchor,
                    "target_hues": [int(x) for x in targets],
                    "coverage": round(coverage, 8),
                    "utilization": round(utilization, 8),
                    "score": round(score, 8),
                    "weighted_hue_displacement": round(displacement, 8),
                    "_rule_index": rule_index,
                }
            )
    ranked.sort(
        key=lambda item: (
            -item["score"],
            item["weighted_hue_displacement"],
            item["_rule_index"],
            item["anchor_hue"],
        )
    )
    winner = dict(ranked[0])
    winner.pop("_rule_index", None)
    alternatives = []
    used_rules: set[str] = {winner["rule"]}
    for item in ranked[1:]:
        if item["rule"] in used_rules:
            continue
        clean = dict(item)
        clean.pop("_rule_index", None)
        alternatives.append(clean)
        used_rules.add(item["rule"])
        if len(alternatives) == 3:
            break
    winner["alternatives"] = alternatives
    return winner


def _hex_from_rgb(rgb: np.ndarray) -> str:
    values = np.clip(np.rint(rgb * 255), 0, 255).astype(np.uint8)
    return "#" + "".join(f"{int(channel):02X}" for channel in values)


def extract_palette(rgb: np.ndarray, lab: np.ndarray, histogram: np.ndarray, limit: int = 6) -> list[dict[str, Any]]:
    """Extract a deterministic chromatic OKLCH palette without random k-means."""
    light, chroma, hue = _oklch(lab)
    work = histogram.copy()
    selected: list[int] = []
    for _ in range(limit):
        peak = int(np.argmax(work))
        if work[peak] <= 0:
            break
        selected.append(peak)
        distance = _circular_distance(np.arange(360), peak)
        work[distance <= 24] = 0.0
    entries: list[dict[str, Any]] = []
    total_weight = max(float(np.sum(chroma)), 1e-9)
    for peak in selected:
        mask = (chroma >= 0.018) & (_circular_distance(hue, peak) <= 18)
        if not np.any(mask):
            continue
        weights = chroma[mask]
        weight_sum = float(weights.sum())
        representative_lab = np.average(lab[mask], axis=0, weights=weights)
        representative_rgb = oklab_to_srgb(representative_lab)
        rep_l, rep_c, rep_h = _oklch(representative_lab)
        entries.append(
            {
                "hex": _hex_from_rgb(representative_rgb),
                "oklch": [round(float(rep_l), 5), round(float(rep_c), 5), round(float(rep_h), 3)],
                "weight": round(weight_sum / total_weight, 5),
            }
        )
    neutral = chroma < 0.018
    if np.mean(neutral) >= 0.10:
        neutral_lab = np.mean(lab[neutral], axis=0)
        neutral_lab[1:] = 0.0
        neutral_rgb = oklab_to_srgb(neutral_lab)
        entries.append(
            {
                "hex": _hex_from_rgb(neutral_rgb),
                "oklch": [round(float(neutral_lab[0]), 5), 0.0, 0.0],
                "weight": round(float(np.mean(neutral)), 5),
                "neutral": True,
            }
        )
    return entries[:limit]


def _tone_metrics(lightness: np.ndarray) -> dict[str, Any]:
    percentiles = np.percentile(lightness, [1, 5, 25, 50, 75, 95, 99])
    mean = float(np.mean(lightness))
    spread = float(percentiles[5] - percentiles[1])
    return {
        "percentiles": {key: round(float(value), 5) for key, value in zip(("p01", "p05", "p25", "p50", "p75", "p95", "p99"), percentiles)},
        "mean": round(mean, 5),
        "standard_deviation": round(float(np.std(lightness)), 5),
        "dynamic_range_p05_p95": round(spread, 5),
        "shadow_fraction": round(float(np.mean(lightness < 0.25)), 5),
        "highlight_fraction": round(float(np.mean(lightness > 0.85)), 5),
        "key": "low" if mean < 0.42 else "high" if mean > 0.68 else "mid",
        "contrast": "hard" if spread > 0.63 else "soft" if spread < 0.35 else "moderate",
    }


def _texture_metrics(rgb: np.ndarray) -> dict[str, Any]:
    gray = cv2.cvtColor(np.clip(rgb * 255, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    laplacian = cv2.Laplacian(gray, cv2.CV_32F)
    sobel_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = np.hypot(sobel_x, sobel_y)
    lap_var = float(np.var(laplacian))
    edge_density = float(np.mean(magnitude > 72.0))
    return {
        "laplacian_variance": round(lap_var, 4),
        "edge_density": round(edge_density, 5),
        "strength": "high" if lap_var > 900 or edge_density > 0.22 else "low" if lap_var < 120 and edge_density < 0.06 else "medium",
    }


def _visual_anchors(rgb: np.ndarray, lab: np.ndarray, count: int = 5) -> list[dict[str, Any]]:
    light, chroma, _ = _oklch(lab)
    height, width = light.shape
    gray = np.clip(light * 255, 0, 255).astype(np.uint8)
    local = cv2.GaussianBlur(gray, (0, 0), 5)
    contrast = np.abs(gray.astype(np.float32) - local.astype(np.float32)) / 255.0
    salience = contrast + np.clip(chroma / 0.25, 0, 1) * 0.55
    grid_y, grid_x = 4, 4
    anchors: list[dict[str, Any]] = []
    for gy in range(grid_y):
        y0, y1 = gy * height // grid_y, (gy + 1) * height // grid_y
        for gx in range(grid_x):
            x0, x1 = gx * width // grid_x, (gx + 1) * width // grid_x
            region = salience[y0:y1, x0:x1]
            if region.size == 0:
                continue
            anchors.append(
                {
                    "x": round((x0 + x1) / (2 * width), 4),
                    "y": round((y0 + y1) / (2 * height), 4),
                    "score": round(float(np.mean(region)), 5),
                    "role": "color" if float(np.mean(chroma[y0:y1, x0:x1])) > 0.08 else "luminance",
                }
            )
    anchors.sort(key=lambda item: (-item["score"], item["y"], item["x"]))
    return anchors[:count]


def _temperature_axis(histogram: np.ndarray) -> float:
    hues = np.arange(360)
    warm = np.exp(-(_circular_distance(hues, 55.0) ** 2) / (2 * 45.0**2))
    cool = np.exp(-(_circular_distance(hues, 235.0) ** 2) / (2 * 50.0**2))
    value = float(np.sum(histogram * (warm - cool)))
    return round(float(np.clip(value, -1.0, 1.0)), 5)


def _normalize_people(
    protected_people: bool | Sequence[Mapping[str, Any]],
    image_width: int,
    image_height: int,
) -> dict[str, Any]:
    if isinstance(protected_people, bool):
        return {
            "enabled": protected_people,
            "source": "explicit_flag" if protected_people else "none",
            "boxes": [],
            "policy": "credible_skin_face_texture" if protected_people else "not_required",
        }
    boxes = []
    for raw in protected_people:
        x, y, width, height = (float(raw[key]) for key in ("x", "y", "width", "height"))
        units = str(raw.get("units", "normalized"))
        if units == "pixels":
            x, width = x / image_width, width / image_width
            y, height = y / image_height, height / image_height
        if width <= 0 or height <= 0:
            raise ValueError("people boxes must have positive width and height")
        boxes.append(
            {
                "x": round(float(np.clip(x, 0, 1)), 6),
                "y": round(float(np.clip(y, 0, 1)), 6),
                "width": round(float(np.clip(width, 0, 1)), 6),
                "height": round(float(np.clip(height, 0, 1)), 6),
            }
        )
    return {
        "enabled": bool(boxes),
        "source": "explicit_boxes",
        "boxes": boxes,
        "policy": "credible_skin_face_texture" if boxes else "not_required",
    }


def _normalize_semantic_hints(semantic_hints: Mapping[str, Any] | None) -> dict[str, Any]:
    allowed = {"subject", "scene", "mood", "lighting", "materials", "confidence", "preserve", "amplify", "break"}
    if semantic_hints is None:
        return {}
    unknown = set(semantic_hints).difference(allowed)
    if unknown:
        raise ValueError(f"unknown semantic hint fields: {sorted(unknown)}")
    normalized = json.loads(_canonical_json(dict(semantic_hints)))
    confidence = normalized.get("confidence")
    if confidence is not None and not 0.0 <= float(confidence) <= 1.0:
        raise ValueError("semantic confidence must be between 0 and 1")
    return normalized


def analyze_photo(
    image_path: str | Path,
    *,
    protected_people: bool | Sequence[Mapping[str, Any]] = False,
    semantic_hints: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute deterministic PhotoDNA from a rendered RGB proxy."""
    path = Path(image_path)
    rgb = _load_rgb(path, ANALYSIS_LONG_EDGE)
    height, width = rgb.shape[:2]
    lab = srgb_to_oklab(rgb)
    light, chroma, _ = _oklch(lab)
    histogram, neutral_fraction = hue_histogram(lab)
    harmony = detect_harmony(histogram)
    tone = _tone_metrics(light)
    texture = _texture_metrics(rgb)
    palette = extract_palette(rgb, lab, histogram)
    saturation_mean = float(np.mean(chroma))
    dominant = int(np.argmax(histogram))
    hints = _normalize_semantic_hints(semantic_hints)
    automatic_mood = [tone["key"], tone["contrast"], texture["strength"]]
    return {
        "analysis_version": "photodna-1.0.0",
        "source_digest": source_digest(path),
        "semantics": {
            "subject_model": "visual_anchor_proxy",
            "subject_regions": _visual_anchors(rgb, lab),
            "subject": hints.get("subject", "undetermined"),
            "scene": hints.get("scene", "undetermined"),
            "mood": hints.get("mood", automatic_mood),
            "lighting": hints.get("lighting", {"key": tone["key"], "contrast": tone["contrast"]}),
            "materials": hints.get("materials", []),
            "confidence": float(hints.get("confidence", 0.35 if not hints else 0.8)),
            "creative_guidance": {
                "preserve": hints.get("preserve", []),
                "amplify": hints.get("amplify", []),
                "break": hints.get("break", []),
            },
            "mood_cues": automatic_mood,
            "semantic_hints": hints,
            "limitations": ["No semantic classifier is bundled; people must be supplied explicitly."],
        },
        "tone": tone,
        "color": {
            "dominant_hue": dominant,
            "mean_chroma": round(saturation_mean, 6),
            "neutral_fraction": round(neutral_fraction, 6),
            "cold_warm_axis": 0.0 if neutral_fraction >= 0.995 else _temperature_axis(histogram),
            "hue_histogram_360": [round(float(value), 9) for value in histogram],
            "oklch_palette": palette,
        },
        "texture": texture,
        "harmony": harmony,
        "visual_anchors": _visual_anchors(rgb, lab),
        "protected_people": _normalize_people(protected_people, width, height),
        "proxy": {"filename": path.name, "analysis_width": width, "analysis_height": height},
    }


def _risk(
    kind: str,
    code: str,
    message: str,
    *,
    artifact: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    risk: dict[str, Any] = {"kind": kind, "code": code, "message": message}
    if artifact is not None:
        risk["artifact"] = dict(artifact)
    return risk


def _candidate(
    candidate_id: str,
    label: str,
    logic: str,
    default_strength: float,
    offline_ops: list[dict[str, Any]],
    parameters: dict[str, dict[str, Any]],
    risks: list[dict[str, Any]],
    people: Mapping[str, Any],
) -> dict[str, Any]:
    protection_amount = {"native": 0.35, "amplify": 0.60, "break": 0.92}[candidate_id]
    return {
        "candidate_id": candidate_id,
        "route": candidate_id,
        "label": label,
        "title": label,
        "logic": logic,
        "intent": logic,
        "rationale": [],
        "design_strength": default_strength,
        "intensity": {"minimum": 0.0, "design": 100.0, "default": default_strength, "maximum": 200.0},
        "offline_ops": offline_ops,
        "lr_recipe": {
            "mode": "baseline_relative",
            "parameters": parameters,
            "preview_fidelity": "directional_not_pixel_equivalent",
            "requires_dynamic_baseline": True,
        },
        "people_protection": {
            "required": bool(people.get("enabled")),
            "preserve_amount": protection_amount,
            "strategy": "global_skin_guard_then_single_reverse_mask_if_needed",
            "regions_digest": _sha256_bytes(_canonical_json(people).encode("utf-8")),
        },
        "risks": risks,
    }


def build_candidates(photo_dna: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Generate Native, Amplify, and Break as three different creative logics."""
    harmony = photo_dna["harmony"]
    tone = photo_dna["tone"]
    color = photo_dna["color"]
    texture = photo_dna["texture"]
    people = photo_dna["protected_people"]
    semantics = photo_dna.get("semantics", {})
    guidance = semantics.get("creative_guidance", {})
    axis = float(color["cold_warm_axis"])
    temperature_direction = 0 if abs(axis) < 0.04 else (1 if axis > 0 else -1)
    dominant = int(color["dominant_hue"])
    dynamic_range = float(tone["dynamic_range_p05_p95"])

    native = _candidate(
        "native",
        "Native",
        "Tidy and extend the color, tonal, and texture language already present.",
        82.0,
        [
            {"op": "oklch_harmony_nudge", "anchor_hue": harmony["anchor_hue"], "amount": 0.12},
            {"op": "contrast", "amount": 0.08 if dynamic_range < 0.58 else 0.035},
            {"op": "saturation", "amount": 0.08},
            {"op": "temperature", "amount": 0.035 * temperature_direction},
        ],
        {
            "contrast": _parameter("delta", 8.0 if dynamic_range < 0.58 else 4.0),
            "vibrance": _parameter("delta", 10.0),
            "clarity": _parameter("delta", 3.0 if texture["strength"] != "high" else 0.0),
            "temperature": _parameter("delta", 300.0 * temperature_direction),
        },
        [_risk("warning", "preview_renderer_difference", "Offline preview is directional and must be read back in Lightroom.")],
        people,
    )
    amplify = _candidate(
        "amplify",
        "Amplify",
        "Push the photograph's strongest temperature, contrast, hue, and material relationships.",
        118.0,
        [
            {"op": "oklch_harmony_nudge", "anchor_hue": harmony["anchor_hue"], "amount": 0.30},
            {"op": "contrast", "amount": 0.20},
            {"op": "saturation", "amount": 0.24},
            {"op": "temperature", "amount": 0.095 * temperature_direction},
            {"op": "local_texture", "amount": 0.14 if texture["strength"] != "high" else 0.06},
        ],
        {
            "contrast": _parameter("delta", 22.0),
            "vibrance": _parameter("delta", 24.0),
            "clarity": _parameter("delta", 12.0 if texture["strength"] != "high" else 5.0),
            "dehaze": _parameter("delta", 7.0),
            "temperature": _parameter("delta", 900.0 * temperature_direction),
            "color_grade_global_hue": _parameter("target", float(harmony["anchor_hue"]), "circular_degrees"),
            "color_grade_global_saturation": _parameter("delta", 8.0),
        },
        [
            _risk("warning", "gamut_pressure", "High strength can clip saturated display colors."),
            _risk("warning", "preview_renderer_difference", "Offline preview is directional and must be read back in Lightroom."),
        ],
        people,
    )

    break_hint = guidance.get("break", [])
    break_hint_text = _canonical_json(break_hint).lower()
    if "duotone" in break_hint_text or "双色" in break_hint_text:
        force_mode = "duotone"
    elif "low key" in break_hint_text or "low-key" in break_hint_text or "低调" in break_hint_text or "吞黑" in break_hint_text:
        force_mode = "low_key"
    elif "poster" in break_hint_text or "band" in break_hint_text or "断阶" in break_hint_text or "假色" in break_hint_text:
        force_mode = "hard_surface"
    else:
        force_mode = "auto"

    if force_mode == "duotone" or (force_mode == "auto" and (float(color["mean_chroma"]) < 0.045 or harmony["rule"] == "monochromatic")):
        break_mode = "duotone_palette_compression"
        targets = [int((dominant + 205) % 360), int((dominant + 28) % 360)]
        break_ops = [
            {"op": "duotone", "shadow_hue": targets[0], "highlight_hue": targets[1], "saturation": 0.58},
            {"op": "crush_blacks", "amount": 0.26},
            {"op": "grain", "amount": 0.16},
        ]
    elif force_mode == "low_key" or (force_mode == "auto" and tone["key"] == "low"):
        break_mode = "low_key_cross_process"
        targets = [int((dominant + 150) % 360), int((dominant + 315) % 360)]
        break_ops = [
            {"op": "channel_matrix", "matrix": [[1.08, -0.08, 0.06], [-0.07, 1.0, 0.14], [0.10, -0.05, 1.12]]},
            {"op": "duotone", "shadow_hue": targets[0], "highlight_hue": targets[1], "saturation": 0.46},
            {"op": "crush_blacks", "amount": 0.36},
            {"op": "grain", "amount": 0.12},
        ]
    elif force_mode == "hard_surface" or (force_mode == "auto" and texture["strength"] == "high"):
        break_mode = "hard_surface_false_color"
        targets = [int((dominant + 165) % 360), int((dominant + 280) % 360), dominant]
        break_ops = [
            {"op": "palette_compress", "target_hues": targets, "amount": 0.78},
            {"op": "posterize_luma", "levels": 8, "amount": 0.34},
            {"op": "contrast", "amount": 0.34},
        ]
    else:
        break_mode = "triadic_channel_shift"
        targets = [dominant, int((dominant + 120) % 360), int((dominant + 240) % 360)]
        break_ops = [
            {"op": "palette_compress", "target_hues": targets, "amount": 0.68},
            {"op": "channel_matrix", "matrix": [[1.14, -0.06, 0.02], [0.04, 0.92, 0.10], [-0.04, 0.09, 1.08]]},
            {"op": "crush_blacks", "amount": 0.18},
            {"op": "grain", "amount": 0.09},
        ]

    break_candidate = _candidate(
        "break",
        "Break",
        f"Reconstruct the image with {break_mode}; this is not a stronger Amplify.",
        152.0,
        break_ops,
        {
            "contrast": _parameter("delta", 34.0),
            "blacks": _parameter("delta", -26.0),
            "vibrance": _parameter("delta", 10.0),
            "grain_amount": _parameter("delta", 24.0),
            "color_grade_shadow_hue": _parameter("target", float(targets[0]), "circular_degrees"),
            "color_grade_shadow_saturation": _parameter("target", 28.0),
            "color_grade_highlight_hue": _parameter("target", float(targets[1]), "circular_degrees"),
            "color_grade_highlight_saturation": _parameter("target", 22.0),
            "blue_primary_hue": _parameter("delta", 18.0 if axis <= 0 else -18.0),
        },
        [
            _risk(
                "intentional",
                "intentional_artifact",
                f"{break_mode} may create deliberate color bias, dead blacks, stepping, or grain.",
                artifact={
                    "purpose": f"Reconstruct the photograph through {break_mode} instead of conventional correction.",
                    "scope": "environment_global_with_person_guard" if people.get("enabled") else "global_frame",
                    "expected_signature": "Declared cast, black compression, palette discontinuity, stepping, or grain matching the selected operator graph.",
                    "people_impact": "Face depth, skin gradients, and texture remain protected; use one reverse mask if global protection is insufficient." if people.get("enabled") else "No protected person is declared in PhotoDNA.",
                },
            ),
            _risk("warning", "person_reverse_mask", "If a person is present, Lightroom may need one reverse-compensation mask."),
            _risk("warning", "preview_renderer_difference", "Offline preview is directional and must be read back in Lightroom."),
        ],
        people,
    )
    native["rationale"] = [
        f"Detected {harmony['rule']} harmony around {harmony['anchor_hue']}°.",
        f"Preserve guidance: {guidance.get('preserve', [])}.",
    ]
    amplify["rationale"] = [
        f"Amplify the source's {'neutral' if temperature_direction == 0 else 'warm' if axis > 0 else 'cool'} axis and {texture['strength']} texture.",
        f"Amplify guidance: {guidance.get('amplify', [])}.",
    ]
    break_candidate["rationale"] = [
        f"Selected {break_mode} from tone/color/texture structure.",
        f"Break guidance: {break_hint}.",
    ]
    return [native, amplify, break_candidate]


def create_session(
    image_path: str | Path,
    *,
    filename: str | None = None,
    photo_id: str | None = None,
    source_digest_override: str | None = None,
    baseline_edit_digest: str | None = None,
    protected_people: bool | Sequence[Mapping[str, Any]] = False,
    semantic_hints: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    path = Path(image_path)
    dna = analyze_photo(path, protected_people=protected_people, semantic_hints=semantic_hints)
    proxy_digest = dna["source_digest"]
    session = {
        "session_version": SESSION_VERSION,
        "target": {
            "photo_id": photo_id,
            "filename": filename or path.name,
            "source_digest": source_digest_override or proxy_digest,
            "proxy_digest": proxy_digest,
            "baseline_edit_digest": baseline_edit_digest,
        },
        "photo_dna": dna,
        "candidates": build_candidates(dna),
        "selection": None,
        "execution": {
            "state": "ANALYZED",
            "state_history": ["ACQUIRE", "ANALYZED"],
            "transaction_id": None,
            "desired": {},
            "applied": {},
            "readback": {},
            "failures": [],
            "person_protection": {
                "required": bool(dna["protected_people"]["enabled"]),
                "result": "pending",
            },
        },
        "previews": {},
        "collection": {"saved": False},
    }
    validate_session(session)
    return session


def _hue_attraction(lab: np.ndarray, anchor: float, amount: float) -> np.ndarray:
    light, chroma, hue = _oklch(lab)
    delta = (anchor - hue + 180.0) % 360.0 - 180.0
    saturation_gate = np.clip((chroma - 0.012) / 0.10, 0.0, 1.0)
    new_hue = hue + delta * amount * saturation_gate
    result = np.empty_like(lab)
    result[..., 0] = light
    result[..., 1] = chroma * np.cos(np.radians(new_hue))
    result[..., 2] = chroma * np.sin(np.radians(new_hue))
    return result


def _hue_rgb(hue: float, light: float = 0.70, chroma: float = 0.13) -> np.ndarray:
    radians = math.radians(hue)
    return oklab_to_srgb(np.array([light, chroma * math.cos(radians), chroma * math.sin(radians)], dtype=np.float32))


def _apply_op(rgb: np.ndarray, op: Mapping[str, Any], multiplier: float, seed: int) -> np.ndarray:
    name = op["op"]
    if name == "oklch_harmony_nudge":
        lab = srgb_to_oklab(rgb)
        return oklab_to_srgb(_hue_attraction(lab, float(op["anchor_hue"]), float(op["amount"]) * multiplier))
    if name == "contrast":
        amount = float(op["amount"]) * multiplier
        return np.clip((rgb - 0.5) * (1.0 + amount) + 0.5, 0.0, 1.0)
    if name == "saturation":
        amount = float(op["amount"]) * multiplier
        lab = srgb_to_oklab(rgb)
        lab[..., 1:] *= max(0.0, 1.0 + amount)
        return oklab_to_srgb(lab)
    if name == "temperature":
        amount = float(op["amount"]) * multiplier
        adjustment = np.array([amount, amount * 0.18, -amount], dtype=np.float32)
        return np.clip(rgb + adjustment, 0.0, 1.0)
    if name == "local_texture":
        amount = float(op["amount"]) * multiplier
        blurred = cv2.GaussianBlur(rgb, (0, 0), 1.4)
        return np.clip(rgb + (rgb - blurred) * amount, 0.0, 1.0)
    if name == "duotone":
        amount = float(op["saturation"]) * multiplier
        lab = srgb_to_oklab(rgb)
        light = lab[..., 0][..., None]
        shadow = _hue_rgb(float(op["shadow_hue"]), 0.48, min(0.18, 0.10 + amount * 0.08))
        highlight = _hue_rgb(float(op["highlight_hue"]), 0.82, min(0.16, 0.08 + amount * 0.06))
        mapped = shadow * (1.0 - light) + highlight * light
        blend = np.clip(amount, 0.0, 1.6)
        return np.clip(rgb * (1.0 - min(blend, 1.0)) + mapped * blend, 0.0, 1.0)
    if name == "crush_blacks":
        amount = float(op["amount"]) * multiplier
        pivot = min(0.40, 0.16 + amount * 0.15)
        crushed = np.where(rgb < pivot, np.power(np.maximum(rgb / max(pivot, 1e-4), 1e-6), 1.0 + amount * 2.0) * pivot, rgb)
        return np.clip(crushed, 0.0, 1.0)
    if name == "grain":
        amount = float(op["amount"]) * multiplier
        generator = np.random.default_rng(seed)
        noise = generator.normal(0.0, max(0.0, amount) * 0.055, rgb.shape[:2]).astype(np.float32)
        return np.clip(rgb + noise[..., None], 0.0, 1.0)
    if name == "channel_matrix":
        matrix = np.asarray(op["matrix"], dtype=np.float32)
        effective = np.eye(3, dtype=np.float32) + (matrix - np.eye(3, dtype=np.float32)) * multiplier
        return np.clip(np.einsum("...c,dc->...d", rgb, effective), 0.0, 1.0)
    if name == "palette_compress":
        lab = srgb_to_oklab(rgb)
        light, chroma, hue = _oklch(lab)
        targets = np.asarray(op["target_hues"], dtype=np.float32)
        distances = np.stack([_circular_distance(hue, target) for target in targets], axis=-1)
        nearest = targets[np.argmin(distances, axis=-1)]
        delta = (nearest - hue + 180.0) % 360.0 - 180.0
        amount = min(1.4, float(op["amount"]) * multiplier)
        new_hue = hue + delta * amount
        lab[..., 0] = light
        lab[..., 1] = chroma * np.cos(np.radians(new_hue))
        lab[..., 2] = chroma * np.sin(np.radians(new_hue))
        return oklab_to_srgb(lab)
    if name == "posterize_luma":
        lab = srgb_to_oklab(rgb)
        levels = max(2, int(op["levels"]))
        quantized = np.round(lab[..., 0] * (levels - 1)) / (levels - 1)
        amount = min(1.0, float(op["amount"]) * multiplier)
        lab[..., 0] = lab[..., 0] * (1.0 - amount) + quantized * amount
        return oklab_to_srgb(lab)
    raise ValueError(f"unsupported offline operation: {name}")


def _people_mask(rgb: np.ndarray, protection: Mapping[str, Any], people: Mapping[str, Any]) -> np.ndarray:
    height, width = rgb.shape[:2]
    mask = np.zeros((height, width), dtype=np.float32)
    boxes = people.get("boxes", [])
    yy, xx = np.mgrid[0:height, 0:width]
    for box in boxes:
        x0 = float(box["x"]) * width
        y0 = float(box["y"]) * height
        bw = max(1.0, float(box["width"]) * width)
        bh = max(1.0, float(box["height"]) * height)
        cx, cy = x0 + bw / 2, y0 + bh / 2
        elliptical = np.exp(-(((xx - cx) / (bw * 0.62)) ** 2 + ((yy - cy) / (bh * 0.62)) ** 2) * 2.0)
        inside = (xx >= x0) & (xx <= x0 + bw) & (yy >= y0) & (yy <= y0 + bh)
        mask = np.maximum(mask, elliptical * inside)
    if people.get("enabled") and not boxes:
        eight = np.clip(rgb * 255, 0, 255).astype(np.uint8)
        ycrcb = cv2.cvtColor(eight, cv2.COLOR_RGB2YCrCb)
        skin = cv2.inRange(ycrcb, np.array([0, 133, 77], np.uint8), np.array([255, 180, 135], np.uint8))
        mask = cv2.GaussianBlur(skin.astype(np.float32) / 255.0, (0, 0), 3.0)
    preserve = float(protection.get("preserve_amount", 0.0))
    return np.clip(mask * preserve, 0.0, 1.0)


def render_candidate(
    source_rgb: np.ndarray,
    candidate: Mapping[str, Any],
    photo_dna: Mapping[str, Any],
    strength: float,
    seed: int,
) -> np.ndarray:
    if not 0.0 <= strength <= 200.0:
        raise ValueError("strength must be between 0 and 200")
    # Unexpected risks block selection/application, not a safe diagnostic
    # preview that lets the operator see and redesign the failed candidate.
    if strength == 0.0:
        return source_rgb.copy()
    multiplier = strength / 100.0
    result = source_rgb.copy()
    for index, op in enumerate(candidate["offline_ops"]):
        result = _apply_op(result, op, multiplier, seed + index * 104729)
    if photo_dna["protected_people"].get("enabled"):
        mask = _people_mask(source_rgb, candidate["people_protection"], photo_dna["protected_people"])
        result = result * (1.0 - mask[..., None]) + source_rgb * mask[..., None]
    return np.clip(result, 0.0, 1.0)


def _save_jpeg(rgb: np.ndarray, path: Path) -> None:
    safe = np.nan_to_num(rgb, nan=0.0, posinf=1.0, neginf=0.0)
    image = Image.fromarray(np.clip(np.rint(safe * 255), 0, 255).astype(np.uint8), "RGB")
    temporary = path.with_suffix(path.suffix + ".tmp")
    image.save(temporary, "JPEG", quality=92, subsampling=0, optimize=True)
    temporary.replace(path)


def _preview_qc(
    baseline: np.ndarray,
    rendered: np.ndarray,
    candidate: Mapping[str, Any],
    photo_dna: Mapping[str, Any],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Detect render accidents separately from declared creative artifacts."""
    finite_fraction = float(np.mean(np.isfinite(rendered)))
    safe_output = np.nan_to_num(rendered, nan=0.0, posinf=1.0, neginf=0.0)
    safe_base = np.nan_to_num(baseline, nan=0.0, posinf=1.0, neginf=0.0)
    baseline_gray = cv2.cvtColor(np.clip(safe_base * 255, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    output_gray = cv2.cvtColor(np.clip(safe_output * 255, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    base_low = float(np.mean(safe_base <= (1.0 / 255.0)))
    base_high = float(np.mean(safe_base >= (254.0 / 255.0)))
    out_low = float(np.mean(safe_output <= (1.0 / 255.0)))
    out_high = float(np.mean(safe_output >= (254.0 / 255.0)))
    base_levels = int(np.unique(baseline_gray).size)
    out_levels = int(np.unique(output_gray).size)
    possible_banding = bool(base_levels >= 64 and out_levels < 24)
    diff = np.mean(np.abs(safe_output - safe_base), axis=2)
    people_difference: float | None = None
    environment_difference: float | None = None
    people_mask_coverage: float | None = None
    if photo_dna["protected_people"].get("enabled"):
        mask = _people_mask(baseline, candidate["people_protection"], photo_dna["protected_people"])
        inside = mask > max(0.12, float(np.max(mask)) * 0.35)
        outside = mask < 0.03
        people_mask_coverage = float(np.mean(inside))
        if np.any(inside):
            people_difference = float(np.mean(diff[inside]))
        if np.any(outside):
            environment_difference = float(np.mean(diff[outside]))
    metrics: dict[str, Any] = {
        "dimensions": {"baseline": [int(baseline.shape[1]), int(baseline.shape[0])], "output": [int(rendered.shape[1]), int(rendered.shape[0])]},
        "finite_fraction": round(finite_fraction, 8),
        "clip_fraction": {
            "baseline_low": round(base_low, 6),
            "baseline_high": round(base_high, 6),
            "output_low": round(out_low, 6),
            "output_high": round(out_high, 6),
        },
        "luma_levels_8bit": {"baseline": base_levels, "output": out_levels},
        "possible_banding": possible_banding,
        "mean_absolute_change": round(float(np.mean(diff)), 6),
        "people_mean_change": None if people_difference is None else round(people_difference, 6),
        "environment_mean_change": None if environment_difference is None else round(environment_difference, 6),
        "people_mask_coverage": None if people_mask_coverage is None else round(people_mask_coverage, 6),
    }
    risks: list[dict[str, str]] = []
    if baseline.shape != rendered.shape:
        risks.append(_risk("unexpected", "preview_dimension_mismatch", "Preview dimensions differ from the source proxy."))
    if finite_fraction < 1.0:
        risks.append(_risk("unexpected", "preview_nonfinite", "Preview renderer produced NaN or infinite channel values."))
    op_names = {str(op["op"]) for op in candidate["offline_ops"]}
    severe_clip = out_low > base_low + 0.20 or out_high > base_high + 0.20
    if severe_clip:
        if candidate["candidate_id"] == "break" and "crush_blacks" in op_names:
            risks.append(_risk("intentional", "preview_detected_clipping", "QC confirms the declared Break clipping artifact."))
        else:
            risks.append(_risk("unexpected", "preview_accidental_clipping", "QC found severe clipping not declared by the recipe."))
    if possible_banding:
        if candidate["candidate_id"] == "break" and "posterize_luma" in op_names:
            risks.append(_risk("intentional", "preview_detected_banding", "QC confirms the declared Break luma stepping artifact."))
        else:
            risks.append(_risk("unexpected", "preview_accidental_banding", "QC found strong luma banding not declared by the recipe."))
    if people_difference is not None and people_difference > 0.14 and (
        environment_difference is None or people_difference > environment_difference * 1.10
    ):
        risks.append(_risk("unexpected", "preview_people_protection_failure", "Protected person region changed more than the safety threshold."))
    if photo_dna["protected_people"].get("enabled") and (people_mask_coverage is None or people_mask_coverage < 0.001):
        risks.append(_risk("unexpected", "preview_people_mask_empty", "A person is declared but the preview protection mask has no usable coverage; supply person boxes."))
    return metrics, risks


def _render_one(
    source_rgb: np.ndarray,
    source_hash: str,
    candidate: Mapping[str, Any],
    photo_dna: Mapping[str, Any],
    strength: float,
    cache_dir: Path,
    requested_long_edge: int,
) -> PreviewResult:
    creative_hash = recipe_hash(candidate, strength)
    preview_hash = _sha256_bytes(
        _canonical_json(
            {
                "creative_recipe_hash": creative_hash,
                "renderer_version": PREVIEW_RENDERER_VERSION,
                "requested_long_edge": int(requested_long_edge),
                "render_dimensions": [int(source_rgb.shape[1]), int(source_rgb.shape[0])],
            }
        ).encode("utf-8")
    )
    cache_key = _sha256_bytes(f"{source_hash}:{preview_hash}".encode("ascii"))
    cached_path = cache_dir / f"{candidate['candidate_id']}-{cache_key}.jpg"
    metadata_path = cache_dir / f"{candidate['candidate_id']}-{cache_key}.json"
    expected_contract = {
        "cache_contract": "1.0.0",
        "source_digest": source_hash,
        "preview_recipe_hash": preview_hash,
        "renderer_version": PREVIEW_RENDERER_VERSION,
        "requested_long_edge": int(requested_long_edge),
        "render_dimensions": [int(source_rgb.shape[1]), int(source_rgb.shape[0])],
    }
    if cached_path.exists() and metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            contract_matches = all(metadata.get(key) == value for key, value in expected_contract.items())
            size_matches = int(metadata.get("jpeg_size", -1)) == cached_path.stat().st_size and cached_path.stat().st_size > 0
            if contract_matches and size_matches and isinstance(metadata.get("qc"), dict) and isinstance(metadata.get("detected_risks"), list):
                return PreviewResult(
                    candidate["candidate_id"],
                    str(cached_path),
                    strength,
                    cache_key,
                    True,
                    preview_hash,
                    metadata["qc"],
                    metadata["detected_risks"],
                )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    seed = int(cache_key[:16], 16) % (2**32)
    rendered = render_candidate(source_rgb, candidate, photo_dna, strength, seed)
    qc, detected = _preview_qc(source_rgb, rendered, candidate, photo_dna)
    _save_jpeg(rendered, cached_path)
    metadata = {**expected_contract, "jpeg_size": cached_path.stat().st_size, "qc": qc, "detected_risks": detected}
    temporary_metadata = metadata_path.with_suffix(metadata_path.suffix + ".tmp")
    temporary_metadata.write_text(json.dumps(metadata, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    temporary_metadata.replace(metadata_path)
    return PreviewResult(candidate["candidate_id"], str(cached_path), strength, cache_key, False, preview_hash, qc, detected)


def _make_contact_sheet(results: Sequence[PreviewResult], output_path: Path) -> None:
    opened = [Image.open(result.path).convert("RGB") for result in results]
    try:
        target_height = min(720, max(image.height for image in opened))
        cards: list[Image.Image] = []
        label_height = 58
        for result, image in zip(results, opened):
            scale = target_height / image.height
            resized = image.resize((max(1, round(image.width * scale)), target_height), Image.Resampling.LANCZOS)
            card = Image.new("RGB", (resized.width, target_height + label_height), "#111111")
            card.paste(resized, (0, label_height))
            draw = ImageDraw.Draw(card)
            draw.text((18, 17), f"{result.candidate_id.upper()}  {result.strength:.0f}%", fill="white", font=ImageFont.load_default())
            cards.append(card)
        gap = 8
        sheet = Image.new("RGB", (sum(card.width for card in cards) + gap * (len(cards) - 1), target_height + label_height), "#222222")
        x = 0
        for card in cards:
            sheet.paste(card, (x, 0))
            x += card.width + gap
        sheet.save(output_path, "JPEG", quality=92, subsampling=0)
    finally:
        for image in opened:
            image.close()


def _advance_state(session: dict[str, Any], state: str) -> None:
    current = session["execution"]["state"]
    allowed = {
        "ANALYZED": {"PREVIEWED"},
        "PREVIEWED": {"PREVIEWED", "SELECTED"},
        "SELECTED": {"SELECTED", "SNAPSHOTTED"},
        "SNAPSHOTTED": {"APPLIED", "ROLLED_BACK"},
        "APPLIED": {"PERSON_PROTECTED", "ROLLED_BACK"},
        "PERSON_PROTECTED": {"VERIFIED", "ROLLED_BACK"},
        "VERIFIED": {"DONE", "ROLLED_BACK"},
    }
    if state == current:
        return
    if state not in allowed.get(current, set()):
        raise SessionValidationError(f"illegal state transition: {current} -> {state}")
    session["execution"]["state"] = state
    session["execution"].setdefault("state_history", []).append(state)


def render_session(
    session: dict[str, Any],
    image_path: str | Path,
    output_dir: str | Path,
    *,
    strengths: Mapping[str, float] | None = None,
    long_edge: int = LONG_EDGE_DEFAULT,
    max_workers: int = 3,
) -> dict[str, Any]:
    """Render and cache all three candidates concurrently."""
    validate_session(session, image_path=image_path)
    if long_edge < 256:
        raise ValueError("long_edge must be at least 256 pixels")
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    cache_dir = output / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    source_rgb = _load_rgb(image_path, long_edge)
    source_hash = session["target"]["proxy_digest"]
    requested = {
        candidate["candidate_id"]: float(
            (strengths or {}).get(candidate["candidate_id"], candidate["intensity"]["default"])
        )
        for candidate in session["candidates"]
    }
    for strength in requested.values():
        if not 0.0 <= strength <= 200.0:
            raise ValueError("all strengths must be between 0 and 200")
    futures = []
    with ThreadPoolExecutor(max_workers=min(max_workers, len(session["candidates"]))) as executor:
        for candidate in session["candidates"]:
            futures.append(
                executor.submit(
                    _render_one,
                    source_rgb,
                    source_hash,
                    candidate,
                    session["photo_dna"],
                    requested[candidate["candidate_id"]],
                    cache_dir,
                    long_edge,
                )
            )
        results = [future.result() for future in futures]
    results.sort(key=lambda result: ("native", "amplify", "break").index(result.candidate_id))
    contact_sheet = output / f"{Path(image_path).stem}-creative-contact-sheet.jpg"
    _make_contact_sheet(results, contact_sheet)
    for candidate, result in zip(session["candidates"], results):
        candidate["risks"] = [risk for risk in candidate["risks"] if risk.get("source") != "preview_qc"]
        for risk in result.detected_risks:
            candidate["risks"].append({**risk, "source": "preview_qc"})
    manifest = {
        result.candidate_id: {
            "path": result.path,
            "strength": result.strength,
            "cache_key": result.cache_key,
            "cache_hit": result.cache_hit,
            "recipe_hash": result.preview_recipe_hash,
            "renderer_version": PREVIEW_RENDERER_VERSION,
            "qc": result.qc,
            "detected_risks": result.detected_risks,
        }
        for result in results
    }
    manifest["contact_sheet"] = str(contact_sheet)
    session["previews"] = manifest
    _advance_state(session, "PREVIEWED")
    validate_session(session)
    return manifest


def select_candidate(session: dict[str, Any], candidate_id: str, strength: float | None = None) -> dict[str, Any]:
    validate_session(session)
    matches = [candidate for candidate in session["candidates"] if candidate["candidate_id"] == candidate_id]
    if not matches:
        raise SessionValidationError(f"unknown candidate: {candidate_id}")
    candidate = matches[0]
    requested = float(candidate["intensity"]["default"] if strength is None else strength)
    if not 0.0 <= requested <= 200.0:
        raise ValueError("strength must be between 0 and 200")
    if any(risk.get("kind") == "unexpected" for risk in candidate.get("risks", [])):
        raise SessionValidationError("selection is blocked by an unexpected risk")
    session["selection"] = {"candidate_id": candidate_id, "requested_strength": requested}
    session["execution"]["desired"] = {
        "candidate_id": candidate_id,
        "requested_strength": requested,
        "strength_factor": round(requested / 100.0, 6),
        "recipe_hash": recipe_hash(candidate, requested),
        "mode": "baseline_relative",
        "parameter_specs": candidate["lr_recipe"]["parameters"],
        "compiled_parameters": None,
        "compilation": "bridge_reads_pinned_baseline_then_interpolates",
        "people_protection": candidate["people_protection"],
    }
    _advance_state(session, "SELECTED")
    validate_session(session)
    return session["selection"]


def _validate_history(history: Sequence[str]) -> None:
    if not history or history[0] != "ACQUIRE":
        raise SessionValidationError("state_history must start at ACQUIRE")
    allowed_pairs = {
        ("ACQUIRE", "ANALYZED"),
        ("ANALYZED", "PREVIEWED"),
        ("PREVIEWED", "PREVIEWED"),
        ("PREVIEWED", "SELECTED"),
        ("SELECTED", "SELECTED"),
        ("SELECTED", "SNAPSHOTTED"),
        ("SNAPSHOTTED", "APPLIED"),
        ("SNAPSHOTTED", "ROLLED_BACK"),
        ("APPLIED", "PERSON_PROTECTED"),
        ("APPLIED", "ROLLED_BACK"),
        ("PERSON_PROTECTED", "VERIFIED"),
        ("PERSON_PROTECTED", "ROLLED_BACK"),
        ("VERIFIED", "DONE"),
        ("VERIFIED", "ROLLED_BACK"),
    }
    for left, right in zip(history, history[1:]):
        if (left, right) not in allowed_pairs:
            raise SessionValidationError(f"illegal state history transition: {left} -> {right}")


def validate_session(session: Mapping[str, Any], image_path: str | Path | None = None) -> list[str]:
    """Strictly validate the shared GradeSession and return warnings."""
    required = {"session_version", "target", "photo_dna", "candidates", "selection", "execution"}
    missing = required.difference(session)
    if missing:
        raise SessionValidationError(f"GradeSession missing fields: {sorted(missing)}")
    if session["session_version"] != SESSION_VERSION:
        raise SessionValidationError(f"unsupported session_version: {session['session_version']}")
    target = session["target"]
    for field in ("filename", "source_digest", "proxy_digest", "baseline_edit_digest", "photo_id"):
        if field not in target:
            raise SessionValidationError(f"target missing {field}")
    if target["proxy_digest"] != session["photo_dna"].get("source_digest"):
        raise SessionValidationError("target proxy_digest and PhotoDNA source digest differ")
    if image_path is not None and source_digest(image_path) != target["proxy_digest"]:
        raise SessionValidationError("analysis proxy changed or does not match GradeSession")
    candidates = session["candidates"]
    if [candidate.get("candidate_id") for candidate in candidates] != ["native", "amplify", "break"]:
        raise SessionValidationError("candidates must be ordered native, amplify, break")
    warnings: list[str] = []
    for candidate in candidates:
        for field in ("intensity", "offline_ops", "lr_recipe", "risks", "people_protection"):
            if field not in candidate:
                raise SessionValidationError(f"{candidate['candidate_id']} missing {field}")
        intensity = candidate["intensity"]
        if not (0 <= float(intensity["minimum"]) <= float(intensity["default"]) <= float(intensity["maximum"]) <= 200):
            raise SessionValidationError(f"invalid intensity bounds for {candidate['candidate_id']}")
        if float(candidate.get("design_strength", -1)) != float(intensity["default"]):
            raise SessionValidationError(f"design_strength must match intensity.default for {candidate['candidate_id']}")
        for risk in candidate["risks"]:
            if risk.get("kind") not in {"intentional", "warning", "unexpected"}:
                raise SessionValidationError(f"invalid risk kind in {candidate['candidate_id']}")
            if risk.get("kind") == "unexpected":
                warnings.append(f"BLOCKED {candidate['candidate_id']}: {risk.get('code')}")
            if risk.get("kind") == "intentional" and risk.get("code") == "intentional_artifact":
                artifact = risk.get("artifact")
                artifact_fields = {"purpose", "scope", "expected_signature", "people_impact"}
                if not isinstance(artifact, Mapping) or artifact_fields.difference(artifact):
                    raise SessionValidationError("intentional_artifact requires purpose, scope, expected_signature, and people_impact")
                if any(not isinstance(artifact[field], str) or not artifact[field].strip() for field in artifact_fields):
                    raise SessionValidationError("intentional_artifact metadata fields must be non-empty strings")
        parameter_specs = candidate["lr_recipe"].get("parameters")
        if not isinstance(parameter_specs, Mapping):
            raise SessionValidationError(f"{candidate['candidate_id']} lr_recipe.parameters must be an object")
        for name, spec in parameter_specs.items():
            if not isinstance(name, str) or not name or not name.replace("_", "").isalnum() or name.lower() != name:
                raise SessionValidationError(f"non-canonical Lightroom parameter name: {name!r}")
            if not isinstance(spec, Mapping) or spec.get("operation") not in {"delta", "target"}:
                raise SessionValidationError(f"invalid parameter operation for {name}")
            if spec.get("interpolation", "linear") not in {"linear", "circular_degrees"}:
                raise SessionValidationError(f"invalid parameter interpolation for {name}")
            if spec.get("operation") == "delta" and spec.get("interpolation", "linear") != "linear":
                raise SessionValidationError(f"delta parameter {name} must use linear interpolation")
    execution = session["execution"]
    for field in ("state", "state_history", "transaction_id", "desired", "applied", "readback", "failures", "person_protection"):
        if field not in execution:
            raise SessionValidationError(f"execution missing {field}")
    _validate_history(execution["state_history"])
    if execution["state"] != execution["state_history"][-1]:
        raise SessionValidationError("execution state differs from state_history tail")
    if execution["state"] not in set(STATE_ORDER) | {"ROLLED_BACK"}:
        raise SessionValidationError(f"unknown execution state: {execution['state']}")
    if execution["state"] in {"SELECTED", "SNAPSHOTTED", "APPLIED", "PERSON_PROTECTED", "VERIFIED", "DONE"} and not session["selection"]:
        raise SessionValidationError("selected or later state requires selection")
    if execution["state"] in {"ACQUIRE", "ANALYZED", "PREVIEWED"} and session["selection"] is not None:
        raise SessionValidationError("selection must remain null until SELECTED")
    if session["selection"]:
        selection = session["selection"]
        matches = [candidate for candidate in candidates if candidate["candidate_id"] == selection.get("candidate_id")]
        if not matches:
            raise SessionValidationError("selection references an unknown candidate")
        selected = matches[0]
        requested = float(selection.get("requested_strength", -1))
        if not 0.0 <= requested <= 200.0:
            raise SessionValidationError("selection requested_strength must be between 0 and 200")
        blocked = [risk for risk in selected["risks"] if risk.get("kind") == "unexpected"]
        if blocked:
            raise SessionValidationError(f"selected candidate is blocked by unexpected risks: {[risk.get('code') for risk in blocked]}")
        desired = execution["desired"]
        if desired.get("candidate_id") != selection["candidate_id"] or float(desired.get("requested_strength", -1)) != requested:
            raise SessionValidationError("execution.desired does not match selection")
        if not math.isclose(float(desired.get("strength_factor", -1)), requested / 100.0, abs_tol=1e-8):
            raise SessionValidationError("execution.desired strength_factor does not match selection")
        if desired.get("parameter_specs") != selected["lr_recipe"]["parameters"]:
            raise SessionValidationError("execution.desired parameter_specs differ from the selected candidate")
        if desired.get("recipe_hash") != recipe_hash(selected, requested):
            raise SessionValidationError("execution.desired recipe_hash does not match the selected candidate")
    protection = execution["person_protection"]
    required_people = bool(session["photo_dna"]["protected_people"].get("enabled"))
    if bool(protection.get("required")) != required_people:
        raise SessionValidationError("execution person_protection.required differs from PhotoDNA")
    if execution["state"] in {"PERSON_PROTECTED", "VERIFIED", "DONE"}:
        result = protection.get("result")
        if required_people and result not in {"protected", "compensated", "verified"}:
            raise SessionValidationError("person image requires a completed protection result")
        if not required_people and result != "not_required":
            raise SessionValidationError("no-person image must record person protection result not_required")
    if execution["state"] in {"VERIFIED", "DONE"} and not execution["readback"]:
        raise SessionValidationError("VERIFIED or DONE requires Lightroom readback")
    return warnings


def collect_style(
    session: Mapping[str, Any],
    library_dir: str | Path,
    *,
    name: str | None = None,
) -> Path:
    """Explicitly collect one verified result; never called by other commands."""
    validate_session(session)
    if session["execution"]["state"] not in {"VERIFIED", "DONE"}:
        raise SessionValidationError("only VERIFIED or DONE results may be collected")
    if not session["execution"]["readback"]:
        raise SessionValidationError("collection requires Lightroom readback values")
    selection = session["selection"]
    if not selection:
        raise SessionValidationError("collection requires an explicit selection")
    previews = session.get("previews", {})
    chosen_preview = previews.get(selection["candidate_id"], {}).get("path")
    if not chosen_preview or not Path(chosen_preview).exists():
        raise SessionValidationError("collection requires the selected candidate preview")
    library = Path(library_dir)
    library.mkdir(parents=True, exist_ok=True)
    slug = name or f"{Path(session['target']['filename']).stem}-{selection['candidate_id']}"
    safe = "".join(character if character.isalnum() or character in "-_" else "-" for character in slug).strip("-")
    entry = library / safe
    if entry.exists():
        suffix = _sha256_bytes(_canonical_json(session["selection"]).encode("utf-8"))[:8]
        entry = library / f"{safe}-{suffix}"
    entry.mkdir(parents=False)
    payload = {
        "collection_version": "1.0",
        "target": session["target"],
        "photo_dna": session["photo_dna"],
        "selection": session["selection"],
        "recipe": session["execution"]["desired"],
        "readback": session["execution"]["readback"],
        "risks": next(candidate["risks"] for candidate in session["candidates"] if candidate["candidate_id"] == selection["candidate_id"]),
    }
    (entry / "style.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copy2(chosen_preview, entry / "preview.jpg")
    contact_sheet = previews.get("contact_sheet")
    if contact_sheet and Path(contact_sheet).exists():
        shutil.copy2(contact_sheet, entry / "contact-sheet.jpg")
    return entry


def load_session(path: str | Path) -> dict[str, Any]:
    session = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_session(session)
    return session


def save_session(session: Mapping[str, Any], path: str | Path) -> None:
    validate_session(session)
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
