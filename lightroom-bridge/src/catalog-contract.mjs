#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG_PATH = path.resolve(
  moduleDir,
  "../plugin/LrCreativeGradingBridge.lrplugin/ParameterCatalog.lua",
);

export async function loadCanonicalCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  const source = await fs.readFile(catalogPath, "utf8");
  const names = new Set();
  for (const match of source.matchAll(/logical\s*=\s*"([^"]+)"/g)) names.add(match[1]);
  if (names.size === 0) throw new Error(`No logical parameter names found in ${catalogPath}`);
  return names;
}

export function selectedRecipeKeys(session) {
  const candidateId = session?.selection?.candidate_id;
  const candidate = session?.candidates?.find(
    (item) => item?.candidate_id === candidateId || item?.id === candidateId,
  );
  if (!candidate) throw new Error(`Selected candidate ${String(candidateId)} was not found`);
  const recipe = candidate.lr_recipe;
  if (!recipe || typeof recipe !== "object") throw new Error("Selected candidate has no lr_recipe");
  return [...new Set([
    ...Object.keys(recipe.parameters ?? {}),
    ...Object.keys(recipe.dynamic_parameters ?? {}),
  ])].sort();
}

export async function assertCatalogCoverage(session, catalogPath = DEFAULT_CATALOG_PATH) {
  const catalog = await loadCanonicalCatalog(catalogPath);
  const keys = selectedRecipeKeys(session);
  const unknown = keys.filter((key) => !catalog.has(key));
  if (unknown.length > 0) {
    const error = new Error(`Recipe uses bridge-unknown parameters: ${unknown.join(", ")}`);
    error.code = "UNKNOWN_PARAMETER";
    error.unknown = unknown;
    throw error;
  }
  return { covered: keys, catalog_size: catalog.size };
}

async function main(argv) {
  const sessionIndex = argv.indexOf("--session");
  if (sessionIndex < 0 || !argv[sessionIndex + 1]) {
    throw new Error("Usage: node src/catalog-contract.mjs --session <GradeSession.json> [--catalog <ParameterCatalog.lua>]");
  }
  const catalogIndex = argv.indexOf("--catalog");
  const catalogPath = catalogIndex >= 0 ? path.resolve(argv[catalogIndex + 1]) : DEFAULT_CATALOG_PATH;
  const session = JSON.parse(await fs.readFile(path.resolve(argv[sessionIndex + 1]), "utf8"));
  const result = await assertCatalogCoverage(session, catalogPath);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.code ?? "CATALOG_CONTRACT_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
