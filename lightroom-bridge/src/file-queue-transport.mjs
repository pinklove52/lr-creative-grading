// 文件队列传输：Node 侧实现，接口与 LightroomSocketTransport 一致
// （call / close），供 McpCore 与 bridge-cli 直接替换使用。
//
// 生命周期规则（与 Lua QueueTransport.lua 及协议规范对应）：
//   1. 发布：next.json.tmp → 原子改名 next.json（请求槽同一时刻至多一个）。
//   2. 等待响应：轮询 outbox/<id>.json；每次轮询校验心跳新鲜度，
//      心跳过期立即判定桥不可用并失败在途请求。
//   3. 启动恢复（Node 负责，因为只有 Node 能枚举目录）：
//      - 删除 inbox 残留 .tmp、孤儿 next.json、全部孤儿 outbox 响应；
//      - processing 中超过恢复宽限期的文件 → failed/（RECOVERY_UNKNOWN），
//        绝不重放；宽限期内的文件保留（插件仍在处理，其响应会成为孤儿
//        并被下一次启动清理）。
//   4. 每次 call 前重读 session.json：插件重启后 token 变化自动跟随。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "./diagnostics.mjs";
import {
  HEARTBEAT_STALE_MS,
  MAX_REQUEST_BYTES,
  MAX_TTL_SECONDS,
  PROTOCOL_VERSION,
  RECOVERY_GRACE_MS,
  SLOT_WAIT_MS,
  isHeartbeatFresh,
  validateRequest,
  validateResponse,
} from "./file-queue-protocol.mjs";

function defaultQueueRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  // LrPathUtils.getStandardFilePath("appData") 在 Windows 上解析到
  // Lightroom 应用数据目录：%APPDATA%\Adobe\Lightroom
  return path.join(appData, "Adobe", "Lightroom", "LrCreativeGradingBridge-v2");
}

