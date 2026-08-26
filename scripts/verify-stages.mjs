#!/usr/bin/env node
// Stage verifier. Simulated M1 coverage is always run; a certification report is
// live only when it is bound to a valid artifacts/live-evidence/Mn.json file.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpCore } from "../lightroom-bridge/src/mcp-core.mjs";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { FakeLightroomPlugin } from "../lightroom-bridge/test/fake-lr-plugin.mjs";
import { computePluginBinding, EVIDENCE_SCHEMA_VERSION, REQUIRED_CHECKS, VALID_STAGES, validateLiveProbe } from "./live-evidence.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(scriptPath), "..");
const bridgeDir = path.join(repoDir, "lightroom-bridge");
const artifactsRoot = path.join(repoDir, "artifacts");

function parseArgs(argv) {
  const args = { stage: "M1", artifacts: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--stage") args.stage = argv[++index] ?? null;
    else if (argv[index] === "--artifacts") args.artifacts = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!VALID_STAGES.includes(args.stage)) throw new Error("--stage must be one of M1, M2, M3, M4");
  return args;
}

function isDirectArtifactRun(candidate) {
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === artifactsRoot && path.basename(resolved) !== "_invalid";
}

function resolveRepositoryEvidence(relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) throw new Error("Evidence path must be repository-relative");
  const resolved = path.resolve(repoDir, relativePath);
  const relative = path.relative(repoDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence path escapes the repository");
  if (relative.split(path.sep).includes("_invalid")) throw new Error("Evidence under _invalid is quarantined");
  return resolved;
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export async function validateLiveEvidence(stage, evidence, options = {}) {
  if (evidence?.schema_version !== EVIDENCE_SCHEMA_VERSION || evidence?.source !== "live" || evidence?.stage !== stage) throw new Error(`Invalid live evidence identity for ${stage}`);
  if (evidence.complete !== true || evidence.ok !== true) throw new Error(`${stage} live evidence is incomplete or failed`);
  if (evidence.environment_doctor?.ok !== true) throw new Error(`${stage} environment doctor did not pass`);
  const currentPluginBinding = options.currentPluginBinding ?? await computePluginBinding();
  const capturedPluginBinding = evidence.plugin_binding;
  if (!capturedPluginBinding || capturedPluginBinding.plugin_build !== currentPluginBinding.plugin_build) {
    throw new Error(`${stage} live evidence plugin_build does not match the current plugin`);
  }
  if (capturedPluginBinding.checksums_path !== currentPluginBinding.checksums_path || capturedPluginBinding.checksums_sha256 !== currentPluginBinding.checksums_sha256) {
    throw new Error(`${stage} live evidence checksums.txt binding does not match the current plugin`);
  }
  validateLiveProbe(stage, evidence.live_probe);
  const ids = new Set(Array.isArray(evidence.checks) ? evidence.checks.filter((item) => item?.ok === true).map((item) => item.id) : []);
  const missing = REQUIRED_CHECKS[stage].filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`${stage} live evidence is missing successful checks: ${missing.join(", ")}`);
  if (!Array.isArray(evidence.attachments) || evidence.attachments.length === 0) throw new Error(`${stage} live evidence has no attachments`);
  const readFile = options.readFile ?? ((relative) => fs.readFile(resolveRepositoryEvidence(relative)));
  if (typeof evidence.observation_manifest?.path !== "string" || !/^[a-f0-9]{64}$/.test(evidence.observation_manifest?.sha256 ?? "")) throw new Error("Live evidence observation manifest is missing or invalid");
  resolveRepositoryEvidence(evidence.observation_manifest.path);
  const manifestDigest = crypto.createHash("sha256").update(await readFile(evidence.observation_manifest.path)).digest("hex");
  if (manifestDigest !== evidence.observation_manifest.sha256) throw new Error("Live evidence observation manifest digest mismatch");
  const attachedChecks = new Set();
  for (const attachment of evidence.attachments) {
    resolveRepositoryEvidence(attachment?.path);
    if (!REQUIRED_CHECKS[stage].includes(attachment?.check_id)) throw new Error("Live evidence attachment has an unknown check_id");
    attachedChecks.add(attachment.check_id);
    const digest = crypto.createHash("sha256").update(await readFile(attachment.path)).digest("hex");
    if (digest !== attachment.sha256) throw new Error(`Live evidence attachment digest mismatch: ${attachment.path}`);
  }
  const unattached = REQUIRED_CHECKS[stage].filter((id) => !attachedChecks.has(id));
  if (unattached.length) throw new Error(`${stage} checks lack evidence attachments: ${unattached.join(", ")}`);
  return true;
}

export async function validatePredecessor(stage, reports, options = {}) {
  const index = VALID_STAGES.indexOf(stage);
  if (index <= 0) return true;
  const predecessor = VALID_STAGES[index - 1];
  const expectedPath = `artifacts/live-evidence/${predecessor}.json`;
  const readFile = options.readFile ?? ((relative) => fs.readFile(resolveRepositoryEvidence(relative)));
  for (const report of reports) {
    if (report?.stage !== predecessor || report?.ok !== true || report?.simulated_only !== false || !Array.isArray(report.evidence_sources)) continue;
    for (const source of report.evidence_sources) {
      if (source?.source !== "live" || source?.path !== expectedPath || !/^[a-f0-9]{64}$/.test(source?.sha256 ?? "")) continue;
      let digest;
      try { digest = crypto.createHash("sha256").update(await readFile(source.path)).digest("hex"); }
      catch { continue; }
      if (digest === source.sha256) return true;
    }
  }
  throw new Error(`${stage} requires a valid certified ${predecessor} report whose live evidence digest still matches`);
}

