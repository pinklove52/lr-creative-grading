import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import {
  CORE33_PARAMETER_NAMES,
  CORE33_SCOPE,
  CORE33_SCOPE_DIGEST,
} from "../lightroom-bridge/src/core33-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const acceptanceMode = process.argv.includes("--m3-acceptance");
const outputPath = path.join(
  root,
  "artifacts",
  "core33",
  acceptanceMode
    ? "transaction-matrix-m3-acceptance-lr15.0.1-jpg-core33.json"
    : "transaction-matrix-lr15.0.1-jpg-core33.json",
);
const transport = new LightroomFileQueueTransport({ requestTimeoutMs: 180_000 });

const groups = [
  { id: "basic_tone_6", names: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"] },
  { id: "texture_3", names: ["texture", "clarity", "dehaze"] },
  { id: "hue_8", names: CORE33_PARAMETER_NAMES.filter((name) => name.startsWith("hue_")) },
  { id: "saturation_8", names: CORE33_PARAMETER_NAMES.filter((name) => name.startsWith("saturation_")) },
  { id: "luminance_8", names: CORE33_PARAMETER_NAMES.filter((name) => name.startsWith("luminance_")) },
  { id: "all_core33", names: [...CORE33_PARAMETER_NAMES] },
];

const acceptanceGroups = [
  { id: "single_1", names: ["exposure"] },
  { id: "batch_5", names: ["contrast", "highlights", "shadows", "whites", "blacks"] },
  { id: "batch_25", names: CORE33_PARAMETER_NAMES.slice(0, 25) },
];

const selectedGroups = acceptanceMode ? acceptanceGroups : groups;

const evidence = {
  schema_version: 1,
  source: "live",
  captured_at: new Date().toISOString(),
  scope_id: CORE33_SCOPE.scope_id,
  scope_digest: CORE33_SCOPE_DIGEST,
  plugin_version: null,
  target: null,
  p3_capabilities_path: "artifacts/core33/capabilities-lr15.0.1-jpg-core33.json",
  tests: [],
  complete: false,
};

function specsFor(names) {
  return Object.fromEntries(names.map((name) => [
    name,
    { operation: "delta", value: name === "exposure" ? 0.1 : 1, interpolation: "linear" },
  ]));
}

function applyRequest(target, names, id) {
  return {
    session_version: "core33-transaction-matrix/1",
    target,
    scope: { scope_id: CORE33_SCOPE.scope_id, scope_digest: CORE33_SCOPE_DIGEST },
    candidate: { candidate_id: id, route: "test" },
    selection: { requested_strength: 100 },
    lr_recipe: { desired_parameters: specsFor(names), ui_required: [] },
    execution_desired: {
      candidate_id: id,
      requested_strength: 100,
      strength_factor: 1,
      recipe_hash: `live-matrix:${id}`,
      mode: "baseline_relative",
      parameter_specs: specsFor(names),
      compiled_parameters: null,
      compilation: "bridge_reads_pinned_baseline_then_interpolates",
      people_protection: null,
    },
    history_name: `Core33 matrix ${id}`,
    strict: true,
    allow_snapshot_fallback: false,
  };
}

function sameNumber(left, right, tolerance = 0.01) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function assertValues(actual, expected, names, label) {
  for (const name of names) {
    assert.ok(sameNumber(actual[name], expected[name]), `${label}: ${name} expected ${expected[name]}, got ${actual[name]}`);
  }
}

async function save() {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function currentSettings() {
  return transport.call("get_settings", {});
}

async function runGroup(group) {
  const before = await currentSettings();
  const request = applyRequest(before.target, group.names, group.id);
  const applied = await transport.call("apply_transaction", request);
  assert.equal(applied.state, "APPLIED", `${group.id}: apply state`);
  assert.equal(applied.failures.length, 0, `${group.id}: apply failures`);
  const appliedDigest = applied.execution_patch.applied_edit_digest;
  assert.ok(appliedDigest && appliedDigest !== before.baseline_edit_digest, `${group.id}: applied digest did not change`);

  const readback = await transport.call("readback", {
    transaction_id: applied.transaction_id,
    target: before.target,
    expected_current_edit_digest: appliedDigest,
  });
  assert.equal(readback.execution.bridge_state, "READBACK_VERIFIED", `${group.id}: readback state`);
  assert.equal(readback.failures.length, 0, `${group.id}: readback failures`);

  const during = await currentSettings();
  const desired = applied.desired.compiled_parameters;
  assertValues(during.values, desired, group.names, `${group.id} requested`);
  const untouched = CORE33_PARAMETER_NAMES.filter((name) => !group.names.includes(name));
  assertValues(during.values, before.values, untouched, `${group.id} untouched`);

  const rolledBack = await transport.call("rollback", {
    transaction_id: applied.transaction_id,
    target: before.target,
    expected_current_edit_digest: appliedDigest,
  });
  assert.equal(rolledBack.state, "ROLLED_BACK", `${group.id}: rollback state`);
  const after = await currentSettings();
  assert.equal(after.baseline_edit_digest, before.baseline_edit_digest, `${group.id}: baseline digest not restored`);
  assertValues(after.values, before.values, CORE33_PARAMETER_NAMES, `${group.id} rollback values`);

  return {
    id: group.id,
    status: "passed",
    parameters: group.names,
    transaction_id: applied.transaction_id,
    snapshot_id: applied.snapshot.id,
    pre_digest: before.baseline_edit_digest,
    applied_digest: appliedDigest,
    rollback_digest: after.baseline_edit_digest,
    desired,
    readback: readback.readback.values,
    unrequested_parameter_count: untouched.length,
    unrequested_parameters_unchanged: true,
    rollback_verified: true,
  };
}

async function runOutOfScopeAtomicity() {
  const before = await currentSettings();
  const request = applyRequest(before.target, ["exposure"], "out_of_scope_atomicity");
  request.lr_recipe.desired_parameters.temperature = {
    operation: "delta", value: 100, interpolation: "linear",
  };
  let error;
  try {
    await transport.call("apply_transaction", request);
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, "OUT_OF_SCOPE_PARAMETER", "out-of-scope transaction must be rejected before write");
  const after = await currentSettings();
  assert.equal(after.baseline_edit_digest, before.baseline_edit_digest, "out-of-scope rejection changed baseline");
  assertValues(after.values, before.values, CORE33_PARAMETER_NAMES, "out-of-scope atomicity");
  return {
    id: "out_of_scope_atomicity",
    status: "passed",
    injected_parameter: "temperature",
    error_code: error.code,
    pre_digest: before.baseline_edit_digest,
    final_digest: after.baseline_edit_digest,
    zero_write_verified: true,
  };
}

try {
  const ping = await transport.call("ping", {});
  evidence.plugin_version = ping.plugin_version;
  const first = await currentSettings();
  evidence.target = first.target;
  assert.equal(first.target.filename.toLowerCase(), "core33-test-chart.jpg", "matrix only runs on the dedicated test chart");
  assert.ok(["JPG", "JPEG"].includes(String(first.target.format).toUpperCase()), "matrix target must be JPG");
  assert.equal(CORE33_SCOPE.parameters.every((entry) => entry.status === "write_probed"), true, "all Core33 parameters must be write_probed");

  for (const group of selectedGroups) {
    evidence.tests.push(await runGroup(group));
    await save();
  }
  evidence.tests.push(await runOutOfScopeAtomicity());
  const final = await currentSettings();
  evidence.final_edit_digest = final.baseline_edit_digest;
  evidence.baseline_restored = final.baseline_edit_digest === first.baseline_edit_digest;
  evidence.complete = evidence.baseline_restored && evidence.tests.every((test) => test.status === "passed");
  await save();
  process.stdout.write(`${JSON.stringify({ ok: evidence.complete, output: outputPath, passed: evidence.tests.length })}\n`);
} catch (error) {
  evidence.error = { code: error?.code ?? "MATRIX_FAILED", message: error?.message ?? String(error), details: error?.details };
  await save();
  throw error;
} finally {
  await transport.close();
}
