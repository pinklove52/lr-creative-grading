const STRENGTH_MIN = 0;
const STRENGTH_MAX = 200;

export class ContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, name) {
  if (!isObject(value)) {
    throw new ContractError("INVALID_REQUEST", `${name} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractError("INVALID_REQUEST", `${name} must be a non-empty string`);
  }
  return value;
}

export function normalizeTarget(input, { required = true } = {}) {
  if (input == null && !required) return undefined;
  const target = assertObject(input, "target");
  const normalized = {
    photo_id: assertNonEmptyString(String(target.photo_id ?? ""), "target.photo_id"),
    filename: assertNonEmptyString(target.filename, "target.filename"),
    source_digest: assertNonEmptyString(target.source_digest, "target.source_digest"),
    baseline_edit_digest: assertNonEmptyString(
      target.baseline_edit_digest,
      "target.baseline_edit_digest",
    ),
  };
  return normalized;
}

function normalizeUiRequired(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ContractError("INVALID_REQUEST", "lr_recipe.ui_required must be an array");
  }
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { operation: assertNonEmptyString(entry, `ui_required[${index}]`) };
    }
    const item = assertObject(entry, `ui_required[${index}]`);
    return {
      ...item,
      operation: assertNonEmptyString(
        item.operation ?? item.type,
        `ui_required[${index}].operation`,
      ),
    };
  });
}

function normalizeCurve(value, name) {
  if (!Array.isArray(value) || value.length < 4 || value.length % 2 !== 0) {
    throw new ContractError("INVALID_REQUEST", `${name} must contain x/y curve pairs`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new ContractError("INVALID_REQUEST", `${name}[${index}] must be finite`);
    }
    return entry;
  });
}

function normalizeParameterSpec(setting, name, legacyNumericMode) {
  if (typeof setting === "number") {
    if (!Number.isFinite(setting)) {
      throw new ContractError("INVALID_REQUEST", `${name} must be finite`);
    }
    if (legacyNumericMode !== "delta") {
      throw new ContractError(
        "AMBIGUOUS_NUMERIC_PARAMETER",
        `${name} is a bare number; set lr_recipe.legacy_numeric_mode='delta' or use an explicit operation`,
      );
    }
    return { operation: "delta", value: setting, interpolation: "linear", legacy: true };
  }

  const spec = assertObject(setting, name);
  if (spec.operation !== "delta" && spec.operation !== "target") {
    throw new ContractError(
      "INVALID_REQUEST",
      `${name}.operation must be 'delta' or 'target'`,
    );
  }
  if (spec.curve_points != null && spec.value != null) {
    if (JSON.stringify(spec.curve_points) !== JSON.stringify(spec.value)) {
      throw new ContractError("CONFLICTING_PARAMETER", `${name}.curve_points and value disagree`);
    }
  }
  const rawValue = spec.curve_points ?? spec.value;
  const isCurve = Array.isArray(rawValue);
  const value = isCurve
    ? normalizeCurve(rawValue, `${name}.curve_points`)
    : (() => {
        if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
          throw new ContractError("INVALID_REQUEST", `${name}.value must be finite or a curve array`);
        }
        return rawValue;
      })();
  if (isCurve && spec.operation !== "target") {
    throw new ContractError("INVALID_REQUEST", `${name} curve recipes only support target operation`);
  }
  const interpolation = spec.interpolation ?? (isCurve ? "curve_points" : "linear");
  const allowed = isCurve
    ? new Set(["curve_points"])
    : new Set(["linear", "circular_degrees"]);
  if (!allowed.has(interpolation)) {
    throw new ContractError(
      "INVALID_REQUEST",
      `${name}.interpolation is incompatible with its value`,
    );
  }
  return isCurve
    ? { operation: spec.operation, value, curve_points: [...value], interpolation }
    : { operation: spec.operation, value, interpolation };
}

function normalizeParameterMap(value, name, legacyNumericMode) {
  if (value == null) return {};
  const input = assertObject(value, name);
  const output = {};
  for (const [key, setting] of Object.entries(input)) {
    assertNonEmptyString(key, `${name} key`);
    output[key] = normalizeParameterSpec(setting, `${name}.${key}`, legacyNumericMode);
  }
  return output;
}

function mergeParameterMaps(parameters, dynamicParameters) {
  const merged = { ...parameters };
  for (const [key, value] of Object.entries(dynamicParameters)) {
    if (Object.hasOwn(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
      throw new ContractError(
        "CONFLICTING_PARAMETER",
        `lr_recipe.parameters and dynamic_parameters disagree for ${key}`,
      );
    }
    merged[key] = value;
  }
  return merged;
}

function findSelectedCandidate(session) {
  const selection = assertObject(session.selection, "selection");
  const candidates = session.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ContractError("INVALID_REQUEST", "candidates must be a non-empty array");
  }
  const candidateId = assertNonEmptyString(
    selection.candidate_id ?? selection.selected_candidate_id,
    "selection.candidate_id",
  );
  const candidate = candidates.find(
    (item) => item?.candidate_id === candidateId || item?.id === candidateId,
  );
  if (!candidate) {
    throw new ContractError("CANDIDATE_NOT_FOUND", `candidate ${candidateId} was not found`);
  }
  return { candidate, selection, candidateId };
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left == null || right == null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    deepEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => deepEqual(left[key], right[key]))
  );
}

function riskIsUnexpected(risk) {
  if (typeof risk === "string") return risk.toLowerCase() === "unexpected";
  if (!isObject(risk)) return false;
  return [risk.classification, risk.category, risk.type, risk.level, risk.kind].some(
    (value) => typeof value === "string" && value.toLowerCase() === "unexpected",
  );
}

function hasUnexpectedRisk(candidate) {
  if (Array.isArray(candidate.risks) && candidate.risks.some(riskIsUnexpected)) return true;
  const assessment = candidate.risk_assessment;
  if (isObject(assessment)) {
    if (Array.isArray(assessment.unexpected) && assessment.unexpected.length > 0) return true;
    if (riskIsUnexpected(assessment)) return true;
  }
  return false;
}

function validateReviewedPreview(session, candidateId, strength, desiredRecipeHash) {
  const previews = assertObject(session.previews, "previews");
  const preview = assertObject(previews[candidateId], `previews.${candidateId}`);
  if (typeof preview.strength !== "number" || Math.abs(preview.strength - strength) > 1e-12) {
    throw new ContractError(
      "UNREVIEWED_STRENGTH",
      `Selected strength ${strength}% differs from the reviewed ${String(preview.strength)}% preview`,
    );
  }
  if (preview.recipe_hash !== desiredRecipeHash) {
    throw new ContractError(
      "UNREVIEWED_RECIPE",
      "Selected preview recipe_hash differs from execution.desired.recipe_hash",
    );
  }
  if (typeof preview.path !== "string" || preview.path.trim() === "") {
    throw new ContractError("INVALID_REQUEST", "Selected preview path must be a non-empty string");
  }
  assertNonEmptyString(preview.artifact_digest, `previews.${candidateId}.artifact_digest`);
  if (!/^[a-f0-9]{64}$/i.test(preview.artifact_digest)) {
    throw new ContractError("INVALID_REQUEST", `previews.${candidateId}.artifact_digest must be a SHA-256 digest`);
  }
  if (Array.isArray(preview.detected_risks) && preview.detected_risks.some(riskIsUnexpected)) {
    throw new ContractError("UNEXPECTED_RISK", "Selected preview contains an unexpected risk");
  }
}

function historyTailState(session) {
  const history =
    session.execution?.state_history ??
    session.state_history ??
    session.execution?.history ??
    session.history;
  if (!Array.isArray(history) || history.length === 0) return null;
  const tail = history[history.length - 1];
  return typeof tail === "string" ? tail : tail?.state ?? tail?.to;
}

function validateSelectedHistory(session) {
  const history = session.execution?.state_history;
  if (!Array.isArray(history)) {
    throw new ContractError("INVALID_SESSION_STATE", "execution.state_history must be an array");
  }
  const states = history.map((entry) =>
    typeof entry === "string" ? entry : entry?.state ?? entry?.to,
  );
  const expected = ["ACQUIRE", "ANALYZED", "PREVIEWED", "SELECTED"];
  if (!deepEqual(states, expected)) {
    throw new ContractError(
      "INVALID_SESSION_STATE",
      `execution.state_history must equal ${expected.join("→")} before apply`,
    );
  }
}

function validateSelectedSession(session, candidate, selection, candidateId, normalizedRecipe) {
  if (session.session_version !== "1.0.0") {
    throw new ContractError(
      "UNSUPPORTED_SESSION_VERSION",
      "Only GradeSession session_version 1.0.0 can be applied",
    );
  }
  const execution = assertObject(session.execution, "execution");
  if (typeof session.session_id !== "string" || session.session_id.trim() === "") {
    throw new ContractError("INVALID_REQUEST", "GradeSession session_id must be a non-empty string");
  }
  if (!Number.isInteger(session.revision) || session.revision < 0) {
    throw new ContractError("INVALID_REQUEST", "GradeSession revision must be a non-negative integer");
  }
  if (session.target?.live_applicable !== true) {
    throw new ContractError("FILE_ONLY_SESSION", "File-only GradeSession cannot be applied to Lightroom");
  }
  if (execution.state !== "SELECTED") {
    throw new ContractError(
      "INVALID_SESSION_STATE",
      `GradeSession must be SELECTED, not ${String(execution.state)}`,
    );
  }
  validateSelectedHistory(session);
  const tailState = historyTailState(session);
  if (tailState != null && tailState !== "SELECTED") {
    throw new ContractError(
      "INVALID_SESSION_STATE",
      `GradeSession state-history tail must be SELECTED, not ${String(tailState)}`,
    );
  }
  if (execution.transaction_id != null && execution.transaction_id !== "") {
    throw new ContractError("INVALID_SESSION_STATE", "GradeSession already has a transaction_id");
  }
  if (hasUnexpectedRisk(candidate)) {
    throw new ContractError(
      "UNEXPECTED_RISK",
      `Selected candidate ${candidateId} contains an unexpected risk and cannot be applied`,
    );
  }

  const desired = assertObject(execution.desired, "execution.desired");
  if (String(desired.candidate_id ?? "") !== String(candidateId)) {
    throw new ContractError("SESSION_INCONSISTENT", "execution.desired.candidate_id differs from selection");
  }
  const strength = normalizeStrength(selection.requested_strength);
  if (desired.requested_strength !== strength) {
    throw new ContractError(
      "SESSION_INCONSISTENT",
      "execution.desired.requested_strength differs from selection.requested_strength",
    );
  }
  const factor = strength / 100;
  if (typeof desired.strength_factor !== "number" || Math.abs(desired.strength_factor - factor) > 1e-12) {
    throw new ContractError("SESSION_INCONSISTENT", "execution.desired.strength_factor is stale");
  }
  if (desired.mode !== "baseline_relative") {
    throw new ContractError("SESSION_INCONSISTENT", "execution.desired.mode must be baseline_relative");
  }
  if (desired.compilation !== "bridge_reads_pinned_baseline_then_interpolates") {
    throw new ContractError("SESSION_INCONSISTENT", "execution.desired.compilation is unsupported");
  }
  if (desired.compiled_parameters !== null) {
    throw new ContractError(
      "SESSION_INCONSISTENT",
      "execution.desired.compiled_parameters must be null before bridge compilation",
    );
  }
  const desiredSpecs = normalizeParameterMap(
    desired.parameter_specs,
    "execution.desired.parameter_specs",
    normalizedRecipe.legacy_numeric_mode,
  );
  if (!deepEqual(desiredSpecs, normalizedRecipe.desired_parameters)) {
    throw new ContractError(
      "SESSION_INCONSISTENT",
      "execution.desired.parameter_specs differs from the selected candidate recipe",
    );
  }
  assertNonEmptyString(desired.recipe_hash, "execution.desired.recipe_hash");
  validateReviewedPreview(session, candidateId, strength, desired.recipe_hash);
  // recipe_hash is strength-specific and therefore belongs to execution.desired,
  // not the PREVIEWED candidate. Candidate/strength/spec consistency is checked
  // structurally above; the preview engine owns the canonical hash algorithm.
}

function normalizeStrength(value) {
  const strength = value ?? 100;
  if (
    typeof strength !== "number" ||
    !Number.isFinite(strength) ||
    strength < STRENGTH_MIN ||
    strength > STRENGTH_MAX
  ) {
    throw new ContractError(
      "INVALID_STRENGTH",
      `selection.requested_strength must be between ${STRENGTH_MIN} and ${STRENGTH_MAX}`,
    );
  }
  return strength;
}

function normalizeRecipe(recipeInput) {
  const recipe = assertObject(recipeInput, "candidate.lr_recipe");
  if (recipe.legacy_numeric_mode != null && recipe.legacy_numeric_mode !== "delta") {
    throw new ContractError(
      "INVALID_REQUEST",
      "lr_recipe.legacy_numeric_mode, when present, must be 'delta'",
    );
  }
  const parameters = normalizeParameterMap(
    recipe.parameters,
    "lr_recipe.parameters",
    recipe.legacy_numeric_mode,
  );
  const dynamicParameters = normalizeParameterMap(
    recipe.dynamic_parameters,
    "lr_recipe.dynamic_parameters",
    recipe.legacy_numeric_mode,
  );
  const merged = mergeParameterMaps(parameters, dynamicParameters);
  if (Object.keys(merged).length === 0 && !recipe.preset_uuid) {
    throw new ContractError(
      "EMPTY_RECIPE",
      "lr_recipe must contain a preset_uuid or at least one parameter",
    );
  }
  let presetAmount = recipe.preset_amount ?? 100;
  if (
    typeof presetAmount !== "number" ||
    !Number.isInteger(presetAmount) ||
    presetAmount < 0 ||
    presetAmount > 200
  ) {
    throw new ContractError("INVALID_REQUEST", "lr_recipe.preset_amount must be an integer 0..200");
  }
  if (recipe.preset_uuid != null) {
    assertNonEmptyString(recipe.preset_uuid, "lr_recipe.preset_uuid");
  }
  return {
    preset_uuid: recipe.preset_uuid ?? null,
    preset_amount: presetAmount,
    parameters,
    dynamic_parameters: dynamicParameters,
    desired_parameters: merged,
    legacy_numeric_mode: recipe.legacy_numeric_mode ?? null,
    ui_required: normalizeUiRequired(recipe.ui_required),
  };
}

/**
 * Compile either a full GradeSession or an already-normalized request into the
 * strict payload understood by the Lua bridge. The Lua side pins the current
 * baseline and compiles these operation specs at 0..200% strength.
 */
export function compileApplyTransaction(input, { requireFullSession = false } = {}) {
  const request = assertObject(input, "apply_transaction input");
  let sessionVersion;
  let target;
  let candidate;
  let selection;
  let candidateId;

  if (requireFullSession && !Array.isArray(request.candidates)) {
    throw new ContractError(
      "FULL_SESSION_REQUIRED",
      "Public apply_transaction requires a complete GradeSession 1.0.0",
    );
  }
  if (Array.isArray(request.candidates)) {
    sessionVersion = assertNonEmptyString(request.session_version, "session_version");
    target = normalizeTarget(request.target);
    ({ candidate, selection, candidateId } = findSelectedCandidate(request));
  } else {
    sessionVersion = request.session_version ?? "bridge-request/1";
    target = normalizeTarget(request.target);
    candidate = request.candidate ?? request;
    selection = request.selection ?? {};
    candidateId = candidate.candidate_id ?? candidate.id ?? "direct";
  }

  const recipe = normalizeRecipe(candidate.lr_recipe ?? request.lr_recipe);
  if (Array.isArray(request.candidates)) {
    validateSelectedSession(request, candidate, selection, candidateId, recipe);
  }
  const requestedStrength = normalizeStrength(selection.requested_strength);
  const historyName = request.history_name ?? `Creative grade: ${candidateId}`;
  assertNonEmptyString(historyName, "history_name");

  return {
    session_version: sessionVersion,
    target,
    candidate: {
      candidate_id: String(candidateId),
      route: candidate.route ?? candidate.type ?? candidate.kind ?? null,
      recipe_hash: request.execution?.desired?.recipe_hash ?? candidate.recipe_hash ?? null,
    },
    selection: { requested_strength: requestedStrength },
    lr_recipe: recipe,
    execution_desired: {
      candidate_id: String(candidateId),
      requested_strength: requestedStrength,
      strength_factor: requestedStrength / 100,
      recipe_hash: request.execution?.desired?.recipe_hash ?? candidate.recipe_hash ?? null,
      mode: "baseline_relative",
      parameter_specs: recipe.desired_parameters,
      compiled_parameters: null,
      compilation: "bridge_reads_pinned_baseline_then_interpolates",
      people_protection: request.execution?.desired?.people_protection ?? null,
    },
    history_name: historyName,
    strict: request.strict !== false,
    allow_snapshot_fallback: request.allow_snapshot_fallback === true,
  };
}

export function normalizeTransactionReference(input) {
  const value = assertObject(input, "transaction reference");
  const transactionId =
    value.transaction_id ?? value.execution?.transaction_id ?? value.execution?.id;
  return {
    transaction_id: assertNonEmptyString(transactionId, "transaction_id"),
    target: value.target ? normalizeTarget(value.target) : undefined,
    expected_current_edit_digest:
      value.expected_current_edit_digest == null
        ? undefined
        : assertNonEmptyString(
            value.expected_current_edit_digest,
            "expected_current_edit_digest",
          ),
  };
}

export function toErrorData(error) {
  if (error instanceof ContractError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: error?.code ?? "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details: error?.details,
  };
}
