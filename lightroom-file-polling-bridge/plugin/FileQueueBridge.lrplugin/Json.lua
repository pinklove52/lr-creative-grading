-- Small JSON codec for the bridge wire protocol. It intentionally supports
-- only JSON data types and rejects cyclic/sparse tables and non-finite numbers.
local Json = { null = {} }

local escapeMap = {
    ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
    ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(value)
    return '"' .. value:gsub('[%z\1-\31\\"]', function(char)
        return escapeMap[char] or string.format('\\u%04x', string.byte(char))
    end) .. '"'
end

local function classifyTable(value)
    local count, max = 0, 0
    local hasString = false
    for key, _ in pairs(value) do
        count = count + 1
        if type(key) == "number" and key > 0 and key == math.floor(key) then
            if key > max then max = key end
        elseif type(key) == "string" then
            hasString = true
        else
            error("JSON object keys must be strings or array indices")
        end
    end
    if hasString then return "object" end
    if max ~= count then error("sparse arrays are not valid JSON") end
    return "array"
end

local function encodeValue(value, stack)
    if value == Json.null or value == nil then return "null" end
    local kind = type(value)
    if kind == "string" then return encodeString(value) end
    if kind == "boolean" then return value and "true" or "false" end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            error("non-finite numbers are not valid JSON")
        end
        return string.format("%.17g", value)
    end
    if kind ~= "table" then error("unsupported JSON value type: " .. kind) end
    if stack[value] then error("cyclic tables are not valid JSON") end
    stack[value] = true
    local output = {}
    if classifyTable(value) == "array" then
        for index = 1, #value do
            output[#output + 1] = encodeValue(value[index], stack)
        end
        stack[value] = nil
        return "[" .. table.concat(output, ",") .. "]"
    end
    local keys = {}
    for key, _ in pairs(value) do keys[#keys + 1] = key end
    table.sort(keys)
    for _, key in ipairs(keys) do
        output[#output + 1] = encodeString(key) .. ":" .. encodeValue(value[key], stack)
    end
    stack[value] = nil
    return "{" .. table.concat(output, ",") .. "}"
end

function Json.encode(value)
    return encodeValue(value, {})
end

local function decodeError(text, index, message)
    error(string.format("JSON decode error at byte %d: %s", index, message), 0)
end

local function utf8(codepoint)
    if codepoint <= 0x7f then return string.char(codepoint) end
    if codepoint <= 0x7ff then
        return string.char(0xc0 + math.floor(codepoint / 0x40), 0x80 + codepoint % 0x40)
    end
    if codepoint <= 0xffff then
        return string.char(
            0xe0 + math.floor(codepoint / 0x1000),
            0x80 + math.floor(codepoint / 0x40) % 0x40,
            0x80 + codepoint % 0x40
        )
    end
    return string.char(
        0xf0 + math.floor(codepoint / 0x40000),
        0x80 + math.floor(codepoint / 0x1000) % 0x40,
        0x80 + math.floor(codepoint / 0x40) % 0x40,
        0x80 + codepoint % 0x40
    )
end

local function skipWhitespace(text, index)
    local _, last = text:find("^[ \n\r\t]*", index)
    return (last or index - 1) + 1
end

local parseValue

local function parseString(text, index)
    index = index + 1
    local output = {}
    local start = index
    while index <= #text do
        local byte = string.byte(text, index)
        if byte == 34 then
            output[#output + 1] = text:sub(start, index - 1)
            return table.concat(output), index + 1
        end
        if byte == 92 then
            output[#output + 1] = text:sub(start, index - 1)
            local escaped = text:sub(index + 1, index + 1)
            local simple = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
            if simple[escaped] then
                output[#output + 1] = simple[escaped]
                index = index + 2
            elseif escaped == "u" then
                local hex = text:sub(index + 2, index + 5)
                if not hex:match("^%x%x%x%x$") then decodeError(text, index, "invalid unicode escape") end
                local codepoint = tonumber(hex, 16)
                index = index + 6
                if codepoint >= 0xd800 and codepoint <= 0xdbff and text:sub(index, index + 1) == "\\u" then
                    local lowHex = text:sub(index + 2, index + 5)
                    local low = tonumber(lowHex, 16)
                    if not low or low < 0xdc00 or low > 0xdfff then
                        decodeError(text, index, "invalid unicode surrogate pair")
                    end
                    codepoint = 0x10000 + (codepoint - 0xd800) * 0x400 + (low - 0xdc00)
                    index = index + 6
                end
                output[#output + 1] = utf8(codepoint)
            else
                decodeError(text, index, "invalid escape")
            end
            start = index
        elseif byte < 32 then
            decodeError(text, index, "control character in string")
        else
            index = index + 1
        end
    end
    decodeError(text, index, "unterminated string")
end

local function parseNumber(text, index)
    local token = text:match("^-?%d+%.?%d*[eE]?[+-]?%d*", index)
    if not token or token == "" then decodeError(text, index, "invalid number") end
    local value = tonumber(token)
    if not value then decodeError(text, index, "invalid number") end
    return value, index + #token
end

local function parseArray(text, index)
    local output = {}
    index = skipWhitespace(text, index + 1)
    if text:sub(index, index) == "]" then return output, index + 1 end
    while true do
        local value
        value, index = parseValue(text, index)
        output[#output + 1] = value
        index = skipWhitespace(text, index)
        local char = text:sub(index, index)
        if char == "]" then return output, index + 1 end
        if char ~= "," then decodeError(text, index, "expected ',' or ']'") end
        index = skipWhitespace(text, index + 1)
    end
end

local function parseObject(text, index)
    local output = {}
    index = skipWhitespace(text, index + 1)
    if text:sub(index, index) == "}" then return output, index + 1 end
    while true do
        if text:sub(index, index) ~= '"' then decodeError(text, index, "expected object key") end
        local key
        key, index = parseString(text, index)
        index = skipWhitespace(text, index)
        if text:sub(index, index) ~= ":" then decodeError(text, index, "expected ':'") end
        index = skipWhitespace(text, index + 1)
        output[key], index = parseValue(text, index)
        index = skipWhitespace(text, index)
        local char = text:sub(index, index)
        if char == "}" then return output, index + 1 end
        if char ~= "," then decodeError(text, index, "expected ',' or '}'") end
        index = skipWhitespace(text, index + 1)
    end
end

parseValue = function(text, index)
    index = skipWhitespace(text, index)
    local char = text:sub(index, index)
    if char == '"' then return parseString(text, index) end
    if char == "{" then return parseObject(text, index) end
    if char == "[" then return parseArray(text, index) end
    if char == "-" or char:match("%d") then return parseNumber(text, index) end
    if text:sub(index, index + 3) == "true" then return true, index + 4 end
    if text:sub(index, index + 4) == "false" then return false, index + 5 end
    if text:sub(index, index + 3) == "null" then return Json.null, index + 4 end
    decodeError(text, index, "unexpected token")
end

function Json.decode(text)
    if type(text) ~= "string" then error("JSON input must be a string") end
    local value, index = parseValue(text, 1)
    index = skipWhitespace(text, index)
    if index <= #text then decodeError(text, index, "trailing data") end
    return value
end

return Json
