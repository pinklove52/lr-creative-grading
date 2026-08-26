#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LightroomFileQueueTransport } from "../lightroom-bridge/src/file-queue-transport.mjs";
import { CORE33_SCOPE, CORE33_SCOPE_DIGEST } from "../lightroom-bridge/src/core33-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseDir = path.join(root, "lightroom-file-polling-bridge", "plugin", "FileQueueBridge.lrplugin");
const chartPath = path.join(root, "artifacts", "core33", "core33-test-chart.jpg");
const outputPath = path.join(root, "artifacts", "core33", "capabilities-lr15.0.1-jpg-core33.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const transport = new LightroomFileQueueTransport({ requestTimeoutMs: 300_000 });

try {
  const target = await transport.call("get_target_photo", {});
  if (String(target.format).toUpperCase() !== "JPG" && String(target.format).toUpperCase() !== "JPEG") {
    throw Object.assign(new Error("Select the imported Core33 JPG test chart"), { code: "UNSUPPORTED_SOURCE_FORMAT" });
  }
  if (String(target.filename).toLowerCase() !== "core33-test-chart.jpg") {
    throw Object.assign(new Error("Select core33-test-chart.jpg before probing"), { code: "PROBE_TARGET_NOT_ALLOWED" });
  }
  const [checksums, chart] = await Promise.all([readFile(path.join(releaseDir, "checksums.txt")), readFile(chartPath)]);
  const result = await transport.call("probe_core33_jpg", {
    target,
    confirmation: "PROBE_CORE33_TEST_CHART_ONLY",
  });
  const records = Object.values(result.parameters ?? {});
  const writeProbed = records.filter((entry) => entry.status === "write_probed").length;
  const evidence = {
    schema_version: 1,
    source: "live",
    captured_at: new Date().toISOString(),
    scope_id: CORE33_SCOPE.scope_id,
    scope_digest: CORE33_SCOPE_DIGEST,
    plugin_version: result.plugin_version,
    parameter_count: records.length,
    write_probed_count: writeProbed,
    complete: records.length === 33 && writeProbed === 33,
    checksums_digest: sha256(checksums),
    test_chart_digest: sha256(chart),
    target: result.target,
    baseline_edit_digest: result.baseline_edit_digest,
    final_edit_digest: result.final_edit_digest,
    snapshot_id: result.snapshot_id,
    parameters: result.parameters,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const runtimePath = path.join(transport.root, "capabilities-lr15.0.1-jpg-core33.json");
  const runtimeTmp = `${runtimePath}.${process.pid}.tmp`;
  await writeFile(runtimeTmp, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rm(runtimePath, { force: true });
  await rename(runtimeTmp, runtimePath);
  process.stdout.write(`${JSON.stringify({ ok: evidence.complete, output: outputPath, write_probed: writeProbed, total: records.length })}\n`);
  if (!evidence.complete) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? "PROBE_FAILED", message: error.message } })}\n`);
  process.exitCode = 2;
} finally {
  transport.close();
}
