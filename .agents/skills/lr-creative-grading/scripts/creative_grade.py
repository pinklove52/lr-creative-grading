#!/usr/bin/env python3
"""Command-line entry point for creative PhotoDNA grading sessions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if __package__:
    from .creative_engine import (
        SessionValidationError,
        collect_style,
        create_session,
        load_session,
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


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze once, preview Native/Amplify/Break, select once, and hand a validated GradeSession to Lightroom."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    analyze = commands.add_parser("analyze", help="Create PhotoDNA, candidates, and an ANALYZED GradeSession.")
    analyze.add_argument("image", help="Lightroom JPEG proxy or ordinary RGB image.")
    analyze.add_argument("--session", required=True, help="Destination GradeSession JSON.")
    analyze.add_argument("--filename", help="Original Lightroom filename when the analyzed proxy is a temporary JPEG.")
    analyze.add_argument("--photo-id", help="Lightroom target photo identifier.")
    analyze.add_argument(
        "--source-digest",
        help="Stable target identity digest from get_target_photo; proxy bytes retain a separate proxy_digest.",
    )
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

    render = commands.add_parser("render", help="Render three cached previews concurrently and make a contact sheet.")
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "analyze":
            session = create_session(
                args.image,
                filename=args.filename,
                photo_id=args.photo_id,
                source_digest_override=args.source_digest,
                baseline_edit_digest=args.baseline_edit_digest,
                protected_people=_people_value(args),
                semantic_hints=_semantic_value(args.semantic_hints),
            )
            save_session(session, args.session)
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
            save_session(session, args.session)
            _dump({"state": session["execution"]["state"], "previews": manifest})
            return 0
        if args.command == "select":
            session = load_session(args.session)
            selection = select_candidate(session, args.candidate, args.strength)
            save_session(session, args.session)
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
    except (OSError, ValueError, KeyError, json.JSONDecodeError, SessionValidationError) as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
