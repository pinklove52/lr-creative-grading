---
name: lr-color-grading
description: Compatibility refinement entry for person protection, complex Lightroom masks, requested crop or healing, and precision finishing within an existing lr-creative-grading GradeSession. Use after global application when a person needs inverse compensation, an SDK-unsupported local edit is required, or the user asks to refine an already selected creative grade.
---

# LR 局部保护与精修兼容入口

Work inside an existing lr-creative-grading GradeSession. Do not reanalyze the photo, recommend new styles, rebuild Native/Amplify/Break candidates, or reapply the full global recipe.

## Required state

Read ../lr-creative-grading/references/session-schema.md and ../lr-creative-grading/references/risk-qc.md. For target and rollback rules, also read ../lr-creative-grading/references/bridge-protocol.md.

Require:

- a target bound by photo_id and baseline digest;
- a recorded selection;
- an APPLIED global transaction, unless the task is an explicitly scoped refinement of that same session;
- a snapshot or saved pre-edit settings;
- declared local work in execution.person_protection or the selected recipe.

If the session is missing or the target differs, return to lr-creative-grading. Do not infer a new target from the active window.

## Protect people as a hard default

When photo_dna.protected_people is present:

1. Inspect the applied result for credible skin gradients, facial depth, and skin texture.
2. Preserve a stylized hue when intentional, but prevent flat faces, broken gradients, posterization spill, lost eye/lip separation, and destructive texture.
3. If the global recipe already protects the person, record method global_recipe and result passed.
4. Otherwise create one inverse person-mask compensation. Correct only the damage caused by the global grade; do not neutralize the environment or turn the mask into a beauty retouch.
5. Inspect the mask boundary once at useful zoom and correct spill or seams.
6. Record PERSON_PROTECTED with mask identity, compensation settings, and verification evidence, then return control to lr-creative-grading for the single public readback and VERIFIED transition.

Semantic person judgment comes from the model and task context as well as deterministic image evidence. Never treat OpenCV face detection as the sole authority for whether protection is required.

For a confirmed no-person image, record required false and result not_required so the state machine can advance before public readback.

## Allowed local operations

Use this skill only for:

- person or subject masks;
- complex local brushes or gradients;
- healing when explicitly requested;
- composition crop when explicitly requested;
- a small precision correction needed to satisfy the selected design and its QC.

Preserve all crop, healing, lens correction, mask, and transform state that the session does not own.

## Control Lightroom semantically

Use the available Windows computer-control skill and follow its instructions.

- Reacquire the exact Lightroom window and verify the target before every local operation.
- Locate controls and masks by semantic labels and current visible state.
- Use direct set_value for numeric controls.
- Never traverse fields with Tab.
- Never reuse stale element indices, screenshot IDs, or coordinates after a panel, module, selection, or layout change.
- Do not stack speculative edits when a control cannot be identified reliably.

The bridge remains responsible for global settings and readback. UI work must not conceal a failed or partial bridge transaction.

## Verify and recover

Default to one fit-view check and one useful-zoom check. Compare the local result with the candidate intent and its declared artifacts. Record mask spill, halos, banding, skin failure, or an unrequested structural change as unexpected.

Update GradeSession with:

- local operation and owning intent;
- exact target and mask identity;
- requested and observed result;
- person-protection status;
- warnings and unexpected findings;
- rollback outcome when needed.

Roll back when the target changed, the mask cannot be bounded, an unexpected artifact remains, or the selected look is no longer represented. Do not export, overwrite, delete, batch-sync, change metadata, or collect the style unless separately and explicitly requested. Collection is performed only by the lr-creative-grading collect command after the user says “收藏”.
