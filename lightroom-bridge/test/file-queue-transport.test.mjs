import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../src/file-queue-transport.mjs";
import { PROTOCOL_VERSION } from "../src/file-queue-protocol.mjs";
import { FakeLightroomPlugin } from "./fake-lr-plugin.mjs";

function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lr-queue-test-"));
}

async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

const defaultHandlers = {
  ping: async () => ({ pong: true }),
  capabilities: async () => ({ bridge: { supported: ["basic"] } }),
  status: async () => ({ state: "idle" }),
};

function runBridgeCli(method, root) {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/bridge-cli.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, method], {
      env: { ...process.env, LR_CREATIVE_BRIDGE_QUEUE: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end("{}\n");
  });
}

test("M1: ping/capabilities/status round trip through the file queue", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    const ping = await transport.call("ping", {});
    assert.equal(ping.pong, true);
    assert.equal(ping.protocol_version, PROTOCOL_VERSION);
    const capabilities = await transport.call("capabilities", {});
    assert.ok(Array.isArray(capabilities.enabled_methods));
    const status = await transport.call("status", {});
    assert.equal(status.running, true);
    assert.equal(status.state, "running");
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("M1 CLI exposes ping and status as direct transport methods", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers, pollMs: 10 });
  await plugin.start();
  try {
    for (const method of ["ping", "status"]) {
      const result = await runBridgeCli(method, root);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
    }
  } finally {
    await plugin.stop();
  }
});

