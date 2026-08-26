-- 文件队列传输层：Lightroom 侧实现。
--
-- 与 v1 双 LrSocket 长连接不同，本层不监听端口、不维护连接状态，
-- 只通过用户级目录中的原子改名文件与 Node 通信：
--
--   inbox/next.json        唯一请求槽（Node 写入；本层只认领这一个文件）
--   processing/<id>.json   认领后的处理中文件（至多一个）
--   outbox/<id>.json       响应（Node 读取后删除）
--   failed/<id>.json       被拒绝/过期/恢复失败的请求 + 原因 sidecar
--   session.json / heartbeat.json / logs/bridge.log
--
-- 核心不变量：本层只执行 inbox/next.json；processing 中的文件在任何
-- 情况下都不会被重新执行（孤儿文件由 Node 启动时按租约恢复规则处理）。
-- 单槽 + 单飞行天然满足"写事务不交错"约束。

local LrApplication = import "LrApplication"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrTasks = import "LrTasks"
local LrUUID = import "LrUUID"

local Bridge = require "BridgeCore"
local Config = require "Config"
local Json = require "Json"

local Queue = {
    running = false,
    busy = false,
    state = "stopped",
    sessionToken = nil,
    startedAt = nil,
    completedRequests = 0,
    failedRequests = 0,
    lastError = nil,
    recentRequestIds = {},
    recentRequestOrder = {},
    paths = {},
}

local function rootDir()
    return LrPathUtils.child(LrPathUtils.getStandardFilePath("appData"), Config.queue_root_name)
end

local function ensureQueuePaths()
    if Queue.paths.sessionFile then return end
    local root = rootDir()
    Queue.paths = {
        inboxDir = LrPathUtils.child(root, "inbox"),
        inboxNext = LrPathUtils.child(LrPathUtils.child(root, "inbox"), "next.json"),
        processingDir = LrPathUtils.child(root, "processing"),
        outboxDir = LrPathUtils.child(root, "outbox"),
        failedDir = LrPathUtils.child(root, "failed"),
        logDir = LrPathUtils.child(root, "logs"),
        logFile = LrPathUtils.child(LrPathUtils.child(root, "logs"), "bridge.log"),
        sessionFile = LrPathUtils.child(root, "session.json"),
        heartbeatFile = LrPathUtils.child(root, "heartbeat.json"),
        capabilitiesFile = LrPathUtils.child(root, "capabilities-lr15.0.1-jpg-core33.json"),
    }
end

local function pluginVersion()
    return Config.plugin_version
end

local function lrVersion()
    local ok, version = pcall(function() return LrApplication.versionString() end)
    if not ok or version == nil then return "unknown" end
    return tostring(version)
end

local function writeText(path, text)
    local handle, reason = io.open(path, "wb")
    if not handle then return false, reason end
    local ok, writeReason = handle:write(text)
    handle:close()
    if not ok then return false, writeReason end
    return true
end

-- 同卷原子发布：先写 .tmp，再删除旧文件后改名。改名前检查旧文件，
-- 避免 LrFileUtils.move 在目标已存在时失败。
local function publishFile(temporaryPath, finalPath)
    if LrFileUtils.exists(finalPath) then
        local removed, removeReason = LrFileUtils.delete(finalPath)
        if not removed then return false, "could not replace existing file: " .. tostring(removeReason) end
    end
    local moved, moveReason = LrFileUtils.move(temporaryPath, finalPath)
    if not moved then return false, tostring(moveReason) end
    return true
end

local function writeJsonAtomic(finalPath, value)
    local ok, encoded = pcall(function() return Json.encode(value) end)
    if not ok then return false, "JSON encoding failed: " .. tostring(encoded) end
    local wrote, reason = writeText(finalPath .. ".tmp", encoded)
    if not wrote then return false, reason end
    return publishFile(finalPath .. ".tmp", finalPath)
end

