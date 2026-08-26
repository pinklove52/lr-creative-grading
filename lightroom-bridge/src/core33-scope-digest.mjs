import { createHash } from "node:crypto";

// The scope digest identifies the immutable contract, not mutable certification
// metadata. Probe status and evidence pointers may advance without silently
// changing which Lightroom controls this scope means.
export function core33ScopeIdentity(scope) {
  return {
    scope_id: scope.scope_id,
    environment: {
      os: scope.environment?.os,
      lightroom_product_version: scope.environment?.lightroom_product_version,
      source_formats: [...(scope.environment?.source_formats ?? [])],
    },
    parameters: (scope.parameters ?? []).map((entry) => ({
      logical: entry.logical,
      lr: entry.lr,
      engine: entry.engine,
      tolerance: entry.tolerance,
    })),
  };
}

export function computeCore33ScopeDigest(scope) {
  return createHash("sha256")
    .update(JSON.stringify(core33ScopeIdentity(scope)))
    .digest("hex");
}
