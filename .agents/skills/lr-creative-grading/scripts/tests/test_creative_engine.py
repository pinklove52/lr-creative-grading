from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from creative_engine import (  # noqa: E402
    SessionValidationError,
    analyze_photo,
    build_candidates,
    collect_style,
    compile_lr_parameters,
    create_session,
    detect_harmony,
    recipe_hash,
    render_candidate,
    render_session,
    load_session,
    migrate_preview_contract,
    save_session,
    select_candidate,
    validate_session,
)
import creative_grade  # noqa: E402


def _synthetic_rgb(width: int = 128, height: int = 96) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width]
    rgb = np.zeros((height, width, 3), dtype=np.float32)
    rgb[..., 0] = xx / max(1, width - 1)
    rgb[..., 1] = yy / max(1, height - 1)
    rgb[..., 2] = 0.18 + 0.62 * ((xx // 16) % 2)
    rgb[20:75, 38:88] = np.array([0.72, 0.42, 0.29], dtype=np.float32)
    return np.clip(rgb, 0, 1)


def _save_rgb(path: Path, rgb: np.ndarray) -> None:
    image = Image.fromarray(np.rint(rgb * 255).astype(np.uint8), "RGB")
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        image.save(path, "JPEG", quality=88)
    else:
        image.save(path, "PNG")


def _peaked_histogram(peaks: list[int], width: float = 4.0) -> np.ndarray:
    hues = np.arange(360)
    result = np.zeros(360, dtype=np.float64)
    for peak in peaks:
        distance = np.abs((hues - peak + 180) % 360 - 180)
        result += np.exp(-(distance**2) / (2 * width**2))
    return result / result.sum()


class HarmonyTests(unittest.TestCase):
    def test_nine_rule_search_recognizes_synthetic_structures(self) -> None:
        cases = {
            "monochromatic": [17],
            "complementary": [17, 197],
            "triad": [17, 137, 257],
            "square": [17, 107, 197, 287],
        }
        for expected, peaks in cases.items():
            with self.subTest(expected=expected):
                detected = detect_harmony(_peaked_histogram(peaks))
                self.assertEqual(expected, detected["rule"])
                self.assertIn("weighted_hue_displacement", detected)
                self.assertLessEqual(abs((detected["anchor_hue"] - 17 + 180) % 360 - 180), 2)

    def test_harmony_is_deterministic(self) -> None:
        histogram = _peaked_histogram([33, 183, 243])
        self.assertEqual(detect_harmony(histogram), detect_harmony(histogram.copy()))


class PhotoDNATests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image = self.root / "proxy.png"
        _save_rgb(self.image, _synthetic_rgb())

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_analysis_has_required_color_tone_texture_palette_and_anchors(self) -> None:
        dna = analyze_photo(self.image)
        self.assertEqual(360, len(dna["color"]["hue_histogram_360"]))
        self.assertTrue(dna["color"]["oklch_palette"])
        self.assertIn(dna["harmony"]["rule"], {name for name, _ in __import__("creative_engine").HARMONY_RULES})
        self.assertIn("percentiles", dna["tone"])
        self.assertIn("laplacian_variance", dna["texture"])
        self.assertTrue(dna["visual_anchors"])

    def test_source_digest_and_photodna_are_deterministic(self) -> None:
        first = analyze_photo(self.image, protected_people=True)
        second = analyze_photo(self.image, protected_people=True)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))

    def test_explicit_people_boxes_are_normalized(self) -> None:
        dna = analyze_photo(
            self.image,
            protected_people=[{"x": 32, "y": 16, "width": 50, "height": 70, "units": "pixels"}],
        )
        people = dna["protected_people"]
        self.assertTrue(people["enabled"])
        self.assertEqual("explicit_boxes", people["source"])
        self.assertAlmostEqual(32 / 128, people["boxes"][0]["x"], places=5)

    def test_semantic_hints_persist_deterministically_and_guide_routes(self) -> None:
        hints = {
            "subject": "solitary cyclist",
            "scene": "foggy bridge",
            "mood": ["quiet", "uncanny"],
            "lighting": "diffuse backlight",
            "materials": ["wet steel", "mist"],
            "confidence": 0.91,
            "preserve": ["green fog cast"],
            "amplify": ["silhouette separation"],
            "break": ["duotone violet and acid yellow"],
        }
        first = create_session(self.image, semantic_hints=hints)
        second = create_session(self.image, semantic_hints=hints)
        self.assertEqual(first["photo_dna"]["semantics"], second["photo_dna"]["semantics"])
        self.assertEqual(first["candidates"][2]["rationale"], second["candidates"][2]["rationale"])
        self.assertIn("duotone_palette_compression", first["candidates"][2]["logic"])
        self.assertIn("green fog cast", json.dumps(first["candidates"][0]["rationale"]))

    def test_conflicting_semantics_change_operator_graph_and_recipes(self) -> None:
        warm = create_session(
            self.image,
            semantic_hints={
                "subject": "child portrait",
                "lighting": "golden warm backlight",
                "mood": "luminous joyful",
                "materials": ["soft skin"],
                "preserve": ["warm skin"],
                "amplify": ["golden rim light"],
                "break": ["duotone"],
            },
        )
        cold = create_session(
            self.image,
            semantic_hints={
                "subject": "steel bridge",
                "lighting": "cold cyan storm light",
                "mood": "dark ominous",
                "materials": ["rough metal"],
                "preserve": ["cold steel"],
                "amplify": ["cyan silhouette"],
                "break": ["low-key shadow swallowing"],
            },
        )
        for index in (0, 1, 2):
            self.assertNotEqual(warm["candidates"][index]["operator_graph"], cold["candidates"][index]["operator_graph"])
            self.assertNotEqual(warm["candidates"][index]["lr_recipe"], cold["candidates"][index]["lr_recipe"])

    def test_live_target_filename_can_be_preserved_when_proxy_is_temporary(self) -> None:
        session = create_session(self.image, filename="IMG_0001.CR3")
        self.assertEqual("IMG_0001.CR3", session["target"]["filename"])
        self.assertEqual(self.image.name, session["photo_dna"]["proxy"]["filename"])


class CandidateAndPreviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image = self.root / "proxy.png"
        self.rgb = _synthetic_rgb()
        _save_rgb(self.image, self.rgb)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_three_candidates_are_structurally_and_visually_distinct(self) -> None:
        dna = analyze_photo(self.image)
        candidates = build_candidates(dna)
        self.assertEqual(["native", "amplify", "break"], [item["candidate_id"] for item in candidates])
        op_signatures = [tuple(op["op"] for op in item["offline_ops"]) for item in candidates]
        self.assertEqual(3, len(set(op_signatures)))
        rendered = [render_candidate(self.rgb, item, dna, item["intensity"]["default"], 123) for item in candidates]
        distances = [float(np.mean(np.abs(rendered[a] - rendered[b]))) for a, b in ((0, 1), (0, 2), (1, 2))]
        self.assertTrue(all(distance > 0.015 for distance in distances), distances)
        self.assertTrue(any(risk["kind"] == "intentional" and risk["code"] == "intentional_artifact" for risk in candidates[2]["risks"]))
        intentional = next(risk for risk in candidates[2]["risks"] if risk["code"] == "intentional_artifact")
        self.assertEqual(
            {"purpose", "scope", "expected_signature", "people_impact"},
            set(intentional["artifact"]),
        )

    def test_zero_percent_is_baseline_and_over_100_extrapolates(self) -> None:
        dna = analyze_photo(self.image)
        candidate = build_candidates(dna)[1]
        zero = render_candidate(self.rgb, candidate, dna, 0.0, 7)
        hundred = render_candidate(self.rgb, candidate, dna, 100.0, 7)
        extreme = render_candidate(self.rgb, candidate, dna, 180.0, 7)
        self.assertLess(float(np.max(np.abs(zero - self.rgb))), 2e-5)
        self.assertGreater(float(np.mean(np.abs(extreme - self.rgb))), float(np.mean(np.abs(hundred - self.rgb))))

    def test_render_cache_hits_and_keys_are_deterministic(self) -> None:
        session = create_session(self.image)
        output = self.root / "previews"
        first = render_session(session, self.image, output, long_edge=512)
        self.assertFalse(first["native"]["cache_hit"])
        self.assertTrue(Path(first["contact_sheet"]).exists())
        second = render_session(session, self.image, output, long_edge=512)
        self.assertTrue(all(second[key]["cache_hit"] for key in ("native", "amplify", "break")))
        self.assertEqual(first["native"]["cache_key"], second["native"]["cache_key"])
        with Image.open(first["contact_sheet"]) as sheet, Image.open(first["native"]["path"]) as preview:
            self.assertGreater(sheet.width, preview.width * 3)
            expected_card_width = round(preview.width * min(720, preview.height) / preview.height)
            self.assertLess(abs(sheet.width - expected_card_width * 4 - 8 * 3), 8)

    def test_selection_requires_exact_reviewed_strength_and_hash(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "reviewed", long_edge=512)
        with self.assertRaisesRegex(SessionValidationError, "not previewed"):
            select_candidate(session, "native", 100)
        session["previews"]["native"]["recipe_hash"] = "wrong"
        with self.assertRaisesRegex(SessionValidationError, "recipe_hash"):
            select_candidate(session, "native")

    def test_selection_rejects_state_without_preview_artifacts(self) -> None:
        session = create_session(self.image)
        session["execution"]["state"] = "PREVIEWED"
        session["execution"]["state_history"].append("PREVIEWED")
        with self.assertRaisesRegex(SessionValidationError, "rendered preview"):
            select_candidate(session, "break", 200)

    def test_people_region_plan_participates_in_preview_cache_key(self) -> None:
        left = create_session(
            self.image,
            protected_people=[{"x": 0.10, "y": 0.10, "width": 0.30, "height": 0.70}],
        )
        right = create_session(
            self.image,
            protected_people=[{"x": 0.60, "y": 0.10, "width": 0.30, "height": 0.70}],
        )
        output = self.root / "region-cache"
        left_manifest = render_session(left, self.image, output, long_edge=512)
        right_manifest = render_session(right, self.image, output, long_edge=512)
        self.assertNotEqual(left_manifest["break"]["cache_key"], right_manifest["break"]["cache_key"])
        self.assertFalse(right_manifest["break"]["cache_hit"])

    def test_preview_cache_does_not_cross_requested_dimensions(self) -> None:
        large = self.root / "large.png"
        _save_rgb(large, _synthetic_rgb(900, 600))
        session = create_session(large)
        output = self.root / "sized-previews"
        small = render_session(session, large, output, long_edge=512)
        larger = render_session(session, large, output, long_edge=700)
        self.assertNotEqual(small["native"]["cache_key"], larger["native"]["cache_key"])
        self.assertFalse(larger["native"]["cache_hit"])

    def test_preview_qc_marks_nonfinite_render_as_unexpected(self) -> None:
        session = create_session(self.image)
        session["candidates"][0]["offline_ops"].append(
            {"op": "channel_matrix", "matrix": [[float("nan"), 0, 0], [0, 1, 0], [0, 0, 1]]}
        )
        manifest = render_session(session, self.image, self.root / "qc-previews", long_edge=512)
        codes = {risk["code"] for risk in manifest["native"]["detected_risks"]}
        self.assertIn("preview_nonfinite", codes)
        self.assertTrue(any(risk["kind"] == "unexpected" for risk in session["candidates"][0]["risks"]))
        cached = render_session(session, self.image, self.root / "qc-previews", long_edge=512)
        cached_codes = {risk["code"] for risk in cached["native"]["detected_risks"]}
        self.assertTrue(cached["native"]["cache_hit"])
        self.assertIn("preview_nonfinite", cached_codes)

    def test_people_protection_preserves_box_more_than_environment(self) -> None:
        box = {"x": 38 / 128, "y": 20 / 96, "width": 50 / 128, "height": 55 / 96}
        dna = analyze_photo(self.image, protected_people=[box])
        break_candidate = build_candidates(dna)[2]
        rendered = render_candidate(self.rgb, break_candidate, dna, 180.0, 101)
        difference = np.mean(np.abs(rendered - self.rgb), axis=2)
        inside = difference[30:65, 48:78].mean()
        outside = np.concatenate((difference[:15].ravel(), difference[:, :20].ravel())).mean()
        self.assertLess(inside, outside * 0.72)
        self.assertTrue(break_candidate["people_protection"]["required"])

    def test_declared_person_without_usable_mask_is_blocked_by_qc(self) -> None:
        blue = self.root / "blue.png"
        _save_rgb(blue, np.full((64, 80, 3), [0.02, 0.08, 0.65], dtype=np.float32))
        session = create_session(blue, protected_people=True)
        manifest = render_session(session, blue, self.root / "blue-previews", long_edge=256)
        codes = {risk["code"] for risk in manifest["native"]["detected_risks"]}
        self.assertIn("preview_people_mask_empty", codes)
        with self.assertRaises(SessionValidationError):
            select_candidate(session, "native")

    def test_unexpected_risk_allows_diagnostic_render_but_blocks_selection(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "previews", long_edge=512)
        bad = copy.deepcopy(session)
        bad["candidates"][2]["risks"].append({"kind": "unexpected", "code": "mask_leak", "message": "unplanned"})
        with self.assertRaises(SessionValidationError):
            select_candidate(bad, "break")
        diagnostic = render_candidate(self.rgb, bad["candidates"][2], bad["photo_dna"], 100, 1)
        self.assertEqual(self.rgb.shape, diagnostic.shape)


class GradeSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image = self.root / "proxy.png"
        _save_rgb(self.image, _synthetic_rgb(64, 48))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_state_machine_and_source_guard(self) -> None:
        session = create_session(
            self.image,
            photo_id="photo-7",
            source_digest_override="stable-lightroom-identity-digest",
            baseline_edit_digest="base-9",
        )
        self.assertEqual("ANALYZED", session["execution"]["state"])
        self.assertEqual("stable-lightroom-identity-digest", session["target"]["source_digest"])
        self.assertNotEqual(session["target"]["source_digest"], session["target"]["proxy_digest"])
        self.assertEqual(session["target"]["proxy_digest"], session["photo_dna"]["source_digest"])
        render_session(session, self.image, self.root / "previews", strengths={"break": 170}, long_edge=256)
        select_candidate(session, "break", 170)
        self.assertEqual("SELECTED", session["execution"]["state"])
        self.assertEqual("break", session["execution"]["desired"]["candidate_id"])
        validate_session(session, image_path=self.image)
        changed = self.root / "changed.png"
        _save_rgb(changed, np.zeros((48, 64, 3), dtype=np.float32))
        with self.assertRaises(SessionValidationError):
            validate_session(session, image_path=changed)

    def test_illegal_state_history_is_rejected(self) -> None:
        session = create_session(self.image)
        session["execution"]["state"] = "DONE"
        session["execution"]["state_history"].append("DONE")
        with self.assertRaises(SessionValidationError):
            validate_session(session)

    def test_incomplete_intentional_artifact_metadata_is_rejected(self) -> None:
        session = create_session(self.image)
        artifact_risk = next(risk for risk in session["candidates"][2]["risks"] if risk["code"] == "intentional_artifact")
        del artifact_risk["artifact"]["people_impact"]
        with self.assertRaises(SessionValidationError):
            validate_session(session)

    def test_collect_is_explicit_and_requires_verified_readback(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "previews", long_edge=256)
        select_candidate(session, "native")
        library = self.root / "library"
        self.assertFalse(library.exists())
        with self.assertRaises(SessionValidationError):
            collect_style(session, library)
        self.assertFalse(library.exists())

    def test_explicit_collect_saves_recipe_dna_preview_and_readback(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "previews", strengths={"amplify": 112}, long_edge=256)
        select_candidate(session, "amplify", 112)
        session["execution"]["state_history"].extend(["SNAPSHOTTED", "APPLIED", "PERSON_PROTECTED", "VERIFIED"])
        session["execution"]["state"] = "VERIFIED"
        session["execution"]["person_protection"]["result"] = "not_required"
        session["execution"]["readback"] = {"contrast": {"value": 22.4, "status": "applied"}}
        entry = collect_style(session, self.root / "library", name="mist-study")
        self.assertTrue((entry / "style.json").exists())
        self.assertTrue((entry / "preview.jpg").exists())
        payload = json.loads((entry / "style.json").read_text(encoding="utf-8"))
        self.assertEqual("amplify", payload["selection"]["candidate_id"])
        self.assertIn("photo_dna", payload)
        self.assertEqual(session["execution"]["readback"], payload["readback"])

    def test_recipe_hash_changes_with_strength(self) -> None:
        candidate = create_session(self.image)["candidates"][0]
        self.assertNotEqual(recipe_hash(candidate, 80), recipe_hash(candidate, 81))

    def test_atomic_session_save_increments_revision_and_rejects_stale_writer(self) -> None:
        destination = self.root / "grade-session.json"
        session = create_session(self.image)
        save_session(session, destination)
        self.assertEqual(0, session["revision"])
        first = load_session(destination)
        stale = load_session(destination)
        render_session(first, self.image, self.root / "atomic-previews", long_edge=256)
        save_session(first, destination, expected_revision=0)
        self.assertEqual(1, first["revision"])
        render_session(stale, self.image, self.root / "stale-previews", long_edge=256)
        with self.assertRaisesRegex(SessionValidationError, "stale GradeSession revision"):
            save_session(stale, destination, expected_revision=0)
        self.assertTrue(destination.with_suffix(".json.bak").exists())

    def test_post_protection_digest_is_reacquired_and_used_for_readback(self) -> None:
        session = create_session(
            self.image,
            photo_id="photo-7",
            source_digest_override="stable-lightroom-identity-digest",
            baseline_edit_digest="base-9",
        )
        session["execution"]["transaction_id"] = "tx-7"
        session["execution"]["readback"] = {"baseline_edit_digest": "after-global-grade"}
        current = {
            "photo_id": "photo-7",
            "filename": self.image.name,
            "source_digest": "stable-lightroom-identity-digest",
            "baseline_edit_digest": "after-person-mask",
        }
        with mock.patch.object(creative_grade, "_call_bridge", return_value=current):
            digest = creative_grade._capture_post_protection_digest(session)
        session["execution"]["person_protection"]["post_edit_digest"] = digest
        reference = creative_grade._transaction_reference(session)
        self.assertEqual("after-person-mask", reference["expected_current_edit_digest"])

    def test_post_protection_digest_rejects_changed_target_identity(self) -> None:
        session = create_session(
            self.image,
            photo_id="photo-7",
            source_digest_override="stable-lightroom-identity-digest",
            baseline_edit_digest="base-9",
        )
        changed = {
            "photo_id": "different-photo",
            "filename": self.image.name,
            "source_digest": "stable-lightroom-identity-digest",
            "baseline_edit_digest": "after-person-mask",
        }
        with mock.patch.object(creative_grade, "_call_bridge", return_value=changed):
            with self.assertRaisesRegex(SessionValidationError, "photo_id"):
                creative_grade._capture_post_protection_digest(session)

    def test_legacy_migration_revokes_unreviewed_selection(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "legacy-previews", long_edge=256)
        select_candidate(session, "native")
        session["selection"]["requested_strength"] = 100.0
        session["execution"]["desired"]["requested_strength"] = 100.0
        session["execution"]["desired"]["strength_factor"] = 1.0
        session["execution"]["desired"]["recipe_hash"] = recipe_hash(session["candidates"][0], 100.0)
        result = migrate_preview_contract(session)
        self.assertEqual("PREVIEWED", result["state"])
        self.assertIsNone(session["selection"])
        self.assertEqual({}, session["execution"]["desired"])

    def test_legacy_migration_records_preview_artifact_digest(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "legacy-digest", long_edge=256)
        del session["previews"]["native"]["artifact_digest"]
        result = migrate_preview_contract(session)
        self.assertTrue(any("artifact_digest" in change for change in result["changes"]))
        validate_session(session)

    def test_parameter_compiler_obeys_zero_design_and_extrapolated_strength(self) -> None:
        specs = {
            "contrast": {"operation": "delta", "value": 20.0, "interpolation": "linear"},
            "color_grade_shadow_hue": {"operation": "target", "value": 10.0, "interpolation": "circular_degrees"},
            "color_grade_shadow_saturation": {"operation": "target", "value": 30.0, "interpolation": "linear"},
        }
        baseline = {"contrast": 5.0, "color_grade_shadow_hue": 350.0, "color_grade_shadow_saturation": 10.0}
        self.assertEqual(baseline, compile_lr_parameters(specs, baseline, 0))
        hundred = compile_lr_parameters(specs, baseline, 100)
        self.assertEqual(25.0, hundred["contrast"])
        self.assertEqual(10.0, hundred["color_grade_shadow_hue"])
        self.assertEqual(30.0, hundred["color_grade_shadow_saturation"])
        two_hundred = compile_lr_parameters(specs, baseline, 200)
        self.assertEqual(45.0, two_hundred["contrast"])
        self.assertEqual(30.0, two_hundred["color_grade_shadow_hue"])
        self.assertEqual(50.0, two_hundred["color_grade_shadow_saturation"])

    def test_applied_cannot_skip_person_protected_audit_state(self) -> None:
        session = create_session(self.image)
        render_session(session, self.image, self.root / "previews", long_edge=256)
        select_candidate(session, "native")
        session["execution"]["state_history"].extend(["SNAPSHOTTED", "APPLIED", "VERIFIED"])
        session["execution"]["state"] = "VERIFIED"
        with self.assertRaises(SessionValidationError):
            validate_session(session)


class CreativeScenarioTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _scenes(self) -> list[tuple[str, np.ndarray, bool]]:
        height, width = 72, 96
        yy, xx = np.mgrid[0:height, 0:width]
        fog = np.stack([0.58 + xx / width * 0.08, 0.62 + yy / height * 0.06, np.full_like(xx, 0.64, dtype=float)], axis=-1)
        architecture = np.full((height, width, 3), 0.10, dtype=float)
        architecture[:, ::12] = 0.94
        architecture[::12, :] = [0.95, 0.65, 0.10]
        neon = np.full((height, width, 3), 0.025, dtype=float)
        neon[8:34, 8:44] = [0.02, 0.85, 0.95]
        neon[32:65, 46:89] = [0.98, 0.02, 0.67]
        portrait = np.full((height, width, 3), [0.025, 0.035, 0.06], dtype=float)
        portrait[13:65, 31:67] = [0.58, 0.30, 0.20]
        portrait[18:32, 38:60] = [0.74, 0.46, 0.32]
        pregraded = np.zeros((height, width, 3), dtype=float)
        pregraded[..., 0] = np.where(xx < width / 2, 0.05, 0.90)
        pregraded[..., 1] = 0.34 + yy / height * 0.20
        pregraded[..., 2] = np.where(xx < width / 2, 0.62, 0.06)
        return [
            ("fog", np.clip(fog, 0, 1), False),
            ("hard-light-architecture", architecture, False),
            ("neon-night", neon, False),
            ("low-key-portrait", portrait, True),
            ("pregraded-jpeg", pregraded, False),
        ]

    def test_five_scene_classes_get_distinct_routes(self) -> None:
        for name, rgb, people in self._scenes():
            with self.subTest(scene=name):
                suffix = ".jpg" if name == "pregraded-jpeg" else ".png"
                path = self.root / f"{name}{suffix}"
                _save_rgb(path, rgb)
                boxes = [{"x": 31 / 96, "y": 13 / 72, "width": 36 / 96, "height": 52 / 72}] if people else False
                dna = analyze_photo(path, protected_people=boxes)
                candidates = build_candidates(dna)
                signatures = {tuple(operation["op"] for operation in candidate["offline_ops"]) for candidate in candidates}
                self.assertEqual(3, len(signatures))
                rendered = [
                    render_candidate(rgb.astype(np.float32), candidate, dna, candidate["intensity"]["default"], 55)
                    for candidate in candidates
                ]
                for left, right in ((0, 1), (0, 2), (1, 2)):
                    self.assertGreater(float(np.mean(np.abs(rendered[left] - rendered[right]))), 0.004)
                if people:
                    self.assertTrue(all(candidate["people_protection"]["required"] for candidate in candidates))


if __name__ == "__main__":
    unittest.main()
