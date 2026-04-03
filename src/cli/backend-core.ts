// summary: Implements the shared long-lived backend core used by MCP and the human CLI.
// FEATURE: Long-lived backend state with watcher ownership, job streaming, and bridge command execution.
// inputs: Bridge commands, repository events, backend configuration, and index job requests.
// outputs: Shared backend state transitions, streamed events, and tool execution results.

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { acquireRepoRuntimeLock, type RepoRuntimeLockHandle } from "../core/runtime-locks.js";
import { resetBackendSchedulerObservability, updateBackendSchedulerObservability } from "../core/runtime-observability.js";
import { listRestorePoints } from "../git/shadow.js";
import { semanticNavigate } from "../tools/semantic-navigate.js";
import { DEFAULT_INDEX_MODE, type IndexMode } from "../tools/index-contract.js";
import { ensureFullIndexArtifacts, type FullIndexProgress } from "../tools/full-index-artifacts.js";
import { indexCodebase } from "../tools/index-codebase.js";
import { getContextTree } from "../tools/context-tree.js";
import { getFeatureHub } from "../tools/feature-hub.js";
import { ensureIdentifierSearchIndex, type IdentifierIndexProgress } from "../tools/semantic-identifiers.js";
import { ensureFileSearchIndex, type FileSearchIndexProgress } from "../tools/semantic-search.js";
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
import { validatePreparedIndex } from "../tools/index-reliability.js";

const WATCH_IGNORE_PREFIXES = [
  ".scplus/",
  ".git/",
  ".pixi/",
  "build/",
  "dist/",
  "landing/.next/",
  "node_modules/",
];

export type BackendEventKind = "job" | "log" | "watch-batch" | "watch-state";
export type BackendJobState = "canceled" | "completed" | "failed" | "progress" | "queued" | "running";
export type BackendJobControlAction = "cancel-pending" | "retry-last" | "supersede-pending";
export type BackendJobName = "index" | "refresh";
type ManualIndexMode = IndexMode | "auto";

export interface BackendEvent {
  kind: BackendEventKind;
  root?: string;
  message?: string;
  level?: "error" | "info" | "stderr";
  job?: BackendJobName;
  state?: BackendJobState;
  mode?: IndexMode;
  phase?: string;
  source?: "manual" | "watch";
  elapsedMs?: number;
  pending?: boolean;
  enabled?: boolean;
  changedPaths?: string[];
  queueDepth?: number;
  rebuildReason?: string;
  processedItems?: number;
  totalItems?: number;
  percentComplete?: number;
  currentFile?: string;
  pendingChangeCount?: number;
  pendingPaths?: string[];
  pendingJobKind?: BackendJobName;
}

interface TextPayload {
  root: string;
  text: string;
}

interface WatchStatePayload {
  root: string;
  enabled: boolean;
}

interface JobControlPayload {
  root: string;
  action: BackendJobControlAction;
  message: string;
  queueDepth: number;
  indexRunning: boolean;
  queued: boolean;
  pendingPaths: string[];
  pendingJobKind?: BackendJobName;
  lastWatchBatch: string[];
  lastMode: ManualIndexMode;
}

type EventSink = (event: BackendEvent) => Promise<void> | void;

function shouldWatchPath(path: string): boolean {
  if (!path) return false;
  return !WATCH_IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function formatFileFingerprint(size: number, mtimeMs: number): string {
  return `${size}:${mtimeMs}`;
}

function formatFileProgress(progress: FileSearchIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedDocuments} indexed docs`,
  ].join(" | ");
}

function formatIdentifierProgress(progress: IdentifierIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedIdentifiers} indexed identifiers`,
  ].join(" | ");
}

function formatFullProgress(progress: FullIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedChunks} indexed chunks`,
    `${progress.indexedStructures} indexed structures`,
  ].join(" | ");
}

function calculatePercentComplete(processedItems: number | undefined, totalItems: number | undefined): number | undefined {
  if (processedItems === undefined || totalItems === undefined || totalItems <= 0) return undefined;
  const raw = Math.round((processedItems / totalItems) * 100);
  return Math.max(0, Math.min(100, raw));
}

function scaleRefreshPercent(stageIndex: number, stageCount: number, stagePercent: number | undefined): number | undefined {
  if (stagePercent === undefined) return undefined;
  const start = Math.floor((100 * stageIndex) / stageCount);
  const end = stageIndex === stageCount - 1
    ? 100
    : Math.floor((100 * (stageIndex + 1)) / stageCount);
  return Math.max(start, Math.min(end, start + Math.round(((end - start) * stagePercent) / 100)));
}

class BackendRootSession {
  private debounceTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly pendingPaths = new Set<string>();
  private previousSnapshot = new Map<string, string>();
  private watchEnabled = false;
  private watchDebounceMs = 1200;
  private activeJob: BackendJobName | null = null;
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
      onBusy: async (owner) => {
        this.emitLog(`waiting blocked by ${owner.holder} in pid ${owner.pid} since ${owner.startedAt}`, "error");
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

export class BackendCore {
  private readonly sessions = new Map<string, BackendRootSession>();

  constructor(private readonly eventSink: EventSink = () => { }) { }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();
  }

  async doctor(rootDir: string): Promise<Awaited<ReturnType<typeof buildDoctorReport>>> {
    return buildDoctorReport(rootDir);
  }

  async tree(rootDir: string): Promise<TextPayload> {
    return {
      root: rootDir,
      text: await getContextTree({
        rootDir,
        includeSymbols: true,
        maxTokens: 50000,
      }),
    };
  }

  async hubs(rootDir: string): Promise<TextPayload> {
    return {
      root: rootDir,
      text: await getFeatureHub({ rootDir }),
    };
  }

  async cluster(rootDir: string): Promise<TextPayload> {
    return {
      root: rootDir,
      text: await semanticNavigate({
        rootDir,
        maxDepth: 3,
        maxClusters: 20,
      }),
    };
  }

  async restorePoints(rootDir: string): Promise<Awaited<ReturnType<typeof listRestorePoints>>> {
    return listRestorePoints(rootDir);
  }

  async index(rootDir: string, mode: ManualIndexMode = "auto"): Promise<string> {
    return this.getSession(rootDir).runManualIndex(mode);
  }

  async setWatchEnabled(rootDir: string, enabled: boolean, debounceMs?: number): Promise<WatchStatePayload> {
    return this.getSession(rootDir).setWatchEnabled(enabled, debounceMs);
  }

  async controlJob(rootDir: string, action: BackendJobControlAction): Promise<JobControlPayload> {
    const session = this.getSession(rootDir);
    if (action === "cancel-pending") {
      return session.cancelPendingJob();
    }
    if (action === "supersede-pending") {
      return session.supersedePendingJob();
    }
    return session.retryLastIndex();
  }

  private getSession(rootDir: string): BackendRootSession {
    const normalizedRoot = resolve(rootDir);
    let session = this.sessions.get(normalizedRoot);
    if (!session) {
      session = new BackendRootSession(normalizedRoot, this.eventSink);
      this.sessions.set(normalizedRoot, session);
    }
    return session;
  }
}

export function createBackendCore(eventSink?: EventSink): BackendCore {
  return new BackendCore(eventSink);
}
