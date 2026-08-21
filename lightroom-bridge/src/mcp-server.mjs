#!/usr/bin/env node
import readline from "node:readline";
import { McpCore } from "./mcp-core.mjs";
import { LightroomFileQueueTransport } from "./file-queue-transport.mjs";
import { LightroomSocketTransport } from "./socket-transport.mjs";

const MAX_STDIN_LINE_BYTES = 1_048_576;

// 默认使用文件队列传输；旧双端口 LrSocket 保留为实验分支，
// 通过 LR_BRIDGE_TRANSPORT=socket 显式启用。
function createTransport() {
  if (process.env.LR_BRIDGE_TRANSPORT === "socket") {
    return new LightroomSocketTransport();
  }
  return new LightroomFileQueueTransport();
}

const transport = createTransport();
const core = new McpCore(transport);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeMessage(message) {
  // MCP stdout is reserved exclusively for JSON-RPC messages.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", async (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > MAX_STDIN_LINE_BYTES) {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "MCP request exceeded the size limit" },
    });
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const response = await core.handleJsonRpc(message);
    if (response) writeMessage(response);
  } catch (error) {
    // Diagnostics stay on stderr so they cannot corrupt MCP framing.
    process.stderr.write(`lr-creative-grading bridge error: ${error?.stack ?? error}\n`);
    if (message.id != null) {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "Internal error" },
      });
    }
  }
});

function shutdown() {
  transport.close();
  input.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
