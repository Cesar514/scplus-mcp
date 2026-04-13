// summary: Manages post-write freshness and synchronous refresh flows after repository mutations.
// FEATURE: Synchronous crash-only refresh after repository mutations.
// inputs: Changed file sets, refresh contracts, and active generation state.
// outputs: Freshness status updates, refresh executions, and blocked-state failures.

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

export interface WriteFreshnessRuntimeStats {
  refreshFailures: number;
  lastRefreshFailure?: {
    rootDir: string;
    cause: RefreshPreparedIndexAfterWriteOptions["cause"];
    paths: string[];
    reason: string;
    at: string;
  };
}

const rootMutationQueue = new Map<string, Promise<void>>();
let writeFreshnessRuntimeStats: WriteFreshnessRuntimeStats = {
  refreshFailures: 0,
};

// Purpose: Format the affected relative paths for user-facing freshness and failure messages.
// Inputs: The repository-relative paths touched by the current write operation.
// Returns/Effects: Returns a deduplicated comma-separated path summary string.
function formatAffectedPaths(relativePaths: string[]): string {
  const unique = Array.from(new Set(relativePaths.map((value) => value.trim()).filter(Boolean)));
  return unique.length > 0 ? unique.join(", ") : "(no files)";
}

// Purpose: Resolve the prepared-index mode that should be refreshed for the current repository root.
// Inputs: The repository root whose active generation and project config should be inspected.
// Returns/Effects: Returns the active prepared-index mode or the default mode when no generation is active.
async function resolveRefreshMode(rootDir: string): Promise<IndexMode> {
  const normalizedRootDir = resolve(rootDir);
  const serving = await loadIndexServingState(normalizedRootDir);
  if (serving.activeGeneration === 0) return DEFAULT_INDEX_MODE;
  const config = await loadIndexArtifact<ProjectIndexConfig>(normalizedRootDir, "project-config", () => {
    throw new Error("Prepared index is missing project-config for the active serving generation.");
  });
  return config.indexMode;
}

// Purpose: Build the blocked-state reason message for a failed post-write refresh attempt.
// Inputs: The write cause, affected paths, and underlying refresh error.
// Returns/Effects: Returns the formatted blocked-state explanation string.
function formatBlockedReason(
  cause: RefreshPreparedIndexAfterWriteOptions["cause"],
  relativePaths: string[],
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Automatic ${cause} refresh failed for ${formatAffectedPaths(relativePaths)}: ${message}`;
}

// Purpose: Serialize write mutations per repository root so refresh-sensitive writes never overlap.
// Inputs: The repository root plus the async mutation operation to run under serialization.
// Returns/Effects: Queues the operation behind prior root mutations and resolves with its result.
export async function runSerializedRootMutation<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const normalizedRootDir = resolve(rootDir);
  const previous = rootMutationQueue.get(normalizedRootDir) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  rootMutationQueue.set(normalizedRootDir, previous.catch(() => {}).then(() => current));
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (rootMutationQueue.get(normalizedRootDir) === current) {
      rootMutationQueue.delete(normalizedRootDir);
    }
  }
}

// Purpose: Mark the active prepared index as dirty after a repository write mutation.
// Inputs: The repository root, affected paths, and the write cause.
// Returns/Effects: Updates serving freshness state to dirty and returns the new serving snapshot.
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

// Purpose: Run the crash-only prepared-index refresh that follows a checkpoint or restore write.
// Inputs: The repository root, changed paths, and the write cause.
// Returns/Effects: Invalidates caches, marks freshness dirty, runs indexing, and returns refresh details.
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
    writeFreshnessRuntimeStats.refreshFailures++;
    writeFreshnessRuntimeStats.lastRefreshFailure = {
      rootDir: normalizedRootDir,
      cause: options.cause,
      paths: [...options.relativePaths],
      reason: blockedReason,
      at: new Date().toISOString(),
    };
    await updateIndexServingFreshness(normalizedRootDir, "blocked", blockedReason);
    throw new Error(`${blockedReason}\nRun repair_index with target="full" after fixing the underlying indexing error.`);
  }
}

// Purpose: Return a defensive snapshot of runtime stats for post-write freshness handling.
// Inputs: No direct inputs beyond the module-level freshness runtime state.
// Returns/Effects: Returns a cloned runtime-stats object safe for callers to inspect.
export function getWriteFreshnessRuntimeStats(): WriteFreshnessRuntimeStats {
  return {
    refreshFailures: writeFreshnessRuntimeStats.refreshFailures,
    lastRefreshFailure: writeFreshnessRuntimeStats.lastRefreshFailure
      ? {
        ...writeFreshnessRuntimeStats.lastRefreshFailure,
        paths: [...writeFreshnessRuntimeStats.lastRefreshFailure.paths],
      }
      : undefined,
  };
}

// Purpose: Reset the post-write freshness runtime stats to their initial zeroed state.
// Inputs: No direct inputs beyond the module-level freshness runtime state.
// Returns/Effects: Reinitializes the runtime stats object.
export function resetWriteFreshnessRuntimeStats(): void {
  writeFreshnessRuntimeStats = {
    refreshFailures: 0,
  };
}

// Purpose: Format the operator-facing freshness banner for the current prepared index serving state.
// Inputs: The repository root whose serving state should be summarized.
// Returns/Effects: Returns the human-readable freshness header text.
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
