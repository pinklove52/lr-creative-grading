local LrDialogs = import "LrDialogs"
local Queue = require "QueueTransport"

local result = Queue.start()
local status = Queue.status()

LrDialogs.message(
    "File Queue Bridge",
    "Bridge start: " .. result
        .. "\nState: " .. status.state
        .. "\nStage: " .. status.stage
        .. "\nSession token present: " .. tostring(status.session_token_present)
        .. (status.last_error and ("\nLast error: " .. status.last_error) or ""),
    result == "started" and "info" or "critical"
)
