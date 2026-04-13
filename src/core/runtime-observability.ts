// summary: Captures shared runtime observability snapshots for backend scheduler reporting.
// FEATURE: In-process metrics cache for doctor, logs, and operator status surfaces.
// inputs: Scheduler events, job timing data, and backend runtime measurements.
// outputs: Cached observability snapshots for doctor, logs, and operator status surfaces.

import { resolve } from "path";

export interface BackendSchedulerObservability {
  watchEnabled: boolean;
  queueDepth: number;
  maxQueueDepth: number;
  batchCount: number;
  dedupedPathEvents: number;
  supersededJobs: number;
  canceledJobs: number;
  pendingChangeCount: number;
  pendingPaths: string[];
  pendingJobKind?: "index" | "refresh";
  fullRebuildReasons: string[];
}

const MAX_FULL_REBUILD_REASONS = 5;
const schedulerSnapshots = new Map<string, BackendSchedulerObservability>();

// Purpose: Construct the empty scheduler observability snapshot used for new repository roots.
// Inputs: No direct inputs beyond the default scheduler metric values encoded in this module.
// Returns/Effects: Returns a zeroed observability snapshot suitable for initialization.
function buildDefaultSchedulerObservability(): BackendSchedulerObservability {
  return {
    watchEnabled: false,
    queueDepth: 0,
    maxQueueDepth: 0,
    batchCount: 0,
    dedupedPathEvents: 0,
    supersededJobs: 0,
    canceledJobs: 0,
    pendingChangeCount: 0,
    pendingPaths: [],
    pendingJobKind: undefined,
    fullRebuildReasons: [],
  };
}

// Purpose: Read the current scheduler observability snapshot for a repository root.
// Inputs: The repository root whose cached scheduler metrics should be retrieved.
// Returns/Effects: Returns a defensive copy of the current observability snapshot for that root.
export function getBackendSchedulerObservability(rootDir: string): BackendSchedulerObservability {
  const snapshot = schedulerSnapshots.get(resolve(rootDir)) ?? buildDefaultSchedulerObservability();
  return {
    ...snapshot,
    pendingPaths: [...snapshot.pendingPaths],
    fullRebuildReasons: [...snapshot.fullRebuildReasons],
  };
}

// Purpose: Update the scheduler observability snapshot for a repository root with normalized bounds.
// Inputs: The repository root and an updater function that derives the next snapshot from the current one.
// Returns/Effects: Stores the normalized snapshot in memory and returns a defensive copy of it.
export function updateBackendSchedulerObservability(
  rootDir: string,
  updater: (current: BackendSchedulerObservability) => BackendSchedulerObservability,
): BackendSchedulerObservability {
  const normalizedRootDir = resolve(rootDir);
  const current = getBackendSchedulerObservability(normalizedRootDir);
  const next = updater(current);
  const normalized: BackendSchedulerObservability = {
    ...next,
    queueDepth: Math.max(0, next.queueDepth),
    maxQueueDepth: Math.max(next.maxQueueDepth, next.queueDepth),
    pendingChangeCount: Math.max(0, next.pendingChangeCount),
    pendingPaths: [...next.pendingPaths],
    fullRebuildReasons: next.fullRebuildReasons.slice(-MAX_FULL_REBUILD_REASONS),
  };
  schedulerSnapshots.set(normalizedRootDir, normalized);
  return getBackendSchedulerObservability(normalizedRootDir);
}

// Purpose: Clear cached scheduler observability for one repository root or for every root.
// Inputs: An optional repository root whose snapshot should be removed.
// Returns/Effects: Deletes one normalized snapshot or clears the entire in-memory cache.
export function resetBackendSchedulerObservability(rootDir?: string): void {
  if (!rootDir) {
    schedulerSnapshots.clear();
    return;
  }
  schedulerSnapshots.delete(resolve(rootDir));
}
