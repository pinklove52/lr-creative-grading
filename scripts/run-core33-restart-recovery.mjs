#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { CORE33_SCOPE, CORE33_SCOPE_DIGEST } from "../lightroom-bridge/src/core33-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidencePath = path.join(root, "artifacts", "core33", "restart-recovery-lr15.0.1-jpg-core33.json");
const transport = new LightroomFileQueueTransport({ requestTimeoutMs: 180_000 });
const command = process.argv[2];

if (!["prepare", "verify"].includes(command)) {
  throw new Error("usage: node scripts/run-core33-restart-recovery.mjs <prepare|verify>");
}

async function save(evidence) {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function load() {
  return JSON.parse(await fs.readFile(evidencePath, "utf8"));
}

function assertChart(settings) {
  assert.equal(settings.target.filename.toLowerCase(), "core33-test-chart.jpg", "select core33-test-chart.jpg");
  assert.ok(["JPG", "JPEG"].includes(String(settings.target.format).toUpperCase()), "target must be JPG");
}

function request(target) {
  const specs = { contrast: { operation: "delta", value: 1, interpolation: "linear" } };
  return {
    session_version: "core33-restart-recovery/1",
    target,
    scope: { scope_id: CORE33_SCOPE.scope_id, scope_digest: CORE33_SCOPE_DIGEST },
    candidate: { candidate_id: "restart_recovery", route: "test" },
    selection: { requested_strength: 100 },
    lr_recipe: { desired_parameters: specs, ui_required: [] },
    execution_desired: {
      candidate_id: "restart_recovery",
      requested_strength: 100,
      strength_factor: 1,
      recipe_hash: "live-negative:restart-recovery",
      mode: "baseline_relative",
      parameter_specs: specs,
      compiled_parameters: null,
      compilation: "bridge_reads_pinned_baseline_then_interpolates",
      people_protection: null,
    },
    history_name: "Core33 restart recovery",
    strict: true,
    allow_snapshot_fallback: false,
  };
}

function recoveryReference(evidence) {
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

async function prepare() {
  const ping = await transport.call("ping", {});
  const before = await transport.call("get_settings", {});
  assertChart(before);
  const applied = await transport.call("apply_transaction", request(before.target));
  assert.equal(applied.state, "APPLIED");
  assert.equal(applied.failures.length, 0);
  const appliedDigest = applied.execution_patch.applied_edit_digest;
  const during = await transport.call("get_settings", {});
  assert.equal(during.baseline_edit_digest, appliedDigest);
  assert.notEqual(appliedDigest, before.baseline_edit_digest);

  const evidence = {
    schema_version: 1,
    source: "live",
    captured_at: new Date().toISOString(),
    scope_id: CORE33_SCOPE.scope_id,
    scope_digest: CORE33_SCOPE_DIGEST,
    plugin_version_before_restart: ping.plugin_version,
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
        contrast_before: before.values.contrast,
        contrast_applied: during.values.contrast,
      },
    },
    restart_attestation: null,
    complete: false,
  };
  await save(evidence);
  return evidence;
}

async function verify() {
  const evidence = await load();
  const ping = await transport.call("ping", {});
  const beforeRollback = await transport.call("get_settings", {});
  assertChart(beforeRollback);
  assert.equal(beforeRollback.target.photo_id, evidence.target.photo_id, "active photo changed across restart");
  assert.equal(beforeRollback.target.source_digest, evidence.target.source_digest, "source identity changed across restart");
  assert.equal(
    beforeRollback.baseline_edit_digest,
    evidence.transaction.applied_edit_digest,
    "the applied transaction did not persist across restart",
  );
  const rolledBack = await transport.call("rollback", recoveryReference(evidence));
  assert.equal(rolledBack.state, "ROLLED_BACK");
  assert.equal(rolledBack.history?.recovered_from_grade_session, true, "rollback did not use persisted recovery journal");
  const after = await transport.call("get_settings", {});
  assert.equal(after.baseline_edit_digest, evidence.transaction.pre_transaction_edit_digest, "restart rollback did not restore baseline");
  assert.equal(after.values.contrast, evidence.stages.prepare.contrast_before, "contrast did not return to baseline");

  evidence.plugin_version_after_restart = ping.plugin_version;
  evidence.restart_attestation = {
    source: "user",
    message: "Lightroom was fully restarted and the bridge was started manually before verify",
    recorded_at: new Date().toISOString(),
  };
  evidence.stages.verify = {
    status: "passed",
    persisted_applied_digest: beforeRollback.baseline_edit_digest,
    rollback_digest: after.baseline_edit_digest,
    recovered_from_grade_session: true,
    baseline_restored: true,
  };
  evidence.complete = true;
  await save(evidence);
  return evidence;
}

try {
  const evidence = command === "prepare" ? await prepare() : await verify();
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
