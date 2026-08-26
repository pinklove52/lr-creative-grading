#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { CORE33_SCOPE, CORE33_SCOPE_DIGEST } from "../lightroom-bridge/src/core33-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidencePath = path.join(root, "artifacts", "core33", "crash-recovery-lr15.0.1-jpg-core33.json");
const command = process.argv[2];
const transport = new LightroomFileQueueTransport({ requestTimeoutMs: 300_000 });

if (!["prepare", "run", "cleanup", "recover-orphan"].includes(command)) {
  throw new Error("usage: node scripts/run-core33-crash-recovery.mjs <prepare|run|cleanup|recover-orphan>");
}

async function save(evidence) {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function load() {
  return JSON.parse(await fs.readFile(evidencePath, "utf8"));
}

function assertChart(settings) {
  assert.equal(settings.target.filename.toLowerCase(), "core33-test-chart.jpg");
  assert.ok(["JPG", "JPEG"].includes(String(settings.target.format).toUpperCase()));
}

function guardRequest(target) {
  const specs = { exposure: { operation: "delta", value: 0.1, interpolation: "linear" } };
  return {
    session_version: "core33-crash-recovery/1",
    target,
    scope: { scope_id: CORE33_SCOPE.scope_id, scope_digest: CORE33_SCOPE_DIGEST },
    candidate: { candidate_id: "crash_cleanup_guard", route: "test" },
    selection: { requested_strength: 100 },
    lr_recipe: { desired_parameters: specs, ui_required: [] },
    execution_desired: {
      candidate_id: "crash_cleanup_guard",
      requested_strength: 100,
      strength_factor: 1,
      recipe_hash: "live-negative:crash-cleanup-guard",
      mode: "baseline_relative",
      parameter_specs: specs,
      compiled_parameters: null,
      compilation: "bridge_reads_pinned_baseline_then_interpolates",
      people_protection: null,
    },
    history_name: "Core33 crash cleanup guard",
    strict: true,
    allow_snapshot_fallback: false,
  };
}

async function prepare() {
  const ping = await transport.call("ping", {});
  const before = await transport.call("get_settings", {});
  assertChart(before);
  const applied = await transport.call("apply_transaction", guardRequest(before.target));
  assert.equal(applied.state, "APPLIED");
  const during = await transport.call("get_settings", {});
  const appliedDigest = applied.execution_patch.applied_edit_digest;
  assert.equal(during.baseline_edit_digest, appliedDigest);
  const evidence = {
    schema_version: 1,
    source: "live",
    captured_at: new Date().toISOString(),
    scope_id: CORE33_SCOPE.scope_id,
    scope_digest: CORE33_SCOPE_DIGEST,
    plugin_version: ping.plugin_version,
    target: before.target,
    crash_target: during.target,
    cleanup_transaction: {
      transaction_id: applied.transaction_id,
      snapshot_id: applied.snapshot.id,
      snapshot_name: applied.snapshot.name,
      pre_transaction_edit_digest: before.baseline_edit_digest,
      pre_transaction_settings_summary: applied.execution_patch.pre_transaction_settings_summary,
      guard_applied_digest: appliedDigest,
      compiled_parameters: applied.desired.compiled_parameters,
    },
    stages: {
      prepare: {
        status: "passed",
        pre_digest: before.baseline_edit_digest,
        guard_digest: appliedDigest,
        exposure_before: before.values.exposure,
        exposure_guard: during.values.exposure,
      },
    },
    complete: false,
  };
  await save(evidence);
  return evidence;
}

async function waitForClaim(callPromise, processingDir) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const files = (await fs.readdir(processingDir).catch(() => [])).filter((name) => name.endsWith(".json"));
    if (files.length === 1) return files[0];
    await Promise.race([delay(50), callPromise.then(() => {}).catch(() => {})]);
  }
  throw new Error("probe request was not claimed into processing within 20 seconds");
}

async function runCrashRequest() {
  const evidence = await load();
  const callPromise = transport.call("probe_core33_jpg", {
    target: evidence.crash_target,
    confirmation: "PROBE_CORE33_TEST_CHART_ONLY",
  });
  const claimName = await waitForClaim(callPromise, transport.paths().processingDir);
  evidence.stages.run = {
    status: "claimed_waiting_for_forced_exit",
    request_id: claimName.replace(/\.json$/i, ""),
    processing_file: claimName,
    claimed_observed_at: new Date().toISOString(),
  };
  await save(evidence);
  process.stdout.write(`${JSON.stringify({ event: "claimed", request_id: evidence.stages.run.request_id })}\n`);

  try {
    await callPromise;
    evidence.stages.run.status = "failed_request_completed_before_exit";
    await save(evidence);
    throw new Error("probe completed; Lightroom was not exited during processing");
  } catch (error) {
    if (evidence.stages.run.status === "failed_request_completed_before_exit") throw error;
    evidence.stages.run.status = "interrupted";
    evidence.stages.run.transport_error_code = error.code ?? "UNKNOWN";
    evidence.stages.run.transport_error_message = error.message;
    evidence.stages.run.interrupted_at = new Date().toISOString();
    await save(evidence);
    return evidence;
  }
}

