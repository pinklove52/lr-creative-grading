import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { EVIDENCE_SCHEMA_VERSION, REQUIRED_CHECKS, parsePluginBuild, validateLiveProbe, validateObservations } from "../../scripts/live-evidence.mjs";
import { validateLiveEvidence, validatePredecessor } from "../../scripts/verify-stages.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
function probe(stage = "M3") {
  return { ping: { stage, lr_version: "15.0.1.1" }, capabilities: { stage, bridge: { implementation: "lua-sdk" } }, status: { stage } };
}
const pluginBinding = { plugin_build: "0.3.0+2", checksums_path: "lightroom-file-polling-bridge/plugin/FileQueueBridge.lrplugin/checksums.txt", checksums_sha256: digest("checksums") };

test("live probe rejects fake plug-in and stage mismatch", () => {
  assert.throws(() => validateLiveProbe("M3", { ...probe(), capabilities: { stage: "M3", bridge: { note: "fake plug-in" } } }), /Fake/);
  assert.throws(() => validateLiveProbe("M2", probe("M3")), /mismatch/);
});

test("observation validation is fail-closed on missing checks and quarantined paths", async () => {
  await assert.rejects(() => validateObservations("M2", { source: "live-observations", stage: "M2", checks: [] }), /Missing/);
  const checks = REQUIRED_CHECKS.M2.map((id) => ({ id, ok: true, observed_at: "2026-08-22T00:00:00Z", evidence_files: ["artifacts/_invalid/log.json"] }));
  await assert.rejects(() => validateObservations("M2", { source: "live-observations", stage: "M2", checks }), /_invalid/);
});

test("stage evidence validates attachment digests and complete required checks", async () => {
  const bytes = Buffer.from("real evidence");
  const evidence = { schema_version: EVIDENCE_SCHEMA_VERSION, source: "live", stage: "M3", complete: true, ok: true, plugin_binding: pluginBinding, environment_doctor: { ok: true }, live_probe: probe(), observation_manifest: { path: "artifacts/live-run/observations.json", sha256: digest(bytes) }, checks: REQUIRED_CHECKS.M3.map((id) => ({ id, ok: true })), attachments: REQUIRED_CHECKS.M3.map((id) => ({ check_id: id, path: `artifacts/live-run/${id}.json`, sha256: digest(bytes) })) };
  assert.equal(await validateLiveEvidence("M3", evidence, { readFile: async () => bytes, currentPluginBinding: pluginBinding }), true);
  evidence.attachments[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateLiveEvidence("M3", evidence, { readFile: async () => bytes, currentPluginBinding: pluginBinding }), /digest mismatch/);
});

test("stage evidence is invalidated when plugin build or checksums change", async () => {
  const bytes = Buffer.from("real evidence");
  const evidence = { schema_version: EVIDENCE_SCHEMA_VERSION, source: "live", stage: "M2", complete: true, ok: true, plugin_binding: pluginBinding, environment_doctor: { ok: true }, live_probe: probe("M2"), observation_manifest: { path: "artifacts/live-run/observations.json", sha256: digest(bytes) }, checks: REQUIRED_CHECKS.M2.map((id) => ({ id, ok: true })), attachments: REQUIRED_CHECKS.M2.map((id) => ({ check_id: id, path: `artifacts/live-run/${id}.json`, sha256: digest(bytes) })) };
  await assert.rejects(() => validateLiveEvidence("M2", evidence, { readFile: async () => bytes, currentPluginBinding: { ...pluginBinding, plugin_build: "0.3.0+3" } }), /plugin_build/);
  await assert.rejects(() => validateLiveEvidence("M2", evidence, { readFile: async () => bytes, currentPluginBinding: { ...pluginBinding, checksums_sha256: digest("changed") } }), /checksums\.txt/);
});

test("plugin build is parsed from Info.lua VERSION", () => {
  assert.equal(parsePluginBuild("return { VERSION = { major = 1, minor = 2, revision = 3, build = 4 } }"), "1.2.3+4");
  assert.throws(() => parsePluginBuild("return {}"), /VERSION/);
});

test("M2 and above cannot validate without all successful live checks", async () => {
  const evidence = { schema_version: EVIDENCE_SCHEMA_VERSION, source: "live", stage: "M2", complete: true, ok: true, plugin_binding: pluginBinding, environment_doctor: { ok: true }, live_probe: probe("M2"), checks: [], attachments: [{}] };
  await assert.rejects(() => validateLiveEvidence("M2", evidence, { currentPluginBinding: pluginBinding }), /missing successful checks/);
});

test("stage certification rehashes the immediately preceding live evidence", async () => {
  const bytes = Buffer.from("predecessor evidence");
  const report = { stage: "M2", ok: true, simulated_only: false, evidence_sources: [{ source: "live", path: "artifacts/live-evidence/M2.json", sha256: digest(bytes) }] };
  await assert.rejects(() => validatePredecessor("M3", [{ stage: "M2", ok: true, simulated_only: true }], { readFile: async () => bytes }), /certified M2/);
  assert.equal(await validatePredecessor("M3", [report], { readFile: async () => bytes }), true);
  await assert.rejects(() => validatePredecessor("M3", [report], { readFile: async () => Buffer.from("replaced") }), /digest still matches/);
});
