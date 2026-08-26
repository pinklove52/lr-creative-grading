import assert from "node:assert/strict";
import test from "node:test";
import {
  HEARTBEAT_STALE_MS,
  MAX_JSON_DEPTH,
  MAX_REQUEST_BYTES,
  MAX_TTL_SECONDS,
  PROTOCOL_VERSION,
  isHeartbeatFresh,
  scanJsonDepth,
  validateRequest,
  validateResponse,
} from "../src/file-queue-protocol.mjs";

const TOKEN = "session-token-for-tests";

function requestOverrides(overrides = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: "request-1",
    token: TOKEN,
    method: "ping",
    params: {},
    created_at_epoch: Math.floor(Date.now() / 1000),
    ttl_seconds: 30,
    ...overrides,
  };
}

test("scanJsonDepth handles nesting, strings, and malformed input iteratively", () => {
  assert.equal(scanJsonDepth("{}"), 1);
  assert.equal(scanJsonDepth('{"a":{"b":{"c":1}}}'), 3);
  assert.equal(scanJsonDepth("[[[[1]]]]"), 4);
  // 字符串中的括号不计数
  assert.equal(scanJsonDepth('{"a":"{not nested [","b":[1]}'), 2);
  // 残缺输入返回 -1
  assert.equal(scanJsonDepth('{"a":'), -1);
  assert.equal(scanJsonDepth('{"a":"unterminated}'), -1);
  assert.equal(scanJsonDepth("}"), -1);
  assert.equal(scanJsonDepth(""), 0);
  // 32 层允许，33 层拒绝（与插件侧一致）
  const depth32 = JSON.stringify(JSON.parse("[" .repeat(32) + "0" + "]".repeat(32)));
  const depth33 = JSON.stringify(JSON.parse("[" .repeat(33) + "0" + "]".repeat(33)));
  assert.equal(scanJsonDepth(depth32), 32);
  assert.equal(scanJsonDepth(depth33), 33);
});

test("validateRequest accepts a well-formed ping envelope", () => {
  const { ok, request } = validateRequest(JSON.stringify(requestOverrides()), { token: TOKEN });
  assert.equal(ok, true);
  assert.equal(request.method, "ping");
});

test("validateRequest rejects each protocol violation with the contract code", () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [requestOverrides({ protocol_version: 1 }), "PROTOCOL_MISMATCH"],
    [requestOverrides({ token: "wrong-token" }), "AUTHENTICATION_FAILED"],
    [requestOverrides({ request_id: "" }), "INVALID_REQUEST"],
    [requestOverrides({ request_id: 42 }), "INVALID_REQUEST"],
    [requestOverrides({ method: "" }), "INVALID_REQUEST"],
    [requestOverrides({ method: 7 }), "INVALID_REQUEST"],
    [requestOverrides({ ttl_seconds: 0 }), "INVALID_REQUEST"],
    [requestOverrides({ ttl_seconds: MAX_TTL_SECONDS + 1 }), "INVALID_REQUEST"],
    [requestOverrides({ created_at_epoch: now - 100, ttl_seconds: 5 }), "STALE_REQUEST"],
  ];
  for (const [envelope, expectedCode] of cases) {
    const { ok, code } = validateRequest(JSON.stringify(envelope), { token: TOKEN });
    assert.equal(ok, false, `expected rejection for ${expectedCode}`);
    assert.equal(code, expectedCode);
  }
});

test("validateRequest rejects oversized, deep, and malformed bodies", () => {
  const big = JSON.stringify(requestOverrides({ params: { blob: "x".repeat(MAX_REQUEST_BYTES) } }));
  assert.equal(validateRequest(big, { token: TOKEN }).code, "REQUEST_TOO_LARGE");
  const deep = `[${"[".repeat(MAX_JSON_DEPTH + 1)}0${"]".repeat(MAX_JSON_DEPTH + 1)}]`;
  assert.equal(validateRequest(deep, { token: TOKEN }).code, "TOO_DEEP");
  assert.equal(validateRequest("{not json", { token: TOKEN }).code, "INVALID_JSON");
  assert.equal(validateRequest("[]", { token: TOKEN }).code, "INVALID_REQUEST");
});

test("validateResponse accepts success and failure envelopes", () => {
  const success = {
    protocol_version: PROTOCOL_VERSION,
    request_id: "request-1",
    ok: true,
    result: { pong: true },
  };
  assert.equal(validateResponse(JSON.stringify(success), "request-1").ok, true);
  const failure = {
    protocol_version: PROTOCOL_VERSION,
    request_id: "request-1",
    ok: false,
    error: { code: "METHOD_DISABLED", message: "nope" },
  };
  const parsed = validateResponse(JSON.stringify(failure), "request-1");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.response.error.code, "METHOD_DISABLED");
});

test("validateResponse rejects shape violations", () => {
  const base = {
    protocol_version: PROTOCOL_VERSION,
    request_id: "request-1",
    ok: true,
    result: {},
  };
  assert.equal(validateResponse(JSON.stringify({ ...base, request_id: "other" }), "request-1").code, "INVALID_PLUGIN_RESPONSE");
  assert.equal(validateResponse(JSON.stringify({ ...base, ok: false }), "request-1").code, "INVALID_PLUGIN_RESPONSE");
  assert.equal(validateResponse(JSON.stringify({ ...base, protocol_version: 1 }), "request-1").code, "INVALID_PLUGIN_RESPONSE");
  assert.equal(validateResponse(JSON.stringify({ ...base, result: undefined }), "request-1").code, "INVALID_PLUGIN_RESPONSE");
  const failure = { ...base, ok: false, error: { code: "X", message: "y" } };
  assert.equal(validateResponse(JSON.stringify(failure), "request-1").ok, true);
  assert.equal(validateResponse(JSON.stringify({ ...failure, error: "not-an-object" }), "request-1").code, "INVALID_PLUGIN_RESPONSE");
});

test("isHeartbeatFresh accepts fresh heartbeats and rejects stale or invalid ones", () => {
  const now = Date.now();
  const fresh = JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    state: "idle",
    last_updated_epoch: Math.floor(now / 1000),
  });
  assert.equal(isHeartbeatFresh(fresh, { now }).fresh, true);
  const stale = JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    state: "idle",
    last_updated_epoch: Math.floor((now - HEARTBEAT_STALE_MS - 1000) / 1000),
  });
  const staleResult = isHeartbeatFresh(stale, { now });
  assert.equal(staleResult.fresh, false);
  assert.equal(staleResult.reason, "HEARTBEAT_STALE");
  assert.equal(isHeartbeatFresh("not json", { now }).fresh, false);
  assert.equal(isHeartbeatFresh(JSON.stringify({ protocol_version: 1, last_updated_epoch: 0 }), { now }).fresh, false);
  assert.equal(isHeartbeatFresh(JSON.stringify({ protocol_version: PROTOCOL_VERSION }), { now }).fresh, false);
});
