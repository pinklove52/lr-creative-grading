#!/usr/bin/env node
import { McpCore } from "./mcp-core.mjs";
import { LightroomFileQueueTransport } from "./file-queue-transport.mjs";
import { LightroomSocketTransport } from "./socket-transport.mjs";
import { toErrorData } from "./grade-session.mjs";

const method = process.argv[2];
if (!method) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "INVALID_REQUEST", message: "Usage: bridge-cli.mjs <method>" } })}\n`);
  process.exit(2);
}

let body = "";
for await (const chunk of process.stdin) body += chunk;
const args = body.trim() ? JSON.parse(body) : {};

// 默认文件队列传输；LR_BRIDGE_TRANSPORT=socket 保留旧实验通道。
const transport =
  process.env.LR_BRIDGE_TRANSPORT === "socket"
    ? new LightroomSocketTransport({ recycleResponseAfterCall: true })
    : new LightroomFileQueueTransport();
const core = new McpCore(transport);

function callMethod(name, params) {
  if (name === "ping" || name === "status") return transport.call(name, params);
  return core.callTool(name, params);
}

try {
  let result;
  if (method === "__sequence") {
    if (!Array.isArray(args.calls) || args.calls.length === 0) {
      throw Object.assign(new Error("__sequence requires a non-empty calls array"), {
        code: "INVALID_REQUEST",
      });
    }
    result = [];
    for (let index = 0; index < args.calls.length; index += 1) {
      const call = args.calls[index];
      if (!call || typeof call.method !== "string" || call.method.startsWith("__")) {
        throw Object.assign(new Error("Invalid bridge sequence entry"), {
          code: "INVALID_REQUEST",
        });
      }
      result.push(await callMethod(call.method, call.params ?? {}));
    }
  } else {
    result = await callMethod(method, args);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: toErrorData(error) })}\n`);
  process.exitCode = 2;
} finally {
  transport.close();
}
