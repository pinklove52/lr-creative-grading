import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_MAX_BYTES = 1_048_576;

function defaultSessionPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  // LrPathUtils.getStandardFilePath("appData") resolves to Lightroom's
  // application-data directory on Windows, not the roaming-data root.
  return path.join(appData, "Adobe", "Lightroom", "LrCreativeGradingBridge", "session.json");
}

function connectSocket(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to Lightroom bridge port ${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export class LightroomSocketTransport {
  constructor(options = {}) {
    this.sessionPath =
      options.sessionPath || process.env.LR_CREATIVE_BRIDGE_SESSION || defaultSessionPath();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.recycleResponseAfterCall = options.recycleResponseAfterCall ?? false;
    this.requestSocket = null;
    this.responseSocket = null;
    this.session = null;
    this.responseBuffer = "";
    this.pending = new Map();
  }

  async readSession() {
    let raw;
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        raw = await fs.readFile(this.sessionPath, "utf8");
        JSON.parse(raw);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 4) await delay(50);
      }
    }
    if (lastError || raw == null) {
      const wrapped = new Error(
        `Lightroom bridge session was not found at ${this.sessionPath}; start Lightroom and enable the plug-in`,
      );
      wrapped.code = "PLUGIN_NOT_RUNNING";
      wrapped.cause = lastError;
      throw wrapped;
    }
    if (Buffer.byteLength(raw) > 65_536) {
      throw Object.assign(new Error("Lightroom bridge session descriptor is too large"), {
        code: "INVALID_SESSION",
      });
    }
    const session = JSON.parse(raw);
    if (session.host !== "127.0.0.1") {
      throw Object.assign(new Error("Refusing a Lightroom bridge that is not bound to 127.0.0.1"), {
        code: "UNSAFE_HOST",
      });
    }
    for (const field of ["request_port", "response_port"]) {
      if (!Number.isInteger(session[field]) || session[field] < 1 || session[field] > 65_535) {
        throw Object.assign(new Error(`Invalid ${field} in Lightroom bridge session`), {
          code: "INVALID_SESSION",
        });
      }
    }
    if (typeof session.token !== "string" || session.token.length < 32) {
      throw Object.assign(new Error("Invalid token in Lightroom bridge session"), {
        code: "INVALID_SESSION",
      });
    }
    session.max_request_bytes = session.max_request_bytes ?? DEFAULT_MAX_BYTES;
    return session;
  }

  async ensureConnected() {
    const next = await this.readSession();
    const sameSession =
      this.session?.session_id === next.session_id &&
      this.requestSocket &&
      !this.requestSocket.destroyed &&
      this.responseSocket &&
      !this.responseSocket.destroyed;
    if (sameSession) return;
    this.close();
    this.session = next;
    // Connect the response channel first so Lightroom can answer immediately.
    this.responseSocket = await connectSocket(next.response_port, this.timeoutMs);
    this.attachResponseReader();
    // A successful TCP connect only means the Windows accept queue has the
    // connection. Lightroom's cooperative Lua task still needs a brief turn
    // to attach its send-mode controller before a request can be answered.
    await delay(150);
    try {
      this.requestSocket = await connectSocket(next.request_port, this.timeoutMs);
      await delay(100);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  attachResponseReader() {
    this.responseSocket.setEncoding("utf8");
    this.responseSocket.on("data", (chunk) => {
      this.responseBuffer += chunk;
      if (Buffer.byteLength(this.responseBuffer) > (this.session?.max_response_bytes ?? DEFAULT_MAX_BYTES)) {
        this.failAll(Object.assign(new Error("Lightroom bridge response exceeded the size limit"), {
          code: "RESPONSE_TOO_LARGE",
        }));
        this.close();
        return;
      }
      let newline;
      while ((newline = this.responseBuffer.indexOf("\n")) >= 0) {
        const line = this.responseBuffer.slice(0, newline).trim();
        this.responseBuffer = this.responseBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.failAll(Object.assign(new Error("Lightroom returned invalid JSON"), {
            code: "INVALID_PLUGIN_RESPONSE",
            cause: error,
          }));
          continue;
        }
        const pending = this.pending.get(message.request_id);
        if (!pending) continue;
        this.pending.delete(message.request_id);
        clearTimeout(pending.timer);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          const pluginError = new Error(message.error?.message ?? "Lightroom bridge request failed");
          pluginError.code = message.error?.code ?? "PLUGIN_ERROR";
          pluginError.details = message.error?.details;
          pending.reject(pluginError);
        }
      }
    });
    const disconnected = () => {
      this.failAll(Object.assign(new Error("Lightroom bridge disconnected"), {
        code: "BRIDGE_DISCONNECTED",
      }));
    };
    this.responseSocket.on("error", disconnected);
    this.responseSocket.on("close", disconnected);
  }

  async call(method, params = {}) {
    await this.ensureConnected();
    const requestId = crypto.randomUUID();
    const envelope = {
      protocol_version: 1,
      request_id: requestId,
      client_id: this.clientId,
      token: this.session.token,
      method,
      params,
      recycle_response: this.recycleResponseAfterCall,
    };
    const payload = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(payload) > this.session.max_request_bytes) {
      throw Object.assign(new Error("Lightroom bridge request exceeds the configured size limit"), {
        code: "REQUEST_TOO_LARGE",
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error(`Lightroom bridge timed out while running ${method}`), {
          code: "BRIDGE_TIMEOUT",
        }));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.requestSocket.write(payload, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    // Give Lightroom a normal EOF so its LrSocket onClosed callback can
    // reconnect. An immediate destroy can leave the plug-in peer in
    // CLOSE_WAIT on Windows and prevent the next short-lived CLI call.
    this.requestSocket?.end();
    this.responseSocket?.end();
    this.requestSocket?.unref();
    this.responseSocket?.unref();
    this.requestSocket = null;
    this.responseSocket = null;
    this.responseBuffer = "";
    this.failAll(Object.assign(new Error("Lightroom bridge connection closed"), {
      code: "BRIDGE_DISCONNECTED",
    }));
  }
}
