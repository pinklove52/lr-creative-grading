---
name: lr-color-grading-flash1
description: Compatibility executor for applying an already selected lr-creative-grading GradeSession through one hardened Lightroom bridge transaction with embedded value verification, without reanalyzing or recommending styles. Use only when the user explicitly asks for Flash1 or explicitly asks to apply an already SELECTED GradeSession; do not use for generic faster grading or before selection.
---

# LR 调色高速执行兼容入口

Consume shared state; do not create a second workflow. Require a validated GradeSession in SELECTED. If it is absent or only PREVIEWED, route back to lr-creative-grading instead of analyzing the photo or recommending styles again.

## Load the execution contract

Read:

- ../lr-creative-grading/references/session-schema.md;
- ../lr-creative-grading/references/bridge-protocol.md;
- ../lr-creative-grading/references/parameter-mapping.md;
- ../lr-creative-grading/references/risk-qc.md.

Resolve ../lr-creative-grading/scripts/creative_grade.py from this SKILL.md directory. Validate before execution, then use its apply command; do not call the bridge with an ad hoc wrapper.

The existing selection is the one user approval. Do not ask for separate Basic, Color, Effects, preset, or strength confirmations.

## Apply one global transaction

1. Read capabilities and get_target_photo.
2. Match photo_id, filename, source_digest when available, and baseline_edit_digest to GradeSession.
3. Require the exact selected candidate, strength, recipe hash, preview artifact digest, and live-applicable target. Reject unknown, out-of-range, unsupported, undeclared, or unreviewed work before any write.
4. Read the sparse baseline settings that the selected recipe owns.
5. Submit one apply_transaction containing the snapshot request, optional preset UUID, and complete dynamic parameter group.
6. Let the apply command validate and merge the transaction execution_patch, then atomically persist SNAPSHOTTED and APPLIED. Never edit GradeSession JSON directly.
7. Record the apply_transaction response's embedded immediate value check while keeping desired, applied, and readback values separate. Do not call the public readback tool yet, because the shared session must pass through PERSON_PROTECTED first.
8. If any parameter partially fails, the target changes, or the embedded check differs outside tolerance, roll back and record ROLLED_BACK.
9. Return at APPLIED and hand person protection or the no-person not_required transition to the lr-creative-grading orchestrator. After PERSON_PROTECTED, the orchestrator calls public readback once for final VERIFIED state.

Use the current visible Lightroom edit as baseline. Do not reset profile, white balance, exposure, curve, crop, grain, lens correction, or any other existing choice merely to establish a neutral base.

## Minimal UI fallback

The bridge is the default for global parameters. A very small operation may use Computer Use only when the selected candidate already declared an allowed ui_fallback and bridge preflight identified it before the transaction.

- Discover the named control semantically and use direct set_value.
- Never traverse numeric fields with Tab.
- Never drag color wheels or unnamed sliders.
- Never reuse an element index, screenshot identifier, or coordinate after state changes.
- Never use UI entry to conceal an unknown parameter, partial transaction, or failed readback.

Person and subject masks, complex brushes, healing, and requested composition crop belong to lr-color-grading.

## Safety and output

- Keep all changes non-destructive and rollback-capable.
- Preserve fields absent from the sparse recipe.
- Do not export, batch-sync, overwrite, collect, delete, or change metadata.
- Do not add a style to the inspiration library unless the user explicitly says “收藏”.
- A declared intentional artifact is allowed; an unexpected artifact or execution failure requires rollback.

Return the GradeSession path, transaction ID, snapshot ID, applied/embedded-check table, failures, rollback status, and remaining person-protection work.
