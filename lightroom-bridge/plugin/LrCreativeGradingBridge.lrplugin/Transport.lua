local LrFileUtils = import "LrFileUtils"
local LrFunctionContext = import "LrFunctionContext"
local LrPathUtils = import "LrPathUtils"
local LrSocket = import "LrSocket"
local LrTasks = import "LrTasks"
local LrUUID = import "LrUUID"

local Bridge = require "BridgeCore"
local Json = require "Json"

local Transport = {
    running = false,
    stopping = false,
    busy = false,
    requestSocket = nil,
    responseSocket = nil,
    requestPort = nil,
    responsePort = nil,
    requestBuffer = "",
    activeClientId = nil,
    recentRequestIds = {},
    recentRequestOrder = {},
    protocolVersion = 1,
    maxRequestBytes = 1048576,
    maxResponseBytes = 1048576,
    statusState = "stopped",
    statusMessage = nil,
}

local function runtimeDirectory()
    return LrPathUtils.child(LrPathUtils.getStandardFilePath("appData"), "LrCreativeGradingBridge")
end

local function sessionPath()
    return LrPathUtils.child(runtimeDirectory(), "session.json")
end

local function writeText(path, text)
    local handle, reason = io.open(path, "wb")
    if not handle then return false, reason end
    local ok, writeReason = handle:write(text)
    handle:close()
    if not ok then return false, writeReason end
    return true
end

local function removeOwnDescriptor()
    local path = sessionPath()
    local ok, contents = pcall(LrFileUtils.readFile, path)
    if ok and type(contents) == "string" then
        local decodedOk, descriptor = pcall(Json.decode, contents)
        if decodedOk and descriptor.session_id == Transport.sessionId then
            pcall(os.remove, path)
        end
    end
end

local function publishDescriptor()
    if not Transport.running or not Transport.requestPort or not Transport.responsePort then return end
    local created, reason = LrFileUtils.createAllDirectories(runtimeDirectory())
    if not created then
        Transport.statusState = "error"
        Transport.statusMessage = "Could not create runtime directory: " .. tostring(reason)
        return
    end
    local descriptor = {
        protocol_version = Transport.protocolVersion,
        plugin_id = _PLUGIN.id,
        session_id = Transport.sessionId,
        host = "127.0.0.1",
        request_port = Transport.requestPort,
        response_port = Transport.responsePort,
        token = Transport.token,
        max_request_bytes = Transport.maxRequestBytes,
        max_response_bytes = Transport.maxResponseBytes,
        single_client = true,
        created_at = os.time(),
    }
    local finalPath = sessionPath()
    local temporaryPath = finalPath .. "." .. Transport.sessionId .. ".tmp"
    local ok, writeReason = writeText(temporaryPath, Json.encode(descriptor))
    if not ok then
        Transport.statusState = "error"
        Transport.statusMessage = "Could not publish bridge session: " .. tostring(writeReason)
        return
    end
    -- Publish a complete descriptor, never a partially written JSON file.
    pcall(os.remove, finalPath)
    local renamed, renameReason = os.rename(temporaryPath, finalPath)
    if not renamed then
        Transport.statusState = "error"
        Transport.statusMessage = "Could not atomically publish bridge session: " .. tostring(renameReason)
        pcall(os.remove, temporaryPath)
        return
    end
    Transport.statusState = "listening"
    Transport.statusMessage = "The authenticated localhost bridge is ready."
end

local function sendEnvelope(envelope)
    local ok, payload = pcall(Json.encode, envelope)
    if not ok then
        payload = Json.encode({
            request_id = envelope.request_id,
            ok = false,
            error = { code = "RESPONSE_ENCODING_FAILED", message = tostring(payload) },
        })
    end
    if #payload > Transport.maxResponseBytes then
        payload = Json.encode({
            request_id = envelope.request_id,
            ok = false,
            error = { code = "RESPONSE_TOO_LARGE", message = "Bridge response exceeded the size limit" },
        })
    end
    if not Transport.responseSocket then return false end
    local sent = pcall(function() Transport.responseSocket:send(payload .. "\n") end)
    return sent
end

local function reject(requestId, code, message, details)
    sendEnvelope({
        request_id = requestId,
        ok = false,
        error = { code = code, message = message, details = details },
    })
end

