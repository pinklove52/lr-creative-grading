# GradeSession contract

GradeSession is the only shared state between analysis, preview, selection, Lightroom application, local refinement, verification, and collection. Store it as UTF-8 JSON and validate it before every stage transition.

## Version and required top-level fields

The contract version is 1.0.0. A reader must reject another version until an explicit migration exists. Preserve optional extension fields when rewriting a session.

Required fields:

| Field | Type | Purpose |
| --- | --- | --- |
| session_version | string | Exact contract version, currently 1.0.0 |
| target | object | Exact photo and baseline binding |
| photo_dna | object | One immutable analysis result |
| candidates | array | Native, Amplify, and Break recipes |
| selection | object or null | The user's single choice |
| execution | object | Transaction, readback, protection, and verification |

previews is an optional object added by render. Session IDs, timestamps, format, proxy paths, and baseline-kind labels are optional extensions rather than required core fields.

session_id and revision are persisted concurrency extensions. Every CLI mutation checks the loaded revision and writes through a temporary file, flushes it, retains one .bak, and atomically replaces the session. Reject a stale expected revision instead of overwriting newer state.

## Target binding

target requires:

- photo_id: Lightroom identifier when available, otherwise null;
- filename: original Lightroom filename; when analysis reads a temporary proxy, supply the original through analyze --filename;
- source_digest: stable Lightroom-photo or file-identity digest used by the apply target guard;
- proxy_digest: SHA-256 of the actual current-render JPEG bytes analyzed by PhotoDNA;
- baseline_edit_digest: stable digest of the current Lightroom develop settings, or null for a documented file-only baseline.

format, proxy_path, baseline_kind, live_applicable, and acquired_at may be added as optional extensions. acquire-live copies the proxy into source/baseline.jpg and marks live_applicable true. Ordinary file analysis marks live_applicable false. Never upgrade a file-only session by binding the active Lightroom photo later.

In file mode, source_digest and proxy_digest may be the same. photo_dna.source_digest equals target.proxy_digest because PhotoDNA describes those rendered bytes. The source, proxy, and baseline digests are pinned at ACQUIRE. Never silently update them after the user switches photos or edits the baseline. Start a new session instead.

File-only preview may use null photo_id or baseline_edit_digest, but live apply_transaction requires photo_id, filename, source_digest, and baseline_edit_digest to be non-empty and revalidated. proxy_digest remains the analysis/preview guard. Do not invent or silently bind missing Lightroom identity at execution time.

## PhotoDNA

photo_dna contains:

- semantics: subject, scene, mood, visual hierarchy, and confidence;
- tone: luminance percentiles, contrast, clipping evidence, and light direction;
- color: 360-bin hue histogram, OKLCH palette, dominant hues, cold-warm axis, chroma distribution, and visible casts;
- texture: edge density, local contrast, grain/noise evidence, and material cues;
- harmony: winning natural rule, anchor, score, alternatives, and protected neutral behavior;
- visual_anchors: important regions and qualities to emphasize or suppress;
- protected_people: enabled, model/context and deterministic evidence sources, regions when known, and the credible-skin/face/texture policy. Face detection alone is insufficient.

PhotoDNA is computed once. If the source changes, create a new session rather than overwriting it.

## Candidate records

candidates must be ordered native, amplify, break and contain exactly one record for each route. Each record contains:

- candidate_id, label, and logic tied to PhotoDNA;
- design_strength and intensity with minimum, design, default, and maximum from 0 through 200; design_strength must equal intensity.default;
- offline_ops, recording deterministic preview operations;
- lr_recipe with baseline-relative parameter specs, preview fidelity, and dynamic-baseline requirement;
- people_protection with required, preserve amount, and strategy;
- risks, using the classification in risk-qc.md.

Every scalar lr_recipe parameter is an object with operation delta or target, numeric value, and interpolation linear or circular_degrees. Bare numeric values are invalid unless lr_recipe explicitly declares legacy_numeric_mode delta; that compatibility mode must be normalized before application. Curves use operation target plus curve_points.

Every preview entry records strength, canonical recipe_hash, preview_render_hash, artifact_digest, cache_key, absolute preview path, QC, and detected risks. recipe_hash covers the candidate and exact strength; preview_render_hash additionally covers renderer/version/dimensions. Do not interchange them. Cache keys derive from proxy_digest plus preview_render_hash. preset_seed_uuid is an optional recipe extension.

Do not encode Break as Amplify with a larger strength. Its intent and operator graph must be distinct.

## Selection

selection remains null through PREVIEWED. The select command writes:

- candidate_id;
- requested_strength from 0 through 200;

