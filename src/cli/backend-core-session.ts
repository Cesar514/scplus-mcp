// summary: Implements the per-root backend session that owns watch queues and indexing jobs.
// FEATURE: Session-scoped backend execution for manual index, refresh, cluster, and watcher flows.
// inputs: Repository roots, backend event sink functions, watch changes, and index job requests.
// outputs: Per-root backend events, queue state updates, and manual or watch-triggered job execution.

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { acquireRepoRuntimeLock, type RepoRuntimeLockHandle } from "../core/runtime-locks.js";
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
  normalizeRelativePath,
  summarizeChangedPaths,
  type WatchExecutionPlan,
} from "./backend-core-helpers.js";
import { buildDoctorReport } from "./reports.js";
import {
  calculatePercentComplete,
  type BackendEvent,
  type BackendJobControlAction,
  type EventSink,
  firstNonEmptyLine,
  formatFileFingerprint,
  formatFileProgress,
  formatFullProgress,
  formatIdentifierProgress,
  type JobControlPayload,
  type ManualIndexMode,
  scaleRefreshPercent,
  shouldWatchPath,
  type TextPayload,
  toErrorMessage,
  type WatchStatePayload,
} from "./backend-core-shared.js";

export class BackendRootSession {
  private debounceTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly pendingPaths = new Set<string>();
  private previousSnapshot = new Map<string, string>();
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

