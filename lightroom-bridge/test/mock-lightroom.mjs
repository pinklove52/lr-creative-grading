import crypto from "node:crypto";

const DEFAULT_RANGE = [-100, 100];
const RANGES = {
  temperature: [-100, 100], tint: [-100, 100], exposure: [-5, 5],
  color_grade_shadow_hue: [0, 360], color_grade_midtone_hue: [0, 360],
  color_grade_highlight_hue: [0, 360], color_grade_global_hue: [0, 360],
  color_grade_shadow_saturation: [0, 100], color_grade_midtone_saturation: [0, 100],
  color_grade_highlight_saturation: [0, 100], color_grade_global_saturation: [0, 100],
  grain_amount: [0, 100], grain_size: [0, 100], grain_roughness: [0, 100],
};

function clone(value) { return structuredClone(value); }

function circularDifference(target, baseline, period) {
  return ((target - baseline + period / 2) % period + period) % period - period / 2;
}

function wrap(value, minimum, maximum) {
  const period = maximum - minimum;
  return minimum + (((value - minimum) % period) + period) % period;
}

export class MockLightroom {
  constructor(target, knownParameters) {
    this.target = { ...target };
    this.known = new Set(knownParameters);
    this.values = Object.fromEntries([...this.known].map((key) => [key, 0]));
    this.editRevision = 0;
    this.transactions = new Map();
    this.threshold = 0.5;
    this.failAfter = null;
    this.rollbackCount = 0;
  }

  currentTarget() {
    return { ...this.target, baseline_edit_digest: `edit-${this.editRevision}` };
  }

  compile(spec, baseline, range, factor, key) {
    let desired;
    if (spec.operation === "delta") desired = baseline + spec.value * factor;
    else if (spec.interpolation === "circular_degrees") {
      desired = wrap(baseline + circularDifference(spec.value, baseline, range[1] - range[0]) * factor, ...range);
    } else desired = baseline + (spec.value - baseline) * factor;
    if (!Number.isFinite(desired) || desired < range[0] || desired > range[1]) {
      throw Object.assign(new Error(`${key} out of range`), { code: "OUT_OF_RANGE" });
    }
    return desired;
  }

  apply(request) {
    const actual = this.currentTarget();
    for (const key of ["photo_id", "filename", "source_digest"]) {
      if (String(request.target[key]) !== String(actual[key])) {
        throw Object.assign(new Error(`target mismatch: ${key}`), { code: "TARGET_MISMATCH" });
      }
    }
    if (request.target.baseline_edit_digest !== actual.baseline_edit_digest) {
      throw Object.assign(new Error("baseline mismatch"), { code: "BASELINE_MISMATCH" });
    }
    const factor = request.selection.requested_strength / 100;
    const plan = [];
    for (const [key, spec] of Object.entries(request.lr_recipe.desired_parameters)) {
      if (!this.known.has(key)) {
        throw Object.assign(new Error(`out of scope: ${key}`), { code: "OUT_OF_SCOPE_PARAMETER" });
      }
      const range = RANGES[key] ?? DEFAULT_RANGE;
      plan.push([key, this.compile(spec, this.values[key], range, factor, key)]);
    }
    const before = clone(this.values);
    const transactionId = crypto.randomUUID();
    const applied = {};
    this.threshold = 1.5;
    try {
      for (let index = 0; index < plan.length; index += 1) {
        const [key, value] = plan[index];
        this.values[key] = value;
        applied[key] = { status: "applied", desired: value, engine: "controller" };
        if (this.failAfter != null && index + 1 === this.failAfter) {
          throw Object.assign(new Error("simulated partial acknowledgment"), {
            code: "PARAMETER_APPLY_FAILED",
          });
        }
      }
    } catch (error) {
      this.values = before;
      this.rollbackCount += 1;
      throw Object.assign(new Error("partial apply rolled back"), {
        code: "PARTIAL_APPLY_ROLLED_BACK",
        details: { cause: error.code, transaction_id: transactionId },
      });
    } finally {
      this.threshold = 0.5;
    }
    this.editRevision += 1;
    const transaction = {
      transaction_id: transactionId,
      before,
      applied,
      desired: Object.fromEntries(plan),
      last_known_edit_digest: `edit-${this.editRevision}`,
    };
    this.transactions.set(transactionId, transaction);
    return {
      transaction_id: transactionId,
      state: "APPLIED",
      desired: {
        ...request.execution_desired,
        compiled_parameters: transaction.desired,
        compilation: "compiled_by_bridge_from_pinned_baseline",
      },
      applied,
      readback: { values: clone(this.values), verified: true },
      skipped: [],
      unsupported: request.lr_recipe.ui_required.map((item) => ({ ...item, status: "ui_required" })),
      failures: [],
    };
  }

  rollback(reference) {
    const transaction = this.transactions.get(reference.transaction_id);
    if (!transaction) throw Object.assign(new Error("transaction missing"), { code: "TRANSACTION_NOT_FOUND" });
    const expected = reference.expected_current_edit_digest ?? transaction.last_known_edit_digest;
    if (`edit-${this.editRevision}` !== expected) {
      throw Object.assign(new Error("baseline changed"), { code: "BASELINE_CHANGED" });
    }
    this.values = clone(transaction.before);
    this.editRevision += 1;
    this.rollbackCount += 1;
    return { transaction_id: transaction.transaction_id, state: "ROLLED_BACK" };
  }
}
