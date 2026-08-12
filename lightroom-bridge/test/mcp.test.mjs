import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpCore, TOOL_DEFINITIONS } from "../src/mcp-core.mjs";
import { makeGradeSession } from "./fixtures.mjs";

test("MCP core exposes exactly the seven bridge tools and forwards GradeSession shape", async () => {
  const calls = [];
  const bridge = { call: async (method, params) => { calls.push({ method, params }); return { ok: true }; } };
  const core = new McpCore(bridge);
  assert.deepEqual(
    TOOL_DEFINITIONS.map((tool) => tool.name),
    ["capabilities", "get_target_photo", "get_proxy", "get_settings", "apply_transaction", "readback", "rollback"],
  );
  const response = await core.handleJsonRpc({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "apply_transaction", arguments: makeGradeSession() },
  });
  assert.equal(response.result.isError, false);
  assert.equal(calls[0].method, "apply_transaction");
  assert.equal(Object.keys(calls[0].params.lr_recipe.desired_parameters).length, 25);
});

test("public MCP apply_transaction rejects a normalized/direct request that bypasses GradeSession gates", async () => {
  const bridge = { call: async () => ({ should_not_run: true }) };
  const core = new McpCore(bridge);
  const response = await core.handleJsonRpc({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: {
      name: "apply_transaction",
      arguments: {
        target: makeGradeSession().target,
        candidate: { candidate_id: "bypass", lr_recipe: { legacy_numeric_mode: "delta", parameters: { contrast: 1 } } },
        selection: { requested_strength: 100 },
      },
    },
  });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, "FULL_SESSION_REQUIRED");
});

test("MCP server keeps stdout pure JSON-RPC and sends no startup logs", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.resolve(testDir, "../src/mcp-server.mjs");
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
  })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0);
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  const messages = lines.map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((item) => item.id), [1, 2]);
  assert.equal(stderr, "");
});