function cleanupReference(evidence, currentDigest) {
  const tx = evidence.cleanup_transaction;
  return {
    transaction_id: tx.transaction_id,
    target: evidence.target,
    snapshot_id: tx.snapshot_id,
    snapshot_name: tx.snapshot_name,
    pre_transaction_edit_digest: tx.pre_transaction_edit_digest,
    pre_transaction_settings_summary: tx.pre_transaction_settings_summary,
    compiled_parameters: tx.compiled_parameters,
    expected_current_edit_digest: currentDigest,
  };
}

async function cleanup() {
  const evidence = await load();
  assert.ok(
    ["interrupted", "failed_request_completed_before_exit"].includes(evidence.stages.run?.status),
    "run must be interrupted or complete cleanly before cleanup",
  );
  const current = await transport.call("get_settings", {});
  assertChart(current);
  assert.equal(current.target.photo_id, evidence.target.photo_id);
  assert.equal(current.target.source_digest, evidence.target.source_digest);
  const processingPath = path.join(transport.paths().processingDir, evidence.stages.run.processing_file);
  const processingPresent = await fs.access(processingPath).then(() => true).catch(() => false);
  const failedPath = path.join(transport.paths().failedDir, evidence.stages.run.processing_file);
  const failedPresent = await fs.access(failedPath).then(() => true).catch(() => false);
  if (evidence.stages.run.status === "interrupted") {
    assert.equal(processingPresent || failedPresent, true, "interrupted request is missing from processing and failed");
    if (failedPresent) {
      const reason = JSON.parse(await fs.readFile(`${failedPath}.reason.json`, "utf8"));
      assert.equal(reason.code, "RECOVERY_UNKNOWN");
    }
  } else {
    assert.equal(processingPresent, false, "completed request unexpectedly left a processing file");
  }
  const rolledBack = await transport.call("rollback", cleanupReference(evidence, current.baseline_edit_digest));
  assert.equal(rolledBack.state, "ROLLED_BACK");
  const after = await transport.call("get_settings", {});
  assert.equal(after.baseline_edit_digest, evidence.cleanup_transaction.pre_transaction_edit_digest);
  evidence.stages.cleanup = {
    status: "passed",
    crash_residue_digest: current.baseline_edit_digest,
    rollback_digest: after.baseline_edit_digest,
    orphan_processing_file_still_present: processingPresent,
    orphan_already_quarantined: failedPresent,
    baseline_restored: true,
  };
  await save(evidence);
  return evidence;
}

async function recoverOrphan() {
  const evidence = await load();
  assert.equal(evidence.stages.cleanup?.status, "passed", "cleanup must pass first");
  await transport.start();
  const name = evidence.stages.run.processing_file;
  const failedPath = path.join(transport.paths().failedDir, name);
  const reasonPath = `${failedPath}.reason.json`;
  const reason = JSON.parse(await fs.readFile(reasonPath, "utf8"));
  assert.equal(reason.code, "RECOVERY_UNKNOWN");
  assert.equal(await fs.access(path.join(transport.paths().processingDir, name)).then(() => true).catch(() => false), false);
  const current = await transport.call("get_settings", {});
  assert.equal(current.baseline_edit_digest, evidence.cleanup_transaction.pre_transaction_edit_digest);
  evidence.stages.recover_orphan = {
    status: "passed",
    failed_file: name,
    error_code: reason.code,
    never_reapplied: true,
    final_digest: current.baseline_edit_digest,
  };
  evidence.complete = true;
  await save(evidence);
  return evidence;
}

try {
  const evidence = command === "prepare"
    ? await prepare()
    : command === "run"
      ? await runCrashRequest()
      : command === "cleanup"
        ? await cleanup()
        : await recoverOrphan();
  process.stdout.write(`${JSON.stringify({ ok: true, command, output: evidencePath, complete: evidence.complete, stage: evidence.stages[command.replace("-", "_")] })}\n`);
} finally {
  await transport.close();
}
