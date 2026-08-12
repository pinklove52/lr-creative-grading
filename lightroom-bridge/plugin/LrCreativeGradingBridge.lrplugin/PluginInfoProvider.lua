local LrView = import "LrView"
local Transport = require "Transport"

local Provider = {}

function Provider.sectionsForTopOfDialog(_, _)
    local f = LrView.osFactory()
    local status = Transport.status()
    return {
        {
            title = "Creative Grading Bridge",
            f:column {
                spacing = f:control_spacing(),
                f:static_text { title = "State: " .. tostring(status.state) },
                f:static_text { title = "Host: 127.0.0.1 only" },
                f:static_text { title = "Protocol: " .. tostring(status.protocol_version) },
                f:static_text { title = status.message or "Waiting for the local MCP service." },
            },
        },
    }
end

return Provider