async function loadCertifiedReports() {
  const reports = [];
  for (const entry of await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === "_invalid" || entry.name === "live-evidence") continue;
    const reportPath = path.join(artifactsRoot, entry.name, "report.json");
    try { reports.push(JSON.parse(await fs.readFile(reportPath, "utf8"))); } catch { /* not a report run */ }
  }
  return reports;
}

async function loadLiveEvidence(stage) {
  const evidencePath = path.join(artifactsRoot, "live-evidence", `${stage}.json`);
  let raw;
  try { raw = await fs.readFile(evidencePath, "utf8"); }
  catch (error) {
    if (stage === "M1" && error?.code === "ENOENT") return null;
    throw new Error(`${stage} requires ${evidencePath}; live evidence was not found`);
  }
  const evidence = JSON.parse(raw);
  await validateLiveEvidence(stage, evidence);
  return { evidence, path: evidencePath, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
}

async function runTests() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test"], { cwd: bridgeDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({
      exitCode: code,
      tests: Number(/ℹ tests (\d+)/.exec(stdout)?.[1] ?? 0),
      pass: Number(/ℹ pass (\d+)/.exec(stdout)?.[1] ?? 0),
      fail: Number(/ℹ fail (\d+)/.exec(stdout)?.[1] ?? 0),
      stdout, stderr,
    }));
  });
}

async function runSimulatedM1(runDir) {
  const root = path.join(runDir, "queue-root");
  const plugin = new FakeLightroomPlugin({ root, pollMs: 10, heartbeatMs: 60 });
  await plugin.start();
  const transport = new LightroomFileQueueTransport({ root, sessionWaitMs: 5_000, pollMs: 10 });
  const core = new McpCore(transport);
  const pings = [];
  try {
    for (let index = 0; index < 100; index += 1) pings.push(await transport.call("ping", { index }));
    const capabilities = await core.callTool("capabilities", {});
    const status = await transport.call("status", {});
    await fs.copyFile(path.join(root, "session.json"), path.join(runDir, "session-sample.json"));
    await fs.copyFile(path.join(root, "heartbeat.json"), path.join(runDir, "heartbeat-sample.json"));
    return { ping_total: pings.length, ping_ok: pings.filter((item) => item?.pong === true).length, pings_sequential_ok: pings.length === 100, completed_requests: status.completed_requests, failed_requests: status.failed_requests, capabilities };
  } finally { await transport.close(); await plugin.stop(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const live = await loadLiveEvidence(args.stage); // fail before creating a report
  await validatePredecessor(args.stage, await loadCertifiedReports());
  const runId = `verify-${args.stage}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = args.artifacts ? path.resolve(args.artifacts) : path.join(artifactsRoot, runId);
  if (!isDirectArtifactRun(outputDir)) throw new Error("Verification output must be a direct child of artifacts/ and must not be _invalid");
  const runDir = path.join(outputDir, "e2e");
  await fs.mkdir(runDir, { recursive: true });
  const tests = await runTests();
  const simulated = await runSimulatedM1(runDir);
  const simulatedFiles = [path.join(runDir, "session-sample.json"), path.join(runDir, "heartbeat-sample.json")];
  const evidenceSources = [];
  for (const file of simulatedFiles) evidenceSources.push({ source: "simulated", path: path.relative(repoDir, file).replaceAll("\\", "/"), sha256: await sha256File(file) });
  if (live) evidenceSources.push({ source: "live", path: path.relative(repoDir, live.path).replaceAll("\\", "/"), sha256: live.sha256 });
  const report = {
    run_id: runId, stage: args.stage, generated_at: new Date().toISOString(), simulated_only: live === null,
    evidence_sources: evidenceSources,
    host: { platform: process.platform, release: os.release(), arch: process.arch }, node: process.versions.node,
    tests: { total: tests.tests, pass: tests.pass, fail: tests.fail, exit_code: tests.exitCode },
    simulated_m1: simulated,
    live_evidence: live ? { stage: live.evidence.stage, generated_at: live.evidence.generated_at, required_checks: live.evidence.required_checks } : null,
  };
  report.ok = tests.exitCode === 0 && simulated.pings_sequential_ok && (args.stage === "M1" || live !== null);
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const kind = report.simulated_only ? "模拟验证（不可认证实机阶段）" : "实机证据绑定验证";
  await fs.writeFile(path.join(outputDir, "summary.md"), `# 阶段验收报告：${args.stage}\n\n- 类型：${kind}\n- 测试：${tests.pass}/${tests.total}\n- 模拟 ping：${simulated.ping_ok}/${simulated.ping_total}\n- 结论：${report.ok ? "通过" : "失败"}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: report.ok, stage: args.stage, simulated_only: report.simulated_only, artifacts: outputDir }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, fatal: String(error?.stack ?? error) })}\n`);
    process.exitCode = 1;
  });
}
