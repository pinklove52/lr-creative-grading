#!/usr/bin/env node
// 阶段验收脚本：一键产出机器可读证据报告（对应执行方案 §5/§7）。
// 用法：node scripts/verify-stages.mjs [--stage M1] [--artifacts artifacts/m1-queue]
//
// 产出：
//   artifacts/<run-id>/
//     report.json    测试统计 + M1 端到端结果 + 环境快照
//     summary.md     人类可读摘要
//     e2e/           端到端运行目录（含心跳/会话/日志样本）

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpCore } from "../lightroom-bridge/src/mcp-core.mjs";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { FakeLightroomPlugin } from "../lightroom-bridge/test/fake-lr-plugin.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");
const bridgeDir = path.join(repoDir, "lightroom-bridge");

function parseArgs(argv) {
  const args = { stage: "M1", artifacts: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--stage") args.stage = argv[++index] ?? "M1";
    if (argv[index] === "--artifacts") args.artifacts = argv[++index] ?? null;
  }
  return args;
}

async function runTests() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test"], {
      cwd: bridgeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      const tests = /ℹ tests (\d+)/.exec(stdout)?.[1] ?? "?";
      const pass = /ℹ pass (\d+)/.exec(stdout)?.[1] ?? "?";
      const fail = /ℹ fail (\d+)/.exec(stdout)?.[1] ?? "?";
      // 提取失败测试名与首条错误摘要（便于报告直接定位）
      const failing = [];
      const failingBlock = stdout.match(/✖ failing tests:[\s\S]*/)?.[0] ?? "";
      for (const match of failingBlock.matchAll(/✖ ([^\n(]+) \(/g)) {
        failing.push(match[1].trim());
      }
      const firstError = failingBlock.match(/Error: ([^\n]+)/)?.[1] ?? null;
      resolve({
        exitCode: code,
        tests: Number(tests),
        pass: Number(pass),
        fail: Number(fail),
        failing,
        firstError,
        stdout,
        stderr,
      });
    });
  });
}

async function runM1EndToEnd(runDir) {
  const root = path.join(runDir, "queue-root");
  const plugin = new FakeLightroomPlugin({ root, pollMs: 10, heartbeatMs: 60 });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 5_000, pollMs: 10 });
  const core = new McpCore(transport);
  const results = { pings: [], capabilities: null, status: null, errors: [] };

  try {
    const started = Date.now();
    for (let index = 0; index < 100; index += 1) {
      const begin = Date.now();
      try {
        const result = await transport.call("ping", { index });
        results.pings.push({ index, ok: true, ms: Date.now() - begin, pong: result.pong });
      } catch (error) {
        results.pings.push({ index, ok: false, ms: Date.now() - begin, code: error.code, message: error.message });
        results.errors.push(error);
        break;
      }
    }
    results.duration_ms = Date.now() - started;
    results.capabilities = await core.callTool("capabilities", {});
    results.status = await transport.call("status", {});
    // 在插件停止（会删除会话文件）之前保留样本作为证据
    const sessionSample = await fs.readFile(path.join(root, "session.json"), "utf8").then(JSON.parse);
    await fs.copyFile(path.join(root, "session.json"), path.join(runDir, "session-sample.json"));
    await fs.copyFile(path.join(root, "heartbeat.json"), path.join(runDir, "heartbeat-sample.json"));
    const summary = {
      protocol_version: sessionSample.protocol_version,
      ping_total: results.pings.length,
      ping_ok: results.pings.filter((item) => item.ok).length,
      ping_failed: results.pings.filter((item) => !item.ok).length,
      pings_sequential_ok: results.pings.length === 100 && results.pings.every((item) => item.ok),
      completed_requests: results.status?.completed_requests,
      failed_requests: results.status?.failed_requests,
      heartbeat_state: results.status?.state,
      queue_root: root,
    };
    return { summary, results };
  } finally {
    await transport.close();
    await plugin.stop();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = `verify-${args.stage}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const artifactsDir = args.artifacts
    ? path.resolve(args.artifacts)
    : path.join(repoDir, "artifacts", runId);
  const runDir = path.join(artifactsDir, "e2e");
  await fs.mkdir(runDir, { recursive: true });

  const testResults = await runTests();
  const e2e = await runM1EndToEnd(runDir);

  const report = {
    run_id: runId,
    stage: args.stage,
    generated_at: new Date().toISOString(),
    host: { platform: process.platform, release: os.release(), arch: process.arch },
    node: process.versions.node,
    tests: {
      total: testResults.tests,
      pass: testResults.pass,
      fail: testResults.fail,
      exit_code: testResults.exitCode,
      failing: testResults.failing,
      first_error: testResults.firstError,
    },
    m1_end_to_end: e2e.summary,
    ok: testResults.fail === 0 && e2e.summary.pings_sequential_ok,
  };
  await fs.writeFile(path.join(artifactsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const failedPings = e2e.results.pings.filter((item) => !item.ok);
  const summaryLines = [
    `# 阶段验收报告：${args.stage}`,
    "",
    `- 运行 ID：\`${runId}\``,
    `- 时间：${report.generated_at}`,
    `- 环境：${report.host.platform} ${report.host.release} (${report.host.arch})，Node ${report.node}`,
    "",
    "## 测试结果",
    "",
    `| 项目 | 值 |`,
    `|---|---|`,
    `| 测试总数 | ${report.tests.total} |`,
    `| 通过 | ${report.tests.pass} |`,
    `| 失败 | ${report.tests.fail} |`,
    `| 退出码 | ${report.tests.exit_code} |`,
    "",
    "## M1 端到端（假插件模拟 Lightroom 侧）",
    "",
    `- 顺序 ping：${e2e.summary.ping_ok}/${e2e.summary.ping_total} 成功`,
    `- 插件侧完成计数：${e2e.summary.completed_requests}，失败计数：${e2e.summary.failed_requests}`,
    `- 心跳状态：${e2e.summary.heartbeat_state}`,
    `- 100 次顺序无丢失：${e2e.summary.pings_sequential_ok ? "✅" : "❌"}`,
    "",
    "## 结论",
    "",
    report.ok
      ? "**M1 全部通过。** 下一步：在 Lightroom 15.0.1 产品版本族实机按验收清单执行 M2/M3。"
      : "**存在失败，不得进入实机阶段。** 先修复证据中的失败项。",
    "",
    "## 附",
    "",
    "- 完整 JSON：`report.json`",
    "- 端到端样本：`e2e/session-sample.json`、`e2e/heartbeat-sample.json`",
  ];
  if (failedPings.length > 0) {
    summaryLines.push("- 失败 ping：", "```json", JSON.stringify(failedPings, null, 2), "```");
  }
  await fs.writeFile(path.join(artifactsDir, "summary.md"), `${summaryLines.join("\n")}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({ ok: report.ok, artifacts: artifactsDir, tests: report.tests, e2e: e2e.summary }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, fatal: String(error?.stack ?? error) })}\n`);
  process.exitCode = 1;
});
