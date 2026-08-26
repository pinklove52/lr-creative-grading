#!/usr/bin/env node
// Guided live evidence collector. It only performs read-only bridge probes; write,
// rollback, crash and UI observations must already exist as timestamped evidence.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(scriptPath), "..");
const artifactsDir = path.join(repoDir, "artifacts");
const liveEvidenceDir = path.join(artifactsDir, "live-evidence");
const releasePluginDir = path.join(repoDir, "lightroom-file-polling-bridge", "plugin", "FileQueueBridge.lrplugin");
const pluginInfoPath = path.join(releasePluginDir, "Info.lua");
const pluginChecksumsPath = path.join(releasePluginDir, "checksums.txt");
export const EVIDENCE_SCHEMA_VERSION = 2;
export const VALID_STAGES = Object.freeze(["M1", "M2", "M3", "M4"]);

export const REQUIRED_CHECKS = Object.freeze({
  M1: ["environment_preflight", "plugin_loaded", "bridge_started", "heartbeat_5s", "bridge_log_started", "live_round_trip", "ping_20", "method_gate", "stop_cleanup", "start_stop_5", "restart_recovery", "invalid_json_quarantine", "ui_responsive"],
  M2: ["m2_capabilities", "target_identity", "settings_match", "proxy_decodes", "target_mismatch", "baseline_digest_changes", "readonly_50", "module_switch"],
  M3: ["single_apply", "single_readback", "snapshot_created", "single_rollback", "batch_5", "batch_25", "unsupported_atomic_reject", "virtual_preview_matches", "master_unchanged", "master_apply_matches", "preview_cycle_10", "crash_recovery_unknown", "rollback_baseline_changed", "idle_30_60m", "start_stop_10"],
  M4: ["m3_report_valid", "temperature_release_decision", "uninstall_clean"],
});

