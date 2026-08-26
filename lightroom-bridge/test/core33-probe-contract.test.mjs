import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CORE33_SCOPE, CORE33_PARAMETER_NAMES } from "../src/core33-scope.mjs";
import { computeCore33ScopeDigest } from "../src/core33-scope-digest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Core33 scope contains exactly the requested JPG 33 controls", () => {
  assert.equal(CORE33_SCOPE.scope_id, "jpg-core33-v1");
  assert.deepEqual(CORE33_SCOPE.environment.source_formats, ["JPG", "JPEG"]);
  assert.equal(CORE33_PARAMETER_NAMES.length, 33);
});

test("Core33 live runner uses a probe-specific five-minute timeout", async () => {
  const source = await fs.readFile(path.join(root, "scripts", "probe-core33-jpg.mjs"), "utf8");
  assert.match(source, /requestTimeoutMs:\s*300_000/);
});

test("generated plug-in catalog always starts fail-closed regardless of historical evidence", async () => {
  const generator = await fs.readFile(path.join(root, "scripts", "sync-core33-scope.mjs"), "utf8");
  const canonical = await fs.readFile(
    path.join(root, "lightroom-bridge", "plugin", "LrCreativeGradingBridge.lrplugin", "ParameterCatalog.lua"),
    "utf8",
  );
  assert.match(generator, /probeStatus = \"unprobed\"/);
  assert.equal([...canonical.matchAll(/probeStatus = "unprobed"/g)].length, 33);
  assert.equal(canonical.includes('probeStatus = "write_probed"'), false);
});

test("Core33 scope digest ignores certification metadata but binds the control contract", () => {
  const original = structuredClone(CORE33_SCOPE);
  const metadataOnly = structuredClone(original);
  metadataOnly.parameters[0].status = "write_probed";
  metadataOnly.evidence = { plugin_build: "next", capabilities_path: "new.json" };
  assert.equal(computeCore33ScopeDigest(metadataOnly), computeCore33ScopeDigest(original));

  const changedContract = structuredClone(original);
  changedContract.parameters[0].tolerance += 0.01;
  assert.notEqual(computeCore33ScopeDigest(changedContract), computeCore33ScopeDigest(original));
});
