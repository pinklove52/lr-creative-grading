-- Generated from lightroom-bridge/config/jpg-core33-v1.json. Do not hand edit.
local Catalog = {}
Catalog.scopeId = "jpg-core33-v1"
Catalog.scopeDigest = "d1542ea82da680d2405c7b0d376e02099a6fb8c9b0f55ec8969c8ca8e3d32c01"
Catalog.sourceFormat = "JPG"
Catalog.entries = {
    { logical = "exposure", lr = "Exposure", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "contrast", lr = "Contrast", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "highlights", lr = "Highlights", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "shadows", lr = "Shadows", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "whites", lr = "Whites", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "blacks", lr = "Blacks", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "texture", lr = "Texture", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "clarity", lr = "Clarity", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "dehaze", lr = "Dehaze", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_red", lr = "HueAdjustmentRed", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_orange", lr = "HueAdjustmentOrange", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_yellow", lr = "HueAdjustmentYellow", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_green", lr = "HueAdjustmentGreen", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_aqua", lr = "HueAdjustmentAqua", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_blue", lr = "HueAdjustmentBlue", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_purple", lr = "HueAdjustmentPurple", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "hue_magenta", lr = "HueAdjustmentMagenta", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_red", lr = "SaturationAdjustmentRed", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_orange", lr = "SaturationAdjustmentOrange", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_yellow", lr = "SaturationAdjustmentYellow", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_green", lr = "SaturationAdjustmentGreen", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_aqua", lr = "SaturationAdjustmentAqua", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_blue", lr = "SaturationAdjustmentBlue", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_purple", lr = "SaturationAdjustmentPurple", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "saturation_magenta", lr = "SaturationAdjustmentMagenta", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_red", lr = "LuminanceAdjustmentRed", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_orange", lr = "LuminanceAdjustmentOrange", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_yellow", lr = "LuminanceAdjustmentYellow", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_green", lr = "LuminanceAdjustmentGreen", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_aqua", lr = "LuminanceAdjustmentAqua", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_blue", lr = "LuminanceAdjustmentBlue", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_purple", lr = "LuminanceAdjustmentPurple", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
    { logical = "luminance_magenta", lr = "LuminanceAdjustmentMagenta", engine = "controller", probeStatus = "unprobed", tolerance = 0.01 },
}
Catalog.byLogical = {}
Catalog.byLightroom = {}
for _, entry in ipairs(Catalog.entries) do
    Catalog.byLogical[entry.logical] = entry
    Catalog.byLightroom[entry.lr] = entry
end
function Catalog.resolve(name)
    return Catalog.byLogical[name] or Catalog.byLightroom[name]
end
return Catalog
