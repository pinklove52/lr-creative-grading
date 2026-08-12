local Catalog = {}

-- Only reversible global creative controls are exposed. Geometry, masks,
-- healing, red-eye, AI operations, and lens correction remain outside this
-- bridge even when a newer SDK happens to expose parts of those surfaces.
Catalog.entries = {
    { logical = "temperature", lr = "Temperature", engine = "controller" },
    { logical = "tint", lr = "Tint", engine = "controller" },
    { logical = "exposure", lr = "Exposure", engine = "controller" },
    { logical = "highlights", lr = "Highlights", engine = "controller" },
    { logical = "shadows", lr = "Shadows", engine = "controller" },
    { logical = "contrast", lr = "Contrast", engine = "controller" },
    { logical = "whites", lr = "Whites", engine = "controller" },
    { logical = "blacks", lr = "Blacks", engine = "controller" },
    { logical = "texture", lr = "Texture", engine = "controller" },
    { logical = "clarity", lr = "Clarity", engine = "controller" },
    { logical = "dehaze", lr = "Dehaze", engine = "controller" },
    { logical = "vibrance", lr = "Vibrance", engine = "controller" },
    { logical = "saturation", lr = "Saturation", engine = "controller" },
    { logical = "profile_amount", lr = "ProfileAmount", engine = "controller" },

    { logical = "parametric_darks", lr = "ParametricDarks", engine = "controller" },
    { logical = "parametric_lights", lr = "ParametricLights", engine = "controller" },
    { logical = "parametric_shadows", lr = "ParametricShadows", engine = "controller" },
    { logical = "parametric_highlights", lr = "ParametricHighlights", engine = "controller" },
    { logical = "curve_refine_saturation", lr = "CurveRefineSaturation", engine = "controller" },

    { logical = "hue_red", lr = "HueAdjustmentRed", engine = "controller" },
    { logical = "hue_orange", lr = "HueAdjustmentOrange", engine = "controller" },
    { logical = "hue_yellow", lr = "HueAdjustmentYellow", engine = "controller" },
    { logical = "hue_green", lr = "HueAdjustmentGreen", engine = "controller" },
    { logical = "hue_aqua", lr = "HueAdjustmentAqua", engine = "controller" },
    { logical = "hue_blue", lr = "HueAdjustmentBlue", engine = "controller" },
    { logical = "hue_purple", lr = "HueAdjustmentPurple", engine = "controller" },
    { logical = "hue_magenta", lr = "HueAdjustmentMagenta", engine = "controller" },
    { logical = "saturation_red", lr = "SaturationAdjustmentRed", engine = "controller" },
    { logical = "saturation_orange", lr = "SaturationAdjustmentOrange", engine = "controller" },
    { logical = "saturation_yellow", lr = "SaturationAdjustmentYellow", engine = "controller" },
    { logical = "saturation_green", lr = "SaturationAdjustmentGreen", engine = "controller" },
    { logical = "saturation_aqua", lr = "SaturationAdjustmentAqua", engine = "controller" },
    { logical = "saturation_blue", lr = "SaturationAdjustmentBlue", engine = "controller" },
    { logical = "saturation_purple", lr = "SaturationAdjustmentPurple", engine = "controller" },
    { logical = "saturation_magenta", lr = "SaturationAdjustmentMagenta", engine = "controller" },
    { logical = "luminance_red", lr = "LuminanceAdjustmentRed", engine = "controller" },
    { logical = "luminance_orange", lr = "LuminanceAdjustmentOrange", engine = "controller" },
    { logical = "luminance_yellow", lr = "LuminanceAdjustmentYellow", engine = "controller" },
    { logical = "luminance_green", lr = "LuminanceAdjustmentGreen", engine = "controller" },
    { logical = "luminance_aqua", lr = "LuminanceAdjustmentAqua", engine = "controller" },
    { logical = "luminance_blue", lr = "LuminanceAdjustmentBlue", engine = "controller" },
    { logical = "luminance_purple", lr = "LuminanceAdjustmentPurple", engine = "controller" },
    { logical = "luminance_magenta", lr = "LuminanceAdjustmentMagenta", engine = "controller" },

    { logical = "color_grade_shadow_hue", lr = "SplitToningShadowHue", engine = "controller", circular = true },
    { logical = "color_grade_shadow_saturation", lr = "SplitToningShadowSaturation", engine = "controller" },
    { logical = "color_grade_shadow_luminance", lr = "ColorGradeShadowLum", engine = "controller" },
    { logical = "color_grade_highlight_hue", lr = "SplitToningHighlightHue", engine = "controller", circular = true },
    { logical = "color_grade_highlight_saturation", lr = "SplitToningHighlightSaturation", engine = "controller" },
    { logical = "color_grade_highlight_luminance", lr = "ColorGradeHighlightLum", engine = "controller" },
    { logical = "color_grade_midtone_hue", lr = "ColorGradeMidtoneHue", engine = "controller", circular = true },
    { logical = "color_grade_midtone_saturation", lr = "ColorGradeMidtoneSat", engine = "controller" },
    { logical = "color_grade_midtone_luminance", lr = "ColorGradeMidtoneLum", engine = "controller" },
    { logical = "color_grade_global_hue", lr = "ColorGradeGlobalHue", engine = "controller", circular = true },
    { logical = "color_grade_global_saturation", lr = "ColorGradeGlobalSat", engine = "controller" },
    { logical = "color_grade_global_luminance", lr = "ColorGradeGlobalLum", engine = "controller" },
    { logical = "color_grade_balance", lr = "SplitToningBalance", engine = "controller" },
    { logical = "color_grade_blending", lr = "ColorGradeBlending", engine = "controller" },

    { logical = "sharpness", lr = "Sharpness", engine = "controller" },
    { logical = "sharpen_radius", lr = "SharpenRadius", engine = "controller" },
    { logical = "sharpen_detail", lr = "SharpenDetail", engine = "controller" },
    { logical = "sharpen_masking", lr = "SharpenEdgeMasking", engine = "controller" },
    { logical = "luminance_noise_reduction", lr = "LuminanceSmoothing", engine = "controller" },
    { logical = "color_noise_reduction", lr = "ColorNoiseReduction", engine = "controller" },

    { logical = "post_crop_vignette_amount", lr = "PostCropVignetteAmount", engine = "controller" },
    { logical = "post_crop_vignette_midpoint", lr = "PostCropVignetteMidpoint", engine = "controller" },
    { logical = "post_crop_vignette_feather", lr = "PostCropVignetteFeather", engine = "controller" },
    { logical = "post_crop_vignette_roundness", lr = "PostCropVignetteRoundness", engine = "controller" },
    { logical = "post_crop_vignette_highlight_contrast", lr = "PostCropVignetteHighlightContrast", engine = "controller" },
    { logical = "grain_amount", lr = "GrainAmount", engine = "controller" },
    { logical = "grain_size", lr = "GrainSize", engine = "controller" },
    { logical = "grain_roughness", lr = "GrainFrequency", engine = "controller" },

    { logical = "shadow_tint", lr = "ShadowTint", engine = "controller" },
    { logical = "red_primary_hue", lr = "RedHue", engine = "controller" },
    { logical = "red_primary_saturation", lr = "RedSaturation", engine = "controller" },
    { logical = "green_primary_hue", lr = "GreenHue", engine = "controller" },
    { logical = "green_primary_saturation", lr = "GreenSaturation", engine = "controller" },
    { logical = "blue_primary_hue", lr = "BlueHue", engine = "controller" },
    { logical = "blue_primary_saturation", lr = "BlueSaturation", engine = "controller" },

    -- Point/channel curves are the only structured settings route. They use
    -- photo:applyDevelopSettings because LrDevelopController.setValue accepts
    -- numeric values only. Capability output makes this distinction explicit.
    { logical = "tone_curve", lr = "ToneCurvePV2012", engine = "develop_settings", kind = "curve" },
    { logical = "tone_curve_red", lr = "ToneCurvePV2012Red", engine = "develop_settings", kind = "curve" },
    { logical = "tone_curve_green", lr = "ToneCurvePV2012Green", engine = "develop_settings", kind = "curve" },
    { logical = "tone_curve_blue", lr = "ToneCurvePV2012Blue", engine = "develop_settings", kind = "curve" },
}

