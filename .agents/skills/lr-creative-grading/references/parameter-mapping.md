# Lightroom parameter mapping

The recipe uses the canonical logical names below. The bridge resolves each through its ParameterCatalog, and the current capabilities response must prove that the resolved identifier is writable in the running Lightroom build.

## Mapping rules

1. Start from the current rendered develop state, not camera defaults.
2. Send sparse updates only. A missing field means preserve it.
3. Read ranges and types at runtime before compilation.
4. Record canonical name, resolved SDK identifier, desired value, applied value, and readback value separately.
5. Reject unknown or out-of-range values. Never silently clamp.
6. Keep offline preview operations and Lightroom settings separate.

Each scalar entry in lr_recipe.parameters is:

    {
      "operation": "delta" or "target",
      "value": number,
      "interpolation": "linear" or "circular_degrees"
    }

Bare numeric values are invalid. They may be accepted only when the recipe explicitly declares legacy_numeric_mode delta, and the compiler must normalize them into full specs before target validation or application.

At strength factor s = requested_strength / 100:

- delta resolves to baseline + s times value;
- target resolves to baseline + s times the shortest valid path from baseline to value;
- circular_degrees always follows the shortest hue arc;
- 0% is baseline, 100% is design, and 200% extrapolates the same design.

## Common global controls

| Canonical group | Logical names | SDK probe candidates |
| --- | --- | --- |
| white balance | temperature, tint | Temperature, Tint |
| tone | exposure, contrast, highlights, shadows, whites, blacks | Exposure, Contrast, Highlights, Shadows, Whites, Blacks |
| presence | texture, clarity, dehaze | Texture, Clarity, Dehaze |
| global color | vibrance, saturation | Vibrance, Saturation |
| vignette | post_crop_vignette_amount, midpoint, roundness, feather, highlight_contrast | PostCropVignetteAmount, PostCropVignetteMidpoint, PostCropVignetteRoundness, PostCropVignetteFeather, PostCropVignetteHighlightContrast |
| grain | grain_amount, grain_size, grain_roughness | GrainAmount, GrainSize, GrainFrequency |

The Lightroom controller exposes `Temperature` and `Tint` on the controller
slider scale (`-100..100`), not in Kelvin. Recipes sent through the controller
bridge must use that scale; Kelvin values belong to a different develop-setting
representation and must not be passed as controller deltas.

White balance may be represented as absolute values by Lightroom. Use target for an authored absolute design value and delta for a baseline-relative shift. Strength interpolation must use the pinned baseline values and runtime range.

## Color mixer

For each lowercase channel red, orange, yellow, green, aqua, blue, purple, and magenta, use:

- hue_<channel> -> HueAdjustment<Channel>;
- saturation_<channel> -> SaturationAdjustment<Channel>;
- luminance_<channel> -> LuminanceAdjustment<Channel>.

Only include channels owned by the selected recipe. Person-protection compilation must review Red, Orange, and neighboring channels before application.

## Color grading

The bridge catalog resolves:

- color_grade_shadow_hue -> SplitToningShadowHue;
- color_grade_shadow_saturation -> SplitToningShadowSaturation;
- color_grade_shadow_luminance -> ColorGradeShadowLum;
- color_grade_highlight_hue -> SplitToningHighlightHue;
- color_grade_highlight_saturation -> SplitToningHighlightSaturation;
- color_grade_highlight_luminance -> ColorGradeHighlightLum;
- color_grade_midtone_hue, saturation, luminance -> ColorGradeMidtoneHue, ColorGradeMidtoneSat, ColorGradeMidtoneLum;
- color_grade_global_hue, saturation, luminance -> ColorGradeGlobalHue, ColorGradeGlobalSat, ColorGradeGlobalLum;
- color_grade_balance -> SplitToningBalance;
- color_grade_blending -> ColorGradeBlending.

This is an explicit controller compatibility mapping, not a claim that old and new Adobe panel semantics are pixel-identical. Accept it only when capabilities reports the identifier and range.

## Calibration

Use shadow_tint -> ShadowTint; red_primary_hue/saturation -> RedHue/RedSaturation; green_primary_hue/saturation -> GreenHue/GreenSaturation; and blue_primary_hue/saturation -> BlueHue/BlueSaturation. Calibration can create strong channel interactions; always read it back and include it in Break risk checks.

## Curves

Represent curves as a target spec with curve_points containing ordered input/output pairs for:

- composite RGB;
- red;
- green;
- blue.

Canonical names resolve to tone_curve -> ToneCurvePV2012, tone_curve_red -> ToneCurvePV2012Red, tone_curve_green -> ToneCurvePV2012Green, and tone_curve_blue -> ToneCurvePV2012Blue. The bridge applies these structured settings through photo:applyDevelopSettings rather than numeric LrDevelopController.setValue. If the current SDK cannot set and read back the curve reliably, classify it as unsupported or move it to the declared preset seed. Never approximate it with unrelated sliders while claiming high fidelity.

## Parameters outside the default global transaction

Preserve these unless the selected recipe or a separate user request explicitly owns them:

- crop and rotation;
- healing and content-aware removal;
- masks and local brushes;
- lens corrections and chromatic-aberration settings;
- transform and perspective;
- sharpening and noise reduction;
- metadata, ratings, flags, and export settings.

Person/subject masks, complex local brushes, healing, and requested crop are UI fallback operations. They do not justify field-by-field UI entry for global settings.

## Applied status

Every desired parameter receives one status:

- applied: supported, written, and read back within its type-specific tolerance;
- skipped: intentionally omitted with a recorded reason;
- unsupported: runtime capabilities prove it cannot be set reliably.

An unexpected skipped or unsupported parameter blocks the transaction. A candidate may intentionally omit a parameter before selection, but the bridge must not invent that decision during application.