-- session.json 中的 token 是跨 Lua 模块重载的唯一运行所有权。Reload 会创建新的
-- Queue 模块，但旧异步闭包仍可能存活；旧循环必须在触碰单槽或心跳前确认自己仍是
-- 当前发布者，否则自动退出，避免不同 stage/token 的桥争用同一队列。
local function ownsPublishedSession()
    if type(Queue.sessionToken) ~= "string" or Queue.sessionToken == "" then
        return false, "local session token missing"
    end
    if not LrFileUtils.exists(Queue.paths.sessionFile) then
        return false, "published session missing"
    end
    local readOk, raw = pcall(LrFileUtils.readFile, Queue.paths.sessionFile)
    if not readOk or type(raw) ~= "string" then
        return false, "published session unreadable"
    end
    local decodeOk, published = pcall(function() return Json.decode(raw) end)
    if not decodeOk or type(published) ~= "table" then
        return false, "published session invalid"
    end
    if published.token ~= Queue.sessionToken then
        return false, "published session token changed"
    end
    return true, nil
end

local function retainSessionOwnership(loopName)
    local owns, reason = ownsPublishedSession()
    if owns then return true end
    Queue.running = false
    Queue.state = "superseded"
    Queue.log("warn", "bridge_superseded", { loop = loopName, reason = reason })
    return false
end

-- 结构化日志：一行一个 JSON，机器可解析；超过上限轮转归档。
local function logFileSize(path)
    local handle = io.open(path, "rb")
    if not handle then return 0 end
    local size = handle:seek("end")
    handle:close()
    return size
end

local function rotateLog()
    if logFileSize(Queue.paths.logFile) < Config.log_max_bytes then return end
    local archived = Queue.paths.logFile .. ".1"
    if LrFileUtils.exists(archived) then pcall(function() LrFileUtils.delete(archived) end) end
    local moved, reason = LrFileUtils.move(Queue.paths.logFile, archived)
    if not moved then
        Queue.lastError = "log rotation failed: " .. tostring(reason)
    end
end

function Queue.log(level, event, fields)
    local entry = { ts = os.time(), level = level, event = event }
    if fields then
        for key, value in pairs(fields) do entry[key] = value end
    end
    local ok, encoded = pcall(function() return Json.encode(entry) end)
    if not ok then
        encoded = '{"ts":' .. os.time() .. ',"level":"error","event":"log_encode_failed"}'
    end
    rotateLog()
    local handle, openError = io.open(Queue.paths.logFile, "ab")
    if not handle then
        Queue.lastError = "log open failed: " .. tostring(openError)
        return
    end
    handle:write(encoded, "\n")
    handle:close()
end

-- 非递归 JSON 深度预扫描：拒绝嵌套过深和明显残缺的输入，
-- 防止深度炸弹与递归解码一起拖垮 Lightroom 宿主。
local function scanJsonDepth(raw)
    local depth, maxDepth = 0, 0
    local inString, escaped = false, false
    for index = 1, #raw do
        local byte = raw:sub(index, index)
        if inString then
            if escaped then
                escaped = false
            elseif byte == "\\" then
                escaped = true
            elseif byte == '"' then
                inString = false
            end
        elseif byte == '"' then
            inString = true
        elseif byte == "{" or byte == "[" then
            depth = depth + 1
            if depth > maxDepth then maxDepth = depth end
        elseif byte == "}" or byte == "]" then
            depth = depth - 1
            if depth < 0 then return -1 end
        end
    end
    if inString or depth ~= 0 then return -1 end
    return maxDepth
end