  constructor(
    private readonly rootDir: string,
    private readonly emitEvent: EventSink,
  ) { }

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
        message: "watcher disabled",
      });
    }
    return { root: this.rootDir, enabled: false };
  }

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

  async cancelPendingJob(): Promise<JobControlPayload> {
    this.assertOpen();
    const pendingPaths = this.getLatestPendingPaths();
    const hadQueuedIndex = this.queuedWatchPlan !== null;
    const hadPendingPaths = this.pendingPaths.size > 0;
    if (!hadQueuedIndex && !hadPendingPaths) {
      throw new Error(`No pending watch job exists for ${this.rootDir}.`);
    }
    this.clearDebounceTimer();
    this.pendingPaths.clear();
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

  async supersedePendingJob(): Promise<JobControlPayload> {
    this.assertOpen();
    const pendingPaths = this.getLatestPendingPaths();
    if (pendingPaths.length === 0) {
      throw new Error(`No pending watch work exists for ${this.rootDir}.`);
    }
    this.clearDebounceTimer();
    this.pendingPaths.clear();
    this.lastWatchBatch = pendingPaths;
    this.supersededJobs++;
    this.canceledJobs++;
    if (this.activeJob) {
      const priorPlan = this.queuedWatchPlan;
      const nextPlan = buildWatchExecutionPlan(priorPlan ? dedupePaths([...priorPlan.changedPaths, ...pendingPaths]) : pendingPaths);
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
        message,
      });
      return this.buildJobControlPayload("supersede-pending", message);
    }

    this.syncSchedulerObservability();
    const nextPlan = buildWatchExecutionPlan(pendingPaths);
    const message = `superseded pending watch batch and started a fresh ${nextPlan.job}: ${summarizeChangedPaths(nextPlan.changedPaths)}`;
    this.emitLog(message);
    void this.runWatchPlan(nextPlan);
    return this.buildJobControlPayload("supersede-pending", message);
  }

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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopWatcher();
    resetBackendSchedulerObservability(this.rootDir);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Backend session for ${this.rootDir} is closed.`);
    }
  }

  private async emit(event: BackendEvent): Promise<void> {
    try {
      await this.emitEvent(event);
    } catch (error) {
      console.error("Backend event sink failed:", error);
    }
  }

  private async hasValidPreparedFullIndex(): Promise<boolean> {
    try {
      const report = await validatePreparedIndex({ rootDir: this.rootDir, mode: DEFAULT_INDEX_MODE });
      return report.ok;
    } catch {
      return false;
    }
  }

  private emitLog(message: string, level: "error" | "info" = "info"): void {
    void this.emit({
      kind: "log",
      root: this.rootDir,
      message,
      level,
      queueDepth: this.getQueueDepth(),
    });
  }

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

  private clearDebounceTimer(): void {
    if (!this.debounceTimer) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private getLatestPendingPaths(): string[] {
    const currentPending = this.getCurrentPendingPaths();
    if (currentPending.length > 0) return currentPending;
    return [...this.lastWatchBatch];
  }

  private getCurrentPendingPaths(): string[] {
    return dedupePaths([
      ...this.pendingPaths,
      ...(this.queuedWatchPlan?.changedPaths ?? []),
    ]);
  }

  private buildJobControlPayload(action: BackendJobControlAction, message: string): JobControlPayload {
    const pendingPaths = this.getLatestPendingPaths();
    const pendingJobKind = this.queuedWatchPlan?.job
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
    return this.pendingPaths.size > 0 || this.queuedWatchPlan ? 1 : 0;
  }

  private syncSchedulerObservability(): void {
    const pendingPaths = this.getCurrentPendingPaths();
    const pendingJobKind = this.queuedWatchPlan?.job
      ?? (pendingPaths.length > 0 ? buildWatchExecutionPlan(pendingPaths).job : undefined);
    updateBackendSchedulerObservability(this.rootDir, (current) => ({
      ...current,
      watchEnabled: this.watchEnabled,
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

  private recordFullRebuildReason(reason: string): void {
    const pendingPaths = this.getCurrentPendingPaths();
    const pendingJobKind = this.queuedWatchPlan?.job
      ?? (pendingPaths.length > 0 ? buildWatchExecutionPlan(pendingPaths).job : undefined);
    updateBackendSchedulerObservability(this.rootDir, (current) => ({
      ...current,
      watchEnabled: this.watchEnabled,
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

  private trackPendingPath(path: string): void {
    if (this.pendingPaths.has(path)) {
      this.dedupedPathEvents++;
    }
    this.pendingPaths.add(path);
    this.syncSchedulerObservability();
  }

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
      this.previousSnapshot = await this.scanSnapshot();
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
        message: `watcher failed: ${toErrorMessage(error)}`,
      });
      throw error;
    }
    this.watchEnabled = true;
    this.syncSchedulerObservability();
    const pollMs = Math.max(250, Math.min(this.watchDebounceMs, 1000));
    this.scanTimer = setInterval(() => {
      void this.scanForChanges();
    }, pollMs);
    this.scanTimer.unref?.();
  }

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
    this.queuedWatchPlan = null;
    this.previousSnapshot.clear();
    this.scanRunning = false;
    this.watchEnabled = false;
    this.syncSchedulerObservability();
    const watchLock = this.watchLock;
    this.watchLock = null;
    if (watchLock) {
      await watchLock.release();
    }
  }

  private resetWatchDebounce(): void {
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushWatchBatch();
    }, this.watchDebounceMs);
    this.debounceTimer.unref?.();
  }

  private async flushWatchBatch(): Promise<void> {
    if (this.pendingPaths.size === 0) return;
    const changedPaths = Array.from(this.pendingPaths).sort();
    this.pendingPaths.clear();
    this.lastWatchBatch = changedPaths;
    this.batchCount++;
    const plan = buildWatchExecutionPlan(changedPaths);
    this.syncSchedulerObservability();
    await this.emit({
      kind: "watch-batch",
      root: this.rootDir,
      changedPaths,
      queueDepth: this.getQueueDepth(),
      pendingPaths: this.getCurrentPendingPaths(),
      pendingChangeCount: this.getCurrentPendingPaths().length,
      pendingJobKind: this.queuedWatchPlan?.job ?? (this.activeJob ? plan.job : undefined),
      message: `detected changes: ${summarizeChangedPaths(changedPaths)}`,
    });
    if (this.activeJob) {
      const priorPlan = this.queuedWatchPlan;
      const nextPlan = buildWatchExecutionPlan(priorPlan ? dedupePaths([...priorPlan.changedPaths, ...changedPaths]) : changedPaths);
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
        message: queuedMessage,
      });
      this.emitLog(`${queuedMessage}: ${summarizeChangedPaths(nextPlan.changedPaths)}`);
      return;
    }
    void this.runWatchPlan(plan);
  }

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

  private async scanSnapshot(directoryPath: string = this.rootDir, snapshot: Map<string, string> = new Map()): Promise<Map<string, string>> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directoryPath, entry.name);
      const relativePath = normalizeRelativePath(relative(this.rootDir, absolutePath));
      if (!shouldWatchPath(relativePath)) continue;
      if (entry.isDirectory()) {
        await this.scanSnapshot(absolutePath, snapshot);
        continue;
      }
      const info = await stat(absolutePath);
      if (!info.isFile()) continue;
      snapshot.set(relativePath, formatFileFingerprint(info.size, info.mtimeMs));
    }
    return snapshot;
  }

  private async scanForChanges(): Promise<void> {
    if (!this.watchEnabled || this.closed || this.scanRunning) return;
    this.scanRunning = true;
    try {
      const nextSnapshot = await this.scanSnapshot();
      for (const [path, fingerprint] of nextSnapshot.entries()) {
        if (this.previousSnapshot.get(path) !== fingerprint) {
          this.trackPendingPath(path);
        }
      }
      for (const path of this.previousSnapshot.keys()) {
        if (!nextSnapshot.has(path)) {
          this.trackPendingPath(path);
        }
      }
      this.previousSnapshot = nextSnapshot;
      if (this.pendingPaths.size > 0) {
        this.resetWatchDebounce();
      }
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
        message: `watcher failed: ${toErrorMessage(error)}`,
      });
    } finally {
      this.scanRunning = false;
    }
  }

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
      await ensureFileSearchIndex(this.rootDir, async (progress) => {
        await emitRefreshProgress(0, progress.phase, formatFileProgress(progress), progress.processedFiles, progress.totalFiles, progress.currentFile);
      });

      await ensureIdentifierSearchIndex(this.rootDir, async (progress) => {
        await emitRefreshProgress(1, progress.phase, formatIdentifierProgress(progress), progress.processedFiles, progress.totalFiles, progress.currentFile);
      });

      await ensureFullIndexArtifacts({ rootDir: this.rootDir }, async (progress) => {
        await emitRefreshProgress(2, progress.phase, formatFullProgress(progress), progress.processedFiles, progress.totalFiles, progress.currentFile);
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
