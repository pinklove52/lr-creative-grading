import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeCore33ScopeDigest } from "./core33-scope-digest.mjs";

export const CORE33_SCOPE_PATH = fileURLToPath(
  new URL("../config/jpg-core33-v1.json", import.meta.url),
);

const scopeBytes = readFileSync(CORE33_SCOPE_PATH);
export const CORE33_SCOPE = JSON.parse(scopeBytes.toString("utf8"));
export const CORE33_SCOPE_DIGEST = computeCore33ScopeDigest(CORE33_SCOPE);

if (CORE33_SCOPE.scope_id !== "jpg-core33-v1") {
  throw new Error("Core33 scope_id must be jpg-core33-v1");
}
if (!Array.isArray(CORE33_SCOPE.parameters) || CORE33_SCOPE.parameters.length !== 33) {
  throw new Error("Core33 scope must contain exactly 33 parameters");
}

export const CORE33_PARAMETER_NAMES = Object.freeze(
  CORE33_SCOPE.parameters.map((entry) => entry.logical),
);
export const CORE33_PARAMETER_SET = new Set(CORE33_PARAMETER_NAMES);
export const CORE33_FORMAT_SET = new Set(
  CORE33_SCOPE.environment.source_formats.map((value) => value.toUpperCase()),
);

if (CORE33_PARAMETER_SET.size !== 33) {
  throw new Error("Core33 logical parameter names must be unique");
}

export function normalizeSourceFormat(value) {
  return String(value ?? "").trim().replace(/^\./, "").toUpperCase();
}

export function assertCore33Format(value, ErrorType, details = undefined) {
  const normalized = normalizeSourceFormat(value);
  if (!CORE33_FORMAT_SET.has(normalized)) {
    throw new ErrorType(
      "UNSUPPORTED_SOURCE_FORMAT",
      `Core33 only supports JPG source photos, not ${normalized || "unknown"}`,
      details,
    );
  }
  return "JPG";
}

export function assertCore33Parameter(name, ErrorType) {
  if (!CORE33_PARAMETER_SET.has(name)) {
    throw new ErrorType(
      "OUT_OF_SCOPE_PARAMETER",
      `${name} is outside ${CORE33_SCOPE.scope_id}`,
      { parameter: name, scope_id: CORE33_SCOPE.scope_id },
    );
  }
}

export function assertCore33Scope(value, ErrorType) {
  if (
    value?.scope_id !== CORE33_SCOPE.scope_id ||
    value?.scope_digest !== CORE33_SCOPE_DIGEST
  ) {
    throw new ErrorType(
      "SCOPE_MISMATCH",
      "GradeSession Core33 scope id or digest does not match this build",
      {
        expected_scope_id: CORE33_SCOPE.scope_id,
        expected_scope_digest: CORE33_SCOPE_DIGEST,
      },
    );
  }
  return {
    scope_id: CORE33_SCOPE.scope_id,
    scope_digest: CORE33_SCOPE_DIGEST,
  };
}