local function moveToFailed(sourcePath, code, message)
    if type(sourcePath) ~= "string" or sourcePath == "" then
        Queue.log("warn", "quarantine_skipped", { code = code, reason = "empty source path" })
        return false
    end
    if not LrFileUtils.exists(sourcePath) then
        Queue.log("warn", "quarantine_skipped", { code = code, source = sourcePath, reason = "source no longer exists" })
        return true
    end
    local name = sourcePath:match("[^/\\]+$") or "unknown.json"
    local safeCode = tostring(code or "REJECTED"):gsub("[^%w_-]", "_")
    local uniqueName = tostring(os.time()) .. "-" .. safeCode .. "-" .. LrUUID.generateUUID() .. "-" .. name
    local destination = LrPathUtils.child(Queue.paths.failedDir, uniqueName)
    local moved, reason
    local moveOk, moveResult, moveReason = pcall(LrFileUtils.move, sourcePath, destination)
    if moveOk then
        moved, reason = moveResult, moveReason
    else
        moved, reason = false, moveResult
    end
    if not moved then
        -- A malformed request must never occupy the single inbox slot forever.
        -- If quarantine cannot preserve it, delete the source as a last resort.
        local deleteOk, deleteResult, deleteReason = pcall(LrFileUtils.delete, sourcePath)
        local deleted = deleteOk and deleteResult ~= false and not LrFileUtils.exists(sourcePath)
        if not deleted then
            Queue.lastError = "could not release rejected request: " .. tostring(deleteReason or deleteResult or reason)
            Queue.state = "quarantine_failed"
            Queue.running = false
            Queue.log("error", "quarantine_failed", {
                source = sourcePath,
                move_reason = tostring(reason),
                delete_reason = tostring(deleteReason or deleteResult),
                bridge_stopped = true,
            })
            return false
        end
        Queue.failedRequests = Queue.failedRequests + 1
        Queue.log("warn", "request_discarded_after_quarantine_failure", {
            code = code, message = message, source = sourcePath, move_reason = tostring(reason),
        })
        return true
    end
    local reasonPayload = {
        code = code,
        message = message,
        moved_at_epoch = os.time(),
        source_name = name,
    }
    local encodedOk, encoded = pcall(Json.encode, reasonPayload)
    if encodedOk then
        local wrote, writeReason = writeText(destination .. ".reason.json", encoded)
        if not wrote then
            Queue.log("warn", "quarantine_reason_write_failed", {
                file = uniqueName, reason = tostring(writeReason),
            })
        end
    else
        Queue.log("warn", "quarantine_reason_encode_failed", {
            file = uniqueName, reason = tostring(encoded),
        })
    end
    Queue.failedRequests = Queue.failedRequests + 1
    Queue.log("warn", "request_quarantined", { code = code, message = message, file = uniqueName })
    return true
end

-- 预检规则与 Node 侧 file-queue-protocol.mjs 保持一致；两侧互不信任。
local function preflight(raw)
    if #raw > Config.max_request_bytes then
        return nil, { code = "REQUEST_TOO_LARGE", message = "Request exceeded the " .. tostring(Config.max_request_bytes) .. "-byte limit" }
    end
    local depth = scanJsonDepth(raw)
    if depth < 0 then
        return nil, { code = "INVALID_JSON", message = "Request JSON is malformed" }
    end
    if depth > Config.max_json_depth then
        return nil, { code = "TOO_DEEP", message = "Request JSON nesting exceeds " .. tostring(Config.max_json_depth) .. " levels" }
    end
    local decoded, message = pcall(Json.decode, raw)
    if not decoded or type(message) ~= "table" then
        return nil, { code = "INVALID_JSON", message = tostring(message) }
    end
    local request = message
    if request.protocol_version ~= Config.protocol_version then
        return nil, { code = "PROTOCOL_MISMATCH", message = "Unsupported bridge protocol version" }
    end
    if type(request.token) ~= "string" or request.token ~= Queue.sessionToken then
        return nil, { code = "AUTHENTICATION_FAILED", message = "Invalid bridge session token" }
    end
    if type(request.request_id) ~= "string" or request.request_id == "" then
        return nil, { code = "INVALID_REQUEST", message = "request_id must be a non-empty string" }
    end
    if Queue.recentRequestIds[request.request_id] then
        return nil, { code = "DUPLICATE_REQUEST", message = "request_id has already been accepted in this session" }
    end
    if type(request.created_at_epoch) ~= "number" or type(request.ttl_seconds) ~= "number"
        or request.ttl_seconds < 1 or request.ttl_seconds > Config.max_ttl_seconds then
        return nil, { code = "INVALID_REQUEST", message = "created_at_epoch or ttl_seconds is invalid" }
    end
    if request.created_at_epoch + request.ttl_seconds < os.time() then
        return nil, { code = "STALE_REQUEST", message = "Request expired before Lightroom could process it" }
    end
    if type(request.method) ~= "string" or request.method == "" then
        return nil, { code = "INVALID_REQUEST", message = "method must be a non-empty string" }
    end
    return request, nil
