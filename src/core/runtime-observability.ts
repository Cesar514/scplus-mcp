// Shared runtime observability snapshots for backend scheduler state reporting
// FEATURE: In-process metrics cache for doctor, logs, and operator status surfaces

import { resolve } from "path";

export interface BackendSchedulerObservability {
  watchEnabled: boolean;
  queueDepth: number;
  maxQueueDepth: number;
  batchCount: number;
  dedupedPathEvents: number;
  supersededJobs: number;
  canceledJobs: number;
  fullRebuildReasons: string[];
}

const MAX_FULL_REBUILD_REASONS = 5;
const schedulerSnapshots = new Map<string, BackendSchedulerObservability>();

function buildDefaultSchedulerObservability(): BackendSchedulerObservability {
  return {
    watchEnabled: false,
    queueDepth: 0,
    maxQueueDepth: 0,
    batchCount: 0,
    dedupedPathEvents: 0,
    supersededJobs: 0,
    canceledJobs: 0,
    fullRebuildReasons: [],
  };
}

export function getBackendSchedulerObservability(rootDir: string): BackendSchedulerObservability {
  const snapshot = schedulerSnapshots.get(resolve(rootDir)) ?? buildDefaultSchedulerObservability();
  return {
    ...snapshot,
    fullRebuildReasons: [...snapshot.fullRebuildReasons],
  };
}

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
    fullRebuildReasons: next.fullRebuildReasons.slice(-MAX_FULL_REBUILD_REASONS),
  };
  schedulerSnapshots.set(normalizedRootDir, normalized);
  return getBackendSchedulerObservability(normalizedRootDir);
}

export function resetBackendSchedulerObservability(rootDir?: string): void {
  if (!rootDir) {
    schedulerSnapshots.clear();
    return;
  }
  schedulerSnapshots.delete(resolve(rootDir));
}
