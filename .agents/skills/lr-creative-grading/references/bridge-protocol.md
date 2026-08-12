# Hardened Lightroom bridge protocol

The Node MCP service uses stdio JSON-RPC and coordinates a Lightroom Classic Lua plug-in through SDK LrSocket localhost request/response ports. It must not write the catalog database or photo XMP sidecars directly. Keep stdout exclusively for newline-delimited MCP JSON-RPC.

## Trust boundary

- Bind both plug-in socket ports only to 127.0.0.1.
- Generate a random session token and ephemeral request/response ports at plug-in start. Publish only that connection metadata in %APPDATA%\LrCreativeGradingBridge\session.json.
- Require the token and one stable client_id on every Node-to-Lua request; accept one client session at a time.
- Enforce a 1 MiB request-size limit and a short idle timeout.
- Reject malformed JSON, unknown methods, concurrent requests, a second client_id, and unsupported protocol versions.
- Never expose a network listener beyond localhost.

Every Node-to-Lua request carries protocol_version, request_id, client_id, token, method, and params. Every response echoes request_id and returns either result or a structured error. The public MCP methods below are tools over stdio.

## Required methods

### capabilities

Return Lightroom version, active module, supported parameter identifiers, types, ranges, enum values, batch/history support, preset support, proxy support, and known SDK limitations. Runtime capability data is authoritative.

### get_target_photo

Return photo_id, filename, path when permitted, format, stable source_digest, current module, and baseline_edit_digest. source_digest identifies the photo/file rather than one rendered JPEG.

### get_proxy

Input is long_edge and optional timeout_seconds. Request a JPEG proxy of the current rendered state, default long edge 2048 px. Return proxy path or bytes, dimensions, color-profile information when available, and proxy_digest computed from the returned JPEG bytes. RAW files do not require rawpy.

### get_settings

Input may include target and parameters. Return exact current values only for the sparse parameter set the recipe may modify, plus baseline_edit_digest. Do not reset or synthesize absent values.

### apply_transaction

Prefer the complete validated GradeSession as input. The MCP layer validates SELECTED state/history and normalizes its four-field apply target, selection, selected candidate lr_recipe, execution.desired, optional lr_recipe.preset_uuid, history_name, strict flag, and allow_snapshot_fallback into the Lua request. Lightroom generates transaction_id only after preflight and snapshot creation.

Before changing anything, switch to Develop when supported, revalidate photo_id, filename, source_digest, and baseline_edit_digest, resolve delta/target parameter specs against the current baseline and selected strength, validate every parameter and range, and create the snapshot. Apply the preset seed by UUID when supplied, then submit the complete supported dynamic setting group using LrDevelopController with a multi-adjustment threshold.

If any preflight check fails, apply nothing. If application partially fails, return the exact applied subset and trigger rollback.

The bridge guarantees one atomic transaction, not necessarily one visible Lightroom history row. Direct numeric controls use setMultipleAdjustmentThreshold as a best-effort single Multiple Settings step; a preset seed or structured curve may create a separate history entry. capabilities.transaction is authoritative, and the skill must not claim a strict single-row result when strict_single_history_guarantee is false.

### readback

Call this public tool after GradeSession reaches PERSON_PROTECTED. Input contains transaction_id, or a GradeSession whose execution.transaction_id supplies it, plus optional target. Return actual current values for every desired parameter and classify each as applied, skipped, or unsupported. Merge its execution_patch to VERIFIED. A successful transport response is not proof of application.

### rollback

Input contains transaction_id, or a GradeSession whose execution.transaction_id supplies it, plus target. Restore the saved pre-transaction values, read them back, and report any mismatch. Never roll back a different target.

## Transaction sequence

1. capabilities;
2. get_target_photo;
3. compare photo_id, filename, source_digest, and baseline_edit_digest with GradeSession;
4. get_settings for the sparse recipe;
5. apply_transaction, which creates the snapshot before the first edit, performs an embedded immediate value check, and returns an execution_patch through APPLIED;
6. one person-protection escalation when required, or an explicit not_required transition for a no-person image;
7. public readback once after PERSON_PROTECTED, merging its execution_patch to VERIFIED;
8. final visual verification;
9. rollback on unexpected failure.

Unknown parameters, out-of-range values, target changes, module-switch failures, bridge disconnects, and partial application are hard failures. Do not silently truncate, clamp, skip, or continue.

## Error contract

Use stable codes:

- AUTHENTICATION_FAILED;
- CLIENT_LOCKED;
- BRIDGE_BUSY;
- REQUEST_TOO_LARGE;
- RESPONSE_TOO_LARGE;
- PROTOCOL_MISMATCH;
- METHOD_NOT_FOUND;
- PLUGIN_NOT_RUNNING;
- BRIDGE_TIMEOUT;
- BRIDGE_DISCONNECTED;
- MODULE_SWITCH_FAILED;
- TARGET_MISMATCH;
- BASELINE_MISMATCH;
- SNAPSHOT_FAILED;
- PRESET_NOT_FOUND;
- UNKNOWN_PARAMETER;
- INVALID_PARAMETER_SPEC;
- OUT_OF_RANGE;
- UNSUPPORTED_PARAMETER;
- PARTIAL_APPLY_ROLLED_BACK;
- READBACK_MISMATCH;
- ROLLBACK_FAILED.

Include stage, parameter when applicable, retryable, applied subset, and a human-readable message.

## Presets and dynamic settings

Use an XMP develop preset only as an optional reusable creative seed, selected by UUID. Keep exposure, white balance, crop, masks, and all photo-specific differences in the dynamic layer. Never locate a preset by a translated display label when UUID is available.

## UI fallback

Reserve UI control for person or subject masks, complex local brushes, healing, and requested composition crop that the SDK cannot perform reliably. Use semantic discovery and direct set_value. Do not Tab through numeric fields, drag unnamed controls, rely on old screenshots, or reuse coordinates after the window changes.

The bridge's installer must default to dry-run. Copying into Lightroom Modules or registering the MCP service requires a separate explicit install action and system permission.