end

local function isEnabled(method)
    for _, enabled in ipairs(Config.enabledMethods()) do
        if enabled == method then return true end
    end
    return false
end

local function writeResponse(requestId, okFlag, payload, durationSeconds)
    local envelope = {
        protocol_version = Config.protocol_version,
        request_id = requestId,
        ok = okFlag,
        plugin_version = pluginVersion(),
        duration_seconds = durationSeconds,
        completed_at_epoch = os.time(),
    }
    if okFlag then
        envelope.result = payload
    else
        envelope.error = payload
    end
    local ok, encoded = pcall(function() return Json.encode(envelope) end)
    if not ok then
        encoded = Json.encode({
            protocol_version = Config.protocol_version,
            request_id = requestId,
            ok = false,
            error = { code = "RESPONSE_ENCODING_FAILED", message = tostring(encoded) },
            plugin_version = pluginVersion(),
            duration_seconds = durationSeconds,
            completed_at_epoch = os.time(),
        })
    end
    local finalPath = LrPathUtils.child(Queue.paths.outboxDir, requestId .. ".json")
    local wrote, reason = writeText(finalPath .. ".tmp", encoded)
    if not wrote then
        Queue.lastError = "response write failed: " .. tostring(reason)
        Queue.log("error", "response_write_failed", { request_id = requestId, reason = tostring(reason) })
        return false
    end
    local moved, moveReason = publishFile(finalPath .. ".tmp", finalPath)
    if not moved then
        Queue.lastError = "response publish failed: " .. tostring(moveReason)
        Queue.log("error", "response_publish_failed", { request_id = requestId, reason = tostring(moveReason) })
        return false
    end
    return true
end

local transportMethods = {
    ping = function()
        return true, {
            pong = true,
            protocol_version = Config.protocol_version,
            plugin_version = pluginVersion(),
            lr_version = lrVersion(),
            stage = Config.stage,
            server_time_epoch = os.time(),
        }
    end,
    capabilities = function()
        local bridge = Bridge.invoke("capabilities", {})
        return true, {
            protocol_version = Config.protocol_version,
            plugin_version = pluginVersion(),
            lr_version = lrVersion(),
            stage = Config.stage,
            enabled_methods = Config.enabledMethods(),
            max_request_bytes = Config.max_request_bytes,
            max_response_bytes = Config.max_response_bytes,
            max_json_depth = Config.max_json_depth,
            max_ttl_seconds = Config.max_ttl_seconds,
            bridge = bridge,
        }
    end,
    status = function()
        return true, {
            running = Queue.running,
            state = Queue.state,
            stage = Config.stage,
            enabled_methods = Config.enabledMethods(),
            session_token_present = Queue.sessionToken ~= nil,
            completed_requests = Queue.completedRequests,
            failed_requests = Queue.failedRequests,
            last_error = Queue.lastError,
            uptime_seconds = Queue.running and math.floor(os.time() - Queue.startedAt) or 0,
        }
    end,
}

local function dispatch(request)
    local handler = transportMethods[request.method]
    if handler then return handler(request.params or {}) end
    return true, Bridge.invoke(request.method, request.params or {})
end

-- 认领后的处理在独立异步任务中执行；任何失败都必须落日志并释放忙标志。
local function processClaimed(request, claimPath)
    local started = os.time()
    local ok, result
    if not isEnabled(request.method) then
        ok, result = false, {
            code = "METHOD_DISABLED",
            message = "method is disabled in stage " .. Config.stage .. ": " .. tostring(request.method),
        }
    else
        local dispatchOk, responseOk, responseResult = LrTasks.pcall(dispatch, request)
        if dispatchOk then
            ok, result = responseOk, responseResult
        elseif type(responseOk) == "table" and responseOk.__bridge_error then
            ok, result = false, {
                code = responseOk.code,
                message = responseOk.message,
                details = responseOk.details,
            }
        else
            ok, result = false, { code = "INTERNAL_ERROR", message = tostring(responseOk) }
        end
    end
    local duration = os.time() - started
    if ok then
        writeResponse(request.request_id, true, result, duration)
        Queue.completedRequests = Queue.completedRequests + 1
        Queue.log("info", "request_completed", {
            request_id = request.request_id,
            method = request.method,
            duration_seconds = duration,
            ok = true,
        })
    else
        writeResponse(request.request_id, false, result, duration)
        Queue.failedRequests = Queue.failedRequests + 1
        Queue.log("warn", "request_failed", {
            request_id = request.request_id,
            method = request.method,
            code = result and result.code or "UNKNOWN",
            message = result and result.message or tostring(result),
            duration_seconds = duration,
        })
    end
    pcall(function() LrFileUtils.delete(claimPath) end)
    Queue.busy = false
