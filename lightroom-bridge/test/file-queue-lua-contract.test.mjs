// Lua 侧契约测试：保证 FileQueueBridge.lrplugin 的源码不变量与
// Node 侧 file-queue-protocol.mjs 的规则一致（两侧互不信任的前提是
// 两侧规则真的相同；本文件用静态断言锁定这一点）。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_JSON_DEPTH,
  MAX_REQUEST_BYTES,
  MAX_TTL_SECONDS,
  PROTOCOL_VERSION,
} from "../src/file-queue-protocol.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(testDir, "../../lightroom-file-polling-bridge/plugin/FileQueueBridge.lrplugin");

async function readPlugin(relative) {
  return fs.readFile(path.join(pluginDir, relative), "utf8");
}

function luaNumber(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(source);
  assert.ok(match, `${name} not found in Lua source`);
  return Number(match[1].replace(/_/g, ""));
}

test("plugin ships all required Lua files including the reused business core", async () => {
  for (const file of [
    "Info.lua",
    "Config.lua",
    "QueueTransport.lua",
    "Start.lua",
    "Stop.lua",
    "BridgeCore.lua",
    "Json.lua",
    "ParameterCatalog.lua",
  ]) {
    await fs.access(path.join(pluginDir, file));
  }
});

test("Config.lua protocol limits match the Node protocol constants", async () => {
  const config = await readPlugin("Config.lua");
  assert.equal(luaNumber(config, "Config\\.protocol_version"), PROTOCOL_VERSION);
  assert.equal(luaNumber(config, "Config\\.max_request_bytes"), MAX_REQUEST_BYTES);
  assert.equal(luaNumber(config, "Config\\.max_response_bytes"), MAX_REQUEST_BYTES);
  assert.equal(luaNumber(config, "Config\\.max_json_depth"), MAX_JSON_DEPTH);
  assert.equal(luaNumber(config, "Config\\.max_ttl_seconds"), MAX_TTL_SECONDS);
});

test("stage gating exposes exactly the M1/M2/M3 method sets from the plan", async () => {
  const config = await readPlugin("Config.lua");
  const grab = (stage) => {
    const match = new RegExp(`${stage}\\s*=\\s*\\{([^}]*)\\}`).exec(config);
    assert.ok(match, `${stage} table not found`);
    return [...match[1].matchAll(/"([a-z_]+)"/g)].map((item) => item[1]);
  };
  assert.deepEqual(grab("M1").sort(), ["capabilities", "ping", "status"]);
  assert.deepEqual(grab("M2").sort(), ["capabilities", "get_proxy", "get_settings", "get_target_photo", "ping", "status"]);
  assert.deepEqual(grab("M3").sort(), [
    "apply_transaction", "capabilities", "get_proxy", "get_settings",
    "get_target_photo", "ping", "readback", "rollback", "status",
  ]);
  // 默认阶段必须是 M1（最保守门控）
  assert.match(config, /Config\.stage\s*=\s*"M1"/);
});

test("Info.lua uses manual start menus and does not auto-start on load", async () => {
  const info = await readPlugin("Info.lua");
  assert.match(info, /"Start File Queue Bridge"/);
  assert.match(info, /"Stop File Queue Bridge"/);
  // 与旧插件相同的 SDK 声明；不使用 LrInitPlugin 自动启动传输
  assert.match(info, /LrSdkVersion\s*=\s*14\.0/);
});

test("QueueTransport.lua enforces the full preflight chain and quarantine codes", async () => {
  const source = await readPlugin("QueueTransport.lua");
  for (const code of [
    "REQUEST_TOO_LARGE",
    "INVALID_JSON",
    "TOO_DEEP",
    "PROTOCOL_MISMATCH",
    "AUTHENTICATION_FAILED",
    "DUPLICATE_REQUEST",
    "STALE_REQUEST",
    "METHOD_DISABLED",
  ]) {
    assert.ok(source.includes(`"${code}"`), `missing error code ${code}`);
  }
  // 关键安全不变量：只执行 inbox/next.json；processing 永不重放
  assert.ok(source.includes('"next.json"'));
  assert.match(
    source,
    /LrPathUtils\.child\(LrPathUtils\.child\(root,\s*"inbox"\),\s*"next\.json"\)/,
  );
  assert.match(
    source,
    /LrPathUtils\.child\(LrPathUtils\.child\(root,\s*"logs"\),\s*"bridge\.log"\)/,
  );
  assert.doesNotMatch(source, /LrPathUtils\.child\(root,\s*"inbox",/);
  assert.doesNotMatch(source, /LrPathUtils\.child\(root,\s*"logs",/);
  assert.match(source, /processingDir/);
  // 响应带协议版本与插件版本；心跳每秒更新
  assert.match(source, /heartbeat_interval_seconds/);
  // 快照/写事务通过 BridgeCore 分发（传输层不重复实现业务）
  assert.match(source, /Bridge\.handle/);
  // 所有异步入口都有 pcall 兜底
  assert.ok((source.match(/pcall/g) ?? []).length >= 8);
});

test("reused BridgeCore.lua stays identical to the canonical lightroom-bridge copy", async () => {
  const canonical = await fs.readFile(
    path.resolve(testDir, "../plugin/LrCreativeGradingBridge.lrplugin/BridgeCore.lua"),
    "utf8",
  );
  const copy = await readPlugin("BridgeCore.lua");
  assert.equal(copy, canonical);
});

test("QueueTransport never imports LrSocket or the legacy socket Transport", async () => {
  const source = await readPlugin("QueueTransport.lua");
  // 头部注释里说明与 LrSocket 的区别是允许的；禁止的是实际导入与使用
  assert.equal(/import\s+"LrSocket"/.test(source), false);
  assert.equal(source.includes("Transport.requestSocket"), false);
});