test("M1 acceptance: 100 sequential pings succeed with no loss or duplication", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers, pollMs: 10 });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000, pollMs: 10 });
  try {
    for (let index = 0; index < 100; index += 1) {
      const result = await transport.call("ping", { index });
      assert.equal(result.pong, true);
    }
    const status = await transport.call("status", {});
    assert.equal(status.completed_requests, 100);
    assert.equal(status.failed_requests, 0);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("start() cleans orphaned inbox tmp, orphan next.json, and orphan outbox responses", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const inbox = path.join(root, "inbox");
  const outbox = path.join(root, "outbox");
  await fs.writeFile(path.join(inbox, "next.json.tmp"), "half-written", "utf8");
  await fs.writeFile(path.join(inbox, "next.json"), "orphan request", "utf8");
  await fs.writeFile(path.join(outbox, "orphan-response.json"), "{}", "utf8");
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    const ping = await transport.call("ping", {});
    assert.equal(ping.pong, true);
    const files = await fs.readdir(outbox);
    assert.deepEqual(files, []);
    const inboxFiles = await fs.readdir(inbox);
    assert.deepEqual(inboxFiles, []);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("recovery: orphaned processing file beyond grace moves to failed with RECOVERY_UNKNOWN", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  // 模拟 LR 崩溃遗留的 processing 文件（把 mtime 改为很久以前）
  const processingDir = path.join(root, "processing");
  const orphan = path.join(processingDir, "dead-request.json");
  await fs.writeFile(orphan, JSON.stringify({ request_id: "dead-request" }), "utf8");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(orphan, old, old);

  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    await transport.call("ping", {});
    // 孤儿文件已移到 failed/ 并带原因
    const failedFiles = await fs.readdir(path.join(root, "failed"));
    assert.ok(failedFiles.includes("dead-request.json"));
    const reason = JSON.parse(
      await fs.readFile(path.join(root, "failed", "dead-request.json.reason.json"), "utf8"),
    );
    assert.equal(reason.code, "RECOVERY_UNKNOWN");
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("recovery: fresh processing file within grace is left alone", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const processingDir = path.join(root, "processing");
  const active = path.join(processingDir, "active-request.json");
  await fs.writeFile(active, JSON.stringify({ request_id: "active-request" }), "utf8");

  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    await transport.call("ping", {});
    // 宽限期内的文件不应被移动
    assert.equal(await fs.access(active).then(() => true).catch(() => false), true);
    assert.equal(
      await fs.readdir(path.join(root, "failed")).then((files) => files.includes("active-request.json")),
      false,
    );
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: invalid JSON, wrong token, duplicate id, stale TTL are quarantined with reasons", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const session = JSON.parse(await fs.readFile(path.join(root, "session.json"), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const inbox = path.join(root, "inbox");
  const outbox = path.join(root, "outbox");
  const next = path.join(inbox, "next.json");
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });

  try {
    // 三类直接拒绝：非法 JSON / 错误 token / 过期 TTL。
    // 槽位请求被隔离时保留源文件名 next.json + 原因 sidecar。
    const cases = [
      ["not-json-at-all", "INVALID_JSON"],
      [JSON.stringify({ protocol_version: PROTOCOL_VERSION, token: "wrong", request_id: "x" }), "AUTHENTICATION_FAILED"],
      [JSON.stringify({ protocol_version: PROTOCOL_VERSION, token: session.token, request_id: "stale", method: "ping", created_at_epoch: now - 100, ttl_seconds: 5 }), "STALE_REQUEST"],
    ];
    for (const [raw, expectedCode] of cases) {
      await fs.writeFile(next, raw, "utf8");
      await waitFor(async () => !(await fs.access(next).then(() => true).catch(() => false)));
      const reason = JSON.parse(
        await fs.readFile(path.join(root, "failed", "next.json.reason.json"), "utf8"),
      );
      assert.equal(reason.code, expectedCode);
    }

    // 重放：先以固定 ID 正常接受并处理，再以同一 ID 重放 → DUPLICATE_REQUEST
    const manual = {
      protocol_version: PROTOCOL_VERSION,
      token: session.token,
      request_id: "manual-1",
      method: "ping",
      params: {},
      created_at_epoch: now,
      ttl_seconds: 30,
    };
    await fs.writeFile(next, JSON.stringify(manual), "utf8");
    await waitFor(async () => !(await fs.access(next).then(() => true).catch(() => false)));
    assert.equal(await fs.access(path.join(outbox, "manual-1.json")).then(() => true).catch(() => false), true);
    await fs.rm(path.join(outbox, "manual-1.json"), { force: true });
    await fs.writeFile(next, JSON.stringify(manual), "utf8");
    await waitFor(async () => !(await fs.access(next).then(() => true).catch(() => false)));
    const quarantined = JSON.parse(await fs.readFile(path.join(root, "failed", "next.json"), "utf8"));
    assert.equal(quarantined.request_id, "manual-1");
    const duplicateReason = JSON.parse(
      await fs.readFile(path.join(root, "failed", "next.json.reason.json"), "utf8"),
    );
    assert.equal(duplicateReason.code, "DUPLICATE_REQUEST");

    // 队列保持健康
    assert.equal((await transport.call("ping", {})).pong, true);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: TOO_DEEP and oversized requests are rejected without disturbing the queue", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const session = JSON.parse(await fs.readFile(path.join(root, "session.json"), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const next = path.join(root, "inbox", "next.json");

  const deep = JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    token: session.token,
    request_id: "deep",
    method: "ping",
    params: { nested: JSON.parse("[".repeat(40) + "0" + "]".repeat(40)) },
    created_at_epoch: now,
    ttl_seconds: 30,
  });
  await fs.writeFile(next, deep, "utf8");
  await waitFor(async () => !(await fs.access(next).then(() => true).catch(() => false)));

  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    // 超限请求在 Node 侧写入前被本地拒绝
    await assert.rejects(
      transport.call("ping", { blob: "x".repeat(300 * 1024) }),
      (error) => error.code === "REQUEST_TOO_LARGE",
    );
    // 队列未被破坏，正常请求继续工作
    const result = await transport.call("ping", {});
    assert.equal(result.pong, true);
    // 深度炸弹被插件隔离：保留原文件（next.json）+ 原因 sidecar
    const quarantined = JSON.parse(await fs.readFile(path.join(root, "failed", "next.json"), "utf8"));
    assert.equal(quarantined.request_id, "deep");
    const reason = JSON.parse(await fs.readFile(path.join(root, "failed", "next.json.reason.json"), "utf8"));
    assert.equal(reason.code, "TOO_DEEP");
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: heartbeat stops -> call fails BRIDGE_UNAVAILABLE and recovers after restart", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  // 阈值必须大于心跳时间戳的秒级截断误差（最多 ~1s）
  const staleMs = 2_500;
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000, heartbeatStaleMs: staleMs });
  try {
    assert.equal((await transport.call("ping", {})).pong, true);
    plugin.stopHeartbeat();
    await waitFor(async () => {
      const hb = await fs.readFile(path.join(root, "heartbeat.json"), "utf8").catch(() => null);
      if (hb === null) return true;
      return Date.now() - JSON.parse(hb).last_updated_epoch * 1000 > staleMs;
    }, 5_000);
    await assert.rejects(transport.call("ping", {}), (error) => error.code === "BRIDGE_UNAVAILABLE");
    // 心跳恢复后自动可用
    plugin.startHeartbeat();
    await waitFor(async () => {
      const hb = await fs.readFile(path.join(root, "heartbeat.json"), "utf8").catch(() => null);
      return hb !== null && Date.now() - JSON.parse(hb).last_updated_epoch * 1000 <= staleMs;
    });
    assert.equal((await transport.call("ping", {})).pong, true);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("heartbeat atomic replacement gap is retried once", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({
    root,
    sessionWaitMs: 3_000,
    heartbeatReadRetryMs: 1,
  });
  try {
    await transport.start();
    const readHeartbeat = transport.readHeartbeat.bind(transport);
    let reads = 0;
    transport.readHeartbeat = async () => {
      reads += 1;
      return reads === 1 ? null : readHeartbeat();
    };
    assert.equal((await transport.call("ping", {})).pong, true);
    assert.ok(reads >= 2);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: plug-in crash mid-processing leaves orphan; restart recovers and keeps working", async () => {
  const root = await makeRoot();
  let crashedOnce = false;
  const plugin = new FakeLightroomPlugin({
    root,
    handlers: {
      // 使用非内部方法名，避免被假插件的内置 ping 处理遮蔽
      crash_me: async () => {
        if (!crashedOnce) {
          crashedOnce = true;
          await plugin.crash();
        }
        return { done: true };
      },
    },
  });
  await plugin.start();
  plugin.session.enabled_methods = [...plugin.session.enabled_methods, "crash_me"];
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000, requestTimeoutMs: 1_500 });
  try {
    // 处理中崩溃：请求超时，processing 文件残留（无响应、无清理）
    await assert.rejects(transport.call("crash_me", {}), (error) => error.code === "BRIDGE_TIMEOUT");
    const processingFiles = await fs.readdir(path.join(root, "processing"));
    assert.equal(processingFiles.length, 1);

    // "重启" Lightroom（新 token）。孤儿文件在宽限期内不会被移动，
    // 但绝不重放（插件只执行 inbox/next.json），槽位不被阻塞。
    await plugin.start();
    plugin.session.enabled_methods = [...plugin.session.enabled_methods, "crash_me"];
    assert.equal((await fs.readdir(path.join(root, "processing"))).length, 1);
    assert.equal((await fs.readdir(path.join(root, "failed"))).length, 0);
    const transport2 = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
    assert.deepEqual(await transport2.call("crash_me", {}), { done: true });
    await transport2.close();
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: plug-in stopped (LR quit) fails PLUGIN_NOT_RUNNING; restart with new token is followed", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 500, requestTimeoutMs: 2_000 });
  try {
    assert.equal((await transport.call("ping", {})).pong, true);
    await plugin.stop();
    await assert.rejects(transport.call("ping", {}), (error) => error.code === "PLUGIN_NOT_RUNNING");
    // LR 重启（新 token）
    await plugin.start();
    assert.equal((await transport.call("ping", {})).pong, true);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: method outside stage gate returns METHOD_DISABLED with full details", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: { ...defaultHandlers, get_settings: async () => ({}) } });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    await assert.rejects(
      transport.call("get_settings", { parameters: ["exposure"] }),
      (error) => {
        assert.equal(error.code, "METHOD_DISABLED");
        assert.match(error.message, /stage M1/);
        return true;
      },
    );
    // 门控不影响门内方法
    assert.equal((await transport.call("ping", {})).pong, true);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("fault injection: plug-in handler error surfaces the plugin error code and details", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({
    root,
    handlers: {
      ...defaultHandlers,
      get_settings: async () => {
        throw Object.assign(new Error("exposure is not supported"), { code: "UNSUPPORTED_PARAMETER", details: { parameter: "exposure" } });
      },
    },
  });
  await plugin.start();
  // 门控放开（模拟 M2 阶段配置）
  plugin.session.enabled_methods = [...plugin.session.enabled_methods, "get_settings"];
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    await assert.rejects(
      transport.call("get_settings", { parameters: ["exposure"] }),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_PARAMETER");
        assert.deepEqual(error.details, { parameter: "exposure" });
        return true;
      },
    );
  } finally {
    await transport.close();
    await plugin.stop();
  }
});

