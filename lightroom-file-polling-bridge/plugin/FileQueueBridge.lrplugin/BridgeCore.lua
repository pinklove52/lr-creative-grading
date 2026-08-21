local LrApplication = import "LrApplication"
local LrApplicationView = import "LrApplicationView"
local LrDevelopController = import "LrDevelopController"
local LrDigest = import "LrDigest"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrTasks = import "LrTasks"
local LrUUID = import "LrUUID"

local Catalog = require "ParameterCatalog"
local Json = require "Json"

local Bridge = {
    protocolVersion = 1,
    transactions = {},
    transactionOrder = {},
    pendingProxy = {},
}

local function bridgeError(code, message, details)
    error({ __bridge_error = true, code = code, message = message, details = details }, 0)
end

local function isFinite(value)
    return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function copyArray(value)
    local output = {}
    for index, item in ipairs(value or {}) do output[index] = item end
    return output
end

local function sortedKeys(value)
    local keys = {}
    for key, _ in pairs(value or {}) do keys[#keys + 1] = key end
    table.sort(keys, function(left, right) return tostring(left) < tostring(right) end)
    return keys
end

local function canonical(value, seen)
    local kind = type(value)
    if kind == "nil" then return "null" end
    if kind == "boolean" then return value and "true" or "false" end
    if kind == "number" then
        if not isFinite(value) then return "number:null" end
        return "number:" .. string.format("%.17g", value)
    end
    if kind == "string" then return "string:" .. string.format("%q", value) end
    if kind ~= "table" then return kind .. ":" .. tostring(value) end
    seen = seen or {}
    if seen[value] then return "<cycle>" end
    seen[value] = true
    local parts = {}
    for _, key in ipairs(sortedKeys(value)) do
        parts[#parts + 1] = canonical(key, seen) .. "=" .. canonical(value[key], seen)
    end
    seen[value] = nil
    return "{" .. table.concat(parts, ";") .. "}"
end

local function sha256(value)
    local ok, digest = LrTasks.pcall(function() return LrDigest.SHA256.digest(value) end)
    if ok and type(digest) == "string" then return digest end
    bridgeError("DIGEST_UNAVAILABLE", "Lightroom SHA-256 support is unavailable", tostring(digest))
end

local function safeMetadata(photo, key, formatted)
    local ok, value = LrTasks.pcall(function()
        if formatted then return photo:getFormattedMetadata(key) end
        return photo:getRawMetadata(key)
    end)
    if ok then return value end
    return nil
end

local function activePhoto()
    local catalog = LrApplication.activeCatalog()
    if not catalog then bridgeError("NO_CATALOG", "No Lightroom catalog is active") end
    local photo = catalog:getTargetPhoto()
    if not photo then bridgeError("NO_TARGET_PHOTO", "No target photo is selected") end
    if safeMetadata(photo, "isVideo", false) or safeMetadata(photo, "fileFormat", false) == "VIDEO" then
        bridgeError("UNSUPPORTED_MEDIA", "Video targets cannot be color graded by this bridge")
    end
    return catalog, photo
end

local function developSettings(photo)
    local settings = photo:getDevelopSettings()
    if type(settings) ~= "table" then
        bridgeError("SETTINGS_UNAVAILABLE", "Could not read current develop settings", tostring(settings))
    end
    return settings
end

local function baselineDigest(photo, settings)
    settings = settings or developSettings(photo)
    return sha256(canonical(settings))
end

local function sourceDigest(photo)
    local identity = {
        photo.localIdentifier,
        safeMetadata(photo, "uuid", false),
        safeMetadata(photo, "path", false),
        safeMetadata(photo, "fileSize", false),
        safeMetadata(photo, "fileFormat", false),
        safeMetadata(photo, "isVirtualCopy", false),
    }
    return sha256(canonical(identity))
end

local function targetFor(photo, settings)
    return {
        photo_id = tostring(photo.localIdentifier),
        filename = tostring(safeMetadata(photo, "fileName", true) or "unknown"),
        source_digest = sourceDigest(photo),
        baseline_edit_digest = baselineDigest(photo, settings),
        format = safeMetadata(photo, "fileFormat", false),
        is_virtual_copy = safeMetadata(photo, "isVirtualCopy", false) == true,
        width = safeMetadata(photo, "width", false),
        height = safeMetadata(photo, "height", false),
    }
end

local function requireString(value, name)
    if type(value) ~= "string" or value == "" then
        bridgeError("INVALID_REQUEST", name .. " must be a non-empty string")
    end
    return value
end

local function validateTargetShape(target)
    if type(target) ~= "table" then bridgeError("INVALID_REQUEST", "target must be an object") end
    requireString(tostring(target.photo_id or ""), "target.photo_id")
    requireString(target.filename, "target.filename")
    requireString(target.source_digest, "target.source_digest")
    requireString(target.baseline_edit_digest, "target.baseline_edit_digest")
end

local function assertTarget(expected, options)
    options = options or {}
    validateTargetShape(expected)
    local catalog, photo = activePhoto()
    local settings = developSettings(photo)
    local actual = targetFor(photo, settings)
    local differences = {}
    for _, field in ipairs({ "photo_id", "filename", "source_digest" }) do
        if tostring(expected[field]) ~= tostring(actual[field]) then
            differences[field] = { expected = expected[field], actual = actual[field] }
        end
    end
    if next(differences) then
        bridgeError("TARGET_MISMATCH", "The active Lightroom photo changed", differences)
    end
    if not options.ignoreBaseline and expected.baseline_edit_digest ~= actual.baseline_edit_digest then
        bridgeError("BASELINE_MISMATCH", "The Lightroom edit changed after the recipe was prepared", {
            expected = expected.baseline_edit_digest,
            actual = actual.baseline_edit_digest,
        })
    end
    return catalog, photo, settings, actual
end

local function currentModule()
    local ok, moduleName = LrTasks.pcall(LrApplicationView.getCurrentModuleName)
    if ok then return moduleName end
    return "unknown"
end

local function ensureDevelopModule()
    if currentModule() == "develop" then return end
    local switched, reason = LrTasks.pcall(LrApplicationView.switchToModule, "develop")
    if not switched then
        bridgeError("MODULE_SWITCH_FAILED", "Lightroom could not switch to Develop", tostring(reason))
    end
    for _ = 1, 20 do
        if currentModule() == "develop" then return end
        LrTasks.sleep(0.05)
    end
    bridgeError("MODULE_SWITCH_FAILED", "Lightroom did not enter Develop within one second")
end

local function controllerRange(entry)
    local ok, minimum, maximum = LrTasks.pcall(LrDevelopController.getRange, entry.lr)
    if not ok or not isFinite(minimum) or not isFinite(maximum) or minimum > maximum then
        return nil, nil, tostring(minimum or maximum)
    end
    return minimum, maximum, nil
end

local function controllerValue(entry)
    local ok, value = LrTasks.pcall(LrDevelopController.getValue, entry.lr)
    if not ok or not isFinite(value) then return nil, tostring(value) end
    return value, nil
end

local function validateCurve(curve, name)
    if type(curve) ~= "table" or #curve < 4 or #curve % 2 ~= 0 then
        bridgeError("INVALID_CURVE", name .. " must contain at least two x/y point pairs")
    end
    local priorX = nil
    for index, value in ipairs(curve) do
        if not isFinite(value) or value < 0 or value > 255 then
            bridgeError("OUT_OF_RANGE", name .. " curve values must be within 0..255", {
                index = index, value = value,
            })
        end
        if index % 2 == 1 then
            if priorX and value <= priorX then
                bridgeError("INVALID_CURVE", name .. " x coordinates must increase strictly")
            end
            priorX = value
        end
    end
    return copyArray(curve)
end

local function probeParameter(entry, settings)
    if entry.engine == "develop_settings" then
        local value = settings and settings[entry.lr]
        return {
            logical_name = entry.logical,
            lightroom_name = entry.lr,
            engine = entry.engine,
            kind = entry.kind,
            status = type(value) == "table" and "supported" or "unsupported",
            range = { minimum = 0, maximum = 255 },
            value = type(value) == "table" and copyArray(value) or nil,
            note = "Structured develop-settings API; may create a separate history entry.",
        }
    end
    local minimum, maximum, rangeError = controllerRange(entry)
    if not minimum then
        return {
            logical_name = entry.logical,
            lightroom_name = entry.lr,
            engine = entry.engine,
            status = "unsupported",
            reason = rangeError,
        }
    end
    local value, valueError = controllerValue(entry)
    return {
        logical_name = entry.logical,
        lightroom_name = entry.lr,
        engine = entry.engine,
        kind = "number",
        circular = entry.circular == true,
        status = value and "supported" or "unsupported",
        range = { minimum = minimum, maximum = maximum },
        value = value,
        reason = valueError,
    }
end

local function capabilities()
    local version = LrApplication.versionTable()
    local moduleName = currentModule()
    local parameters = {}
    local photoSettings = nil
    if moduleName == "develop" then
        local catalog = LrApplication.activeCatalog()
        local photo = catalog and catalog:getTargetPhoto() or nil
        if photo then photoSettings = developSettings(photo) end
    end
    for _, entry in ipairs(Catalog.entries) do
        if moduleName == "develop" and photoSettings then
            parameters[entry.logical] = probeParameter(entry, photoSettings)
        else
            parameters[entry.logical] = {
                logical_name = entry.logical,
                lightroom_name = entry.lr,
                engine = entry.engine,
                kind = entry.kind or "number",
                circular = entry.circular == true,
                status = "unprobed",
                reason = "Select an image in Develop to probe its actual range.",
            }
        end
    end
    return {
        protocol_version = Bridge.protocolVersion,
        plugin_version = "0.1.0",
        lightroom = {
            version_string = LrApplication.versionString(),
            major = version.major, minor = version.minor, revision = version.revision,
            build_version = version.build_version,
            current_module = moduleName,
        },
        transport = {
            host = "127.0.0.1",
            authenticated = true,
            single_client = true,
            max_request_bytes = 1048576,
        },
        parameters = parameters,
        ui_required = Catalog.uiRequired,
        protected_not_exposed = { "crop", "masks", "heal", "red_eye", "lens_corrections", "geometry" },
        transaction = {
            target_and_baseline_guard = true,
            unique_develop_snapshot = true,
            preset_uuid = type(LrApplication.developPresetByUuid) == "function",
            multiple_adjustment_threshold = type(LrDevelopController.setMultipleAdjustmentThreshold) == "function",
            direct_numeric_history = "best_effort_single_Multiple_Settings_step",
            structured_curve_history = "may_be_separate",
            preset_history = "may_be_separate",
            strict_single_history_guarantee = false,
            virtual_copy_snapshot = "capability_probed_at_runtime_with_full-settings fallback",
        },
    }
end

local function getTargetPhoto()
    local _, photo = activePhoto()
    local settings = developSettings(photo)
    return targetFor(photo, settings)
end

local function getSettings(params)
    params = params or {}
    ensureDevelopModule()
    local _, photo, settings, target
    if params.target then
        _, photo, settings, target = assertTarget(params.target)
    else
        _, photo = activePhoto()
        settings = developSettings(photo)
        target = targetFor(photo, settings)
    end
    local requested = params.parameters
    if requested ~= nil and type(requested) ~= "table" then
        bridgeError("INVALID_REQUEST", "parameters must be an array")
    end
    local names = requested or {}
    if not requested then
        for _, entry in ipairs(Catalog.entries) do names[#names + 1] = entry.logical end
    end
    local values, parameterCapabilities = {}, {}
    local seen = {}
    for _, name in ipairs(names) do
        if type(name) ~= "string" or seen[name] then
            bridgeError("INVALID_REQUEST", "parameters must contain unique strings")
        end
        seen[name] = true
        local entry = Catalog.resolve(name)
        if not entry then bridgeError("UNKNOWN_PARAMETER", "Unknown Lightroom parameter: " .. name) end
        local capability = probeParameter(entry, settings)
        parameterCapabilities[entry.logical] = capability
        if capability.status == "supported" then values[entry.logical] = capability.value end
    end
    return {
        target = target,
        values = values,
        parameter_capabilities = parameterCapabilities,
        baseline_edit_digest = target.baseline_edit_digest,
    }
end

local function writeBinary(path, bytes)
    local handle, reason = io.open(path, "wb")
    if not handle then bridgeError("PROXY_WRITE_FAILED", "Could not create JPEG proxy", tostring(reason)) end
    local ok, writeReason = handle:write(bytes)
    handle:close()
    if not ok then bridgeError("PROXY_WRITE_FAILED", "Could not write JPEG proxy", tostring(writeReason)) end
end

local function getProxy(params)
    params = params or {}
    local longEdge = params.long_edge or 2048
    local timeoutSeconds = params.timeout_seconds or 20
    if not isFinite(longEdge) or longEdge ~= math.floor(longEdge) or longEdge < 256 or longEdge > 4096 then
        bridgeError("INVALID_REQUEST", "long_edge must be an integer from 256 to 4096")
    end
    if not isFinite(timeoutSeconds) or timeoutSeconds < 1 or timeoutSeconds > 60 then
        bridgeError("INVALID_REQUEST", "timeout_seconds must be from 1 to 60")
    end
    local _, photo = activePhoto()
    local before = targetFor(photo, developSettings(photo))
    local requestId = LrUUID.generateUUID()
    local pending = {
        bytes = nil,
        last_error = nil,
        callbacks = 0,
        attempts = {},
        request_references = {},
    }
    Bridge.pendingProxy[requestId] = pending
    local variants = {
        { label = "square", width = longEdge, height = longEdge },
        -- Lightroom's Windows preview cache can reject a two-dimensional request
        -- even when a width-only request for the same photo succeeds.
        { label = "width_only", width = longEdge },
        { label = "smallest_available" },
    }
    local waited = 0
    for _, variant in ipairs(variants) do
        if pending.bytes or waited >= timeoutSeconds then break end
        local attempt = { label = variant.label, callbacks = 0, error = nil }
        pending.attempts[#pending.attempts + 1] = attempt
        local attemptDone = false
        local attemptClosed = false
        local reference = photo:requestJpegThumbnail(variant.width, variant.height, function(jpegBytes, reason)
            attempt.callbacks = attempt.callbacks + 1
            pending.callbacks = pending.callbacks + 1
            if attemptClosed then return end
            if type(jpegBytes) == "string" and #jpegBytes > 0 then
                pending.bytes = jpegBytes
                attemptDone = true
            elseif reason then
                attempt.error = tostring(reason)
                pending.last_error = attempt.error
                attemptDone = true
            end
        end)
        pending.request_references[#pending.request_references + 1] = reference
        while not attemptDone and waited < timeoutSeconds do
            LrTasks.sleep(0.05)
            waited = waited + 0.05
        end
        attemptClosed = true
    end
    Bridge.pendingProxy[requestId] = nil
    if not pending.bytes then
        bridgeError("PROXY_TIMEOUT", "Lightroom did not produce a JPEG proxy before timeout", {
            reason = pending.last_error,
            callbacks = pending.callbacks,
            attempts = pending.attempts,
            timeout_seconds = timeoutSeconds,
        })
    end
    local _, afterPhoto = activePhoto()
    local after = targetFor(afterPhoto, developSettings(afterPhoto))
    if before.photo_id ~= after.photo_id or before.source_digest ~= after.source_digest then
        bridgeError("TARGET_MISMATCH", "The active photo changed while Lightroom rendered the proxy")
    end
    if before.baseline_edit_digest ~= after.baseline_edit_digest then
        bridgeError("PROXY_STALE", "The Lightroom edit changed while the proxy was rendering", {
            before = before.baseline_edit_digest,
            after = after.baseline_edit_digest,
        })
    end
    local proxyDir = LrPathUtils.child(LrPathUtils.getStandardFilePath("temp"), "LrCreativeGradingBridge")
    proxyDir = LrPathUtils.child(proxyDir, "proxies")
    local made, makeReason = LrFileUtils.createAllDirectories(proxyDir)
    if not made then bridgeError("PROXY_WRITE_FAILED", "Could not create proxy directory", tostring(makeReason)) end
    local proxyPath = LrPathUtils.child(proxyDir, tostring(photo.localIdentifier) .. "-" .. requestId .. ".jpg")
    writeBinary(proxyPath, pending.bytes)
    return {
        target = {
            photo_id = after.photo_id,
            filename = after.filename,
            source_digest = after.source_digest,
            baseline_edit_digest = after.baseline_edit_digest,
            proxy_digest = sha256(pending.bytes),
            format = after.format,
            is_virtual_copy = after.is_virtual_copy,
            width = after.width,
            height = after.height,
        },
        path = proxyPath,
        mime_type = "image/jpeg",
        byte_length = #pending.bytes,
        proxy_digest = sha256(pending.bytes),
        digest = sha256(pending.bytes), -- compatibility alias; never replace target.source_digest with this.
        requested_long_edge = longEdge,
        callback_count = pending.callbacks,
        rendering = "Lightroom current-render JPEG thumbnail; asynchronous first-success result",
    }
end

local function optionalPresetUuid(recipe)
    local value = recipe.preset_uuid
    if value == nil or value == false or value == Json.null then return nil end
    requireString(value, "lr_recipe.preset_uuid")
    return value
end

local function validatePreset(recipe)
    local presetUuid = optionalPresetUuid(recipe)
    if not presetUuid then return nil, 0 end
    local preset = LrApplication.developPresetByUuid(presetUuid)
    if not preset then bridgeError("PRESET_NOT_FOUND", "No Lightroom preset exists for the supplied UUID") end
    local ok, settings = LrTasks.pcall(function() return preset:getSetting() end)
    if not ok or type(settings) ~= "table" then
        bridgeError("PRESET_UNVERIFIABLE", "The preset settings could not be inspected safely", tostring(settings))
    end
    local protected = {}
    for key, _ in pairs(settings) do
        local text = tostring(key)
        if Catalog.protectedPresetKeys[text]
            or text:match("^Crop") or text:match("^Retouch") or text:match("^Mask")
            or text:match("^Lens") or text:match("^Perspective") or text:match("^Upright")
            or text:match("^RedEye") then
            protected[#protected + 1] = text
        end
    end
    if #protected > 0 then
        table.sort(protected)
        bridgeError("UNSAFE_PRESET", "Preset includes protected geometry/local settings", protected)
    end
    return preset, settings
end

local function normalizedCircularDifference(target, baseline, period)
    return ((target - baseline + period / 2) % period) - period / 2
end

local function wrapCircular(value, minimum, maximum)
    local period = maximum - minimum
    if period <= 0 then return value end
    if value == maximum then return maximum end
    return minimum + ((value - minimum) % period)
end

local function compileCurve(entry, baseline, spec, factor)
    if spec.operation ~= "target" or spec.interpolation ~= "curve_points" then
        bridgeError("INVALID_PARAMETER_SPEC", entry.logical .. " requires target/curve_points")
    end
    local target = validateCurve(spec.curve_points or spec.value, entry.logical .. ".target")
    baseline = validateCurve(baseline, entry.logical .. ".baseline")
    if factor == 0 then return baseline end
    if factor == 1 then return target end
    if #baseline ~= #target then
        bridgeError("CURVE_TOPOLOGY_MISMATCH", entry.logical .. " needs matching baseline and target nodes outside 100%")
    end
    local output = {}
    for index = 1, #target, 2 do
        if math.abs(baseline[index] - target[index]) > 0.000001 then
            bridgeError("CURVE_TOPOLOGY_MISMATCH", entry.logical .. " x coordinates differ outside 100%")
        end
        output[index] = baseline[index]
        output[index + 1] = baseline[index + 1] + (target[index + 1] - baseline[index + 1]) * factor
    end
    return validateCurve(output, entry.logical .. ".compiled")
end

local function compileNumber(entry, baseline, spec, factor, minimum, maximum)
    if not isFinite(spec.value) then
        bridgeError("INVALID_PARAMETER_SPEC", entry.logical .. ".value must be finite")
    end
    if spec.operation ~= "delta" and spec.operation ~= "target" then
        bridgeError("INVALID_PARAMETER_SPEC", entry.logical .. ".operation must be delta or target")
    end
    local interpolation = spec.interpolation or "linear"
    local desired
    if spec.operation == "delta" then
        if interpolation ~= "linear" then
            bridgeError("INVALID_PARAMETER_SPEC", entry.logical .. " delta requires linear interpolation")
        end
        desired = baseline + spec.value * factor
    elseif interpolation == "linear" then
        if spec.value < minimum or spec.value > maximum then
            bridgeError("OUT_OF_RANGE", entry.logical .. " target is outside Lightroom range", {
                value = spec.value, minimum = minimum, maximum = maximum,
            })
        end
        desired = baseline + (spec.value - baseline) * factor
    elseif interpolation == "circular_degrees" then
        if not entry.circular then
            bridgeError("INVALID_PARAMETER_SPEC", entry.logical .. " is not a circular-degree control")
        end
        if spec.value < minimum or spec.value > maximum then
            bridgeError("OUT_OF_RANGE", entry.logical .. " hue target is outside Lightroom range", {
                value = spec.value, minimum = minimum, maximum = maximum,
            })
        end
        local difference = normalizedCircularDifference(spec.value, baseline, maximum - minimum)
        desired = wrapCircular(baseline + difference * factor, minimum, maximum)
    else
        bridgeError("INVALID_PARAMETER_SPEC", "Unknown interpolation for " .. entry.logical)
    end
    if not isFinite(desired) or desired < minimum or desired > maximum then
        bridgeError("OUT_OF_RANGE", entry.logical .. " compiled value is outside Lightroom range", {
            desired = desired, minimum = minimum, maximum = maximum, strength_factor = factor,
        })
    end
    return desired
end

local function buildPlan(request, beforeSettings)
    if type(request) ~= "table" then bridgeError("INVALID_REQUEST", "apply request must be an object") end
    validateTargetShape(request.target)
    local selection = request.selection
    if type(selection) ~= "table" or not isFinite(selection.requested_strength)
        or selection.requested_strength < 0 or selection.requested_strength > 200 then
        bridgeError("INVALID_STRENGTH", "selection.requested_strength must be within 0..200")
    end
    local factor = selection.requested_strength / 100
    local recipe = request.lr_recipe
    if type(recipe) ~= "table" or type(recipe.desired_parameters) ~= "table" then
        bridgeError("INVALID_REQUEST", "lr_recipe.desired_parameters must be an object")
    end
    local presetUuid = optionalPresetUuid(recipe)
    local preset, _ = validatePreset(recipe)
    local presetAmount = recipe.preset_amount or 100
    if not isFinite(presetAmount) or presetAmount ~= math.floor(presetAmount)
        or presetAmount < 0 or presetAmount > 200 then
        bridgeError("INVALID_REQUEST", "preset_amount must be an integer within 0..200")
    end
    local compiledPresetAmount = math.floor(presetAmount * factor + 0.5)
    if compiledPresetAmount > 200 then
        bridgeError("OUT_OF_RANGE", "Preset amount exceeds Lightroom's 200% maximum at requested strength", {
            preset_amount = presetAmount, requested_strength = selection.requested_strength,
        })
    end
    local plan = {
        factor = factor,
        preset = factor == 0 and nil or preset,
        preset_uuid = presetUuid,
        preset_amount = factor == 0 and 0 or compiledPresetAmount,
        numeric = {}, curves = {}, ordered = {},
        desired = {}, specs = recipe.desired_parameters,
        ui_required = type(recipe.ui_required) == "table" and recipe.ui_required or {},
    }
    local requestedByLogical = {}
    for suppliedName, spec in pairs(recipe.desired_parameters) do
        local entry = Catalog.resolve(suppliedName)
        if not entry then bridgeError("UNKNOWN_PARAMETER", "Unknown Lightroom parameter: " .. tostring(suppliedName)) end
        if requestedByLogical[entry.logical] then
            bridgeError("CONFLICTING_PARAMETER", "Parameter was supplied twice through aliases: " .. entry.logical)
        end
        if type(spec) ~= "table" then
            bridgeError("INVALID_PARAMETER_SPEC", suppliedName .. " must be an explicit parameter specification")
        end
        requestedByLogical[entry.logical] = { entry = entry, spec = spec }
    end
    for _, entry in ipairs(Catalog.entries) do
        local requested = requestedByLogical[entry.logical]
        if requested then
            local desired
            if entry.engine == "develop_settings" then
                local baseline = beforeSettings[entry.lr]
                if type(baseline) ~= "table" then
                    bridgeError("UNSUPPORTED_PARAMETER", entry.logical .. " is unavailable for the active photo")
                end
                desired = compileCurve(entry, baseline, requested.spec, factor)
                plan.curves[entry.lr] = desired
            else
                local minimum, maximum, rangeError = controllerRange(entry)
                if not minimum then
                    bridgeError("UNSUPPORTED_PARAMETER", entry.logical .. " is unavailable for the active photo", rangeError)
                end
                local baseline, valueError = controllerValue(entry)
                if baseline == nil then
                    bridgeError("UNSUPPORTED_PARAMETER", entry.logical .. " has no readable value", valueError)
                end
                desired = compileNumber(entry, baseline, requested.spec, factor, minimum, maximum)
                plan.numeric[entry.lr] = desired
                plan.ordered[#plan.ordered + 1] = entry
            end
            plan.desired[entry.logical] = desired
        end
    end
    if not plan.preset and not plan.preset_uuid and next(plan.desired) == nil then
        bridgeError("EMPTY_RECIPE", "Transaction contains no preset or parameters")
    end
    return plan
end

local function findSnapshotId(photo, name)
    local ok, snapshots = LrTasks.pcall(function() return photo:getDevelopSnapshots() end)
    if not ok or type(snapshots) ~= "table" then return nil end
    for _, snapshot in ipairs(snapshots) do
        if snapshot.name == name then return snapshot.snapshotID end
    end
    return nil
end

local function createSnapshot(catalog, photo, name)
    local created = false
    local ok, reason = LrTasks.pcall(function()
        catalog:withWriteAccessDo("Creative grading safety snapshot", function()
            created = photo:createDevelopSnapshot(name, false)
        end)
    end)
    if not ok then return false, nil, tostring(reason) end
    if not created then return false, nil, "createDevelopSnapshot returned false" end
    return true, findSnapshotId(photo, name), nil
end

local function targetsStillMatch(photo, expected)
    if tostring(photo.localIdentifier) ~= tostring(expected.photo_id) then return false end
    return sourceDigest(photo) == expected.source_digest
end

local function valuesEqual(left, right, tolerance)
    tolerance = tolerance or 0.0001
    if type(left) ~= type(right) then return false end
    if type(left) == "number" then return math.abs(left - right) <= tolerance end
    if type(left) ~= "table" then return left == right end
    if #left ~= #right then return false end
    for index = 1, #left do
        if not valuesEqual(left[index], right[index], tolerance) then return false end
    end
    return true
end

-- Lightroom's controller surface quantizes its values before exposing them
-- through getValue. Keep structured develop settings strict, but allow the
-- controller's sub-unit write/readback quantization without masking a real
-- one-point drift.
local CONTROLLER_VALUE_TOLERANCE = 0.999

local function readActual(plan, photo)
    local actual, failures = {}, {}
    local settings = developSettings(photo)
    for _, entry in ipairs(Catalog.entries) do
        if plan.desired[entry.logical] ~= nil then
            local value, reason
            if entry.engine == "develop_settings" then
                value = settings[entry.lr]
                if type(value) == "table" then value = copyArray(value) end
            else
                value, reason = controllerValue(entry)
            end
            actual[entry.logical] = value
            local tolerance = entry.engine == "controller" and CONTROLLER_VALUE_TOLERANCE or 0.0001
            if value == nil or not valuesEqual(value, plan.desired[entry.logical], tolerance) then
                failures[#failures + 1] = {
                    parameter = entry.logical,
                    code = "READBACK_MISMATCH",
                    desired = plan.desired[entry.logical],
                    actual = value,
                    reason = reason,
                }
            end
        end
    end
    return actual, failures
end

local function rememberTransaction(transaction)
    Bridge.transactions[transaction.transaction_id] = transaction
    Bridge.transactionOrder[#Bridge.transactionOrder + 1] = transaction.transaction_id
    while #Bridge.transactionOrder > 20 do
        local expired = table.remove(Bridge.transactionOrder, 1)
        Bridge.transactions[expired] = nil
    end
end

local function restoreTransaction(transaction, automatic)
    local photo = transaction.photo
    local catalog = transaction.catalog
    if not automatic then
        local _, active = activePhoto()
        if not targetsStillMatch(active, transaction.target) then
            bridgeError("TARGET_MISMATCH", "Rollback target is not the active Lightroom photo")
        end
    end
    local restored, method, reason = false, nil, nil
    if transaction.snapshot_id then
        local ok, result = LrTasks.pcall(function()
            catalog:withWriteAccessDo("Rollback creative grading", function()
                photo:applyDevelopSnapshot(transaction.snapshot_id)
            end)
        end)
        if ok then restored, method = true, "develop_snapshot" else reason = tostring(result) end
    end
    if not restored and transaction.before_settings then
        local ok, result = LrTasks.pcall(function()
            photo:applyDevelopSettings(transaction.before_settings, "Rollback creative grading", false)
        end)
        if ok then restored, method = true, "full_develop_settings_fallback" else reason = tostring(result) end
    end
    if not restored then
        transaction.failures[#transaction.failures + 1] = {
            code = "ROLLBACK_FAILED", message = reason or "No rollback method succeeded",
        }
        transaction.state = "ROLLBACK_FAILED"
        return { restored = false, state = transaction.state, reason = reason }
    end
    transaction.state = "ROLLED_BACK"
    transaction.rolled_back_at = os.time()
    transaction.rollback_method = method
    return {
        restored = true,
        state = transaction.state,
        method = method,
        transaction_id = transaction.transaction_id,
        target = targetFor(photo, developSettings(photo)),
    }
end

local function publicTransaction(transaction, readback)
    local public = {
        transaction_id = transaction.transaction_id,
        state = transaction.state,
        target = transaction.target,
        snapshot = {
            name = transaction.snapshot_name,
            id = transaction.snapshot_id,
            created = transaction.snapshot_created,
            is_virtual_copy = transaction.target.is_virtual_copy,
            fallback_available = transaction.before_settings ~= nil,
        },
        desired = transaction.desired,
        applied = transaction.applied,
        readback = readback or transaction.readback,
        skipped = transaction.skipped,
        unsupported = transaction.unsupported,
        failures = transaction.failures,
        history = transaction.history,
    }
    local append = {}
    if transaction.state == "APPLIED" then append = { "SNAPSHOTTED", "APPLIED" }
    elseif transaction.state == "ROLLED_BACK" then append = { "ROLLED_BACK" }
    end
    local gradeSessionState = transaction.state == "READBACK_VERIFIED" and "APPLIED" or transaction.state
    public.execution = {
        transaction_id = transaction.transaction_id,
        state = gradeSessionState,
        bridge_state = transaction.state,
        desired = transaction.desired,
        applied = transaction.applied,
        readback = readback or transaction.readback,
        failures = transaction.failures,
    }
    public.execution_patch = {
        transaction_id = transaction.transaction_id,
        state = gradeSessionState,
        bridge_state = transaction.state,
        state_history_append = append,
        desired = transaction.desired,
        applied = transaction.applied,
        readback = readback or transaction.readback,
        failures = transaction.failures,
        skipped = transaction.skipped,
        unsupported = transaction.unsupported,
    }
    if transaction.state == "READBACK_VERIFIED" then
        public.execution_patch.state = nil
        public.execution_patch.state_history_append = nil
        public.execution_patch.readback_verified = true
        public.execution_patch.recommended_next_state = "VERIFIED"
        public.execution_patch.required_predecessor = "PERSON_PROTECTED"
    end
    return public
end

local function applyTransaction(request)
    ensureDevelopModule()
    local catalog, photo, beforeSettings, target = assertTarget(request.target)
    local plan = buildPlan(request, beforeSettings)
    -- Recheck after all potentially slow capability and preset inspection work.
    catalog, photo, beforeSettings, target = assertTarget(request.target)
    plan = buildPlan(request, beforeSettings)

    local transactionId = LrUUID.generateUUID()
    local snapshotName = "CreativeGrade pre " .. transactionId
    local created, snapshotId, snapshotReason = createSnapshot(catalog, photo, snapshotName)
    if not created and request.allow_snapshot_fallback ~= true then
        bridgeError("SNAPSHOT_FAILED", "Lightroom did not create the required safety snapshot", {
            reason = snapshotReason,
            is_virtual_copy = target.is_virtual_copy,
            fallback_captured = beforeSettings ~= nil,
        })
    end
    local transaction = {
        transaction_id = transactionId,
        state = "SNAPSHOTTED",
        catalog = catalog, photo = photo,
        target = target,
        before_settings = beforeSettings,
        snapshot_name = snapshotName,
        snapshot_id = snapshotId,
        snapshot_created = created,
        plan = plan,
        desired = {
            candidate_id = request.candidate and request.candidate.candidate_id or nil,
            requested_strength = request.selection.requested_strength,
            strength_factor = plan.factor,
            recipe_hash = request.execution_desired and request.execution_desired.recipe_hash or nil,
            mode = "baseline_relative",
            parameter_specs = plan.specs,
            compiled_parameters = plan.desired,
            compilation = "compiled_by_bridge_from_pinned_baseline",
            people_protection = request.execution_desired and request.execution_desired.people_protection or nil,
            preset_uuid = plan.preset_uuid,
            preset_amount = plan.preset_amount,
        },
        applied = {}, skipped = {}, unsupported = {}, failures = {},
        history = {
            requested_name = request.history_name,
            direct_parameters = "setMultipleAdjustmentThreshold best effort",
            structured_curves = next(plan.curves) and "may create a separate history entry" or "not used",
            preset = plan.preset and "may create a separate history entry" or "not used",
            guaranteed_single_step = false,
        },
    }
    for _, operation in ipairs(plan.ui_required) do
        transaction.unsupported[#transaction.unsupported + 1] = {
            operation = operation.operation or operation.type or tostring(operation),
            status = "ui_required",
            reason = operation.reason or "Operation is intentionally delegated to Lightroom UI",
        }
    end
    rememberTransaction(transaction)

    local applyOk, applyReason = LrTasks.pcall(function()
        if plan.preset and plan.preset_amount > 0 then
            catalog:withWriteAccessDo(request.history_name or "Creative grading preset", function()
                photo:applyDevelopPreset(plan.preset, nil, plan.preset_amount, false)
            end)
            transaction.applied.preset = {
                status = "applied", uuid = plan.preset_uuid, amount = plan.preset_amount,
            }
        elseif plan.preset_uuid then
            transaction.skipped[#transaction.skipped + 1] = {
                operation = "preset", reason = "requested strength is 0%",
            }
        end
        if not targetsStillMatch(photo, target) then
            bridgeError("TARGET_MISMATCH", "The active photo changed during preset application")
        end
        if next(plan.curves) then
            local curvesToApply = {}
            for _, entry in ipairs(Catalog.entries) do
                local desiredCurve = plan.curves[entry.lr]
                if desiredCurve then
                    if not plan.preset and valuesEqual(beforeSettings[entry.lr], desiredCurve) then
                        transaction.skipped[#transaction.skipped + 1] = {
                            parameter = entry.logical, reason = "already_at_compiled_value",
                        }
                    else
                        curvesToApply[entry.lr] = desiredCurve
                        transaction.applied[entry.logical] = {
                            status = "applied", desired = desiredCurve, engine = entry.engine,
                        }
                    end
                end
            end
            if next(curvesToApply) then
                photo:applyDevelopSettings(curvesToApply, request.history_name or "Creative grading curves", false)
            end
        end
        if #plan.ordered > 0 then
            local thresholdSet = LrTasks.pcall(LrDevelopController.setMultipleAdjustmentThreshold, 1.5)
            local numericOk, numericReason = LrTasks.pcall(function()
                for _, entry in ipairs(plan.ordered) do
                    local desired = plan.numeric[entry.lr]
                    local beforeValue = controllerValue(entry)
                    if not plan.preset and valuesEqual(beforeValue, desired) then
                        transaction.skipped[#transaction.skipped + 1] = {
                            parameter = entry.logical, reason = "already_at_compiled_value",
                        }
                    else
                        local setOk, setReason = LrTasks.pcall(LrDevelopController.setValue, entry.lr, desired)
                        if not setOk then
                            bridgeError("PARAMETER_APPLY_FAILED", "Lightroom rejected " .. entry.logical, tostring(setReason))
                        end
                        transaction.applied[entry.logical] = {
                            status = "applied", desired = desired, engine = entry.engine,
                        }
                    end
                end
            end)
            if thresholdSet then LrTasks.pcall(LrDevelopController.setMultipleAdjustmentThreshold, 0.5) end
            if not numericOk then error(numericReason, 0) end
        end
    end)

    if not applyOk then
        local failure = applyReason
        if type(failure) == "table" and failure.__bridge_error then
            transaction.failures[#transaction.failures + 1] = {
                code = failure.code, message = failure.message, details = failure.details,
            }
        else
            transaction.failures[#transaction.failures + 1] = {
                code = "PARAMETER_APPLY_FAILED", message = tostring(failure),
            }
        end
        local rollbackResult = restoreTransaction(transaction, true)
        bridgeError("PARTIAL_APPLY_ROLLED_BACK", "Transaction failed and rollback was attempted", {
            transaction_id = transactionId,
            state = transaction.state,
            failures = transaction.failures,
            rollback = rollbackResult,
        })
    end

    if not targetsStillMatch(photo, target) then
        transaction.failures[#transaction.failures + 1] = {
            code = "TARGET_MISMATCH", message = "The active photo changed before verification",
        }
        local rollbackResult = restoreTransaction(transaction, true)
        bridgeError("PARTIAL_APPLY_ROLLED_BACK", "Target changed and rollback was attempted", {
            transaction_id = transactionId, rollback = rollbackResult,
        })
    end
    local actual, failures = readActual(plan, photo)
    if #failures > 0 then
        for _, failure in ipairs(failures) do transaction.failures[#transaction.failures + 1] = failure end
        local rollbackResult = restoreTransaction(transaction, true)
        bridgeError("PARTIAL_APPLY_ROLLED_BACK", "Readback did not match desired values", {
            transaction_id = transactionId,
            failures = failures,
            rollback = rollbackResult,
        })
    end
    transaction.state = "APPLIED"
    transaction.readback = {
        values = actual,
        baseline_edit_digest = baselineDigest(photo),
        verified = true,
    }
    transaction.last_known_edit_digest = transaction.readback.baseline_edit_digest
    return publicTransaction(transaction)
end

local function transactionFromParams(params)
    if type(params) ~= "table" then bridgeError("INVALID_REQUEST", "transaction reference must be an object") end
    local id = requireString(params.transaction_id, "transaction_id")
    local transaction = Bridge.transactions[id]
    if not transaction then bridgeError("TRANSACTION_NOT_FOUND", "Unknown or expired transaction: " .. id) end
    if params.target then
        validateTargetShape(params.target)
        if params.target.photo_id ~= transaction.target.photo_id
            or params.target.source_digest ~= transaction.target.source_digest then
            bridgeError("TARGET_MISMATCH", "Transaction target reference does not match")
        end
    end
    return transaction
end

local function readback(params)
    ensureDevelopModule()
    local transaction = transactionFromParams(params)
    local _, active = activePhoto()
    if not targetsStillMatch(active, transaction.target) then
        bridgeError("TARGET_MISMATCH", "Readback target is not the active Lightroom photo")
    end
    local currentDigest = baselineDigest(active)
    local expectedDigest = params.expected_current_edit_digest
        or transaction.last_known_edit_digest
    if expectedDigest and currentDigest ~= expectedDigest then
        bridgeError("BASELINE_CHANGED", "The Lightroom edit changed after the transaction", {
            expected = expectedDigest, actual = currentDigest,
        })
    end
    if transaction.state == "ROLLED_BACK" then return publicTransaction(transaction) end
    local actual, failures = readActual(transaction.plan, transaction.photo)
    transaction.readback = {
        values = actual,
        baseline_edit_digest = baselineDigest(transaction.photo),
        verified = #failures == 0,
    }
    if #failures > 0 then
        for _, failure in ipairs(failures) do transaction.failures[#transaction.failures + 1] = failure end
        bridgeError("READBACK_MISMATCH", "One or more Lightroom values no longer match", {
            transaction_id = transaction.transaction_id,
            failures = failures,
        })
    end
    transaction.last_known_edit_digest = transaction.readback.baseline_edit_digest
    transaction.state = "READBACK_VERIFIED"
    return publicTransaction(transaction)
end

local function rollback(params)
    local transaction = transactionFromParams(params)
    if transaction.state == "ROLLED_BACK" then return publicTransaction(transaction) end
    local _, active = activePhoto()
    if not targetsStillMatch(active, transaction.target) then
        bridgeError("TARGET_MISMATCH", "Rollback target is not the active Lightroom photo")
    end
    local currentDigest = baselineDigest(active)
    local expectedDigest = params.expected_current_edit_digest
        or transaction.last_known_edit_digest
    if expectedDigest and currentDigest ~= expectedDigest then
        bridgeError("BASELINE_CHANGED", "Rollback would overwrite edits made after the transaction", {
            expected = expectedDigest, actual = currentDigest,
        })
    end
    local result = restoreTransaction(transaction, false)
    if not result.restored then
        bridgeError("ROLLBACK_FAILED", "Lightroom could not restore the transaction", result)
    end
    return publicTransaction(transaction, { rollback = result })
end

local handlers = {
    capabilities = capabilities,
    get_target_photo = getTargetPhoto,
    get_proxy = getProxy,
    get_settings = getSettings,
    apply_transaction = applyTransaction,
    readback = readback,
    rollback = rollback,
}

function Bridge.invoke(method, params)
    local handler = handlers[method]
    if not handler then
        bridgeError("METHOD_NOT_FOUND", "Unknown bridge method: " .. tostring(method))
    end
    return handler(params or {})
end

function Bridge.handle(method, params)
    local ok, result = LrTasks.pcall(Bridge.invoke, method, params or {})
    if ok then return true, result end
    if type(result) == "table" and result.__bridge_error then
        return false, { code = result.code, message = result.message, details = result.details }
    end
    return false, { code = "INTERNAL_ERROR", message = tostring(result) }
end

return Bridge
