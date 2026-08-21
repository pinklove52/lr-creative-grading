// Lightroom 写能力版本策略：只放行已验收的 15.0.1 产品版本族。
// ProductVersion 可能是 15.0.1、15.0.1.1，或带构建说明的 15.0.1 (...)。
export const ACCEPTED_LR_VERSION_PREFIX = "15.0.1";

export function isAcceptedLrVersion(actual) {
  return typeof actual === "string" && actual.startsWith(ACCEPTED_LR_VERSION_PREFIX);
}
