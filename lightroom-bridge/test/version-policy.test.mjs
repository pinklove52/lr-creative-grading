import assert from "node:assert/strict";
import test from "node:test";
import { ACCEPTED_LR_VERSION_PREFIX, evaluateLrVersion, isAcceptedLrVersion } from "../src/version-policy.mjs";

test("Lightroom 15.0.1 version family is accepted by prefix", () => {
  assert.equal(ACCEPTED_LR_VERSION_PREFIX, "15.0.1");
  assert.equal(isAcceptedLrVersion("15.0.1"), true);
  assert.equal(isAcceptedLrVersion("15.0.1.1"), true);
  assert.equal(isAcceptedLrVersion("15.0.1 (build 202511041508-dddee541)"), true);
});

test("unknown Lightroom versions fail the write-mode hard gate", () => {
  for (const value of [null, undefined, "", "   "]) {
    const result = evaluateLrVersion(value);
    assert.equal(result.known, false);
    assert.equal(result.accepted, false);
    assert.match(result.reason, /could not be read/);
  }
});

test("versions outside the 15.0.1 prefix remain blocked", () => {
  assert.equal(isAcceptedLrVersion("15.0.0.9"), false);
  assert.equal(isAcceptedLrVersion("15.1.0"), false);
  assert.equal(isAcceptedLrVersion("16.0.0"), false);
  assert.equal(isAcceptedLrVersion(null), false);
});