end

local function pollOnce()
    if not retainSessionOwnership("poll") then return end
    if Queue.busy then return end
    local slot = Queue.paths.inboxNext
    if not LrFileUtils.exists(slot) then return end
    -- Node only creates the slot after reading session.json. Recheck after observing the
    -- slot so an old loop cannot quarantine a request published for a newer token.
    if not retainSessionOwnership("poll_claim") then return end

    local readOk, contents = pcall(LrFileUtils.readFile, slot)
    if not readOk or type(contents) ~= "string" then
        Queue.log("warn", "slot_read_failed", { message = tostring(contents) })
        moveToFailed(slot, "SLOT_READ_FAILED", tostring(contents))
        return
    end

    local request, rejected = preflight(contents)
    if rejected then
        moveToFailed(slot, rejected.code, rejected.message)
        return
    end

    local requestId = request.request_id
    local claimPath = LrPathUtils.child(Queue.paths.processingDir, requestId .. ".json")
    if LrFileUtils.exists(claimPath) then
        moveToFailed(slot, "DUPLICATE_REQUEST", "a processing file already exists for this request_id")
        return
    end
    local moved, moveReason = LrFileUtils.move(slot, claimPath)
    if not moved then
        Queue.lastError = "claim failed: " .. tostring(moveReason)
        Queue.log("error", "claim_failed", { reason = tostring(moveReason) })
        return
    end

    Queue.busy = true
    Queue.recentRequestIds[requestId] = true
    Queue.recentRequestOrder[#Queue.recentRequestOrder + 1] = requestId
    if #Queue.recentRequestOrder > Config.keep_recent_request_ids then
        local oldest = table.remove(Queue.recentRequestOrder, 1)
        Queue.recentRequestIds[oldest] = nil
    end

    LrTasks.startAsyncTask(function()
        processClaimed(request, claimPath)
    end)
end

local function pollLoop()
    while Queue.running do
        if not retainSessionOwnership("poll_loop") then break end
        local ok, errorMessage = pcall(pollOnce)
        if not ok then
            Queue.log("error", "poll_failed", { message = tostring(errorMessage) })
        end
        LrTasks.sleep(Config.poll_interval_seconds)
    end
end

local function heartbeatPayload()
    return {
        protocol_version = Config.protocol_version,
        state = Queue.lastError and "error" or (Queue.busy and "processing" or "idle"),
        lr_version = lrVersion(),
        plugin_version = pluginVersion(),
        stage = Config.stage,
        uptime_seconds = math.floor(os.time() - (Queue.startedAt or os.time())),
        completed_requests = Queue.completedRequests,
        failed_requests = Queue.failedRequests,
        last_error = Queue.lastError,
        last_updated_epoch = os.time(),
    }
end

local function updateHeartbeat()
    local ok, payload = pcall(heartbeatPayload)
    if not ok then return end
    local wrote, reason = writeJsonAtomic(Queue.paths.heartbeatFile, payload)
    if not wrote then
        Queue.lastError = "heartbeat publish failed: " .. tostring(reason)
    end
end

local function heartbeatLoop()
    while Queue.running do
        if not retainSessionOwnership("heartbeat_loop") then break end
        local ok, errorMessage = pcall(updateHeartbeat)
        if not ok then
            Queue.lastError = "heartbeat task crashed: " .. tostring(errorMessage)
        end
        LrTasks.sleep(Config.heartbeat_interval_seconds)
    end
end

local function ensureDirectories()
    local created, reason = LrFileUtils.createAllDirectories(Queue.paths.inboxDir)
    if not created then error("could not create inbox directory: " .. tostring(reason)) end
    for _, directory in ipairs({ Queue.paths.processingDir, Queue.paths.outboxDir, Queue.paths.failedDir, Queue.paths.logDir }) do
        local ok, directoryReason = LrFileUtils.createAllDirectories(directory)
        if not ok then error("could not create directory: " .. tostring(directoryReason)) end
    end
end

function Queue.start()
    if Queue.running then return "already_running" end
    Queue.running = true
    Queue.state = "starting"
    Queue.startedAt = os.time()
    Queue.sessionToken = (LrUUID.generateUUID() .. LrUUID.generateUUID()):gsub("%-", "")
    Queue.recentRequestIds = {}
    Queue.recentRequestOrder = {}
    Queue.completedRequests = 0
    Queue.failedRequests = 0
    Queue.lastError = nil

    ensureQueuePaths()

    local ok, errorMessage = pcall(ensureDirectories)
    if not ok then
        Queue.running = false
        Queue.state = "error"
        Queue.lastError = tostring(errorMessage)
        return "directory_error"
    end

    if LrFileUtils.exists(Queue.paths.capabilitiesFile) then
        local evidenceOk, evidenceOrReason = pcall(function()
            return Json.decode(LrFileUtils.readFile(Queue.paths.capabilitiesFile))
        end)
        if evidenceOk then
            local loaded, loadReason = Bridge.loadProbeEvidence(evidenceOrReason)
            if not loaded then Queue.lastError = "Core33 evidence rejected: " .. tostring(loadReason) end
        else
            Queue.lastError = "Core33 evidence unreadable: " .. tostring(evidenceOrReason)
        end
    end

    local published, publishReason = writeJsonAtomic(Queue.paths.sessionFile, {
        protocol_version = Config.protocol_version,
        plugin_id = _PLUGIN.id,
        plugin_version = pluginVersion(),
        lr_version = lrVersion(),
        stage = Config.stage,
        enabled_methods = Config.enabledMethods(),
        token = Queue.sessionToken,
        max_request_bytes = Config.max_request_bytes,
        max_response_bytes = Config.max_response_bytes,
        max_json_depth = Config.max_json_depth,
        max_ttl_seconds = Config.max_ttl_seconds,
        heartbeat_interval_seconds = Config.heartbeat_interval_seconds,
        created_at_epoch = os.time(),
    })
    if not published then
        Queue.running = false
        Queue.state = "error"
        Queue.lastError = "session publish failed: " .. tostring(publishReason)
        return "session_error"
    end

    Queue.state = "running"
    Queue.log("info", "bridge_started", {
        stage = Config.stage,
        lr_version = lrVersion(),
        plugin_version = pluginVersion(),
        token_length = #Queue.sessionToken,
    })
    LrTasks.startAsyncTask(pollLoop)
    LrTasks.startAsyncTask(heartbeatLoop)
    return "started"
end

function Queue.stop()
    ensureQueuePaths()
    local wasRunning = Queue.running
    Queue.running = false
    Queue.state = "stopped"
    Queue.log("info", "bridge_stopped", { local_module_was_running = wasRunning })
    -- 删除会话与心跳，让 Node 立即感知桥不可用。
    pcall(function() LrFileUtils.delete(Queue.paths.sessionFile) end)
    pcall(function() LrFileUtils.delete(Queue.paths.heartbeatFile) end)
    Queue.sessionToken = nil
    return "stopped"
end

function Queue.status()
    return {
        running = Queue.running,
        state = Queue.state,
        stage = Config.stage,
        enabled_methods = Config.enabledMethods(),
        session_token_present = Queue.sessionToken ~= nil,
        completed_requests = Queue.completedRequests,
        failed_requests = Queue.failedRequests,
        last_error = Queue.lastError,
        uptime_seconds = Queue.running and math.floor(os.time() - Queue.startedAt) or 0,
    }
end

return Queue
