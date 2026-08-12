export const TARGET = Object.freeze({
  photo_id: "42",
  filename: "fixture.dng",
  source_digest: "source-identity-sha256",
  baseline_edit_digest: "edit-0",
  proxy_digest: "proxy-bytes-sha256",
  live_applicable: true,
});

export const PARAMETER_SPECS = Object.freeze({
  temperature: { operation: "delta", value: 300, interpolation: "linear" },
  tint: { operation: "target", value: 8, interpolation: "linear" },
  exposure: { operation: "delta", value: 0.35, interpolation: "linear" },
  highlights: { operation: "target", value: -24, interpolation: "linear" },
  shadows: { operation: "target", value: 31, interpolation: "linear" },
  contrast: { operation: "delta", value: 18, interpolation: "linear" },
  whites: { operation: "target", value: 14, interpolation: "linear" },
  blacks: { operation: "target", value: -19, interpolation: "linear" },
  texture: { operation: "delta", value: 12, interpolation: "linear" },
  clarity: { operation: "delta", value: 9, interpolation: "linear" },
  dehaze: { operation: "delta", value: 7, interpolation: "linear" },
  vibrance: { operation: "delta", value: 16, interpolation: "linear" },
  saturation: { operation: "delta", value: -3, interpolation: "linear" },
  hue_orange: { operation: "target", value: -8, interpolation: "linear" },
  saturation_blue: { operation: "target", value: 22, interpolation: "linear" },
  luminance_green: { operation: "target", value: -12, interpolation: "linear" },
  color_grade_shadow_hue: { operation: "target", value: 205, interpolation: "circular_degrees" },
  color_grade_shadow_saturation: { operation: "target", value: 18, interpolation: "linear" },
  color_grade_midtone_hue: { operation: "target", value: 32, interpolation: "circular_degrees" },
  color_grade_midtone_saturation: { operation: "target", value: 11, interpolation: "linear" },
  color_grade_highlight_hue: { operation: "target", value: 48, interpolation: "circular_degrees" },
  color_grade_highlight_saturation: { operation: "target", value: 21, interpolation: "linear" },
  grain_amount: { operation: "target", value: 26, interpolation: "linear" },
  grain_size: { operation: "target", value: 31, interpolation: "linear" },
  blue_primary_hue: { operation: "target", value: -14, interpolation: "linear" },
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