local function processRequest(line)
    if #line > Transport.maxRequestBytes then
        reject(nil, "REQUEST_TOO_LARGE", "Request exceeded the one-megabyte limit")
        return
    end
    local decoded, message = pcall(Json.decode, line)
    if not decoded or type(message) ~= "table" then
        reject(nil, "INVALID_JSON", "Request was not valid JSON", tostring(message))
        return
    end
    local requestId = message.request_id
    if type(requestId) ~= "string" or requestId == "" then
        reject(nil, "INVALID_REQUEST", "request_id must be a non-empty string")
        return
    end
    if message.protocol_version ~= Transport.protocolVersion then
        reject(requestId, "PROTOCOL_MISMATCH", "Unsupported bridge protocol version")
        return
    end
    if type(message.token) ~= "string" or message.token ~= Transport.token then
        reject(requestId, "AUTHENTICATION_FAILED", "Invalid bridge session token")
        return
    end
    if type(message.client_id) ~= "string" or message.client_id == "" then
        reject(requestId, "INVALID_REQUEST", "client_id must be a non-empty string")
        return
    end
    if Transport.activeClientId and Transport.activeClientId ~= message.client_id then
        reject(requestId, "CLIENT_LOCKED", "This Lightroom session already has an authenticated client")
        return
    end
    Transport.activeClientId = message.client_id
    if Transport.recentRequestIds[requestId] then
        reject(requestId, "DUPLICATE_REQUEST", "request_id has already been accepted in this session")
        return
    end
    Transport.recentRequestIds[requestId] = true
    Transport.recentRequestOrder[#Transport.recentRequestOrder + 1] = requestId
    if #Transport.recentRequestOrder > 256 then
        local expired = table.remove(Transport.recentRequestOrder, 1)
        Transport.recentRequestIds[expired] = nil
    end
    if type(message.method) ~= "string" then
        reject(requestId, "INVALID_REQUEST", "method must be a string")
        return
    end
    if Transport.busy then
        reject(requestId, "BRIDGE_BUSY", "Lightroom is still processing the prior request")
        return
    end
    Transport.busy = true
    LrTasks.startAsyncTask(function()
        local handled, result = Bridge.handle(message.method, message.params or {})
        if handled then
            sendEnvelope({ request_id = requestId, ok = true, result = result })
        else
            sendEnvelope({ request_id = requestId, ok = false, error = result })
        end
        Transport.busy = false
    end)
end

local function receiveChunk(_, chunk)
    if type(chunk) ~= "string" then return end
    Transport.requestBuffer = Transport.requestBuffer .. chunk
    if #Transport.requestBuffer > Transport.maxRequestBytes then
        Transport.requestBuffer = ""
        reject(nil, "REQUEST_TOO_LARGE", "Buffered request exceeded the size limit")
        return
    end
    while true do
        local newline = Transport.requestBuffer:find("\n", 1, true)
        if not newline then break end
        local line = Transport.requestBuffer:sub(1, newline - 1)
        Transport.requestBuffer = Transport.requestBuffer:sub(newline + 1)
        if line ~= "" then processRequest(line) end
    end
    -- Some Lightroom/Windows LrSocket builds deliver one complete message to
    -- onMessage with the transport newline already removed. Preserve the
    -- newline framing path above, but also accept a complete buffered JSON
    -- object so it cannot wait forever for a delimiter Lightroom consumed.
    if Transport.requestBuffer ~= "" then
        local decoded, bufferedMessage = pcall(Json.decode, Transport.requestBuffer)
        if decoded and type(bufferedMessage) == "table" then
            local line = Transport.requestBuffer
            Transport.requestBuffer = ""
            processRequest(line)
        end
    end
end

local function disconnected(kind, socket, reason)
    if Transport.stopping then return end
    Transport.activeClientId = nil
    Transport.recentRequestIds = {}
    Transport.recentRequestOrder = {}
    Transport.statusState = "reconnecting"
    Transport.statusMessage = kind .. " socket disconnected: " .. tostring(reason or "closed")
    if kind == "request" then Transport.requestPort = nil else Transport.responsePort = nil end
    removeOwnDescriptor()
    pcall(function() socket:reconnect() end)
end

local function bindSockets(context)
    Transport.requestSocket = LrSocket.bind {
        functionContext = context,
        plugin = _PLUGIN,
        port = 0,
        mode = "receive",
        onConnecting = function(_, port)
            Transport.requestPort = port
            publishDescriptor()
        end,
        onConnected = function(_, port)
            Transport.requestPort = port
            publishDescriptor()
        end,
        onMessage = receiveChunk,
        onClosed = function(socket) disconnected("request", socket, "closed") end,
        onError = function(socket, reason) disconnected("request", socket, reason) end,
    }
    Transport.responseSocket = LrSocket.bind {
        functionContext = context,
        plugin = _PLUGIN,
        port = 0,
        mode = "send",
        onConnecting = function(_, port)
            Transport.responsePort = port
            publishDescriptor()
        end,
        onConnected = function(_, port)
            Transport.responsePort = port
            publishDescriptor()
        end,
        onMessage = function() end,
        onClosed = function(socket) disconnected("response", socket, "closed") end,
        onError = function(socket, reason) disconnected("response", socket, reason) end,
    }
end

function Transport.start()
    if Transport.running then return end
    Transport.running = true
    Transport.stopping = false
    Transport.statusState = "starting"
    Transport.statusMessage = "Allocating authenticated localhost sockets."
    Transport.sessionId = LrUUID.generateUUID()
    Transport.token = (LrUUID.generateUUID() .. LrUUID.generateUUID()):gsub("%-", "")
    Transport.recentRequestIds = {}
    Transport.recentRequestOrder = {}
    LrTasks.startAsyncTask(function()
        LrFunctionContext.callWithContext("creative_grading_bridge", function(context)
            bindSockets(context)
            while Transport.running do LrTasks.sleep(0.25) end
        end)
    end)
end

function Transport.stop()
    if not Transport.running then return end
    Transport.stopping = true
    Transport.running = false
    removeOwnDescriptor()
    if Transport.requestSocket then pcall(function() Transport.requestSocket:close() end) end
    if Transport.responseSocket then pcall(function() Transport.responseSocket:close() end) end
    Transport.requestSocket = nil
    Transport.responseSocket = nil
    Transport.requestPort = nil
    Transport.responsePort = nil
    Transport.activeClientId = nil
    Transport.recentRequestIds = {}
    Transport.recentRequestOrder = {}
    Transport.token = nil
    Transport.statusState = "stopped"
    Transport.statusMessage = "Bridge stopped and session token removed."
end

function Transport.status()
    return {
        state = Transport.statusState,
        message = Transport.statusMessage,
        protocol_version = Transport.protocolVersion,
    }
end

return Transport