test("Node restart mid-flight: orphaned response is cleaned by the next transport instance", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({
    root,
    handlers: { ...defaultHandlers, slow: async () => ({ done: true }) },
    handlerDelayMs: 400,
  });
  await plugin.start();
  plugin.session.enabled_methods = [...plugin.session.enabled_methods, "slow"];

  const transportA = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000, requestTimeoutMs: 5_000 });
  // 发送后立刻"崩溃"（不等待响应，模拟 Node 进程死亡）
  const pendingCall = transportA.call("slow", {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  await transportA.close();
  await assert.rejects(pendingCall, (error) => error.code === "BRIDGE_DISCONNECTED");

  // 插件完成处理并把响应留在 outbox（孤儿，无人读取）
  await waitFor(async () => {
    const outbox = await fs.readdir(path.join(root, "outbox"));
    return outbox.length === 1;
  }, 5_000);

  // 新 Node 实例启动时清理孤儿响应，队列照常工作
  const transportB = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  try {
    assert.equal((await transportB.call("ping", {})).pong, true);
    assert.deepEqual(await fs.readdir(path.join(root, "outbox")), []);
  } finally {
    await transportB.close();
    await plugin.stop();
  }
});

test("McpCore works against the file queue transport through capabilities", async () => {
  const root = await makeRoot();
  const plugin = new FakeLightroomPlugin({ root, handlers: defaultHandlers });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 3_000 });
  const { McpCore } = await import("../src/mcp-core.mjs");
  try {
    const core = new McpCore(transport);
    const capabilities = await core.callTool("capabilities", {});
    assert.ok(capabilities.bridge);
  } finally {
    await transport.close();
    await plugin.stop();
  }
});
