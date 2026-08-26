import assert from "node:assert/strict";
import test from "node:test";
import { assertCatalogCoverage } from "../src/catalog-contract.mjs";
import { compileApplyTransaction, normalizeTransactionReference } from "../src/grade-session.mjs";
import { makeGradeSession, PARAMETER_SPECS, SCOPE, TARGET } from "./fixtures.mjs";

test("compiles a SELECTED GradeSession-shaped Core33 transaction", async () => {
  const session = makeGradeSession();
  const request = compileApplyTransaction(session);
  assert.equal(Object.keys(request.lr_recipe.desired_parameters).length, 33);
  assert.equal(request.target.source_digest, TARGET.source_digest);
  assert.notEqual(request.target.source_digest, TARGET.proxy_digest);
  assert.equal(request.execution_desired.compiled_parameters, null);
  assert.equal(request.execution_desired.mode, "baseline_relative");
  const coverage = await assertCatalogCoverage(session);
  assert.deepEqual(coverage.covered, Object.keys(PARAMETER_SPECS).sort());
});

test("rejects non-1.0.0, PREVIEWED/APPLIED, stale history, and preexisting transaction", () => {
  assert.throws(() => compileApplyTransaction(makeGradeSession({ session_version: "0.9.0" })), /1\.0\.0/);
  assert.throws(() => compileApplyTransaction(makeGradeSession({ state: "PREVIEWED" })), /SELECTED/);
  assert.throws(() => compileApplyTransaction(makeGradeSession({ state: "APPLIED" })), /SELECTED/);
  assert.throws(
    () => compileApplyTransaction(makeGradeSession({ state_history: ["ACQUIRE", "ANALYZED", "PREVIEWED"] })),
    /state_history/,
  );
  assert.throws(() => compileApplyTransaction(makeGradeSession({ transaction_id: "already" })), /transaction_id/);
});

test("rejects unexpected risk and stale execution.desired", () => {
  assert.throws(
    () => compileApplyTransaction(makeGradeSession({ risks: [{ kind: "unexpected", code: "banding" }] })),
    /unexpected risk/,
  );
  const stale = makeGradeSession();
  stale.execution.desired.requested_strength = 80;
  assert.throws(() => compileApplyTransaction(stale), /differs/);
  const staleSpecs = makeGradeSession();
  staleSpecs.execution.desired.parameter_specs.contrast.value = 999;
  assert.throws(() => compileApplyTransaction(staleSpecs), /parameter_specs differs/);
});

test("requires the exact reviewed preview strength and recipe hash", () => {
  const changedStrength = makeGradeSession();
  changedStrength.previews[changedStrength.selection.candidate_id].strength = 82;
  assert.throws(() => compileApplyTransaction(changedStrength), /reviewed/);

  const changedHash = makeGradeSession();
  changedHash.previews[changedHash.selection.candidate_id].recipe_hash = "different-preview-hash";
  assert.throws(() => compileApplyTransaction(changedHash), /recipe_hash/);

  const risky = makeGradeSession();
  risky.previews[risky.selection.candidate_id].detected_risks.push({
    kind: "unexpected", code: "intent_mismatch",
  });
  assert.throws(() => compileApplyTransaction(risky), /unexpected risk/);

  const invalidDigest = makeGradeSession();
  invalidDigest.previews[invalidDigest.selection.candidate_id].artifact_digest = "not-a-sha256";
  assert.throws(() => compileApplyTransaction(invalidDigest), /SHA-256/);

  const fileOnly = makeGradeSession({ target: { live_applicable: false } });
  assert.throws(() => compileApplyTransaction(fileOnly), /File-only/);
});

test("requires explicit parameter operations; bare numbers need legacy delta opt-in", () => {
  const direct = {
    scope: SCOPE,
    target: TARGET,
    candidate: { candidate_id: "direct", lr_recipe: { parameters: { contrast: 10 } } },
    selection: { requested_strength: 100 },
  };
  assert.throws(() => compileApplyTransaction(direct), /bare number/);
  direct.candidate.lr_recipe.legacy_numeric_mode = "delta";
  const request = compileApplyTransaction(direct);
  assert.deepEqual(request.lr_recipe.desired_parameters.contrast, {
    operation: "delta", value: 10, interpolation: "linear", legacy: true,
  });
});

test("rejects curves because they are outside Core33", () => {
  const points = [0, 0, 128, 112, 255, 255];
  const direct = {
    scope: SCOPE,
    target: TARGET,
    candidate: {
      candidate_id: "curve",
      lr_recipe: {
        parameters: {
          tone_curve_red: { operation: "target", curve_points: points, interpolation: "curve_points" },
        },
      },
    },
    selection: { requested_strength: 100 },
  };
  assert.throws(
    () => compileApplyTransaction(direct),
    (error) => error.code === "OUT_OF_SCOPE_PARAMETER",
  );
});

test("Core33 rejects non-JPG targets, stale scopes, and excluded parameters", () => {
  assert.throws(
    () => compileApplyTransaction(makeGradeSession({ target: { format: "DNG", filename: "fixture.dng" } })),
    (error) => error.code === "UNSUPPORTED_SOURCE_FORMAT",
  );
  assert.throws(
    () => compileApplyTransaction(makeGradeSession({ scope_digest: "0".repeat(64) })),
    (error) => error.code === "SCOPE_MISMATCH",
  );
  assert.throws(
    () => compileApplyTransaction(makeGradeSession({ parameter_specs: {
      exposure: { operation: "delta", value: 0.1, interpolation: "linear" },
      tint: { operation: "delta", value: 1, interpolation: "linear" },
    } })),
    (error) => error.code === "OUT_OF_SCOPE_PARAMETER",
  );
});

test("transaction references never reinterpret the original target baseline as current edit digest", () => {
  const reference = normalizeTransactionReference({ transaction_id: "tx-1", target: TARGET });
  assert.equal(reference.target.baseline_edit_digest, TARGET.baseline_edit_digest);
  assert.equal(reference.expected_current_edit_digest, undefined);
  const explicit = normalizeTransactionReference({
    transaction_id: "tx-1", target: TARGET, expected_current_edit_digest: "edit-after-mask",
  });
  assert.equal(explicit.expected_current_edit_digest, "edit-after-mask");
});

test("transaction recovery fields survive the Node normalization seam", () => {
  const compiled = { exposure: 0.25, tone_curve: [0, 0, 255, 255] };
  const settingsSummary = {
    Exposure2012: { kind: "number", value: 0 },
    ToneCurvePV2012: { kind: "table", digest: "a".repeat(64), count: 4 },
  };
  const reference = normalizeTransactionReference({
    transaction_id: "tx-restart",
    target: TARGET,
    expected_current_edit_digest: "edit-after-apply",
    snapshot_id: "snapshot-42",
    snapshot_name: "CreativeGrade pre tx-restart",
    pre_transaction_edit_digest: "edit-before-apply",
    compiled_parameters: compiled,
    pre_transaction_settings_summary: settingsSummary,
  });
  assert.deepEqual(reference, {
    transaction_id: "tx-restart",
    target: {
      photo_id: TARGET.photo_id,
      filename: TARGET.filename,
      source_digest: TARGET.source_digest,
      baseline_edit_digest: TARGET.baseline_edit_digest,
      format: "JPG",
    },
    expected_current_edit_digest: "edit-after-apply",
    snapshot_id: "snapshot-42",
    snapshot_name: "CreativeGrade pre tx-restart",
    pre_transaction_edit_digest: "edit-before-apply",
    compiled_parameters: compiled,
    pre_transaction_settings_summary: settingsSummary,
  });
});
