#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { CORE33_SCOPE, CORE33_SCOPE_DIGEST } from "../lightroom-bridge/src/core33-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidencePath = path.join(root, "artifacts", "core33", "manual-edit-guard-lr15.0.1-jpg-core33.json");
const transport = new LightroomFileQueueTransport({ requestTimeoutMs: 180_000 });
const command = process.argv[2];

if (!["prepare", "verify", "cleanup"].includes(command)) {
  throw new Error("usage: node scripts/run-core33-manual-edit-guard.mjs <prepare|verify|cleanup>");
}

async function loadEvidence() {
  return JSON.parse(await fs.readFile(evidencePath, "utf8"));
}

async function saveEvidence(evidence) {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function assertDedicatedChart(settings) {
  assert.equal(settings.target.filename.toLowerCase(), "core33-test-chart.jpg", "select the dedicated Core33 chart");
  assert.ok(["JPG", "JPEG"].includes(String(settings.target.format).toUpperCase()), "target must be JPG");
}

function applyRequest(target) {
  const parameterSpecs = {
    exposure: { operation: "delta", value: 0.1, interpolation: "linear" },
  };
  return {
    session_version: "core33-manual-edit-guard/1",
    target,
    scope: { scope_id: CORE33_SCOPE.scope_id, scope_digest: CORE33_SCOPE_DIGEST },
    candidate: { candidate_id: "manual_edit_guard", route: "test" },
    selection: { requested_strength: 100 },
    lr_recipe: { desired_parameters: parameterSpecs, ui_required: [] },
    execution_desired: {
      candidate_id: "manual_edit_guard",
      requested_strength: 100,
      strength_factor: 1,
      recipe_hash: "live-negative:manual-edit-guard",
      mode: "baseline_relative",
      parameter_specs: parameterSpecs,
      compiled_parameters: null,
      compilation: "bridge_reads_pinned_baseline_then_interpolates",
      people_protection: null,
    },
    history_name: "Core33 manual edit guard",
    strict: true,
    allow_snapshot_fallback: false,
  };
}

async function prepare() {
  const ping = await transport.call("ping", {});
  const before = await transport.call("get_settings", {});
  assertDedicatedChart(before);
  const applied = await transport.call("apply_transaction", applyRequest(before.target));
  assert.equal(applied.state, "APPLIED");
  assert.equal(applied.failures.length, 0);
  const appliedDigest = applied.execution_patch.applied_edit_digest;
  assert.ok(appliedDigest && appliedDigest !== before.baseline_edit_digest, "test write did not change the digest");
  const during = await transport.call("get_settings", {});
  assert.equal(during.baseline_edit_digest, appliedDigest, "published Lightroom state differs from apply response");

  const evidence = {
    schema_version: 1,
    source: "live",
    captured_at: new Date().toISOString(),
    scope_id: CORE33_SCOPE.scope_id,
    scope_digest: CORE33_SCOPE_DIGEST,
    plugin_version: ping.plugin_version,
    target: before.target,
    transaction: {
      transaction_id: applied.transaction_id,
      snapshot_id: applied.snapshot.id,
      snapshot_name: applied.snapshot.name,
      pre_transaction_edit_digest: before.baseline_edit_digest,
      pre_transaction_settings_summary: applied.execution_patch.pre_transaction_settings_summary,
      applied_edit_digest: appliedDigest,
      compiled_parameters: applied.desired.compiled_parameters,
    },
    stages: {
      prepare: {
        status: "passed",
        pre_digest: before.baseline_edit_digest,
        applied_digest: appliedDigest,
        exposure_before: before.values.exposure,
        exposure_applied: during.values.exposure,
      },
    },
    complete: false,
  };
  await saveEvidence(evidence);
  return evidence;
}

function rollbackReference(evidence) {
  const tx = evidence.transaction;
  return {
    transaction_id: tx.transaction_id,
    target: evidence.target,
    snapshot_id: tx.snapshot_id,
    snapshot_name: tx.snapshot_name,
    pre_transaction_edit_digest: tx.pre_transaction_edit_digest,
    pre_transaction_settings_summary: tx.pre_transaction_settings_summary,
    compiled_parameters: tx.compiled_parameters,
    expected_current_edit_digest: tx.applied_edit_digest,
  };
}

async function verify() {
  const evidence = await loadEvidence();
  const beforeAttempt = await transport.call("get_settings", {});
  assertDedicatedChart(beforeAttempt);
  assert.notEqual(
    beforeAttempt.baseline_edit_digest,
    evidence.transaction.applied_edit_digest,
    "no manual Lightroom edit detected after prepare",
  );

  let caught;
  try {
    await transport.call("rollback", rollbackReference(evidence));
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, "BASELINE_CHANGED", "rollback must refuse to overwrite the manual edit");
  const afterAttempt = await transport.call("get_settings", {});
  assert.equal(
    afterAttempt.baseline_edit_digest,
    beforeAttempt.baseline_edit_digest,
    "failed rollback changed the manually edited Lightroom state",
  );

  evidence.stages.verify = {
    status: "passed",
    error_code: caught.code,
    expected_applied_digest: evidence.transaction.applied_edit_digest,
    manual_edit_digest: beforeAttempt.baseline_edit_digest,
    after_refused_rollback_digest: afterAttempt.baseline_edit_digest,
    manual_edit_preserved: true,
  };
  await saveEvidence(evidence);
  return evidence;
}

async function cleanup() {
  const evidence = await loadEvidence();
  assert.equal(evidence.stages.verify?.status, "passed", "verify must pass before cleanup");
  const beforeCleanup = await transport.call("get_settings", {});
  assertDedicatedChart(beforeCleanup);
  assert.equal(
    beforeCleanup.baseline_edit_digest,
    evidence.transaction.applied_edit_digest,
    "undo exactly the manual edit before cleanup",
  );
  const rolledBack = await transport.call("rollback", rollbackReference(evidence));
  assert.equal(rolledBack.state, "ROLLED_BACK");
  const after = await transport.call("get_settings", {});
  assert.equal(after.baseline_edit_digest, evidence.transaction.pre_transaction_edit_digest, "cleanup did not restore baseline");
  evidence.stages.cleanup = {
    status: "passed",
    rollback_digest: after.baseline_edit_digest,
    baseline_restored: true,
  };
  evidence.complete = true;
  await saveEvidence(evidence);
  return evidence;
}

try {
  const evidence = command === "prepare" ? await prepare() : command === "verify" ? await verify() : await cleanup();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command,
    output: evidencePath,
    complete: evidence.complete,
    stage: evidence.stages[command],
  })}\n`);
} finally {
  await transport.close();
}
