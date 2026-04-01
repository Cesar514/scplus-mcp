// Post-write index freshness management for checkpoint and restore flows
// FEATURE: Synchronous crash-only refresh after repository mutations

import { resolve } from "path";
import { DEFAULT_INDEX_MODE, type IndexMode, type ProjectIndexConfig } from "./index-contract.js";
import { indexCodebase } from "./index-codebase.js";
import { invalidateSearchCache } from "./semantic-search.js";
import { invalidateIdentifierSearchCache } from "./semantic-identifiers.js";
import { invalidateFastQueryCache } from "./exact-query.js";
import { loadIndexArtifact, loadIndexServingState, updateIndexServingFreshness, type IndexServingState } from "../core/index-database.js";

export interface RefreshPreparedIndexAfterWriteOptions {
  rootDir: string;
  relativePaths: string[];
  cause: "checkpoint" | "restore";
}

function formatAffectedPaths(relativePaths: string[]): string {
  const unique = Array.from(new Set(relativePaths.map((value) => value.trim()).filter(Boolean)));
  return unique.length > 0 ? unique.join(", ") : "(no files)";
}

async function resolveRefreshMode(rootDir: string): Promise<IndexMode> {
  const normalizedRootDir = resolve(rootDir);
  const serving = await loadIndexServingState(normalizedRootDir);
  if (serving.activeGeneration === 0) return DEFAULT_INDEX_MODE;
  const config = await loadIndexArtifact<ProjectIndexConfig>(normalizedRootDir, "project-config", () => {
    throw new Error("Prepared index is missing project-config for the active serving generation.");
  });
  return config.indexMode;
}

function formatBlockedReason(
  cause: RefreshPreparedIndexAfterWriteOptions["cause"],
  relativePaths: string[],
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Automatic ${cause} refresh failed for ${formatAffectedPaths(relativePaths)}: ${message}`;
}

export async function markPreparedIndexDirtyAfterWrite(
  rootDir: string,
  relativePaths: string[],
  cause: RefreshPreparedIndexAfterWriteOptions["cause"],
): Promise<IndexServingState> {
  return updateIndexServingFreshness(
    resolve(rootDir),
    "dirty",
    `${cause} changed ${formatAffectedPaths(relativePaths)}`,
  );
}

export async function refreshPreparedIndexAfterWrite(
  options: RefreshPreparedIndexAfterWriteOptions,
): Promise<{ mode: IndexMode; output: string }> {
  const normalizedRootDir = resolve(options.rootDir);
  invalidateSearchCache();
  invalidateIdentifierSearchCache();
  invalidateFastQueryCache(normalizedRootDir);
  await markPreparedIndexDirtyAfterWrite(normalizedRootDir, options.relativePaths, options.cause);

  try {
    const mode = await resolveRefreshMode(normalizedRootDir);
    const output = await indexCodebase({ rootDir: normalizedRootDir, mode });
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    invalidateFastQueryCache(normalizedRootDir);
    return { mode, output };
  } catch (error) {
    const blockedReason = formatBlockedReason(options.cause, options.relativePaths, error);
    await updateIndexServingFreshness(normalizedRootDir, "blocked", blockedReason);
    throw new Error(`${blockedReason}\nRun repair_index with target="full" after fixing the underlying indexing error.`);
  }
}

export async function formatPreparedIndexFreshnessHeader(rootDir: string): Promise<string> {
  const serving = await loadIndexServingState(resolve(rootDir));
  const parts = [
    `Index freshness: ${serving.activeGenerationFreshness}`,
    `Active generation: ${serving.activeGeneration}`,
  ];
  if (serving.pendingGeneration !== null) parts.push(`Pending generation: ${serving.pendingGeneration}`);
  if (serving.activeGenerationValidatedAt) parts.push(`Validated: ${serving.activeGenerationValidatedAt}`);
  if (serving.activeGenerationBlockedReason) parts.push(`Reason: ${serving.activeGenerationBlockedReason}`);
  return parts.join(" | ");
}
