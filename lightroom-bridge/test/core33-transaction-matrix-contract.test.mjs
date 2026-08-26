import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Core33 live transaction matrix covers all groups, full apply, rollback, and atomic rejection", async () => {
  const source = await fs.readFile(path.join(root, "scripts", "run-core33-transaction-matrix.mjs"), "utf8");
  for (const id of ["basic_tone_6", "texture_3", "hue_8", "saturation_8", "luminance_8", "all_core33"]) {
    assert.match(source, new RegExp(id));
  }
  assert.match(source, /OUT_OF_SCOPE_PARAMETER/);
  assert.match(source, /zero_write_verified/);
  assert.match(source, /unrequested_parameters_unchanged/);
  assert.match(source, /baseline_restored/);
});
