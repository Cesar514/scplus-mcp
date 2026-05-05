// summary: Implements the per-root backend session that owns watch queues and indexing jobs.
// FEATURE: Session-scoped backend execution for manual index, refresh, cluster, and watcher flows.
// inputs: Repository roots, backend event sink functions, watch changes, and index job requests.
// outputs: Per-root backend events, queue state updates, and manual or watch-triggered job execution.

import { acquireRepoRuntimeLock, type RepoRuntimeLockHandle } from "../core/runtime-locks.js";
import { updateIndexServingFreshness } from "../core/index-database.js";
import { refreshEmbeddingsForChangedPaths } from "../core/embedding-tracker.js";
import { resetBackendSchedulerObservability, updateBackendSchedulerObservability } from "../core/runtime-observability.js";
import { semanticNavigate } from "../tools/semantic-navigate.js";
import { DEFAULT_INDEX_MODE, type IndexMode } from "../tools/index-contract.js";
import { ensureFullIndexArtifacts } from "../tools/full-index-artifacts.js";
import { indexCodebase } from "../tools/index-codebase.js";
import { ensureIdentifierSearchIndex } from "../tools/semantic-identifiers.js";
import { ensureFileSearchIndex } from "../tools/semantic-search.js";
import { validatePreparedIndex } from "../tools/index-reliability.js";
import {
  buildWatchExecutionPlan,
  dedupePaths,
  formatIntegrityObservabilitySummary,
  formatSchedulerObservabilitySummary,
  formatStageObservabilitySummary,
  summarizeChangedPaths,
  type WatchExecutionPlan,
} from "./backend-core-helpers.js";
import {
  createBackendBoundedScanner,
  type BackendBoundedScannerController,
  type BackendScannerSnapshot,
} from "./backend-scan-state.js";
import { buildDoctorReport } from "./reports.js";
import {
  calculatePercentComplete,
  type BackendEvent,
  type BackendJobControlAction,
  type EventSink,
  firstNonEmptyLine,
  formatFileProgress,
  formatFullProgress,
  formatIdentifierProgress,
  type JobControlPayload,
  type ManualIndexMode,
  scaleRefreshPercent,
  type TextPayload,
  toErrorMessage,
  type WatchStatePayload,
} from "./backend-core-shared.js";

const DEFAULT_WATCH_MAX_PENDING_PATHS = 5000;
const DEFAULT_WATCH_EVENT_PATH_SAMPLE = 100;

