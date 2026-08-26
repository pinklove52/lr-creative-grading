import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(testDir, "../plugin/LrCreativeGradingBridge.lrplugin");

async function source(name) { return fs.readFile(path.join(pluginDir, name), "utf8"); }

test("Lua plug-in declares modern minimum SDK and all public methods", async () => {
  const [info, core] = await Promise.all([source("Info.lua"), source("BridgeCore.lua")]);
  assert.match(info, /LrSdkMinimumVersion\s*=\s*14\.0/);
  for (const method of [
    "capabilities", "get_target_photo", "get_proxy", "get_settings",
    "apply_transaction", "readback", "rollback", "probe_core33_jpg",
  ]) assert.match(core, new RegExp(`${method}\\s*=`));
});

test("Lua business core exposes the traceable Core33 probe release label", async () => {
  const core = await source("BridgeCore.lua");
  assert.match(core, /coreVersion = "0\.3\.0-core33-probe\.7"/);
  assert.match(core, /plugin_version = Bridge\.coreVersion/);
});

test("Lua source contains strict snapshot, proxy freshness, rollback, and threshold cleanup guards", async () => {
  const core = await source("BridgeCore.lua");
  assert.match(core, /createDevelopSnapshot\(name, false\)/);
  assert.match(core, /before\.baseline_edit_digest ~= after\.baseline_edit_digest/);
  assert.match(core, /PROXY_STALE/);
  assert.match(core, /BASELINE_CHANGED/);
  assert.match(core, /PARTIAL_APPLY_ROLLED_BACK/);
  assert.match(core, /setMultipleAdjustmentThreshold, 0\.5/);
  assert.match(core, /target\.source_digest/);
  assert.match(core, /proxy_digest/);
});

test("Lua proxy uses a current-render export and never a cached thumbnail", async () => {
  const core = await source("BridgeCore.lua");
  assert.match(core, /local LrExportSession = import "LrExportSession"/);
  assert.match(core, /local exportSession = LrExportSession/);
  assert.match(core, /rendition:waitForRender\(\)/);
  assert.match(core, /LR_format = "JPEG"/);
  assert.match(core, /LR_reimportExportedPhoto = false/);
  assert.match(core, /LR_useWatermark = false/);
  assert.match(core, /rendering = "Lightroom export-session current-render JPEG"/);
  assert.doesNotMatch(core, /requestJpegThumbnail/);
});

test("Lua readback tolerates controller quantization but keeps structured values strict", async () => {
  const core = await source("BridgeCore.lua");
  assert.match(core, /CONTROLLER_VALUE_TOLERANCE\s*=\s*0\.999/);
  assert.match(core, /entry\.engine\s*==\s*"controller"\s+and\s+CONTROLLER_VALUE_TOLERANCE\s+or\s+0\.0001/);
});

test("Lua preflight exposes only unprobed Core33 and verifies rollback digests", async () => {
  const [core, catalog] = await Promise.all([source("BridgeCore.lua"), source("ParameterCatalog.lua")]);
  assert.doesNotMatch(catalog, /logical = "temperature"/);
  assert.match(catalog, /Catalog\.scopeId = "jpg-core33-v1"/);
  assert.equal([...catalog.matchAll(/logical\s*=\s*"/g)].length, 33);
  assert.match(core, /entry\.probeStatus ~= "write_probed"/);
  assert.match(core, /UNPROBED_PARAMETER/);
  assert.match(core, /waitForBaselineDigest/);
  assert.match(core, /digest_verified = true/);
  assert.match(core, /snapshot was created but its ID did not become visible/);
  assert.match(core, /pre_transaction_edit_digest = target\.baseline_edit_digest/);
  assert.match(core, /recovered_from_grade_session = true/);
  assert.match(core, /required_fields = \{ "target", "snapshot_id", "pre_transaction_edit_digest" \}/);
  assert.match(core, /diffSettingsSummaries/);
  assert.match(core, /differences_truncated = differencesTruncated/);
  assert.match(core, /pre_transaction_settings_summary = settingsSummary\(beforeSettings\)/);
  assert.match(core, /local function waitForAppliedDigest/);
  assert.match(core, /transaction\.applied_edit_digest = waitForAppliedDigest/);
  assert.match(core, /applied_edit_digest = transaction\.applied_edit_digest/);
  assert.match(core, /local function rollback\(params\)\s+-- Lightroom's snapshot APIs[\s\S]*?ensureDevelopModule\(\)/);
});

test("Core33 probe waits for published settings and refreshes controller state after rollback", async () => {
  const core = await source("BridgeCore.lua");
  assert.match(core, /local function waitForAppliedState/);
  assert.match(core, /stableCount >= 3/);
  assert.match(core, /lastDigest ~= baseline/);
  assert.match(core, /local function waitForBaselineState/);
  assert.match(core, /controllerBaselineMatches/);
  assert.match(core, /switchToModule, "library"/);
  assert.match(core, /diffSettingsSummaries\(\s*baselineSummary, appliedSummary, 64/);
});

test("Lua transport enforces loopback-only SDK sockets, token, size, single-client and duplicate IDs", async () => {
  const transport = await source("Transport.lua");
  assert.match(transport, /host = "127\.0\.0\.1"/);
  assert.match(transport, /maxRequestBytes = 1048576/);
  assert.match(transport, /AUTHENTICATION_FAILED/);
  assert.match(transport, /CLIENT_LOCKED/);
  assert.match(transport, /DUPLICATE_REQUEST/);
  assert.match(transport, /recentRequestOrder > 256/);
  assert.match(transport, /LrFileUtils\.move\(temporaryPath, finalPath\)/);
  assert.match(transport, /49152 \+ \(\(portSeed % 8000\) \* 2\)/);
  assert.match(transport, /port = Transport\.requestPort/);
  assert.match(transport, /port = Transport\.responsePort/);
  assert.match(transport, /publishDescriptor\(\)/);
  assert.match(transport, /message\.recycle_response == true/);
  assert.match(transport, /Transport\.responseSocket:reconnect\(\)/);
});

test("Lua transport accepts complete JSON when Lightroom strips the newline delimiter", async () => {
  const transport = await source("Transport.lua");
  assert.match(transport, /pcall\(Json\.decode, Transport\.requestBuffer\)/);
  assert.match(transport, /type\(bufferedMessage\) == "table"/);
  assert.match(transport, /processRequest\(line\)/);
});

test("plug-in never references a catalog database or XMP sidecar", async () => {
  const names = await fs.readdir(pluginDir);
  const contents = await Promise.all(names.filter((name) => name.endsWith(".lua")).map(source));
  const combined = contents.join("\n").toLowerCase();
  assert.equal(combined.includes(".lrcat"), false);
  assert.equal(combined.includes("sidecar"), false);
});
