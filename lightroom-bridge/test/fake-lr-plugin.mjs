// 假 Lightroom 插件：按文件队列协议 v2 实现插件侧行为的 JS 模拟器，
// 与 Lua QueueTransport.lua 遵循同一套规则（校验复用 file-queue-protocol）。
// 用途：在无 Lightroom 的 CI/本地环境对 Node 传输做端到端与故障注入测试。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROTOCOL_VERSION, validateRequest } from "../src/file-queue-protocol.mjs";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export class FakeLightroomPlugin {
  constructor({ root, handlers = {}, pollMs = 25, heartbeatMs = 80, crashAfterClaim = false, keepRecent = 128, handlerDelayMs = 0 }) {
    this.root = root;
    this.handlers = handlers;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.crashAfterClaim = crashAfterClaim;
    this.keepRecent = keepRecent;
    this.handlerDelayMs = handlerDelayMs;
    this.running = false;
    this.busy = false;
    this.crashed = false;
    this.completed = 0;
    this.failed = 0;
    this.lastError = null;
    this.session = null;
    this.startedAt = 0;
    this.recent = new Set();
    this.order = [];
    this._pollTimer = null;
    this._heartbeatTimer = null;
  }

  p() {
    return {
      inbox: path.join(this.root, "inbox"),
      next: path.join(this.root, "inbox", "next.json"),
      processing: path.join(this.root, "processing"),
      outbox: path.join(this.root, "outbox"),
      failed: path.join(this.root, "failed"),
      session: path.join(this.root, "session.json"),
      heartbeat: path.join(this.root, "heartbeat.json"),
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

  async writeJsonAtomic(finalPath, value) {
    const tmp = `${finalPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), "utf8");
    if (await this.exists(finalPath)) await fs.rm(finalPath, { force: true });
    await fs.rename(tmp, finalPath);
  }

  async start() {
    if (this.running) return;
    const p = this.p();
    for (const dir of [p.inbox, p.processing, p.outbox, p.failed]) {
      await fs.mkdir(dir, { recursive: true });
    }
    this.crashed = false;
    this.busy = false;
    this.recent = new Set();
    this.order = [];
    this.completed = 0;
    this.failed = 0;
    this.lastError = null;
    this.startedAt = Date.now();
    this.session = {
      protocol_version: PROTOCOL_VERSION,
      token: crypto.randomUUID(),
      plugin_version: "0.2.0",
      lr_version: "15.0.1.1",
      stage: "M1",
      enabled_methods: ["ping", "capabilities", "status"],
      created_at_epoch: nowSeconds(),
    };
    await this.writeJsonAtomic(p.session, this.session);
    this.running = true;
    await this._heartbeat();
    this._pollTimer = setInterval(() => {
      this._pollOnce().catch((error) => {
        this.lastError = String(error?.message ?? error);
      });
    }, this.pollMs);
    this._pollTimer.unref();
    this._heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.heartbeatMs);
    this._heartbeatTimer.unref();
  }

  // 与 Lua QueueTransport.lua 的 transportMethods 对应：ping/capabilities/status
  // 由插件内部处理（status 返回真实统计），其余方法走 handlers 覆盖。
  async _handleInternal(method) {
    if (method === "ping") {
      return {
        ok: true,
        result: {
          pong: true,
          protocol_version: PROTOCOL_VERSION,
          plugin_version: "0.2.0",
          lr_version: "15.0.1.1",
          stage: this.session?.stage ?? "M1",
          server_time_epoch: nowSeconds(),
        },
      };
    }
    if (method === "capabilities") {
      return {
        ok: true,
        result: {
          protocol_version: PROTOCOL_VERSION,
          plugin_version: "0.2.0",
          lr_version: "15.0.1.1",
          stage: this.session?.stage ?? "M1",
          enabled_methods: this.session?.enabled_methods ?? [],
          bridge: { note: "fake plug-in; real SDK capabilities come from BridgeCore" },
        },
      };
    }
    if (method === "status") {
      return {
        ok: true,
        result: {
          running: this.running,
          // 与 Lua Queue.status() 语义一致：running/stopped/error/starting
          state: this.running ? "running" : "stopped",
          stage: this.session?.stage ?? "M1",
          enabled_methods: this.session?.enabled_methods ?? [],
          session_token_present: this.session !== null,
          completed_requests: this.completed,
          failed_requests: this.failed,
          last_error: this.lastError,
          uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
        },
      };
    }
    return null;
  }

  // 正常退出：删除会话与心跳（模拟 LR 退出）。
  async stop() {
    this.running = false;
    clearInterval(this._pollTimer);
    clearInterval(this._heartbeatTimer);
    this._pollTimer = null;
    this._heartbeatTimer = null;
    const p = this.p();
    await fs.rm(p.session, { force: true });
    await fs.rm(p.heartbeat, { force: true });
  }

  // 崩溃：停止一切活动但保留会话/心跳文件（心跳自然过期），
  // 处理中文件保持原样（模拟进程死亡，无清理）。
  async crash() {
    this.crashed = true;
    this.running = false;
    clearInterval(this._pollTimer);
    clearInterval(this._heartbeatTimer);
    this._pollTimer = null;
    this._heartbeatTimer = null;
  }

  // 仅停止心跳（模拟 Lightroom 卡死导致任务调度停摆）。
  stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  // 恢复心跳（配合 stopHeartbeat 使用，模拟任务调度恢复）。
  startHeartbeat() {
    if (!this.running || this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, this.heartbeatMs);
  }

  async _quarantine(source, code, message) {
    const name = path.basename(source);
    const destination = path.join(this.p().failed, name);
    await fs.writeFile(
      `${destination}.reason.json`,
      JSON.stringify({ code, message, moved_at_epoch: nowSeconds() }),
      "utf8",
    );
    if (await this.exists(destination)) await fs.rm(destination, { force: true });
    await fs.rename(source, destination);
    this.failed += 1;
  }

  async _writeResponse(requestId, ok, payload, durationSeconds) {
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      ok,
      plugin_version: "0.2.0",
      duration_seconds: durationSeconds,
      completed_at_epoch: nowSeconds(),
    };
    if (ok) envelope.result = payload;
    else envelope.error = payload;
    const finalPath = path.join(this.p().outbox, `${requestId}.json`);
    const tmp = `${finalPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(envelope), "utf8");
    if (await this.exists(finalPath)) await fs.rm(finalPath, { force: true });
    await fs.rename(tmp, finalPath);
  }

  async _pollOnce() {
    if (this.busy || !this.running) return;
    const p = this.p();
    if (!(await this.exists(p.next))) return;

    const raw = await fs.readFile(p.next, "utf8");
    const checked = validateRequest(raw, { token: this.session.token });
    if (!checked.ok) {
      await this._quarantine(p.next, checked.code, checked.message);
      return;
    }
    const request = checked.request;
    if (this.recent.has(request.request_id)) {
      await this._quarantine(p.next, "DUPLICATE_REQUEST", "request_id has already been accepted in this session");
      return;
    }
    const claim = path.join(p.processing, `${request.request_id}.json`);
    if (await this.exists(claim)) {
      await this._quarantine(p.next, "DUPLICATE_REQUEST", "a processing file already exists for this request_id");
      return;
    }
    await fs.rename(p.next, claim);

    if (this.crashAfterClaim) {
      // 认领后立即崩溃：processing 文件保持原样，无响应、无清理。
      this.crashed = true;
      this.running = false;
      clearInterval(this._pollTimer);
      clearInterval(this._heartbeatTimer);
      this._pollTimer = null;
      this._heartbeatTimer = null;
      return;
    }

    this.busy = true;
    this.recent.add(request.request_id);
    this.order.push(request.request_id);
    if (this.order.length > this.keepRecent) {
      this.recent.delete(this.order.shift());
    }

    const started = Date.now();
    let ok;
    let result;
    if (!this.session.enabled_methods.includes(request.method)) {
      ok = false;
      result = { code: "METHOD_DISABLED", message: `method is disabled in stage ${this.session.stage}: ${request.method}` };
    } else {
      const internal = await this._handleInternal(request.method);
      if (internal !== null) {
        ok = internal.ok;
        result = internal.result;
      } else if (typeof this.handlers[request.method] === "function") {
        try {
          if (this.handlerDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.handlerDelayMs));
          }
          result = await this.handlers[request.method](request.params ?? {});
          ok = true;
        } catch (error) {
          ok = false;
          result = {
            code: error.code || "INTERNAL_ERROR",
            message: error.message || String(error),
            details: error.details,
          };
        }
      } else {
        ok = false;
        result = { code: "METHOD_NOT_FOUND", message: `Unknown bridge method: ${request.method}` };
      }
    }
    // 处理过程中崩溃：保留 processing 文件，不响应（模拟进程死亡）。
    if (this.crashed) return;

    const durationSeconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    await this._writeResponse(request.request_id, ok, result, durationSeconds);
    await fs.rm(claim, { force: true });
    this.busy = false;
    if (ok) this.completed += 1;
    else this.failed += 1;
  }

  async _heartbeat() {
    if (!this.running) return;
    await this.writeJsonAtomic(this.p().heartbeat, {
      protocol_version: PROTOCOL_VERSION,
      state: this.lastError ? "error" : this.busy ? "processing" : "idle",
      lr_version: "15.0.1.1",
      plugin_version: "0.2.0",
      stage: "M1",
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      completed_requests: this.completed,
      failed_requests: this.failed,
      last_error: this.lastError,
      last_updated_epoch: nowSeconds(),
    });
  }
}
