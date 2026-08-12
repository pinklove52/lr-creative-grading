#!/usr/bin/env node
import { McpCore } from "./mcp-core.mjs";
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
const transport = new LightroomSocketTransport();
const core = new McpCore(transport);

try {
  const result = await core.callTool(method, args);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: toErrorData(error) })}\n`);
  process.exitCode = 2;
} finally {
  transport.close();
}