Catalog.byLogical = {}
Catalog.byLightroom = {}
for _, entry in ipairs(Catalog.entries) do
    Catalog.byLogical[entry.logical] = entry
    Catalog.byLightroom[entry.lr] = entry
end

Catalog.uiRequired = {
    { operation = "person_mask_compensation", reason = "AI/person masks require Lightroom UI review" },
    { operation = "subject_mask", reason = "Mask topology is deliberately outside global transactions" },
    { operation = "complex_local_brush", reason = "Local brush geometry requires UI" },
    { operation = "crop", reason = "Composition and crop remain a visual UI operation" },
    { operation = "heal", reason = "Healing content and generative variations require UI" },
}

Catalog.protectedPresetKeys = {
    CropTop = true, CropBottom = true, CropLeft = true, CropRight = true,
    CropAngle = true, straightenAngle = true, RetouchInfo = true,
    RedEyeInfo = true, MaskGroupBasedCorrections = true,
    EnableMaskGroupBasedCorrections = true, EnableRetouch = true,
    EnableRedEye = true, LensProfileEnable = true, EnableLensCorrections = true,
    PerspectiveVertical = true, PerspectiveHorizontal = true,
    PerspectiveRotate = true, PerspectiveScale = true, PerspectiveAspect = true,
    PerspectiveX = true, PerspectiveY = true, PerspectiveUpright = true,
}

function Catalog.resolve(name)
    return Catalog.byLogical[name] or Catalog.byLightroom[name]
end

return Catalog
