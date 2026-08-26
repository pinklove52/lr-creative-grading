#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "sync-core33-scope.mjs"), "--check"], {
  cwd: repoRoot,
  stdio: "inherit",
});
const canonicalDir = path.join(repoRoot, "lightroom-bridge", "plugin", "LrCreativeGradingBridge.lrplugin");
const releaseDir = path.join(repoRoot, "lightroom-file-polling-bridge", "plugin", "FileQueueBridge.lrplugin");
const checksumPath = path.join(releaseDir, "checksums.txt");
const controlledCopies = ["BridgeCore.lua", "Json.lua", "ParameterCatalog.lua"];
const preferredOrder = [
  "Info.lua",
  "Config.lua",
  "QueueTransport.lua",
  "Start.lua",
  "Stop.lua",
  ...controlledCopies,
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertControlledCopies() {
  const results = [];
  for (const filename of controlledCopies) {
    const [canonical, release] = await Promise.all([
      readFile(path.join(canonicalDir, filename)),
      readFile(path.join(releaseDir, filename)),
    ]);
    if (!canonical.equals(release)) {
      throw new Error(`${filename} differs from the canonical lightroom-bridge copy`);
    }
    results.push({ filename, sha256: sha256(release) });
  }
  return results;
}

async function releaseFiles() {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== "checksums.txt" && !entry.name.endsWith(".tmp"))
    .map((entry) => entry.name);
  const rank = new Map(preferredOrder.map((name, index) => [name, index]));
  files.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right, "en");
  });
  return files;
}

async function replaceChecksums(contents) {
  const temporaryPath = `${checksumPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, checksumPath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await rm(checksumPath, { force: true });
    await rename(temporaryPath, checksumPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const copies = await assertControlledCopies();
const files = await releaseFiles();
if (files.length === 0) throw new Error("FileQueueBridge.lrplugin contains no releasable files");

const records = [];
for (const filename of files) {
  const bytes = await readFile(path.join(releaseDir, filename));
  records.push({ filename, sha256: sha256(bytes) });
}
await replaceChecksums(`${records.map((record) => `${record.sha256}  ${record.filename}`).join("\n")}\n`);

for (const record of records) {
  const bytes = await readFile(path.join(releaseDir, record.filename));
  if (sha256(bytes) !== record.sha256) throw new Error(`${record.filename} changed while checksums were generated`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  plugin: path.relative(repoRoot, releaseDir),
  controlled_copies: copies,
  checksum_file: path.relative(repoRoot, checksumPath),
  files: records,
  next_required_steps: [
    "npm test",
    "recapture live evidence for the current stage",
    "node scripts/verify-stages.mjs --stage <current-stage>",
  ],
}, null, 2)}\n`);