function pluginError(message, code, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export class LightroomFileQueueTransport {
  constructor(options = {}) {
    this.root = options.root || process.env.LR_CREATIVE_BRIDGE_QUEUE || defaultQueueRoot();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.sessionWaitMs = options.sessionWaitMs ?? 15_000;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
    this.pollMs = options.pollMs ?? 50;
    // Windows 上插件发布心跳时会先删除旧文件再改名，期间可能出现极短空窗。
    // 只对“文件暂时不存在”做一次有界重读；真实的过期心跳仍立即失败。
    this.heartbeatReadRetryMs = options.heartbeatReadRetryMs ?? Math.max(10, Math.min(this.pollMs, 50));
    // 诊断日志默认落盘到队列目录（方案 §6.5）；stderr 由 MCP/CLI 层控制。
    this.logger = options.logger ?? createLogger({
      filePath: path.join(this.root, "logs", "node-bridge.log"),
    });
    this.session = null;
    this.started = false;
    this.closed = false;
    this.sessionWarned = false;
  }

  paths() {
    return {
      inboxDir: path.join(this.root, "inbox"),
      next: path.join(this.root, "inbox", "next.json"),
      processingDir: path.join(this.root, "processing"),
      outboxDir: path.join(this.root, "outbox"),
      failedDir: path.join(this.root, "failed"),
      sessionFile: path.join(this.root, "session.json"),
      heartbeatFile: path.join(this.root, "heartbeat.json"),
    };
  }

  async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readHeartbeat() {
    try {
      return await fs.readFile(this.paths().heartbeatFile, "utf8");
    } catch {
      return null;
    }
  }

  async assertHeartbeatFresh() {
    let raw = await this.readHeartbeat();
    if (raw === null) {
      await delay(this.heartbeatReadRetryMs);
      raw = await this.readHeartbeat();
    }
    if (raw === null) {
      throw pluginError("Lightroom bridge heartbeat was not found", "BRIDGE_UNAVAILABLE");
    }
    const { fresh, reason, ageMs } = isHeartbeatFresh(raw, { staleMs: this.heartbeatStaleMs });
    if (!fresh) {
      throw pluginError(`Lightroom bridge heartbeat is not fresh (${reason})`, "BRIDGE_UNAVAILABLE", { reason, ageMs });
    }
    return fresh;
  }

  async recoverOrphans() {
    const p = this.paths();
    // 删除残留临时文件与孤儿请求槽（无人等待它们）。
    await fs.rm(path.join(p.inboxDir, "next.json"), { force: true });
    await fs.rm(path.join(p.inboxDir, "next.json.tmp"), { force: true });
    // 孤儿响应：没有任何客户端在等待。
    for (const name of await fs.readdir(p.outboxDir).catch(() => [])) {
      await fs.rm(path.join(p.outboxDir, name), { force: true });
    }
    // processing 恢复：超过宽限期的文件视为插件崩溃后的孤儿。
    const now = Date.now();
    for (const name of await fs.readdir(p.processingDir).catch(() => [])) {
      const source = path.join(p.processingDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(source)).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < RECOVERY_GRACE_MS) {
        await this.logger.warn("processing_kept", { file: name, reason: "within recovery grace window" });
        continue;
      }
      const destination = path.join(p.failedDir, name);
      await fs.rename(source, destination).catch(async () => {
        await fs.copyFile(source, destination).catch(() => {});
        await fs.rm(source, { force: true });
      });
      const sidecar = {
        code: "RECOVERY_UNKNOWN",
        message: "Processing file was orphaned (plug-in likely crashed); outcome is unknown and it was never re-applied",
        moved_from: `processing/${name}`,
        detected_at_epoch: Math.floor(now / 1000),
      };
      await fs.writeFile(`${destination}.reason.json`, JSON.stringify(sidecar), "utf8");
      await this.logger.warn("processing_recovered", { file: name });
    }
  }

  async readSession() {
    const raw = await fs.readFile(this.paths().sessionFile, "utf8").catch(() => null);
    if (raw === null) return null;
    if (Buffer.byteLength(raw) > 64 * 1024) {
      throw pluginError("Lightroom bridge session descriptor is too large", "INVALID_SESSION");
    }
    let session;
    try {
      session = JSON.parse(raw);
    } catch {
      throw pluginError("Lightroom bridge session descriptor is not valid JSON", "INVALID_SESSION");
    }
    if (session.protocol_version !== PROTOCOL_VERSION) {
      throw pluginError(`Unsupported bridge protocol version: ${session.protocol_version}`, "PROTOCOL_MISMATCH");
    }
    if (typeof session.token !== "string" || session.token.length < 16) {
      throw pluginError("Invalid token in Lightroom bridge session", "INVALID_SESSION");
    }
    if (!Array.isArray(session.enabled_methods) || session.enabled_methods.length === 0) {
      throw pluginError("Session is missing enabled_methods", "INVALID_SESSION");
    }
    return session;
  }

  async start() {
    if (this.started) return;
    this.closed = false;
    await fs.mkdir(path.join(this.root, "inbox"), { recursive: true });
    await fs.mkdir(path.join(this.root, "processing"), { recursive: true });
    await fs.mkdir(path.join(this.root, "outbox"), { recursive: true });
    await fs.mkdir(path.join(this.root, "failed"), { recursive: true });
    await this.recoverOrphans();

    const deadline = Date.now() + this.sessionWaitMs;
    let session = null;
    while (Date.now() < deadline) {
      session = await this.readSession().catch((error) => {
        throw error;
      });
      if (session) break;
      await delay(100);
    }
    if (session === null) {
      throw pluginError(
        `Lightroom bridge session was not found at ${this.paths().sessionFile}; start Lightroom, enable the plug-in, and use its Start menu item`,
        "PLUGIN_NOT_RUNNING",
      );
    }
    this.session = session;
    await this.assertHeartbeatFresh().catch(() => {
      // 会话存在但心跳缺失：桥可能刚启动（心跳 1s 一次），等待一个周期。
      return delay(this.heartbeatStaleMs + 500);
    });
    await this.assertHeartbeatFresh();
    this.started = true;
    await this.logger.info("transport_started", { queue_root: this.root, stage: session.stage });
  }

  // 每次调用前重读会话：插件重启（新 token）后自动跟随。
  async refreshSession() {
    const session = await this.readSession();
    if (session === null) {
      throw pluginError(
        `Lightroom bridge session disappeared; plug-in was stopped at ${this.paths().sessionFile}`,
        "PLUGIN_NOT_RUNNING",
      );
    }
    if (this.session?.token !== session.token || this.session?.stage !== session.stage) {
      await this.logger.info("session_refreshed", { tokenChanged: this.session?.token !== session.token, stage: session.stage });
      this.session = session;
    }
    return session;
  }

  // 请求槽等待：只关心 next.json 是否释放。processing 中的孤儿文件
  // 不阻塞槽位（插件从不重放 processing；宽限期恢复由 start() 处理）。
  async waitForSlot() {
    const p = this.paths();
    const deadline = Date.now() + SLOT_WAIT_MS;
    while (true) {
      if (this.closed) {
        throw pluginError("Lightroom bridge transport was closed while waiting for the request slot", "BRIDGE_DISCONNECTED");
      }
      if (!(await this.exists(p.next))) return;
      await this.assertHeartbeatFresh();
      if (Date.now() > deadline) {
        throw pluginError(
          "Lightroom bridge request slot is still occupied by a previous request",
          "QUEUE_SLOT_BUSY",
          { next_present: true },
        );
      }
      await delay(this.pollMs);
    }
  }

  async call(method, params = {}) {
    await this.start();
    if (this.closed) {
      throw pluginError("Lightroom bridge transport was closed", "BRIDGE_DISCONNECTED");
    }
    await this.refreshSession();
    const requestId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      token: this.session.token,
      method,
      params,
      created_at_epoch: now,
      // TTL 需要覆盖槽位等待 + 插件处理时间，留 15s 余量。
      ttl_seconds: Math.min(MAX_TTL_SECONDS, Math.floor(this.requestTimeoutMs / 1000) + 15),
    };
    const payload = JSON.stringify(envelope);
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      throw pluginError("Lightroom bridge request exceeds the configured size limit", "REQUEST_TOO_LARGE");
    }
    // 请求侧规则自检（与插件侧同一套规则）。
    const checked = validateRequest(payload, { token: this.session.token });
    if (!checked.ok) {
      throw pluginError(`Request failed local validation: ${checked.message}`, checked.code);
    }

    const p = this.paths();
    await this.waitForSlot();
    await fs.writeFile(`${p.next}.tmp`, payload, "utf8");
    await fs.rename(`${p.next}.tmp`, p.next);

    const startedAt = Date.now();
    const deadline = startedAt + this.requestTimeoutMs;
    await this.logger.info("request_sent", { request_id: requestId, method });
    try {
      while (true) {
        await delay(this.pollMs);
        if (this.closed) {
          throw pluginError("Lightroom bridge transport was closed while waiting for the response", "BRIDGE_DISCONNECTED");
        }
        await this.assertHeartbeatFresh();
        const responsePath = path.join(p.outboxDir, `${requestId}.json`);
        if (await this.exists(responsePath)) {
          const raw = await fs.readFile(responsePath, "utf8");
          await fs.rm(responsePath, { force: true });
          const parsed = validateResponse(raw, requestId);
          if (!parsed.ok) {
            throw pluginError(`Lightroom returned an invalid response: ${parsed.message}`, parsed.code);
          }
          const { response } = parsed;
          await this.logger.info("request_completed", {
            request_id: requestId,
            method,
            ok: response.ok,
            duration_ms: Date.now() - startedAt,
            plugin_duration_seconds: response.duration_seconds,
          });
          if (response.ok) return response.result;
          const error = pluginError(
            response.error?.message ?? "Lightroom bridge request failed",
            response.error?.code ?? "PLUGIN_ERROR",
            response.error?.details,
          );
          error.request_id = requestId;
          throw error;
        }
        if (Date.now() > deadline) {
          throw pluginError(`Lightroom bridge timed out while running ${method}`, "BRIDGE_TIMEOUT", {
            request_id: requestId,
            timeout_ms: this.requestTimeoutMs,
          });
        }
      }
    } catch (error) {
      if (error.code !== "BRIDGE_UNAVAILABLE") {
        await this.logger.warn("request_failed", { request_id: requestId, method, code: error.code, message: error.message });
      }
      throw error;
    }
  }

  async status() {
    const raw = await this.readHeartbeat();
    const heartbeat = raw === null ? null : (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    return {
      transport: "file-queue",
      started: this.started,
      queue_root: this.root,
      session: this.session ? {
        stage: this.session.stage,
        enabled_methods: this.session.enabled_methods,
        plugin_version: this.session.plugin_version,
        lr_version: this.session.lr_version,
      } : null,
      heartbeat,
    };
  }

  async close() {
    this.closed = true;
    this.started = false;
    this.session = null;
  }
}
