import assert from "node:assert/strict";
import test from "node:test";
import { compileApplyTransaction } from "../src/grade-session.mjs";
import { loadCanonicalCatalog } from "../src/catalog-contract.mjs";
import { makeGradeSession, TARGET } from "./fixtures.mjs";
import { MockLightroom } from "./mock-lightroom.mjs";

async function setup(overrides = {}) {
  const catalog = await loadCanonicalCatalog();
  const mock = new MockLightroom(TARGET, catalog);
  const request = compileApplyTransaction(makeGradeSession(overrides));
  return { mock, request };
}

test("rejects target and baseline mismatches before any field changes", async () => {
  const { mock, request } = await setup();
  request.target.photo_id = "99";
  assert.throws(() => mock.apply(request), (error) => error.code === "TARGET_MISMATCH");
  assert.equal(mock.editRevision, 0);
  const fresh = compileApplyTransaction(makeGradeSession());
  fresh.target.baseline_edit_digest = "edit-stale";
  assert.throws(() => mock.apply(fresh), (error) => error.code === "BASELINE_MISMATCH");
  assert.equal(mock.editRevision, 0);
});

test("rejects unknown and strength-extrapolated out-of-range parameters atomically", async () => {
  const { mock, request } = await setup();
  request.lr_recipe.desired_parameters.not_a_slider = {
    operation: "delta", value: 1, interpolation: "linear",
  };
  assert.throws(() => mock.apply(request), (error) => error.code === "OUT_OF_SCOPE_PARAMETER");
  assert.equal(mock.editRevision, 0);

  const out = compileApplyTransaction(makeGradeSession({ requested_strength: 200 }));
  out.lr_recipe.desired_parameters.exposure = {
    operation: "delta", value: 4, interpolation: "linear",
  };
  assert.throws(() => mock.apply(out), (error) => error.code === "OUT_OF_RANGE");
  assert.equal(mock.editRevision, 0);
});

test("sends all 33 Core33 settings as one preflighted transaction and reports ui_required", async () => {
  const { mock, request } = await setup();
  const result = mock.apply(request);
  assert.equal(Object.keys(result.applied).length, 33);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].status, "ui_required");
  assert.deepEqual(Object.keys(result.desired.compiled_parameters).sort(), Object.keys(result.applied).sort());
  assert.equal(result.failures.length, 0);
  assert.equal(mock.threshold, 0.5);
});

test("partial acknowledgment automatically rolls back and always resets history threshold", async () => {
  const { mock, request } = await setup();
  const before = structuredClone(mock.values);
  mock.failAfter = 8;
  assert.throws(() => mock.apply(request), (error) => error.code === "PARTIAL_APPLY_ROLLED_BACK");
  assert.deepEqual(mock.values, before);
  assert.equal(mock.rollbackCount, 1);
  assert.equal(mock.threshold, 0.5);
});

test("explicit rollback works only while the applied edit digest is still current", async () => {
  const { mock, request } = await setup();
  const before = structuredClone(mock.values);
  const applied = mock.apply(request);
  mock.rollback({ transaction_id: applied.transaction_id });
  assert.deepEqual(mock.values, before);

  const second = mock.apply({ ...request, target: mock.currentTarget() });
  mock.editRevision += 1; // simulate a manual edit after apply
  assert.throws(
    () => mock.rollback({ transaction_id: second.transaction_id }),
    (error) => error.code === "BASELINE_CHANGED",
  );
});

test("0/100/200 strength pins baseline, reaches design, and extrapolates Core33 controls", async () => {
  const catalog = await loadCanonicalCatalog();
  for (const [strength, expected] of [
    [0, { contrast: 10, exposure: 1, hue: -10 }],
    [100, { contrast: 20, exposure: 2, hue: 10 }],
    [200, { contrast: 30, exposure: 3, hue: 30 }],
  ]) {
    const mock = new MockLightroom(TARGET, catalog);
    mock.values.contrast = 10;
    mock.values.exposure = 1;
    mock.values.hue_red = -10;
    const session = makeGradeSession({
      requested_strength: strength,
      parameter_specs: {
        contrast: { operation: "delta", value: 10, interpolation: "linear" },
        exposure: { operation: "target", value: 2, interpolation: "linear" },
        hue_red: { operation: "delta", value: 20, interpolation: "linear" },
      },
    });
    const result = mock.apply(compileApplyTransaction(session));
    assert.equal(result.desired.compiled_parameters.contrast, expected.contrast);
    assert.equal(result.desired.compiled_parameters.exposure, expected.exposure);
    assert.equal(result.desired.compiled_parameters.hue_red, expected.hue);
  }
});
