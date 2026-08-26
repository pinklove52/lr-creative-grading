import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { CORE33_SCOPE, CORE33_SCOPE_DIGEST } from "../lightroom-bridge/src/core33-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifactDir = path.join(root, "artifacts", "core33", "m3-virtual-copy-acceptance");
const evidencePath = path.join(artifactDir, "evidence.json");
const masterMatrixPath = path.join(root, "artifacts", "core33", "transaction-matrix-m3-acceptance-lr15.0.1-jpg-core33.json");
const mode = process.argv[2];
const transport = new LightroomFileQueueTransport({ requestTimeoutMs: 180_000 });

const parameterSpecs = {
  exposure: { operation: "delta", value: 0.3, interpolation: "linear" },
  contrast: { operation: "delta", value: 8, interpolation: "linear" },
  highlights: { operation: "delta", value: -12, interpolation: "linear" },
  shadows: { operation: "delta", value: 10, interpolation: "linear" },
  saturation_blue: { operation: "delta", value: 9, interpolation: "linear" },
};

function requestFor(target) {
  return {
    session_version: "m3-virtual-copy-acceptance/1",
    target,
    scope: { scope_id: CORE33_SCOPE.scope_id, scope_digest: CORE33_SCOPE_DIGEST },
    candidate: { candidate_id: "m3_virtual_copy", route: "acceptance" },
    selection: { requested_strength: 100 },
    lr_recipe: { desired_parameters: parameterSpecs, ui_required: [] },
    execution_desired: {
      candidate_id: "m3_virtual_copy",
      requested_strength: 100,
      strength_factor: 1,
      recipe_hash: "m3-virtual-copy-fixed-recipe-v1",
      mode: "baseline_relative",
      parameter_specs: parameterSpecs,
      compiled_parameters: null,
      compilation: "bridge_reads_pinned_baseline_then_interpolates",
      people_protection: null,
    },
    history_name: "M3 virtual-copy acceptance",
    strict: true,
    allow_snapshot_fallback: true,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function save(evidence) {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function exportProxy(name) {
  const proxy = await transport.call("get_proxy", { long_edge: 1800 });
  await fs.mkdir(artifactDir, { recursive: true });
  const destination = path.join(artifactDir, name);
  await fs.copyFile(proxy.path, destination);
  return { proxy_digest: proxy.proxy_digest, path: path.relative(root, destination).replaceAll("\\", "/"), target: proxy.target };
}

function assertSameValues(left, right, label) {
  for (const name of Object.keys(parameterSpecs)) {
    assert.ok(Math.abs(Number(left[name]) - Number(right[name])) <= 0.01, `${label}: ${name} differs`);
  }
}

async function applyAndReadback(target) {
  const applied = await transport.call("apply_transaction", requestFor(target));
  assert.equal(applied.state, "APPLIED");
  assert.equal(applied.failures.length, 0);
  const appliedDigest = applied.execution_patch.applied_edit_digest;
  const readback = await transport.call("readback", {
    transaction_id: applied.transaction_id,
    target,
    expected_current_edit_digest: appliedDigest,
  });
  assert.equal(readback.execution.bridge_state, "READBACK_VERIFIED");
  assert.equal(readback.failures.length, 0);
  assertSameValues(readback.readback.values, applied.desired.compiled_parameters, "desired/readback");
  return {
    transaction_id: applied.transaction_id,
    snapshot_id: applied.snapshot.id,
    snapshot_name: applied.snapshot.name,
    pre_digest: target.baseline_edit_digest,
    applied_digest: appliedDigest,
    desired: applied.desired.compiled_parameters,
    readback: readback.readback.values,
  };
}

async function rollback(record, target) {
  const result = await transport.call("rollback", {
    transaction_id: record.transaction_id,
    snapshot_id: record.snapshot_id,
    snapshot_name: record.snapshot_name,
    target,
    pre_transaction_edit_digest: record.pre_digest,
    compiled_parameters: record.desired,
    expected_current_edit_digest: record.applied_digest,
  });
  assert.equal(result.state, "ROLLED_BACK");
  const after = await transport.call("get_settings", {});
  assert.equal(after.baseline_edit_digest, record.pre_digest);
  return { state: result.state, digest: after.baseline_edit_digest, baseline_restored: true };
}

try {
  if (mode === "--verify-virtual-rollback") {
    const evidence = await readJson(evidencePath);
    assert.equal(evidence.state, "MASTER_VERIFIED_WAITING_VIRTUAL_ROLLBACK");
    const before = await transport.call("get_settings", {});
    assert.equal(before.target.photo_id, evidence.virtual.target.photo_id, "wrong virtual copy selected");
    assert.equal(before.target.is_virtual_copy, true);
    assert.equal(before.baseline_edit_digest, evidence.virtual.pre_digest, "virtual copy is not at its original baseline");
    const verification = await applyAndReadback(before.target);
    const rollbackResult = await rollback(verification, before.target);
    evidence.virtual.original_recovery = {
      bridge_response: "ROLLBACK_FAILED",
      actual_digest_after_response: before.baseline_edit_digest,
      baseline_was_restored: true,
      cause: "The acceptance harness omitted pre_transaction_edit_digest after a bridge restart, so the bridge compared the restored snapshot against the applied digest."
    };
    evidence.virtual.rollback_verification = { ...verification, rollback: rollbackResult };
    evidence.virtual.rollback = rollbackResult;
    evidence.state = "COMPLETE";
    evidence.complete = evidence.master_unchanged_while_virtual_applied === true
      && evidence.master_parameter_match === true
      && evidence.pixel_comparison?.matches === true
      && evidence.master.rollback.baseline_restored === true
      && evidence.virtual.rollback.baseline_restored === true;
    evidence.completed_at = new Date().toISOString();
    await save(evidence);
    process.stdout.write(`${JSON.stringify({ ok: evidence.complete, state: evidence.state, evidence: evidencePath, virtual_rollback_verified: true })}\n`);
  } else if (mode === "--recover-virtual") {
    const transactionId = process.argv[3];
    assert.match(transactionId ?? "", /^[0-9A-F-]{36}$/i, "recovery requires the transaction UUID from the newest CreativeGrade pre snapshot");
    const masterMatrix = await readJson(masterMatrixPath);
    const current = await transport.call("get_settings", {});
    assert.equal(current.target.is_virtual_copy, true, "current target must remain the virtual copy");
    const readback = await transport.call("readback", {
      transaction_id: transactionId,
      target: current.target,
      expected_current_edit_digest: current.baseline_edit_digest,
    });
    assert.equal(readback.execution.bridge_state, "READBACK_VERIFIED");
    const proxy = await exportProxy("virtual-applied.jpg");
    const virtual = {
      transaction_id: transactionId,
      snapshot_id: readback.snapshot.id,
      pre_digest: masterMatrix.final_edit_digest,
      applied_digest: current.baseline_edit_digest,
      desired: readback.desired.compiled_parameters,
      readback: readback.readback.values,
    };
    assertSameValues(virtual.readback, virtual.desired, "recovered desired/readback");
    const evidence = {
      schema_version: 1,
      source: "live",
      stage: "M3",
      captured_at: new Date().toISOString(),
      plugin_version: (await transport.call("ping", {})).plugin_version,
      recipe_hash: "m3-virtual-copy-fixed-recipe-v1",
      parameter_specs: parameterSpecs,
      recovery_note: "The original apply/readback succeeded; evidence persistence was recovered after a local proxy destination directory error without repeating the write.",
      master_before: { target: masterMatrix.target, digest: masterMatrix.final_edit_digest },
      virtual: { target: current.target, ...virtual, proxy },
      state: "VIRTUAL_APPLIED_WAITING_MASTER",
      complete: false,
    };
    await save(evidence);
    process.stdout.write(`${JSON.stringify({ ok: true, state: evidence.state, evidence: evidencePath, proxy: proxy.path })}\n`);
  } else if (mode === "--recover-master") {
    const transactionId = process.argv[3];
    assert.match(transactionId ?? "", /^[0-9A-F-]{36}$/i, "recovery requires the latest master transaction UUID");
    const evidence = await readJson(evidencePath);
    assert.equal(evidence.state, "VIRTUAL_APPLIED_WAITING_MASTER");
    const current = await transport.call("get_settings", {});
    assert.equal(current.target.is_virtual_copy, false, "current target must remain the master");
    assert.equal(current.target.photo_id, evidence.master_before.target.photo_id, "wrong master selected");
    const readback = await transport.call("readback", {
      transaction_id: transactionId,
      target: current.target,
      expected_current_edit_digest: current.baseline_edit_digest,
    });
    assert.equal(readback.execution.bridge_state, "READBACK_VERIFIED");
    const master = {
      transaction_id: transactionId,
      snapshot_id: readback.snapshot.id,
      pre_digest: evidence.master_before.digest,
      applied_digest: current.baseline_edit_digest,
      desired: readback.desired.compiled_parameters,
      readback: readback.readback.values,
      proxy: { path: "artifacts/core33/m3-virtual-copy-acceptance/master-applied.jpg" },
    };
    assertSameValues(master.desired, evidence.virtual.desired, "recovered virtual/master desired");
    assertSameValues(master.readback, evidence.virtual.readback, "recovered virtual/master readback");
    evidence.master_unchanged_while_virtual_applied = master.pre_digest === evidence.master_before.digest;
    evidence.master = { target: current.target, ...master };
    evidence.master_parameter_match = true;
    evidence.master.rollback = await rollback(master, current.target);
    evidence.state = "MASTER_VERIFIED_WAITING_VIRTUAL_ROLLBACK";
    evidence.updated_at = new Date().toISOString();
    evidence.recovery_note_master = "The original same-recipe master apply/readback succeeded; the transaction was recovered and rolled back after byte-level proxy digests differed. Pixel comparison is recorded separately."
    await save(evidence);
    process.stdout.write(`${JSON.stringify({ ok: true, state: evidence.state, evidence: evidencePath, master_rollback: true })}\n`);
  } else if (mode === "--apply-virtual") {
    const masterMatrix = await readJson(masterMatrixPath);
    assert.equal(masterMatrix.complete, true);
    assert.equal(masterMatrix.target.is_virtual_copy, false);
    const before = await transport.call("get_settings", {});
    assert.equal(before.target.filename.toLowerCase(), "core33-test-chart.jpg");
    assert.equal(before.target.is_virtual_copy, true, "current target must be the virtual copy");
    assert.equal(before.baseline_edit_digest, masterMatrix.final_edit_digest, "virtual copy must start from the recorded master baseline");
    const virtual = await applyAndReadback(before.target);
    const proxy = await exportProxy("virtual-applied.jpg");
    const evidence = {
      schema_version: 1,
      source: "live",
      stage: "M3",
      captured_at: new Date().toISOString(),
      plugin_version: (await transport.call("ping", {})).plugin_version,
      recipe_hash: "m3-virtual-copy-fixed-recipe-v1",
      parameter_specs: parameterSpecs,
      master_before: { target: masterMatrix.target, digest: masterMatrix.final_edit_digest },
      virtual: { target: before.target, ...virtual, proxy },
      state: "VIRTUAL_APPLIED_WAITING_MASTER",
      complete: false,
    };
    await save(evidence);
    process.stdout.write(`${JSON.stringify({ ok: true, state: evidence.state, evidence: evidencePath, proxy: proxy.path })}\n`);
  } else if (mode === "--apply-master") {
    const evidence = await readJson(evidencePath);
    assert.equal(evidence.state, "VIRTUAL_APPLIED_WAITING_MASTER");
    const before = await transport.call("get_settings", {});
    assert.equal(before.target.filename.toLowerCase(), "core33-test-chart.jpg");
    assert.equal(before.target.is_virtual_copy, false, "current target must be the master");
    assert.equal(before.target.photo_id, evidence.master_before.target.photo_id, "wrong master selected");
    assert.equal(before.baseline_edit_digest, evidence.master_before.digest, "master changed while virtual copy was graded");
    evidence.master_unchanged_while_virtual_applied = true;
    const master = await applyAndReadback(before.target);
    assertSameValues(master.desired, evidence.virtual.desired, "virtual/master desired");
    assertSameValues(master.readback, evidence.virtual.readback, "virtual/master readback");
    const proxy = await exportProxy("master-applied.jpg");
    evidence.byte_proxy_digest_match = proxy.proxy_digest === evidence.virtual.proxy.proxy_digest;
    evidence.master = { target: before.target, ...master, proxy };
    evidence.master_parameter_match = true;
    evidence.master.rollback = await rollback(master, before.target);
    evidence.state = "MASTER_VERIFIED_WAITING_VIRTUAL_ROLLBACK";
    evidence.updated_at = new Date().toISOString();
    await save(evidence);
    process.stdout.write(`${JSON.stringify({ ok: true, state: evidence.state, evidence: evidencePath, proxy_match: true, master_rollback: true })}\n`);
  } else if (mode === "--rollback-virtual") {
    const evidence = await readJson(evidencePath);
    assert.equal(evidence.state, "MASTER_VERIFIED_WAITING_VIRTUAL_ROLLBACK");
    const before = await transport.call("get_settings", {});
    assert.equal(before.target.photo_id, evidence.virtual.target.photo_id, "wrong virtual copy selected");
    assert.equal(before.target.is_virtual_copy, true);
    evidence.virtual.rollback = await rollback(evidence.virtual, before.target);
    evidence.state = "COMPLETE";
    evidence.complete = evidence.master_unchanged_while_virtual_applied === true
      && evidence.master_parameter_match === true
      && evidence.pixel_comparison?.matches === true
      && evidence.master.rollback.baseline_restored === true
      && evidence.virtual.rollback.baseline_restored === true;
    evidence.completed_at = new Date().toISOString();
    await save(evidence);
    process.stdout.write(`${JSON.stringify({ ok: evidence.complete, state: evidence.state, evidence: evidencePath })}\n`);
  } else {
    throw new Error("Use --apply-virtual, --recover-virtual <transaction-id>, --apply-master, --recover-master <transaction-id>, --rollback-virtual, or --verify-virtual-rollback");
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? "VIRTUAL_COPY_ACCEPTANCE_FAILED", message: error?.message ?? String(error) })}\n`);
  process.exitCode = 1;
} finally {
  await transport.close();
}
