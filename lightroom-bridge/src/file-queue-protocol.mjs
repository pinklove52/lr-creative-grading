// 文件队列协议 v2 的规则唯一实现（Node 侧）。
// Lua 侧 QueueTransport.lua 实现同一套规则；两侧互不信任，
// 任何一侧的放宽都必须同时修改两侧并回归测试。

export const PROTOCOL_VERSION = 2;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_JSON_DEPTH = 32;
export const MAX_TTL_SECONDS = 300;
export const HEARTBEAT_STALE_MS = 5_000;
// processing 中文件的恢复宽限期：超过该时长仍未完成视为孤儿
// （插件已崩溃），移入 failed/ 并标记 RECOVERY_UNKNOWN，绝不重放。
export const RECOVERY_GRACE_MS = 120_000;
export const SLOT_WAIT_MS = 10_000;

// 非递归深度扫描：迭代解析字符串与花括号/方括号嵌套。
// 返回最大嵌套深度；-1 表示结构残缺（字符串未闭合或括号不配对）。
export function scanJsonDepth(text) {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth < 0) return -1;
    }
  }
  return inString || depth !== 0 ? -1 : maxDepth;
}

function reject(code, message) {
  return { ok: false, code, message };
}

// 校验请求信封；规则与 Lua preflight() 一一对应。
export function validateRequest(raw, { token, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof raw !== "string") return reject("INVALID_REQUEST", "Request body must be a string");
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    return reject("REQUEST_TOO_LARGE", `Request exceeded the ${MAX_REQUEST_BYTES}-byte limit`);
  }
  const depth = scanJsonDepth(raw);
  if (depth < 0) return reject("INVALID_JSON", "Request JSON is malformed");
  if (depth > MAX_JSON_DEPTH) {
    return reject("TOO_DEEP", `Request JSON nesting exceeds ${MAX_JSON_DEPTH} levels`);
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    return reject("INVALID_JSON", String(error?.message ?? error));
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return reject("INVALID_REQUEST", "Request must be a JSON object");
  }
  if (request.protocol_version !== PROTOCOL_VERSION) {
    return reject("PROTOCOL_MISMATCH", "Unsupported bridge protocol version");
  }
  if (typeof request.token !== "string" || request.token !== token) {
    return reject("AUTHENTICATION_FAILED", "Invalid bridge session token");
  }
  if (typeof request.request_id !== "string" || request.request_id === "") {
    return reject("INVALID_REQUEST", "request_id must be a non-empty string");
  }
  if (
    typeof request.created_at_epoch !== "number" ||
    typeof request.ttl_seconds !== "number" ||
    request.ttl_seconds < 1 ||
    request.ttl_seconds > MAX_TTL_SECONDS
  ) {
    return reject("INVALID_REQUEST", "created_at_epoch or ttl_seconds is invalid");
  }
  if (request.created_at_epoch + request.ttl_seconds < now) {
    return reject("STALE_REQUEST", "Request expired before it could be processed");
  }
  if (typeof request.method !== "string" || request.method === "") {
    return reject("INVALID_REQUEST", "method must be a non-empty string");
  }
  return { ok: true, request };
}

// 校验插件响应信封；request_id 必须与等待中的请求一致。
export function validateResponse(raw, requestId) {
  if (typeof raw !== "string") return reject("INVALID_REQUEST", "Response body must be a string");
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
    return reject("RESPONSE_TOO_LARGE", `Response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`);
  }
  const depth = scanJsonDepth(raw);
  if (depth < 0 || depth > MAX_JSON_DEPTH) return reject("INVALID_PLUGIN_RESPONSE", "Response JSON is malformed");
  let response;
  try {
    response = JSON.parse(raw);
  } catch (error) {
    return reject("INVALID_PLUGIN_RESPONSE", String(error?.message ?? error));
  }
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    return reject("INVALID_PLUGIN_RESPONSE", "Response must be a JSON object");
  }
  if (response.protocol_version !== PROTOCOL_VERSION) {
    return reject("INVALID_PLUGIN_RESPONSE", "Unsupported response protocol version");
  }
  if (response.request_id !== requestId) {
    return reject("INVALID_PLUGIN_RESPONSE", "Response request_id does not match the request");
  }
  if (typeof response.ok !== "boolean") {
    return reject("INVALID_PLUGIN_RESPONSE", "Response ok must be a boolean");
  }
  if (response.ok && !("result" in response)) {
    return reject("INVALID_PLUGIN_RESPONSE", "Successful response is missing result");
  }
  if (!response.ok && (response.error === null || typeof response.error !== "object" || Array.isArray(response.error))) {
    return reject("INVALID_PLUGIN_RESPONSE", "Failed response is missing an error object");
  }
  return { ok: true, response };
}

// 心跳新鲜度：协议匹配且最后更新时间在宽限期内。
export function parseHeartbeat(raw) {
  if (typeof raw !== "string") return { ok: false, code: "INVALID_HEARTBEAT" };
  if (Buffer.byteLength(raw) > 64 * 1024) return { ok: false, code: "INVALID_HEARTBEAT" };
  let heartbeat;
  try {
    heartbeat = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID_HEARTBEAT" };
  }
  if (heartbeat === null || typeof heartbeat !== "object") return { ok: false, code: "INVALID_HEARTBEAT" };
  if (heartbeat.protocol_version !== PROTOCOL_VERSION) return { ok: false, code: "INVALID_HEARTBEAT" };
  if (typeof heartbeat.last_updated_epoch !== "number") return { ok: false, code: "INVALID_HEARTBEAT" };
  return { ok: true, heartbeat };
}

export function isHeartbeatFresh(raw, { staleMs = HEARTBEAT_STALE_MS, now = Date.now() } = {}) {
  const parsed = parseHeartbeat(raw);
  if (!parsed.ok) return { fresh: false, reason: parsed.code, heartbeat: null };
  const ageMs = now - parsed.heartbeat.last_updated_epoch * 1000;
  if (ageMs > staleMs) {
    return { fresh: false, reason: "HEARTBEAT_STALE", heartbeat: parsed.heartbeat, ageMs };
  }
  return { fresh: true, heartbeat: parsed.heartbeat, ageMs };
}
