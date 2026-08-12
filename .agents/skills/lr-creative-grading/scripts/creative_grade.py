#!/usr/bin/env python3
"""Command-line entry point for creative PhotoDNA grading sessions."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

if __package__:
    from .creative_engine import (
        SessionValidationError,
        collect_style,
        create_session,
        load_session,
        migrate_preview_contract,
        render_session,
        save_session,
        select_candidate,
        validate_session,
    )
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from creative_engine import (  # type: ignore[no-redef]
        SessionValidationError,
        collect_style,
        create_session,
        load_session,
        migrate_preview_contract,
        render_session,
        save_session,
        select_candidate,
        validate_session,
    )


def _people_value(args: argparse.Namespace) -> bool | list[dict[str, Any]]:
    if args.people_boxes:
        source = args.people_boxes
        path = Path(source)
        try:
            is_file = path.is_file()
        except OSError:
            is_file = False
        text = path.read_text(encoding="utf-8") if is_file else source
        decoded = json.loads(text)
        if not isinstance(decoded, list):
            raise ValueError("--people-boxes must decode to a JSON list")
        return decoded
    return bool(args.protected_people)


def _semantic_value(source: str | None) -> dict[str, Any] | None:
    if source is None:
        return None
    path = Path(source)
    try:
        is_file = path.is_file()
    except OSError:
        is_file = False
    decoded = json.loads(path.read_text(encoding="utf-8") if is_file else source)
    if not isinstance(decoded, dict):
        raise ValueError("--semantic-hints must decode to a JSON object")
    return decoded


def _dump(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _bridge_cli() -> Path:
    repository_root = Path(__file__).resolve().parents[4]
    return repository_root / "lightroom-bridge" / "src" / "bridge-cli.mjs"


def _call_bridge(method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    cli = _bridge_cli()
    if not cli.is_file():
        raise OSError(f"Lightroom bridge CLI is missing: {cli}")
    completed = subprocess.run(
        ["node", str(cli), method],
        input=json.dumps(payload or {}, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=60,
    )
    output = completed.stdout.strip() or completed.stderr.strip()
    decoded = json.loads(output) if output else {}
    if completed.returncode != 0 or not decoded.get("ok"):
        error = decoded.get("error", {})
        raise OSError(f"{error.get('code', 'BRIDGE_ERROR')}: {error.get('message', output)}")
    return decoded["result"]


def _merge_execution_patch(session: dict[str, Any], patch: dict[str, Any]) -> None:
    execution = session["execution"]
    transaction_id = patch.get("transaction_id")
    if execution.get("transaction_id") not in {None, transaction_id}:
        raise SessionValidationError("bridge execution_patch transaction_id differs from GradeSession")
    append = patch.get("state_history_append") or []
    allowed = {
        "SELECTED": ["SNAPSHOTTED", "APPLIED"],
        "SNAPSHOTTED": ["APPLIED"],
        "APPLIED": ["ROLLED_BACK"],
        "PERSON_PROTECTED": ["ROLLED_BACK"],
        "VERIFIED": ["ROLLED_BACK"],
    }
    if append and append != allowed.get(execution["state"]):
        raise SessionValidationError(f"invalid bridge state_history_append from {execution['state']}: {append}")
    for state in append:
        if state != execution["state"]:
            execution["state_history"].append(state)
            execution["state"] = state
    for field in ("transaction_id", "desired", "applied", "readback", "failures", "skipped", "unsupported", "bridge_state"):
        if field in patch:
            execution[field] = patch[field]
    if patch.get("state") == "ROLLED_BACK" and execution["state"] != "ROLLED_BACK":
        execution["state_history"].append("ROLLED_BACK")
        execution["state"] = "ROLLED_BACK"


def _transaction_reference(session: dict[str, Any]) -> dict[str, Any]:
    execution = session["execution"]
    reference: dict[str, Any] = {
        "transaction_id": execution["transaction_id"],
        "target": session["target"],
    }
    current_digest = execution.get("person_protection", {}).get("post_edit_digest")
    if not current_digest:
        current_digest = execution.get("readback", {}).get("baseline_edit_digest")
    if current_digest:
        reference["expected_current_edit_digest"] = current_digest
    return reference


def _record_person_stage(session: dict[str, Any]) -> None:
    execution = session["execution"]
    if execution["state"] != "APPLIED":
        raise SessionValidationError("person stage requires APPLIED")
    if execution["person_protection"].get("required"):
        raise SessionValidationError("person protection requires lr-color-grading before verification")
    execution["person_protection"]["result"] = "not_required"
    execution["state_history"].append("PERSON_PROTECTED")
    execution["state"] = "PERSON_PROTECTED"


def _capture_post_protection_digest(session: dict[str, Any]) -> str:
    current = _call_bridge("get_target_photo")
    expected = session["target"]
    for field in ("photo_id", "filename", "source_digest"):
        if str(current.get(field)) != str(expected.get(field)):
            raise SessionValidationError(f"Lightroom target changed before person-protection completion: {field}")
    digest = current.get("baseline_edit_digest")
    if not isinstance(digest, str) or not digest:
        raise SessionValidationError("Lightroom did not return the post-protection edit digest")
    return digest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze once, preview Native/Amplify/Break, select once, and hand a validated GradeSession to Lightroom."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    analyze = commands.add_parser("analyze", help="Create PhotoDNA, candidates, and an ANALYZED GradeSession.")
    analyze.add_argument("image", nargs="?", help="Lightroom JPEG proxy or ordinary RGB image.")
    analyze.add_argument("--session", required=True, help="Destination GradeSession JSON.")
    analyze.add_argument("--acquire-manifest", help="acquire.json produced by acquire-live; supplies the immutable proxy and live target fields.")
    analyze.add_argument("--filename", help="Original Lightroom filename when the analyzed proxy is a temporary JPEG.")
    analyze.add_argument("--photo-id", help="Lightroom target photo identifier.")
    analyze.add_argument(
        "--source-digest",
        help="Stable target identity digest from get_target_photo; proxy bytes retain a separate proxy_digest.",
    )

    doctor = commands.add_parser("doctor", help="Check bridge files and the live Lightroom plug-in without editing Lightroom.")
    doctor.add_argument("--live", action="store_true", help="Require a running Lightroom plug-in and report capabilities.")

    acquire = commands.add_parser("acquire-live", help="Acquire an identity-bound Lightroom proxy into a session workspace.")
    acquire.add_argument("--workspace", required=True, help="New GradeSession workspace directory.")
    acquire.add_argument("--long-edge", type=int, default=2048)
    analyze.add_argument("--baseline-edit-digest", help="Digest of Lightroom settings visible at acquisition.")
    analyze.add_argument("--protected-people", action="store_true", help="Enable conservative global skin protection.")
    analyze.add_argument(
        "--people-boxes",
        help='JSON file or JSON list of {"x","y","width","height", "units":"normalized|pixels"}.',
    )
    analyze.add_argument(
        "--semantic-hints",
        help="JSON file or inline object with subject/scene/mood/lighting/materials/confidence/preserve/amplify/break.",
    )

    render = commands.add_parser("render", help="Render three cached candidates and make a baseline-plus-three contact sheet.")
    render.add_argument("session", help="ANALYZED GradeSession JSON (updated in place).")
    render.add_argument("image", help="Same source proxy used by analyze.")
    render.add_argument("--output-dir", required=True, help="Preview and cache destination.")
    render.add_argument("--native", type=float, help="Native strength, 0..200.")
    render.add_argument("--amplify", type=float, help="Amplify strength, 0..200.")
    render.add_argument("--break-strength", type=float, help="Break strength, 0..200.")
    render.add_argument("--long-edge", type=int, default=1800)

    select = commands.add_parser("select", help="Record the sole user choice and compile desired Lightroom work.")
    select.add_argument("session", help="PREVIEWED GradeSession JSON (updated in place).")
    select.add_argument("candidate", choices=("native", "amplify", "break"))
    select.add_argument("--strength", type=float, help="Chosen strength, 0..200; defaults to candidate design default.")

    validate = commands.add_parser("validate", help="Validate schema, target digest, risks, and state history.")
    validate.add_argument("session")
    validate.add_argument("--image", help="Optional analyzed proxy file whose digest must match target.proxy_digest.")

    collect = commands.add_parser("collect", help="Explicitly collect a verified result in the personal inspiration library.")
    collect.add_argument("session")
    collect.add_argument("--library", required=True)
    collect.add_argument("--name")

    apply = commands.add_parser("apply", help="Apply a SELECTED live GradeSession and merge its execution patch.")
    apply.add_argument("session")

    protect = commands.add_parser("protect-not-required", help="Record the mandatory no-person audit transition.")
    protect.add_argument("session")

    protected = commands.add_parser("protect", help="Record completed person protection after Lightroom local refinement.")
    protected.add_argument("session")
    protected.add_argument("--result", required=True, choices=("protected", "compensated", "verified"))
    protected.add_argument("--method", required=True)
    protected.add_argument("--mask-id")

    migrate = commands.add_parser("migrate", help="Upgrade a legacy preview manifest and revoke any unreviewed selection.")
    migrate.add_argument("session")

    verify = commands.add_parser("verify", help="Run the single public readback after PERSON_PROTECTED.")
    verify.add_argument("session")

    done = commands.add_parser("done", help="Finish a VERIFIED session after visual QC.")
    done.add_argument("session")

    rollback = commands.add_parser("rollback", help="Roll back an applied Lightroom transaction.")
    rollback.add_argument("session")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "doctor":
            checks = {
                "node": shutil.which("node") is not None,
                "bridge_cli": _bridge_cli().is_file(),
            }
            if args.live:
                checks["capabilities"] = _call_bridge("capabilities")
                checks["target"] = _call_bridge("get_target_photo")
            _dump({"ok": all(bool(value) for value in checks.values()), "checks": checks})
            return 0
        if args.command == "acquire-live":
            workspace = Path(args.workspace).resolve()
            source_dir = workspace / "source"
            source_dir.mkdir(parents=True, exist_ok=False)
            target = _call_bridge("get_target_photo")
            proxy = _call_bridge("get_proxy", {"long_edge": args.long_edge})
            if any(target[field] != proxy["target"][field] for field in ("photo_id", "filename", "source_digest", "baseline_edit_digest")):
                raise SessionValidationError("Lightroom target changed between identity and proxy acquisition")
            baseline = source_dir / "baseline.jpg"
            shutil.copy2(proxy["path"], baseline)
            manifest = {
                "target": target,
                "proxy_digest": proxy["proxy_digest"],
                "proxy_path": str(baseline),
                "live_applicable": True,
            }
            (workspace / "acquire.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            _dump(manifest)
            return 0
        if args.command == "analyze":
            if Path(args.session).exists():
                raise OSError(f"Refusing to overwrite existing GradeSession: {args.session}")
            acquired: dict[str, Any] | None = None
            if args.acquire_manifest:
                acquired = json.loads(Path(args.acquire_manifest).read_text(encoding="utf-8"))
                if not acquired.get("live_applicable"):
                    raise SessionValidationError("acquire manifest is not live-applicable")
            image = acquired["proxy_path"] if acquired else args.image
            if not image:
                raise ValueError("analyze requires image or --acquire-manifest")
            target = acquired["target"] if acquired else {}
            session = create_session(
                image,
                filename=target.get("filename") or args.filename,
                photo_id=target.get("photo_id") or args.photo_id,
                source_digest_override=target.get("source_digest") or args.source_digest,
                baseline_edit_digest=target.get("baseline_edit_digest") or args.baseline_edit_digest,
                protected_people=_people_value(args),
                semantic_hints=_semantic_value(args.semantic_hints),
            )
            save_session(session, args.session, expected_revision=-1)
            _dump(
                {
                    "state": session["execution"]["state"],
                    "session": str(Path(args.session).resolve()),
                    "source_digest": session["target"]["source_digest"],
                    "proxy_digest": session["target"]["proxy_digest"],
                    "harmony": session["photo_dna"]["harmony"],
                    "candidates": [candidate["candidate_id"] for candidate in session["candidates"]],
                }
            )
            return 0
        if args.command == "render":
            session = load_session(args.session)
            revision = int(session.get("revision", 0))
            strengths = {
                key: value
                for key, value in {
                    "native": args.native,
                    "amplify": args.amplify,
                    "break": args.break_strength,
                }.items()
                if value is not None
            }
            manifest = render_session(
                session,
                args.image,
                args.output_dir,
                strengths=strengths,
                long_edge=args.long_edge,
            )
            save_session(session, args.session, expected_revision=revision)
            _dump({"state": session["execution"]["state"], "previews": manifest})
            return 0
        if args.command == "select":
            session = load_session(args.session)
            revision = int(session.get("revision", 0))
            selection = select_candidate(session, args.candidate, args.strength)
            save_session(session, args.session, expected_revision=revision)
            _dump({"state": session["execution"]["state"], "selection": selection, "desired": session["execution"]["desired"]})
            return 0
        if args.command == "validate":
            session = load_session(args.session)
            warnings = validate_session(session, image_path=args.image)
            _dump({"valid": True, "state": session["execution"]["state"], "warnings": warnings})
            return 0
        if args.command == "collect":
            session = load_session(args.session)
            entry = collect_style(session, args.library, name=args.name)
            _dump({"collected": True, "entry": str(entry.resolve())})
            return 0
        if args.command == "apply":
            session = load_session(args.session)
            if not session["target"].get("live_applicable"):
                raise SessionValidationError("file-only GradeSession cannot be applied to Lightroom")
            response = _call_bridge("apply_transaction", session)
            _merge_execution_patch(session, response["execution_patch"])
            save_session(session, args.session, expected_revision=int(session.get("revision", 0)))
            _dump({"state": session["execution"]["state"], "transaction_id": session["execution"]["transaction_id"]})
            return 0
        if args.command == "protect-not-required":
            session = load_session(args.session)
            _record_person_stage(session)
            session["execution"]["person_protection"]["post_edit_digest"] = _capture_post_protection_digest(session)
            save_session(session, args.session, expected_revision=int(session.get("revision", 0)))
            _dump({"state": session["execution"]["state"], "result": "not_required"})
            return 0
        if args.command == "protect":
            session = load_session(args.session)
            if session["execution"]["state"] != "APPLIED":
                raise SessionValidationError("protect requires APPLIED")
            protection = session["execution"]["person_protection"]
            if not protection.get("required"):
                raise SessionValidationError("use protect-not-required for a confirmed no-person image")
            protection.update({
                "result": args.result,
                "method": args.method,
                "mask_id": args.mask_id,
                "post_edit_digest": _capture_post_protection_digest(session),
            })
            session["execution"]["state_history"].append("PERSON_PROTECTED")
            session["execution"]["state"] = "PERSON_PROTECTED"
            save_session(session, args.session, expected_revision=int(session.get("revision", 0)))
            _dump({"state": "PERSON_PROTECTED", "person_protection": protection})
            return 0
        if args.command == "migrate":
            path = Path(args.session)
            session = json.loads(path.read_text(encoding="utf-8"))
            revision = int(session.get("revision", 0))
            result = migrate_preview_contract(session)
            save_session(session, path, expected_revision=revision)
            _dump(result)
            return 0
        if args.command == "verify":
            session = load_session(args.session)
            if session["execution"]["state"] != "PERSON_PROTECTED":
                raise SessionValidationError("verify requires PERSON_PROTECTED")
            response = _call_bridge("readback", _transaction_reference(session))
            patch = response["execution_patch"]
            if not patch.get("readback_verified") or patch.get("required_predecessor") != "PERSON_PROTECTED":
                raise SessionValidationError("bridge readback did not provide the expected verification evidence")
            session["execution"]["readback"] = patch["readback"]
            session["execution"]["state_history"].append("VERIFIED")
            session["execution"]["state"] = "VERIFIED"
            save_session(session, args.session, expected_revision=int(session.get("revision", 0)))
            _dump({"state": "VERIFIED", "readback": session["execution"]["readback"]})
            return 0
        if args.command == "done":
            session = load_session(args.session)
            if session["execution"]["state"] != "VERIFIED":
                raise SessionValidationError("done requires VERIFIED")
            session["execution"]["state_history"].append("DONE")
            session["execution"]["state"] = "DONE"
            save_session(session, args.session, expected_revision=int(session.get("revision", 0)))
            _dump({"state": "DONE"})
            return 0
        if args.command == "rollback":
            session = load_session(args.session)
            response = _call_bridge("rollback", _transaction_reference(session))
            _merge_execution_patch(session, response["execution_patch"])
            save_session(session, args.session, expected_revision=int(session.get("revision", 0)))
            _dump({"state": session["execution"]["state"], "rollback": response})
            return 0
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError, SessionValidationError) as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
