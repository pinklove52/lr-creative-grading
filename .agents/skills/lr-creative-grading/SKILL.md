---
name: lr-creative-grading
description: Orchestrate photo-native creative Lightroom grading from one PhotoDNA analysis through Native, Amplify, and Break previews, one user choice, transactional application, person protection, readback, and rollback. Use when the user wants a photo-specific look, bold or extreme color reconstruction, a three-way preview, or an end-to-end reversible creative grade without contest rules or automatic normalization.
---

# Lightroom 内生创意调色

Treat the Lightroom result the user currently sees as the creative baseline. Preserve its useful bias, contrast, grain, and exposure tendency. Do not normalize the image, impose contest rules, or force a conventionally reasonable result unless the user explicitly asks.

## Load the contract

Read references/session-schema.md for every run. Read references/creative-operators.md before producing candidates and references/risk-qc.md before preview or application. For live Lightroom work, also read references/bridge-protocol.md and references/parameter-mapping.md.

Use scripts/creative_grade.py as the single CLI entry:

- doctor: verify the bundled bridge and, with --live, the running Lightroom plug-in;
- acquire-live: pin target identity and copy the current-render proxy into a new session workspace;
- analyze: create PhotoDNA once, merge model semantics through --semantic-hints, and advance ACQUIRE to ANALYZED;
- render: compile and cache Native, Amplify, and Break previews, then advance to PREVIEWED;
- select: record the one user decision and requested 0–200% strength;
- apply, protect/protect-not-required, verify, done, and rollback: own every live state transition and merge; never hand-edit GradeSession JSON;
- migrate: normalize legacy preview hashes/digests and revoke an old selection when its exact strength was never previewed;
- validate: check the shared GradeSession at every handoff;
- collect: save to the inspiration library only when the user explicitly says “收藏” or makes an equally direct save-to-library request.

The processing core is scripts/creative_engine.py. Never replace it with a per-photo hard-coded preview script.

## Run one coordinated workflow

1. Resolve creative_grade.py from this SKILL.md directory, not from the process working directory. Run doctor --live and acquire-live for live Lightroom work, then pass its acquire.json through analyze --acquire-manifest. Treat the copied source/baseline.jpg as immutable. Otherwise use the supplied local image and keep the session file-only. Never bind a file-only session to the current Lightroom photo later.
2. Before analyze, write compact JSON semantic hints for subject, scene, mood, lighting, and materials from the model and task context, and pass them through analyze --semantic-hints. Pass model/context person judgment separately through --protected-people or --people-boxes so it is written into photo_dna.protected_people. Build one PhotoDNA covering semantics, tone, color, texture, natural harmony, visual anchors, and protected people. OpenCV face detection is never the sole authority. Separate visible evidence from inference. Do not restart analysis at later stages.
3. Compile semantic hints into the persisted creative_intent and operator_graph, then generate exactly three complete candidates in parallel:
   - Native organizes and extends the image's existing language.
   - Amplify strengthens its most distinctive relationship.
   - Break reconstructs the image with a structurally justified extreme operator.
4. Give every candidate its own design strength, offline_ops, lr_recipe, preview fidelity, risks, and person-protection intent. Break must not be merely a stronger Amplify.
5. Render equal-size, long-edge 1800 px previews and a contact sheet containing Baseline, Native, Amplify, and Break. Persist the canonical recipe_hash, renderer hash, and preview artifact digest separately. Label the result as an offline approximation when Adobe did not render it.
6. Present all three candidates together and ask for one choice or an exact 0–200% strength. Before that response, stop at PREVIEWED and do not touch Lightroom. Selection is valid only when that exact candidate/strength/hash/artifact was rendered and passed preview QC. If strength changes, rerender before selecting.
7. Validate target identity, baseline digest, module, capabilities, ranges, and risks. Refuse unknown, out-of-range, or unsupported parameters; never silently clamp or skip them.
8. Run the apply command so it creates a snapshot, applies the complete dynamic recipe in one transaction, validates and merges execution_patch, and atomically persists the incremented session revision. Do not use an ad hoc bridge_call script or edit state_history directly.
9. Protect every detected or declared person. First constrain the compiled global recipe; if that cannot preserve credible skin gradients, face depth, and texture, perform one inverse person-mask compensation through lr-color-grading. Record PERSON_PROTECTED, or record not_required when PhotoDNA establishes that no person is present.
10. After PERSON_PROTECTED, run verify once, inspect the rendered result with at most two default visual checks, then run done. Intentional artifacts may remain; unexpected artifacts must be corrected or rolled back through the rollback command.

## Respect creative risk

Allow deliberate color casts, channel separation, hard clipping, dead blacks, posterization, extreme saturation, cross-processing, and heavy grain when they serve the chosen Break design. Mark each as intentional_artifact with its purpose and affected region.

Only unexpected risk blocks selection or application; its diagnostic preview may remain visible. Warning risk requires disclosure and monitoring, not automatic normalization. Person protection is always mandatory and cannot be downgraded by a candidate's style.

## Keep execution reversible

- Never modify the catalog database or XMP sidecar directly.
- Never overwrite the source, export, batch-sync, delete, or change metadata unless separately requested.
- Keep crop, healing, lens corrections, and existing masks unchanged when outside the selected recipe.
- Roll back when the target changes, the baseline digest differs, the bridge disconnects, a parameter partially fails, or final verification finds an unexpected artifact.
- Use Lightroom UI only for person or subject masks, complex local brushes, healing, and requested composition crop that the bridge cannot reliably perform.
- For UI fallback, use semantic control discovery and direct set_value operations. Never traverse fields with Tab or reuse stale coordinates.

## Preserve compatibility

- lr-color-preview is a preview-only alias and must stop after PREVIEWED.
- lr-color-grading-flash1 consumes an already SELECTED GradeSession and performs transactional global application without reanalysis or recommendations.
- lr-color-grading handles person protection, complex masks, requested crop, healing, and precision refinement only.

Return the GradeSession path, candidate previews, selected direction and strength, transaction/readback result, person-protection status, and any unresolved warning. Do not add the result to the inspiration library unless the user explicitly says to collect or save it.
