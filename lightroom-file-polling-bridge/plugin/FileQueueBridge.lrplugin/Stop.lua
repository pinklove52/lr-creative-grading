local LrDialogs = import "LrDialogs"
local Queue = require "QueueTransport"

local result = Queue.stop()

LrDialogs.message(
    "File Queue Bridge",
    "Bridge stop: " .. result
        .. "\nSession and heartbeat files have been removed.",
    result == "stopped" and "info" or "critical"
)
