import { CORE33_SCOPE, CORE33_SCOPE_DIGEST } from "../src/core33-scope.mjs";

export const SCOPE = Object.freeze({ scope_id: CORE33_SCOPE.scope_id, scope_digest: CORE33_SCOPE_DIGEST });

export const TARGET = Object.freeze({
  photo_id: "42",
  filename: "fixture.jpg",
  format: "JPG",
  source_digest: "source-identity-sha256",
  baseline_edit_digest: "edit-0",
  proxy_digest: "proxy-bytes-sha256",
  live_applicable: true,
});

export const PARAMETER_SPECS = Object.freeze({
  exposure: { operation: "delta", value: 0.35, interpolation: "linear" },
  contrast: { operation: "delta", value: 18, interpolation: "linear" },
  highlights: { operation: "target", value: -24, interpolation: "linear" },
  shadows: { operation: "target", value: 31, interpolation: "linear" },
  whites: { operation: "target", value: 14, interpolation: "linear" },
  blacks: { operation: "target", value: -19, interpolation: "linear" },
  texture: { operation: "delta", value: 12, interpolation: "linear" },
  clarity: { operation: "delta", value: 9, interpolation: "linear" },
  dehaze: { operation: "delta", value: 7, interpolation: "linear" },
  ...Object.fromEntries(["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"].flatMap((color) => [
    [`hue_${color}`, { operation: "delta", value: 4, interpolation: "linear" }],
    [`saturation_${color}`, { operation: "delta", value: 6, interpolation: "linear" }],
    [`luminance_${color}`, { operation: "delta", value: -3, interpolation: "linear" }],
  ])),
});

export function makeGradeSession(overrides = {}) {
  const strength = overrides.requested_strength ?? 100;
  const recipeHash = overrides.recipe_hash ?? "recipe-sha256";
  const candidateId = overrides.candidate_id ?? "amplify-1";
  const parameterSpecs = structuredClone(overrides.parameter_specs ?? PARAMETER_SPECS);
  const candidate = {
    candidate_id: candidateId,
    route: "amplify",
    recipe_hash: recipeHash,
    risks: overrides.risks ?? [
      { kind: "intentional", code: "deep_blacks", message: "Designed shadow compression" },
    ],
    lr_recipe: {
      preset_uuid: null,
      preset_amount: 100,
      parameters: parameterSpecs,
      dynamic_parameters: {},
      ui_required: [
        { operation: "person_mask_compensation", reason: "Protect face and skin after globals" },
      ],
    },
  };
  return {
    session_version: overrides.session_version ?? "1.0.0",
    scope_id: overrides.scope_id ?? CORE33_SCOPE.scope_id,
    scope_digest: overrides.scope_digest ?? CORE33_SCOPE_DIGEST,
    session_id: overrides.session_id ?? "session-fixture-1",
    revision: overrides.revision ?? 3,
    target: { ...TARGET, ...(overrides.target ?? {}) },
    photo_dna: { source_digest: TARGET.proxy_digest },
    candidates: [candidate],
    selection: { candidate_id: candidateId, requested_strength: strength },
    execution: {
      state: overrides.state ?? "SELECTED",
      state_history: overrides.state_history ?? ["ACQUIRE", "ANALYZED", "PREVIEWED", "SELECTED"],
      transaction_id: overrides.transaction_id ?? null,
      desired: {
        candidate_id: candidateId,
        requested_strength: strength,
        strength_factor: strength / 100,
        recipe_hash: recipeHash,
        mode: "baseline_relative",
        parameter_specs: structuredClone(parameterSpecs),
        compiled_parameters: null,
        compilation: "bridge_reads_pinned_baseline_then_interpolates",
        people_protection: { required: true },
      },
      applied: {}, readback: {}, failures: [],
    },
    previews: {
      [candidateId]: {
        path: `previews/${candidateId}.jpg`,
        strength,
        recipe_hash: recipeHash,
        artifact_digest: "a".repeat(64),
        detected_risks: [],
      },
    },
    collection: { saved: false },
  };
}