The selected candidate and requested_strength must exactly match an existing preview entry. Its recipe_hash must match the canonical candidate/strength hash, artifact_digest must match the preview bytes, the artifact must exist, and detected_risks must contain no unexpected item. Rerender and re-QC whenever the user changes strength.

For a legacy session, migrate may normalize preview recipe/artifact digests. If the recorded selection does not exactly match the reviewed preview, migration must revoke selection, clear execution.desired, and return to PREVIEWED. It must never fabricate a preview authorization.

named_mix, user_note, and selected_at are optional extensions. Selecting also writes execution.desired with:

- candidate_id and requested_strength;
- strength_factor, equal to requested_strength divided by 100;
- recipe_hash;
- mode baseline_relative;
- parameter_specs copied from the selected candidate;
- compiled_parameters, which remains null until the bridge locks and reads the pinned baseline;
- compilation, describing the pending bridge-baseline interpolation;
- people_protection.

The bridge resolves delta and target specs only after validating the live target and baseline. It then fills compiled_parameters with the exact absolute values it intends to apply. Do not put a second lr_recipe object inside execution.desired.

One selection authorizes only the recorded recipe and target. It is not permission to export, synchronize, overwrite, collect, or apply the look to other photos.

## Execution

execution requires:

- state: the current fixed state-machine value;
- state_history: the complete ordered list beginning with ACQUIRE;
- transaction_id, initially null;
- desired: compiled selected work, initially empty;
- applied: settings accepted by the bridge, initially empty;
- readback: actual values and per-parameter status, initially empty;
- failures: structured failure records, initially empty;
- person_protection: required and result, initialized as required true/false from PhotoDNA with result pending.

At PERSON_PROTECTED, VERIFIED, or DONE, a person image must have result protected, compensated, or verified. A confirmed no-person image must have result not_required. snapshot_id, verification, and rollback are optional execution extensions written by live Lightroom stages.

PERSON_PROTECTED also records post_edit_digest from a fresh get_target_photo after proving photo identity is unchanged. This digest distinguishes the authorized local protection edit from an unrelated later Lightroom change and becomes expected_current_edit_digest for final readback.

An absent recipe field means leave the existing Lightroom setting unchanged. It never means write zero.

## State machine

The only forward path is:

    ACQUIRE
      -> ANALYZED
      -> PREVIEWED
      -> SELECTED
      -> SNAPSHOTTED
      -> APPLIED
      -> PERSON_PROTECTED
      -> VERIFIED
      -> DONE

The session is first persisted at ANALYZED with state_history ACQUIRE, ANALYZED. ROLLED_BACK is a terminal recovery state reachable after SNAPSHOTTED. A no-person image still records PERSON_PROTECTED with required false and result not_required so that the audit path remains complete.

Transition requirements:

| Transition | Required evidence |
| --- | --- |
| ACQUIRE -> ANALYZED | Target digests and complete PhotoDNA |
| ANALYZED -> PREVIEWED | Three valid candidates and cached previews |
| PREVIEWED -> SELECTED | Explicit user choice and requested strength |
| SELECTED -> SNAPSHOTTED | Target/digest revalidation and snapshot confirmation |
| SNAPSHOTTED -> APPLIED | One transaction response with no unexpected failure |
| APPLIED -> PERSON_PROTECTED | Required protection completed or not_required recorded |
| PERSON_PROTECTED -> VERIFIED | Full readback and visual QC |
| VERIFIED -> DONE | No unresolved unexpected risk |
| execution -> ROLLED_BACK | Pre-transaction values restored and verified |

Merge bridge execution_patch fields only after validating transaction_id and the declared state_history_append against this table. apply_transaction appends SNAPSHOTTED, APPLIED; the person stage appends PERSON_PROTECTED; public readback appends VERIFIED; rollback appends ROLLED_BACK. Never replace the whole session with a bridge response.

## Invariants

- Analyze each proxy_digest at most once per session.
- Preserve optional extension fields when rewriting a session.
- Keep candidate preview operations separate from Lightroom settings.
- Keep desired, applied, and readback values separate; never infer readback from a successful request.
- Refuse photo identity source_digest or baseline_edit_digest mismatch at apply; refuse proxy_digest mismatch during analysis and preview.
- Only unexpected risk blocks selection, application, or completion; a safe diagnostic preview may still exist.
- Preserve existing crop, healing, lens correction, and masks unless the selected recipe explicitly owns them.
- Collection state is not required in GradeSession. The collect command creates a separate library entry only after an explicit user request.

Validate with:

    python scripts/creative_grade.py validate <session-path>

Do not advance state when validation fails.
