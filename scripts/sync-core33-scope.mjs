import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeCore33ScopeDigest } from "../lightroom-bridge/src/core33-scope-digest.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const scopePath = resolve(root, "lightroom-bridge/config/jpg-core33-v1.json");
const canonicalPath = resolve(root, "lightroom-bridge/plugin/LrCreativeGradingBridge.lrplugin/ParameterCatalog.lua");
const releasePath = resolve(root, "lightroom-file-polling-bridge/plugin/FileQueueBridge.lrplugin/ParameterCatalog.lua");
const scopeBytes = await readFile(scopePath);
const scope = JSON.parse(scopeBytes.toString("utf8"));
const digest = computeCore33ScopeDigest(scope);

if (scope.scope_id !== "jpg-core33-v1" || scope.parameters?.length !== 33) {
  throw new Error("scope must be jpg-core33-v1 with exactly 33 parameters");
}
const logical = new Set();
const lr = new Set();
for (const entry of scope.parameters) {
  if (!entry.logical || !entry.lr || entry.engine !== "controller") {
    throw new Error(`invalid Core33 entry: ${JSON.stringify(entry)}`);
  }
  if (logical.has(entry.logical) || lr.has(entry.lr)) throw new Error("duplicate Core33 mapping");
  if (!["unprobed", "write_probed", "unsupported"].includes(entry.status)) {
    throw new Error(`invalid probe status for ${entry.logical}`);
  }
  logical.add(entry.logical);
  lr.add(entry.lr);
}

const q = (value) => JSON.stringify(value);
const lines = [
  "-- Generated from lightroom-bridge/config/jpg-core33-v1.json. Do not hand edit.",
  "local Catalog = {}",
  `Catalog.scopeId = ${q(scope.scope_id)}`,
  `Catalog.scopeDigest = ${q(digest)}`,
  'Catalog.sourceFormat = "JPG"',
  "Catalog.entries = {",
  // Certification status in the scope JSON is historical evidence metadata.
  // A newly loaded plug-in must always fail closed until Bridge.loadProbeEvidence
  // accepts evidence whose plug-in version exactly matches the running build.
  ...scope.parameters.map((entry) =>
    `    { logical = ${q(entry.logical)}, lr = ${q(entry.lr)}, engine = ${q(entry.engine)}, probeStatus = "unprobed", tolerance = ${entry.tolerance} },`),
  "}",
  "Catalog.byLogical = {}",
  "Catalog.byLightroom = {}",
  "for _, entry in ipairs(Catalog.entries) do",
  "    Catalog.byLogical[entry.logical] = entry",
  "    Catalog.byLightroom[entry.lr] = entry",
  "end",
  "function Catalog.resolve(name)",
  "    return Catalog.byLogical[name] or Catalog.byLightroom[name]",
  "end",
  "return Catalog",
  "",
];
const generated = lines.join("\n");
const write = process.argv.includes("--write");
for (const target of [canonicalPath, releasePath]) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (write) await writeFile(target, generated, "utf8");
  else if (current !== generated) throw new Error(`${target} is not synchronized with Core33 scope`);
}
console.log(JSON.stringify({ ok: true, scope_id: scope.scope_id, scope_digest: digest, count: 33, write }));