// Purpose: Parse a positive integer environment budget for watch queue behavior.
// Inputs: Environment variable name plus the default used when it is absent.
// Returns/Effects: Returns a positive integer or throws for invalid configured values.
function parseWatchBudget(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim() || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set; received ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

export class BackendRootSession {
  private debounceTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly pendingPaths = new Set<string>();
  private scanner: BackendBoundedScannerController | null = null;
  private watchEnabled = false;
  private watchDebounceMs = 1200;
  private activeJob: "cluster" | "index" | "refresh" | null = null;
  private queuedWatchPlan: WatchExecutionPlan | null = null;
  private closed = false;
  private scanRunning = false;
  private dedupedPathEvents = 0;
  private batchCount = 0;
  private supersededJobs = 0;
  private canceledJobs = 0;
  private lastWatchBatch: string[] = [];
  private lastIndexMode: ManualIndexMode = "auto";
  private watchLock: RepoRuntimeLockHandle | null = null;
  private pendingOverflowReason: string | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly emitEvent: EventSink,
  ) { }

  // Purpose: Enable or disable the repository watcher and emit the resulting watch state snapshot.
  // Inputs: The desired enabled state plus an optional debounce override for the watcher.
  // Returns/Effects: Starts or stops watcher resources, emits watch-state events, and returns the new state payload.
  async setWatchEnabled(enabled: boolean, debounceMs?: number): Promise<WatchStatePayload> {
    this.assertOpen();
    if (enabled) {
      if (!this.watchEnabled) await this.startWatcher(debounceMs);
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: true,
        queueDepth: this.getQueueDepth(),
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        ...this.buildScannerEventFields(),
        message: "watcher enabled",
      });
      return { root: this.rootDir, enabled: true };
    }

    if (this.watchEnabled) {
      await this.stopWatcher();
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: false,
        queueDepth: this.getQueueDepth(),
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        ...this.buildScannerEventFields(),
        message: "watcher disabled",
      });
    }
    return { root: this.rootDir, enabled: false };
  }

  // Purpose: Run the next manual prepared-index operation using either a full rebuild or incremental refresh.
  // Inputs: An optional manual index mode that selects auto, full, or refresh behavior.
  // Returns/Effects: Launches the selected backend job and resolves with its human-readable summary output.
  async runManualIndex(mode: ManualIndexMode = "auto"): Promise<string> {
    this.assertOpen();
    if (this.activeJob) {
      throw new Error(`Backend job already running for ${this.rootDir}.`);
    }
    this.lastIndexMode = mode;
    if (mode !== "auto") {
      return this.runIndex(mode, "manual");
    }
    if (!await this.hasValidPreparedFullIndex()) {
      return this.runIndex(DEFAULT_INDEX_MODE, "manual", "manual bootstrap rebuild because no valid prepared index exists yet");
    }
    return this.runRefresh({
      job: "refresh",
      mode: DEFAULT_INDEX_MODE,
      changedPaths: [],
      reason: "manual incremental refresh using the existing prepared index",
    }, "manual");
  }

  // Purpose: Refresh cluster-oriented prepared-index artifacts and return the rendered semantic cluster report.
  // Inputs: No direct inputs beyond the session root and configured backend event sink.
  // Returns/Effects: Emits cluster job progress events, refreshes search artifacts, and returns rendered cluster text.
  async runManualCluster(): Promise<TextPayload> {
    this.assertOpen();
    if (this.activeJob) {
      throw new Error(`Backend job already running for ${this.rootDir}.`);
    }
    const mutationLock = await this.acquireMutationLock("bridge manual cluster refresh");
    this.activeJob = "cluster";
    await this.emit({
      kind: "job",
      root: this.rootDir,
      job: "cluster",
      state: "running",
      mode: DEFAULT_INDEX_MODE,
      phase: "cluster-scan",
      source: "manual",
      queueDepth: this.getQueueDepth(),
      pending: this.queuedWatchPlan !== null,
      pendingPaths: this.getCurrentPendingPaths(),
      pendingChangeCount: this.getCurrentPendingPaths().length,
      pendingJobKind: this.queuedWatchPlan?.job,
      message: "running semantic cluster refresh",
    });
    try {
      await ensureFileSearchIndex(this.rootDir, async (progress) => {
        await this.emit({
          kind: "job",
          root: this.rootDir,
          job: "cluster",
          state: "progress",
          mode: DEFAULT_INDEX_MODE,
          phase: progress.phase,
          source: "manual",
          queueDepth: this.getQueueDepth(),
          pending: this.queuedWatchPlan !== null,
          message: formatFileProgress(progress),
          processedItems: progress.processedFiles,
          totalItems: progress.totalFiles,
          percentComplete: scaleRefreshPercent(0, 3, calculatePercentComplete(progress.processedFiles, progress.totalFiles)),
          currentFile: progress.currentFile,
          pendingPaths: this.getCurrentPendingPaths(),
          pendingChangeCount: this.getCurrentPendingPaths().length,
          pendingJobKind: this.queuedWatchPlan?.job,
        });
      });
      await ensureIdentifierSearchIndex(this.rootDir, async (progress) => {
        await this.emit({
          kind: "job",
          root: this.rootDir,
          job: "cluster",
          state: "progress",
          mode: DEFAULT_INDEX_MODE,
          phase: progress.phase,
          source: "manual",
          queueDepth: this.getQueueDepth(),
          pending: this.queuedWatchPlan !== null,
          message: formatIdentifierProgress(progress),
          processedItems: progress.processedFiles,
          totalItems: progress.totalFiles,
          percentComplete: scaleRefreshPercent(1, 3, calculatePercentComplete(progress.processedFiles, progress.totalFiles)),
          currentFile: progress.currentFile,
          pendingPaths: this.getCurrentPendingPaths(),
          pendingChangeCount: this.getCurrentPendingPaths().length,
          pendingJobKind: this.queuedWatchPlan?.job,
        });
      });
      await ensureFullIndexArtifacts({ rootDir: this.rootDir }, async (progress) => {
        await this.emit({
          kind: "job",
          root: this.rootDir,
          job: "cluster",
          state: "progress",
          mode: DEFAULT_INDEX_MODE,
          phase: progress.phase,
          source: "manual",
          queueDepth: this.getQueueDepth(),
          pending: this.queuedWatchPlan !== null,
          message: formatFullProgress(progress),
          processedItems: progress.processedFiles,
          totalItems: progress.totalFiles,
          percentComplete: scaleRefreshPercent(2, 3, calculatePercentComplete(progress.processedFiles, progress.totalFiles)),
          currentFile: progress.currentFile,
          pendingPaths: this.getCurrentPendingPaths(),
          pendingChangeCount: this.getCurrentPendingPaths().length,
          pendingJobKind: this.queuedWatchPlan?.job,
        });
      });
      const rendered = await semanticNavigate({
        rootDir: this.rootDir,
        maxDepth: 3,
        maxClusters: 20,
      });
      const summary = "semantic cluster refresh completed";
      this.emitLog(summary);
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "cluster",
        state: "completed",
        mode: DEFAULT_INDEX_MODE,
        phase: "completed",
        source: "manual",
        queueDepth: this.getQueueDepth(),
        pending: this.queuedWatchPlan !== null,
        percentComplete: 100,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message: summary,
      });
      return { root: this.rootDir, text: rendered };
    } catch (error) {
      const message = toErrorMessage(error);
      this.emitLog(message, "error");
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "cluster",
        state: "failed",
        mode: DEFAULT_INDEX_MODE,
        phase: "failed",
        source: "manual",
        queueDepth: this.getQueueDepth(),
        pending: this.queuedWatchPlan !== null,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message,
      });
      throw error;
    } finally {
      this.activeJob = null;
      this.syncSchedulerObservability();
      await mutationLock.release();
    }
  }

  // Purpose: Cancel any queued or pending watch-triggered backend job before it starts running.
  // Inputs: No direct inputs beyond the current session queue and pending watch paths.
  // Returns/Effects: Clears pending watch work, emits cancellation events when needed, and returns queue state details.
  async cancelPendingJob(): Promise<JobControlPayload> {
    this.assertOpen();
    const pendingPaths = this.getLatestPendingPaths();
    const hadQueuedIndex = this.queuedWatchPlan !== null;
    const hadPendingPaths = this.pendingPaths.size > 0 || this.pendingOverflowReason !== null;
    if (!hadQueuedIndex && !hadPendingPaths) {
      throw new Error(`No pending watch job exists for ${this.rootDir}.`);
    }
    this.clearDebounceTimer();
    this.pendingPaths.clear();
    this.pendingOverflowReason = null;
    const canceledPlan = this.queuedWatchPlan;
    this.queuedWatchPlan = null;
    this.lastWatchBatch = pendingPaths;
    this.canceledJobs++;
    this.syncSchedulerObservability();
    const message = hadQueuedIndex
      ? `canceled queued watch ${canceledPlan?.job ?? "job"} for ${summarizeChangedPaths(pendingPaths)}`
      : `canceled pending watch batch before queueing: ${summarizeChangedPaths(pendingPaths)}`;
    this.emitLog(message);
    if (canceledPlan) {
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: canceledPlan.job,
        state: "canceled",
        mode: DEFAULT_INDEX_MODE,
        phase: "queued",
        source: "watch",
        queueDepth: this.getQueueDepth(),
        rebuildReason: canceledPlan.reason,
        pending: false,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: undefined,
        message,
      });
    }
    return this.buildJobControlPayload("cancel-pending", message);
  }

  // Purpose: Replace stale pending watch work with a fresh plan built from the latest file changes.
  // Inputs: No direct inputs beyond the active job state and accumulated pending watch paths.
  // Returns/Effects: Cancels older queued work, queues or launches the newest watch plan, and returns control metadata.
  async supersedePendingJob(): Promise<JobControlPayload> {
    this.assertOpen();
    const pendingPaths = this.getLatestPendingPaths();
    const overflowReason = this.pendingOverflowReason;
    if (pendingPaths.length === 0 && !overflowReason) {
      throw new Error(`No pending watch work exists for ${this.rootDir}.`);
    }
    this.clearDebounceTimer();
    this.pendingPaths.clear();
    this.pendingOverflowReason = null;
    this.lastWatchBatch = pendingPaths;
    this.supersededJobs++;
    this.canceledJobs++;
    if (this.activeJob) {
      const priorPlan = this.queuedWatchPlan;
      const nextPlan = overflowReason
        ? this.buildWatchPlan([], overflowReason)
        : buildWatchExecutionPlan(priorPlan ? dedupePaths([...priorPlan.changedPaths, ...pendingPaths]) : pendingPaths);
      this.queuedWatchPlan = nextPlan;
      this.syncSchedulerObservability();
      if (priorPlan) {
        await this.emit({
          kind: "job",
          root: this.rootDir,
          job: priorPlan.job,
          state: "canceled",
          mode: priorPlan.mode,
          phase: "queued",
          source: "watch",
          queueDepth: this.getQueueDepth(),
          rebuildReason: priorPlan.reason,
          pending: false,
          pendingPaths: this.getCurrentPendingPaths(),
          pendingChangeCount: this.getCurrentPendingPaths().length,
          pendingJobKind: nextPlan.job,
          ...this.buildScannerEventFields(),
          message: `canceled stale queued watch ${priorPlan.job}`,
        });
      }
      const message = `superseded stale queued watch ${nextPlan.job} with latest changes: ${summarizeChangedPaths(nextPlan.changedPaths)}`;
      this.emitLog(message);
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: nextPlan.job,
        state: "queued",
        mode: nextPlan.mode,
        phase: "queued",
        source: "watch",
        queueDepth: this.getQueueDepth(),
        rebuildReason: nextPlan.reason,
        pending: true,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: nextPlan.job,
        ...this.buildScannerEventFields(),
        message,
      });
      return this.buildJobControlPayload("supersede-pending", message);
    }

    this.syncSchedulerObservability();
    const nextPlan = this.buildWatchPlan(pendingPaths, overflowReason);
    const message = `superseded pending watch batch and started a fresh ${nextPlan.job}: ${summarizeChangedPaths(nextPlan.changedPaths)}`;
    this.emitLog(message);
    void this.runWatchPlan(nextPlan);
    return this.buildJobControlPayload("supersede-pending", message);
  }

  // Purpose: Re-run the last manual prepared-index operation using the session's most recent mode.
  // Inputs: No direct inputs beyond the stored last manual index mode.
  // Returns/Effects: Starts the remembered manual index flow and returns control metadata after it begins.
  async retryLastIndex(): Promise<JobControlPayload> {
    this.assertOpen();
    if (this.activeJob) {
      throw new Error(`Cannot retry index for ${this.rootDir} while another run is active.`);
    }
    const mode = this.lastIndexMode;
    this.emitLog(`retrying last prepared-index sync with ${mode} strategy`);
    await this.runManualIndex(mode);
    return this.buildJobControlPayload("retry-last", `retried last prepared-index sync with ${mode} strategy`);
  }

  // Purpose: Close the session and release any watcher resources or observability state it owns.
  // Inputs: No direct inputs beyond the session lifecycle state.
  // Returns/Effects: Stops active watcher resources, marks the session closed, and clears scheduler observability.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopWatcher();
    resetBackendSchedulerObservability(this.rootDir);
  }

  // Purpose: Guard public session operations from running after the session has been closed.
  // Inputs: No direct inputs beyond the session closed flag.
  // Returns/Effects: Throws when callers try to operate on a closed backend session.
  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Backend session for ${this.rootDir} is closed.`);
    }
  }

  // Purpose: Forward backend events to the configured sink while containing sink failures inside the session.
  // Inputs: A backend event payload ready to be delivered to the shared event sink.
  // Returns/Effects: Awaits sink delivery and logs sink failures instead of crashing the current flow.
  private async emit(event: BackendEvent): Promise<void> {
    try {
      await this.emitEvent(event);
    } catch (error) {
      console.error("Backend event sink failed:", error);
    }
  }

  // Purpose: Check whether the repository currently has a valid prepared full index available for incremental work.
  // Inputs: No direct inputs beyond the session root directory and default prepared-index mode.
  // Returns/Effects: Returns true when validation succeeds and false when validation fails or throws.
  private async hasValidPreparedFullIndex(): Promise<boolean> {
    try {
      const report = await validatePreparedIndex({ rootDir: this.rootDir, mode: DEFAULT_INDEX_MODE });
      return report.ok;
    } catch {
      return false;
    }
  }

  // Purpose: Emit a structured backend log event tied to the current queue depth and root.
  // Inputs: A log message plus an optional severity level.
  // Returns/Effects: Queues a log event for observers without blocking the caller on event delivery.
  private emitLog(message: string, level: "error" | "info" = "info"): void {
    void this.emit({
      kind: "log",
      root: this.rootDir,
      message,
      level,
      queueDepth: this.getQueueDepth(),
    });
  }

  // Purpose: Acquire the repository mutation lock required for index, refresh, and cluster operations.
  // Inputs: A human-readable lock holder label describing the current backend operation.
  // Returns/Effects: Returns the acquired lock handle and emits error logs when contention occurs.
  private async acquireMutationLock(holder: string): Promise<RepoRuntimeLockHandle> {
    return acquireRepoRuntimeLock(this.rootDir, "mutation", {
      holder,
      timeoutMs: 0,
      allowTakeover: true,
      onBusy: async (owner) => {
        this.emitLog(`waiting blocked by ${owner.holder} in pid ${owner.pid} since ${owner.startedAt}`, "error");
      },
      onTakeover: async (owner) => {
        this.emitLog(`terminating competing scplus mutation owner ${owner.holder} in pid ${owner.pid}`, "error");
      },
    });
  }

  // Purpose: Stop any active debounce timer before queue state changes or watcher shutdown.
  // Inputs: No direct inputs beyond the current debounce timer handle.
  // Returns/Effects: Clears the timer and resets the stored handle to null.
  private clearDebounceTimer(): void {
    if (!this.debounceTimer) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  // Purpose: Report the newest pending watch paths, falling back to the most recent flushed watch batch when needed.
  // Inputs: No direct inputs beyond pending queue state and the last watch batch snapshot.
  // Returns/Effects: Returns a deduplicated list of paths representing the latest queued or just-flushed watch work.
  private getLatestPendingPaths(): string[] {
    const currentPending = this.getCurrentPendingPaths();
    if (currentPending.length > 0) return currentPending;
    return [...this.lastWatchBatch];
  }

  // Purpose: Build the current deduplicated watch pending-path list from queued and buffered changes.
  // Inputs: No direct inputs beyond the pending path set and any queued watch plan.
  // Returns/Effects: Returns the current set of pending watch paths in stable deduplicated form.
  private getCurrentPendingPaths(): string[] {
    return dedupePaths([
      ...this.pendingPaths,
      ...(this.queuedWatchPlan?.changedPaths ?? []),
    ]);
  }

  // Purpose: Assemble the response payload for queue-control commands such as cancel, supersede, and retry.
  // Inputs: The control action identifier and the human-readable message describing the queue change.
  // Returns/Effects: Returns a snapshot of queue, mode, and pending-path state for the caller.
  private buildJobControlPayload(action: BackendJobControlAction, message: string): JobControlPayload {
    const pendingPaths = this.getLatestPendingPaths();
    const pendingJobKind = this.queuedWatchPlan?.job
      ?? (this.pendingOverflowReason ? "index" : undefined)
      ?? (this.pendingPaths.size > 0 ? buildWatchExecutionPlan(Array.from(this.pendingPaths)).job : undefined);
    return {
      root: this.rootDir,
      action,
      message,
      queueDepth: this.getQueueDepth(),
      indexRunning: this.activeJob !== null,
      queued: this.queuedWatchPlan !== null || this.pendingPaths.size > 0,
      pendingPaths,
      pendingJobKind,
      lastWatchBatch: [...this.lastWatchBatch],
      lastMode: this.lastIndexMode,
    };
  }

  private getQueueDepth(): number {
    return this.pendingPaths.size > 0 || this.pendingOverflowReason || this.queuedWatchPlan ? 1 : 0;
  }

  // Purpose: Return the latest scanner snapshot or a disabled placeholder for event payloads.
  // Inputs: No direct inputs beyond the optional active scanner instance.
  // Returns/Effects: Returns scanner diagnostics without mutating scanner state.
  private getScannerSnapshot(): BackendScannerSnapshot {
    return this.scanner?.snapshot() ?? {
      status: "disabled",
      nativeWatchCount: 0,
      directoryQueueSize: 0,
      fileQueueSize: 0,
      knownDirectoryCount: 0,
      knownFileCount: 0,
      scanGeneration: 0,
      budgets: {
        maxDirsPerTick: 0,
        maxFilesPerTick: 0,
        maxMsPerTick: 0,
        statConcurrency: 0,
        rescanIntervalMs: 0,
      },
    };
  }

  // Purpose: Build scanner diagnostics shared by watch-state, watch-batch, and job events.
  // Inputs: No direct inputs beyond the active scanner snapshot.
  // Returns/Effects: Returns flattened optional event fields for backend consumers.
  private buildScannerEventFields(): Partial<BackendEvent> {
    const scanner = this.getScannerSnapshot();
    return {
      scannerStatus: scanner.status,
      nativeWatchCount: scanner.nativeWatchCount,
      scannerDirectoryQueueSize: scanner.directoryQueueSize,
      scannerFileQueueSize: scanner.fileQueueSize,
      scannerKnownDirectoryCount: scanner.knownDirectoryCount,
      scannerKnownFileCount: scanner.knownFileCount,
      scannerGeneration: scanner.scanGeneration,
      scannerLastFullCoverageAt: scanner.lastFullCoverageAt,
      scannerLastFailure: scanner.lastScanFailure,
      scannerLastOverflowReason: scanner.lastOverflowReason,
    };
  }

  // Purpose: Build bounded changed-path fields for events that may represent huge file batches.
  // Inputs: The complete changed-path list for the batch.
  // Returns/Effects: Returns a sample plus total count and truncation metadata.
  private buildChangedPathEventFields(
    changedPaths: string[],
  ): Pick<BackendEvent, "changedPaths" | "changedPathsTruncated" | "totalChangedPathCount"> {
    const sampleSize = parseWatchBudget("SCPLUS_WATCH_EVENT_PATH_SAMPLE", DEFAULT_WATCH_EVENT_PATH_SAMPLE);
    return {
      changedPaths: changedPaths.slice(0, sampleSize),
      changedPathsTruncated: changedPaths.length > sampleSize,
      totalChangedPathCount: changedPaths.length,
    };
  }

  // Purpose: Build a watch plan for normal or overflowed pending changes.
  // Inputs: The changed paths collected for the batch and any pending overflow reason.
  // Returns/Effects: Returns a refresh or full-index plan with explicit overflow escalation.
  private buildWatchPlan(changedPaths: string[], overflowReason: string | null): WatchExecutionPlan {
    if (!overflowReason) return buildWatchExecutionPlan(changedPaths);
    return {
      job: "index",
      mode: DEFAULT_INDEX_MODE,
      changedPaths: [],
      reason: overflowReason,
    };
  }

  // Purpose: Push the latest watcher and queue counters into backend scheduler observability state.
  // Inputs: No direct inputs beyond the current session queue, watcher flags, and scheduler counters.
  // Returns/Effects: Updates the shared scheduler observability record for this repository root.
  private syncSchedulerObservability(): void {
    const pendingPaths = this.getCurrentPendingPaths();
    const pendingJobKind = this.queuedWatchPlan?.job
      ?? (this.pendingOverflowReason ? "index" : undefined)
      ?? (pendingPaths.length > 0 ? buildWatchExecutionPlan(pendingPaths).job : undefined);
    const scanner = this.getScannerSnapshot();
    updateBackendSchedulerObservability(this.rootDir, (current) => ({
      ...current,
      watchEnabled: this.watchEnabled,
      scannerStatus: scanner.status,
      nativeWatchCount: scanner.nativeWatchCount,
      scannerDirectoryQueueSize: scanner.directoryQueueSize,
      scannerFileQueueSize: scanner.fileQueueSize,
      scannerKnownDirectoryCount: scanner.knownDirectoryCount,
      scannerKnownFileCount: scanner.knownFileCount,
      scannerGeneration: scanner.scanGeneration,
      scannerLastFullCoverageAt: scanner.lastFullCoverageAt,
      scannerLastFailure: scanner.lastScanFailure,
      scannerLastOverflowReason: scanner.lastOverflowReason,
      queueDepth: this.getQueueDepth(),
      maxQueueDepth: Math.max(current.maxQueueDepth, this.getQueueDepth()),
      batchCount: this.batchCount,
      dedupedPathEvents: this.dedupedPathEvents,
      supersededJobs: this.supersededJobs,
      canceledJobs: this.canceledJobs,
      pendingChangeCount: pendingPaths.length,
      pendingPaths,
      pendingJobKind,
    }));
  }

  // Purpose: Record a new full-rebuild reason in scheduler observability for later diagnostics.
  // Inputs: The human-readable reason describing why a full rebuild was required.
  // Returns/Effects: Appends the rebuild reason to the shared scheduler observability record.
  private recordFullRebuildReason(reason: string): void {
    const pendingPaths = this.getCurrentPendingPaths();
    const pendingJobKind = this.queuedWatchPlan?.job
      ?? (this.pendingOverflowReason ? "index" : undefined)
      ?? (pendingPaths.length > 0 ? buildWatchExecutionPlan(pendingPaths).job : undefined);
    const scanner = this.getScannerSnapshot();
    updateBackendSchedulerObservability(this.rootDir, (current) => ({
      ...current,
      watchEnabled: this.watchEnabled,
      scannerStatus: scanner.status,
      nativeWatchCount: scanner.nativeWatchCount,
      scannerDirectoryQueueSize: scanner.directoryQueueSize,
      scannerFileQueueSize: scanner.fileQueueSize,
      scannerKnownDirectoryCount: scanner.knownDirectoryCount,
      scannerKnownFileCount: scanner.knownFileCount,
      scannerGeneration: scanner.scanGeneration,
      scannerLastFullCoverageAt: scanner.lastFullCoverageAt,
      scannerLastFailure: scanner.lastScanFailure,
      scannerLastOverflowReason: scanner.lastOverflowReason,
      queueDepth: this.getQueueDepth(),
      maxQueueDepth: Math.max(current.maxQueueDepth, this.getQueueDepth()),
      batchCount: this.batchCount,
      dedupedPathEvents: this.dedupedPathEvents,
      supersededJobs: this.supersededJobs,
      canceledJobs: this.canceledJobs,
      pendingChangeCount: pendingPaths.length,
      pendingPaths,
      pendingJobKind,
      fullRebuildReasons: [...current.fullRebuildReasons, reason],
    }));
  }

  // Purpose: Add a changed path to the pending watch buffer while tracking caps and deduplication.
  // Inputs: A normalized repository-relative path detected as changed by the bounded scanner.
  // Returns/Effects: Updates pending state or records an overflow that forces a full rebuild.
  private async trackPendingPath(path: string): Promise<void> {
    if (this.pendingOverflowReason) {
      this.dedupedPathEvents++;
      return;
    }
    if (this.pendingPaths.has(path)) {
      this.dedupedPathEvents++;
    }
    const maxPendingPaths = parseWatchBudget("SCPLUS_WATCH_MAX_PENDING_PATHS", DEFAULT_WATCH_MAX_PENDING_PATHS);
    if (!this.pendingPaths.has(path) && this.pendingPaths.size + 1 > maxPendingPaths) {
      const reason = `watch pending path overflow: cap=${maxPendingPaths}, observedAtLeast=${this.pendingPaths.size + 1}; full rebuild required`;
      this.pendingPaths.clear();
      this.pendingOverflowReason = reason;
      this.emitLog(reason, "error");
      await this.scanner?.recordOverflow(reason);
      await updateIndexServingFreshness(this.rootDir, "dirty", reason);
      this.syncSchedulerObservability();
      return;
    }
    this.pendingPaths.add(path);
    this.syncSchedulerObservability();
  }

  // Purpose: Start bounded backend-owned scanning for the repository and persist its initial cursor.
  // Inputs: An optional debounce override used to tune watch batch timing.
  // Returns/Effects: Acquires the watcher lock, initializes scanner state, and schedules bounded scan ticks.
  private async startWatcher(debounceMs?: number): Promise<void> {
    if (this.watchEnabled) return;
    this.watchDebounceMs = debounceMs ?? this.watchDebounceMs;
    this.watchLock = await acquireRepoRuntimeLock(this.rootDir, "watcher", {
      holder: "bridge watcher",
      timeoutMs: 0,
      allowTakeover: true,
      onTakeover: async (owner) => {
        this.emitLog(`terminating competing scplus watcher owner ${owner.holder} in pid ${owner.pid}`, "error");
      },
    });
    try {
      this.scanner = await createBackendBoundedScanner(this.rootDir);
    } catch (error) {
      this.emitLog(`watcher failed: ${toErrorMessage(error)}`, "error");
      await this.stopWatcher();
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: false,
        queueDepth: this.getQueueDepth(),
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        ...this.buildScannerEventFields(),
        message: `watcher failed: ${toErrorMessage(error)}`,
      });
      throw error;
    }
    this.watchEnabled = true;
    this.syncSchedulerObservability();
    await this.scanForChanges();
    const pollMs = Math.max(250, Math.min(this.watchDebounceMs, this.getScannerSnapshot().budgets.rescanIntervalMs));
    this.scanTimer = setInterval(() => {
      void this.scanForChanges();
    }, pollMs);
    this.scanTimer.unref?.();
  }

  // Purpose: Stop polling-based watch scanning and release all watcher-owned resources.
  // Inputs: No direct inputs beyond the session watcher state and timer handles.
  // Returns/Effects: Clears timers, resets watch queues and snapshots, updates observability, and releases the watcher lock.
  private async stopWatcher(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.pendingPaths.clear();
    this.pendingOverflowReason = null;
    this.queuedWatchPlan = null;
    this.scanner = null;
    this.scanRunning = false;
    this.watchEnabled = false;
    this.syncSchedulerObservability();
    const watchLock = this.watchLock;
    this.watchLock = null;
    if (watchLock) {
      await watchLock.release();
    }
  }

  // Purpose: Restart the debounce window used to batch watch-triggered file changes into one job plan.
  // Inputs: No direct inputs beyond the current debounce interval and timer handle.
  // Returns/Effects: Schedules a deferred batch flush and replaces any prior pending debounce timer.
  private resetWatchDebounce(): void {
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushWatchBatch();
    }, this.watchDebounceMs);
    this.debounceTimer.unref?.();
  }

  // Purpose: Convert the buffered watch changes into a batch event and either queue or launch the resulting plan.
  // Inputs: No direct inputs beyond the buffered pending paths and any currently active backend job.
  // Returns/Effects: Emits a watch-batch event, updates queue state, and starts or queues the next watch plan.
  private async flushWatchBatch(): Promise<void> {
    if (this.pendingPaths.size === 0 && !this.pendingOverflowReason) return;
    const changedPaths = Array.from(this.pendingPaths).sort();
    const overflowReason = this.pendingOverflowReason;
    this.pendingPaths.clear();
    this.pendingOverflowReason = null;
    this.lastWatchBatch = changedPaths;
    this.batchCount++;
    const plan = this.buildWatchPlan(changedPaths, overflowReason);
    this.syncSchedulerObservability();
    await this.emit({
      kind: "watch-batch",
      root: this.rootDir,
      ...this.buildChangedPathEventFields(changedPaths),
      queueDepth: this.getQueueDepth(),
      pendingPaths: this.getCurrentPendingPaths(),
      pendingChangeCount: this.getCurrentPendingPaths().length,
      pendingJobKind: this.queuedWatchPlan?.job ?? (this.activeJob ? plan.job : undefined),
      rebuildReason: overflowReason ?? undefined,
      ...this.buildScannerEventFields(),
      message: overflowReason ?? `detected changes: ${summarizeChangedPaths(changedPaths)}`,
    });
    if (this.activeJob) {
      const priorPlan = this.queuedWatchPlan;
      const nextPlan = overflowReason
        ? this.buildWatchPlan([], overflowReason)
        : buildWatchExecutionPlan(priorPlan ? dedupePaths([...priorPlan.changedPaths, ...changedPaths]) : changedPaths);
      if (priorPlan) {
        this.supersededJobs++;
        this.canceledJobs++;
        await this.emit({
          kind: "job",
          root: this.rootDir,
          job: priorPlan.job,
          state: "canceled",
          mode: priorPlan.mode,
          phase: "queued",
          source: "watch",
          queueDepth: this.getQueueDepth(),
          rebuildReason: priorPlan.reason,
          pending: false,
          pendingPaths: this.getCurrentPendingPaths(),
          pendingChangeCount: this.getCurrentPendingPaths().length,
          pendingJobKind: nextPlan.job,
          ...this.buildScannerEventFields(),
          message: `canceled stale queued watch ${priorPlan.job}`,
        });
      }
      this.queuedWatchPlan = nextPlan;
      this.syncSchedulerObservability();
      const queuedMessage = nextPlan.job === "refresh"
        ? "queued background refresh because another backend job is already running"
        : "queued full rebuild because another backend job is already running";
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: nextPlan.job,
        state: "queued",
        mode: nextPlan.mode,
        phase: "queued",
        source: "watch",
        pending: true,
        queueDepth: this.getQueueDepth(),
        rebuildReason: nextPlan.reason,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: nextPlan.job,
        ...this.buildScannerEventFields(),
        message: queuedMessage,
      });
      this.emitLog(`${queuedMessage}: ${summarizeChangedPaths(nextPlan.changedPaths)}`);
      return;
    }
    void this.runWatchPlan(plan);
  }

  // Purpose: Execute a queued watch plan by dispatching it to refresh or full-index handling.
  // Inputs: The watch execution plan that was built from recent file changes.
  // Returns/Effects: Runs the appropriate backend job and relies on emitted events to surface failures.
  private async runWatchPlan(plan: WatchExecutionPlan): Promise<void> {
    try {
      if (plan.job === "refresh") {
        await this.runRefresh(plan);
        return;
      }
      await this.runIndex(plan.mode, "watch", plan.reason);
    } catch {
      // The failure is surfaced through explicit job and log events.
    }
  }

  // Purpose: Run one bounded scanner tick and queue any changed paths for batched processing.
  // Inputs: No direct inputs beyond watcher state and the active bounded scanner.
  // Returns/Effects: Updates persisted scanner state, queues changes, and blocks freshness on fatal scan errors.
  private async scanForChanges(): Promise<void> {
    if (!this.watchEnabled || this.closed || this.scanRunning || !this.scanner) return;
    this.scanRunning = true;
    try {
      const result = await this.scanner.scanTick();
      for (const path of result.changedPaths) await this.trackPendingPath(path);
      this.syncSchedulerObservability();
      if (result.completedCoverage) {
        this.emitLog(`bounded scanner coverage completed: dirs=${result.knownDirectoryCount}, files=${result.knownFileCount}`);
      }
      if (this.pendingPaths.size > 0) {
        this.resetWatchDebounce();
      }
      if (this.pendingOverflowReason) this.resetWatchDebounce();
    } catch (error) {
      const message = `watcher failed: ${toErrorMessage(error)}`;
      this.emitLog(message, "error");
      await updateIndexServingFreshness(this.rootDir, "blocked", message);
      await this.stopWatcher();
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: false,
        queueDepth: this.getQueueDepth(),
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        ...this.buildScannerEventFields(),
        message,
      });
    } finally {
      this.scanRunning = false;
    }
  }

  // Purpose: Run an incremental refresh using prepared-index artifacts and emit staged progress updates.
  // Inputs: The watch execution plan to refresh plus an optional source label for manual versus watch flows.
  // Returns/Effects: Acquires the mutation lock, refreshes prepared artifacts, emits progress events, and returns a summary string.
  private async runRefresh(plan: WatchExecutionPlan, source: "manual" | "watch" = "watch"): Promise<string> {
    const mutationLock = await this.acquireMutationLock(source === "manual" ? "bridge manual refresh" : "bridge watch refresh");
    const stageCount = 3;
    const emitRefreshProgress = async (
      stageIndex: number,
      phase: string,
      message: string,
      processedItems?: number,
      totalItems?: number,
      currentFile?: string,
    ): Promise<void> => {
      const stagePercent = calculatePercentComplete(processedItems, totalItems);
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "refresh",
        state: "progress",
        mode: plan.mode,
        phase,
        source,
        queueDepth: this.getQueueDepth(),
        rebuildReason: plan.reason,
        pending: this.queuedWatchPlan !== null,
        message,
        processedItems,
        totalItems,
        percentComplete: scaleRefreshPercent(stageIndex, stageCount, stagePercent),
        currentFile,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
      });
      this.emitLog(message);
    };

    try {
      this.activeJob = "refresh";
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "refresh",
        state: "running",
        mode: plan.mode,
        phase: "file-search",
        source,
        queueDepth: this.getQueueDepth(),
        rebuildReason: plan.reason,
        pending: this.queuedWatchPlan !== null,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message: source == "manual"
          ? "running manual incremental refresh"
          : `running background incremental refresh for ${summarizeChangedPaths(plan.changedPaths)}`,
      });
      if (source === "watch" && plan.changedPaths.length > 0) {
        const refreshed = await refreshEmbeddingsForChangedPaths({
          rootDir: this.rootDir,
          relativePaths: plan.changedPaths,
        });
        const embeddingMessage = [
          `watch embedding refresh: paths=${refreshed.refreshedPaths.length}`,
          `file-vectors=${refreshed.fileEmbeddings}`,
          `identifier-vectors=${refreshed.identifierEmbeddings}`,
        ].join(", ");
        this.emitLog(embeddingMessage);
      }
      await ensureFileSearchIndex(this.rootDir, async (progress) => {
        await emitRefreshProgress(
          0,
          progress.phase,
          formatFileProgress(progress),
          progress.processedFiles,
          progress.totalFiles,
          progress.currentFile,
        );
      });

      await ensureIdentifierSearchIndex(this.rootDir, async (progress) => {
        await emitRefreshProgress(
          1,
          progress.phase,
          formatIdentifierProgress(progress),
          progress.processedFiles,
          progress.totalFiles,
          progress.currentFile,
        );
      });

      await ensureFullIndexArtifacts({ rootDir: this.rootDir }, async (progress) => {
        await emitRefreshProgress(
          2,
          progress.phase,
          formatFullProgress(progress),
          progress.processedFiles,
          progress.totalFiles,
          progress.currentFile,
        );
      });

      const summary = source == "manual"
        ? "manual incremental refresh completed"
        : `background watch refresh completed for ${summarizeChangedPaths(plan.changedPaths)}`;
      this.emitLog(summary);
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "refresh",
        state: "completed",
        mode: plan.mode,
        phase: "completed",
        source,
        queueDepth: this.getQueueDepth(),
        rebuildReason: plan.reason,
        pending: this.queuedWatchPlan !== null,
        percentComplete: 100,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message: summary,
      });
      try {
        const observabilityReport = await buildDoctorReport(this.rootDir);
        this.emitLog(formatStageObservabilitySummary(observabilityReport));
        this.emitLog(formatIntegrityObservabilitySummary(observabilityReport));
        this.emitLog(formatSchedulerObservabilitySummary(observabilityReport));
      } catch (error) {
        this.emitLog(`observability summary unavailable: ${toErrorMessage(error)}`, "error");
      }
      return summary;
    } catch (error) {
      const message = toErrorMessage(error);
      this.emitLog(message, "error");
      if (source === "watch") {
        await updateIndexServingFreshness(this.rootDir, "blocked", `watch refresh failed: ${message}`);
      }
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "refresh",
        state: "failed",
        mode: plan.mode,
        phase: "failed",
        source,
        queueDepth: this.getQueueDepth(),
        rebuildReason: plan.reason,
        pending: this.queuedWatchPlan !== null,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message,
      });
      throw error;
    } finally {
      this.activeJob = null;
      this.syncSchedulerObservability();
      await mutationLock.release();
      if (this.queuedWatchPlan) {
        const nextPlan = this.queuedWatchPlan;
        this.queuedWatchPlan = null;
        this.syncSchedulerObservability();
        this.emitLog(`running queued watch ${nextPlan.job} after recent file changes`);
        void this.runWatchPlan(nextPlan);
      }
    }
  }

  // Purpose: Run a full prepared-index rebuild for the repository and emit end-to-end progress updates.
  // Inputs: The index mode, the initiating source, and an optional override for the rebuild reason text.
  // Returns/Effects: Acquires the mutation lock, runs the index pipeline, emits job events, and returns the index output.
  private async runIndex(mode: IndexMode, source: "manual" | "watch", rebuildReasonOverride?: string): Promise<string> {
    const mutationLock = await this.acquireMutationLock(source === "manual" ? "bridge manual index" : "bridge watch index");
    this.activeJob = "index";
    const rebuildReason = rebuildReasonOverride
      ?? (source === "watch"
        ? `watch-triggered full rebuild for ${this.lastWatchBatch.length > 0 ? summarizeChangedPaths(this.lastWatchBatch) : "pending file changes"}`
        : "manual operator-requested full rebuild");
    this.recordFullRebuildReason(rebuildReason);
    await this.emit({
      kind: "job",
      root: this.rootDir,
      job: "index",
      state: "running",
      mode,
      phase: "bootstrap",
      source,
      queueDepth: this.getQueueDepth(),
      rebuildReason,
      pending: this.queuedWatchPlan !== null,
      pendingPaths: this.getCurrentPendingPaths(),
      pendingChangeCount: this.getCurrentPendingPaths().length,
      pendingJobKind: this.queuedWatchPlan?.job,
      message: source === "watch" ? "running watcher-triggered index" : "running manual index",
    });
    try {
      const output = await indexCodebase({
        rootDir: this.rootDir,
        mode,
        skipRuntimeMutationLock: true,
        onProgress: async (progress) => {
          await this.emit({
            kind: "job",
            root: this.rootDir,
            job: "index",
            state: "progress",
            mode,
            phase: progress.phase,
            source,
            elapsedMs: progress.elapsedMs,
            queueDepth: this.getQueueDepth(),
            rebuildReason,
            pending: this.queuedWatchPlan !== null,
            message: progress.message,
            processedItems: progress.processedItems,
            totalItems: progress.totalItems,
            percentComplete: progress.percentComplete,
            currentFile: progress.currentFile,
            pendingPaths: this.getCurrentPendingPaths(),
            pendingChangeCount: this.getCurrentPendingPaths().length,
            pendingJobKind: this.queuedWatchPlan?.job,
          });
          this.emitLog(progress.message);
        },
      });
      const summary = firstNonEmptyLine(output) || "index completed";
      this.emitLog(summary);
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "index",
        state: "completed",
        mode,
        phase: "completed",
        source,
        queueDepth: this.getQueueDepth(),
        rebuildReason,
        pending: this.queuedWatchPlan !== null,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message: summary,
      });
      try {
        const observabilityReport = await buildDoctorReport(this.rootDir);
        this.emitLog(formatStageObservabilitySummary(observabilityReport));
        this.emitLog(formatIntegrityObservabilitySummary(observabilityReport));
        this.emitLog(formatSchedulerObservabilitySummary(observabilityReport));
      } catch (error) {
        this.emitLog(`observability summary unavailable: ${toErrorMessage(error)}`, "error");
      }
      return output;
    } catch (error) {
      const message = toErrorMessage(error);
      this.emitLog(message, "error");
      await this.emit({
        kind: "job",
        root: this.rootDir,
        job: "index",
        state: "failed",
        mode,
        phase: "failed",
        source,
        queueDepth: this.getQueueDepth(),
        rebuildReason,
        pending: this.queuedWatchPlan !== null,
        pendingPaths: this.getCurrentPendingPaths(),
        pendingChangeCount: this.getCurrentPendingPaths().length,
        pendingJobKind: this.queuedWatchPlan?.job,
        message,
      });
      throw error;
    } finally {
      this.activeJob = null;
      this.syncSchedulerObservability();
      await mutationLock.release();
      if (this.queuedWatchPlan) {
        const nextPlan = this.queuedWatchPlan;
        this.queuedWatchPlan = null;
        this.syncSchedulerObservability();
        this.emitLog(`running queued watch ${nextPlan.job} after recent file changes`);
        void this.runWatchPlan(nextPlan);
      }
    }
  }
}
