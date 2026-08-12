import fs from "node:fs/promises";
import { McpCore } from "../../lightroom-bridge/src/mcp-core.mjs";
import { LightroomSocketTransport } from "../../lightroom-bridge/src/socket-transport.mjs";

const [method, inputPath] = process.argv.slice(2);
if (!method) throw new Error("Usage: node bridge_call.mjs <method> [input-json]");

const args = inputPath ? JSON.parse(await fs.readFile(inputPath, "utf8")) : {};
const transport = new LightroomSocketTransport();
const core = new McpCore(transport);

try {
  const result = await core.callTool(method, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  transport.close();
}