function parseArgs(argv) {
  const args = { stage: null, observations: null, init: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--stage") args.stage = argv[++index] ?? null;
    else if (argv[index] === "--observations") args.observations = argv[++index] ?? null;
    else if (argv[index] === "--init") args.init = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!VALID_STAGES.includes(args.stage)) throw new Error("--stage must be one of M1, M2, M3, M4");
  if (Boolean(args.observations) === Boolean(args.init)) throw new Error("Use exactly one of --observations <json> or --init <json>");
  return args;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertUsableEvidencePath(filePath) {
  const resolved = path.resolve(filePath);
  if (!isInside(repoDir, resolved)) throw new Error(`Evidence must be inside the repository: ${resolved}`);
  if (path.relative(artifactsDir, resolved).split(path.sep).includes("_invalid")) throw new Error(`Evidence under artifacts/_invalid is forbidden: ${resolved}`);
  return resolved;
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export function parsePluginBuild(infoLuaSource) {
  const versionBlock = /VERSION\s*=\s*\{([\s\S]*?)\}/.exec(infoLuaSource)?.[1];
  if (!versionBlock) throw new Error("Plugin Info.lua has no VERSION block");
  const component = (name, required = false) => {
    const value = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(versionBlock)?.[1];
    if (value === undefined && required) throw new Error(`Plugin VERSION is missing ${name}`);
    return Number(value ?? 0);
  };
  return `${component("major", true)}.${component("minor", true)}.${component("revision")}+${component("build")}`;
}

export async function computePluginBinding(options = {}) {
  const readFile = options.readFile ?? fs.readFile;
  const [infoBytes, checksumsBytes] = await Promise.all([
    readFile(pluginInfoPath),
    readFile(pluginChecksumsPath),
  ]);
  return {
    plugin_build: parsePluginBuild(infoBytes.toString("utf8")),
    checksums_path: path.relative(repoDir, pluginChecksumsPath).replaceAll("\\", "/"),
    checksums_sha256: crypto.createHash("sha256").update(checksumsBytes).digest("hex"),
  };
}

export async function validateObservations(stage, manifest, options = {}) {
  if (manifest?.source !== "live-observations") throw new Error("Observation source must be live-observations");
  if (manifest?.stage !== stage) throw new Error(`Observation stage mismatch: expected ${stage}`);
  if (!Array.isArray(manifest.checks)) throw new Error("Observation manifest checks must be an array");
  const byId = new Map(manifest.checks.map((item) => [item?.id, item]));
  const missing = REQUIRED_CHECKS[stage].filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Missing required live checks: ${missing.join(", ")}`);
  const failed = REQUIRED_CHECKS[stage].filter((id) => byId.get(id)?.ok !== true);
  if (failed.length) throw new Error(`Live checks are not successful: ${failed.join(", ")}`);
  const resolvePath = options.resolvePath ?? assertUsableEvidencePath;
  const hashFile = options.hashFile ?? sha256File;
  const attachments = [];
  for (const id of REQUIRED_CHECKS[stage]) {
    const check = byId.get(id);
    if (!Number.isFinite(Date.parse(check.observed_at))) throw new Error(`Check ${id} needs a valid observed_at timestamp`);
    if (!Array.isArray(check.evidence_files) || check.evidence_files.length === 0) throw new Error(`Check ${id} needs at least one evidence file`);
    for (const item of check.evidence_files) {
      const resolved = resolvePath(path.resolve(repoDir, item));
      attachments.push({ check_id: id, path: path.relative(repoDir, resolved).replaceAll("\\", "/"), sha256: await hashFile(resolved) });
    }
  }
  return { required_checks: [...REQUIRED_CHECKS[stage]], checks: REQUIRED_CHECKS[stage].map((id) => byId.get(id)), attachments };
}

async function runJsonCommand(command, args, cwd, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.end(stdin);
    child.on("exit", (code) => {
      try {
        const parsed = JSON.parse(stdout || stderr);
        if (code !== 0 || parsed.ok !== true) reject(new Error(`Command failed (${code}): ${stdout || stderr}`));
        else resolve(parsed);
      } catch (error) { reject(error); }
    });
  });
}

async function collectLiveProbe(stage) {
  const cli = path.join(repoDir, "lightroom-bridge", "src", "bridge-cli.mjs");
  const ping = await runJsonCommand(process.execPath, [cli, "ping"], repoDir, "{}\n");
  const capabilities = await runJsonCommand(process.execPath, [cli, "capabilities"], repoDir, "{}\n");
  const status = await runJsonCommand(process.execPath, [cli, "status"], repoDir, "{}\n");
  const probe = { ping: ping.result, capabilities: capabilities.result, status: status.result };
  validateLiveProbe(stage, probe);
  return probe;
}

export function validateLiveProbe(stage, probe) {
  const expected = stage === "M4" ? "M3" : stage;
  for (const name of ["ping", "capabilities", "status"]) {
    if (probe?.[name]?.stage !== expected) throw new Error(`${name} stage mismatch: expected ${expected}`);
  }
  if (String(probe?.capabilities?.bridge?.note ?? "").toLowerCase().includes("fake plug-in")) throw new Error("Fake plug-in evidence is forbidden");
  if (!String(probe?.ping?.lr_version ?? "").startsWith("15.0.1")) throw new Error("Unsupported Lightroom version in live probe");
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) {
    const destination = assertUsableEvidencePath(path.resolve(args.init));
    const template = {
      source: "live-observations", stage: args.stage,
      checks: REQUIRED_CHECKS[args.stage].map((id) => ({ id, ok: false, observed_at: null, evidence_files: [], note: "" })),
    };
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({ ok: true, template: destination, stage: args.stage }, null, 2)}\n`);
    return;
  }
  const manifestPath = assertUsableEvidencePath(path.resolve(args.observations));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const observations = await validateObservations(args.stage, manifest);
  const doctor = await runJsonCommand(process.execPath, [path.join(repoDir, "lightroom-bridge", "src", "environment-doctor.mjs")], repoDir);
  const liveProbe = await collectLiveProbe(args.stage);
  const pluginBinding = await computePluginBinding();
  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION, source: "live", stage: args.stage, complete: true, ok: true,
    generated_at: new Date().toISOString(),
    host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.versions.node },
    plugin_binding: pluginBinding,
    observation_manifest: { path: path.relative(repoDir, manifestPath).replaceAll("\\", "/"), sha256: await sha256File(manifestPath) },
    environment_doctor: doctor, live_probe: liveProbe,
    required_checks: observations.required_checks, checks: observations.checks, attachments: observations.attachments,
  };
  await fs.mkdir(liveEvidenceDir, { recursive: true });
  const destination = path.join(liveEvidenceDir, `${args.stage}.json`);
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await fs.rename(temporary, destination);
  process.stdout.write(`${JSON.stringify({ ok: true, evidence: destination, stage: args.stage }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, fatal: String(error?.stack ?? error) })}\n`);
    process.exitCode = 1;
  });
}
