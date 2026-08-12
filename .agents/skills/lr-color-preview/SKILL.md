---
name: lr-color-preview
description: Compatibility entry for generating the Native, Amplify, and Break preview stage of a shared lr-creative-grading GradeSession without writing to Lightroom. Use when the user asks to preview, audition, compare, or generate A/B/C color looks before live application.
---

# Lightroom 调色预览兼容入口

Use the lr-creative-grading contract and stop after PREVIEWED. This skill does not own a separate analysis model, recommendation flow, or approval gate.

## Required contract

Read ../lr-creative-grading/references/session-schema.md, ../lr-creative-grading/references/creative-operators.md, and ../lr-creative-grading/references/risk-qc.md.

Resolve ../lr-creative-grading/scripts/creative_grade.py from this SKILL.md directory and pass the resulting absolute path to Python. Do not assume the process working directory is a skill folder.

Do not use a per-photo hard-coded renderer.

## Preview-only flow

1. Run doctor --live and acquire-live for a Lightroom target, or bind the supplied image as file-only. Preserve the acquired source/baseline.jpg.
2. Pin stable source_digest, original Lightroom filename, analyzed proxy_digest, and baseline_edit_digest. Pass the original filename to analyze --filename when the visible proxy is temporary. The currently visible Lightroom result is the baseline; do not normalize it.
3. Pass model/context hints for subject, scene, mood, lighting, and materials with analyze --semantic-hints. Pass person presence and regions through --protected-people or --people-boxes. Run analysis once so PhotoDNA combines semantic and deterministic image evidence.
4. Run render to create the Native, Amplify, and Break candidates in parallel at their own design strengths.
5. Reuse the proxy_digest plus recipe/render hashes and generate equal-frame, long-edge 1800 px previews plus a Baseline/Native/Amplify/Break contact sheet.
6. Validate the GradeSession and verify labels, hashes, histograms, people, gradients, and declared artifacts.
7. Present the three candidates together and ask for one exact candidate/strength. A changed strength must be rerendered and QC-checked; never select an unreviewed recipe hash.
8. Stop at PREVIEWED. The lr-creative-grading orchestrator records selection and owns every later transition.

Rendering derivatives in the workspace does not require a second preview-authorization question. It grants no permission to write Lightroom settings.

## Boundaries

- Preserve the source byte-for-byte and write only new preview derivatives.
- Do not change Lightroom sliders, presets, crop, masks, metadata, sync, or export.
- Do not use an image-generation model for grading previews.
- Label non-Adobe output as offline approximation and record offline_ops separately from lr_recipe.
- Allow declared intentional artifacts. An unexpected risk marks a candidate blocked from selection and application; its preview may remain visible for diagnosis unless rendering it would itself be unsafe or invalid.
- Protect people in every candidate. Do not rely on OpenCV face detection as the sole person signal.
- Do not collect the result unless the user explicitly says “收藏”.
- Do not delete existing previews, including the DSC_2667 regression sample.

Return the GradeSession path, contact sheet, three preview paths, fidelity notes, and unresolved warnings.
