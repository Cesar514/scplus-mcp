// Transport-neutral backend core for persistent CLI and MCP index sessions
// FEATURE: Long-lived backend state with watcher ownership, job streaming, and bridge command execution

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { resetBackendSchedulerObservability, updateBackendSchedulerObservability } from "../core/runtime-observability.js";
import { listRestorePoints } from "../git/shadow.js";
import { semanticNavigate } from "../tools/semantic-navigate.js";
import { DEFAULT_INDEX_MODE, type IndexMode } from "../tools/index-contract.js";
import { indexCodebase } from "../tools/index-codebase.js";
import { getContextTree } from "../tools/context-tree.js";
import { getFeatureHub } from "../tools/feature-hub.js";
import { buildDoctorReport } from "./reports.js";

const WATCH_IGNORE_PREFIXES = [
  ".contextplus/",
  ".git/",
  ".pixi/",
  "build/",
  "dist/",
  "landing/.next/",
  "node_modules/",
];

export type BackendEventKind = "job" | "log" | "watch-batch" | "watch-state";
export type BackendJobState = "completed" | "failed" | "progress" | "queued" | "running";

export interface BackendEvent {
  kind: BackendEventKind;
  root?: string;
  message?: string;
  level?: "error" | "info" | "stderr";
  job?: "index";
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
}

interface TextPayload {
  root: string;
  text: string;
}

interface WatchStatePayload {
  root: string;
  enabled: boolean;
}

type EventSink = (event: BackendEvent) => Promise<void> | void;

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

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

class BackendRootSession {
  private debounceTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly pendingPaths = new Set<string>();
  private previousSnapshot = new Map<string, string>();
  private watchEnabled = false;
  private watchDebounceMs = 1200;
  private indexRunning = false;
  private queuedWatchIndex = false;
  private closed = false;
  private scanRunning = false;
  private dedupedPathEvents = 0;
  private batchCount = 0;
  private supersededJobs = 0;
  private canceledJobs = 0;
  private lastWatchBatch: string[] = [];

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
        message: "watcher enabled",
      });
      return { root: this.rootDir, enabled: true };
    }

    if (this.watchEnabled) {
      this.stopWatcher();
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: false,
        message: "watcher disabled",
      });
    }
    return { root: this.rootDir, enabled: false };
  }

  async runManualIndex(mode: IndexMode = DEFAULT_INDEX_MODE): Promise<string> {
    this.assertOpen();
    if (this.indexRunning) {
      throw new Error(`Index job already running for ${this.rootDir}.`);
    }
    return this.runIndex(mode, "manual");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatcher();
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

  private emitLog(message: string, level: "error" | "info" = "info"): void {
    void this.emit({
      kind: "log",
      root: this.rootDir,
      message,
      level,
      queueDepth: this.getQueueDepth(),
    });
  }

  private getQueueDepth(): number {
    return this.pendingPaths.size + (this.queuedWatchIndex ? 1 : 0);
  }

  private syncSchedulerObservability(): void {
    updateBackendSchedulerObservability(this.rootDir, (current) => ({
      ...current,
      watchEnabled: this.watchEnabled,
      queueDepth: this.getQueueDepth(),
      maxQueueDepth: Math.max(current.maxQueueDepth, this.getQueueDepth()),
      batchCount: this.batchCount,
      dedupedPathEvents: this.dedupedPathEvents,
      supersededJobs: this.supersededJobs,
      canceledJobs: this.canceledJobs,
    }));
  }

  private recordFullRebuildReason(reason: string): void {
    updateBackendSchedulerObservability(this.rootDir, (current) => ({
      ...current,
      watchEnabled: this.watchEnabled,
      queueDepth: this.getQueueDepth(),
      maxQueueDepth: Math.max(current.maxQueueDepth, this.getQueueDepth()),
      batchCount: this.batchCount,
      dedupedPathEvents: this.dedupedPathEvents,
      supersededJobs: this.supersededJobs,
      canceledJobs: this.canceledJobs,
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
    try {
      this.previousSnapshot = await this.scanSnapshot();
    } catch (error) {
      this.emitLog(`watcher failed: ${toErrorMessage(error)}`, "error");
      this.stopWatcher();
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: false,
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

  private stopWatcher(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.pendingPaths.clear();
    this.previousSnapshot.clear();
    this.scanRunning = false;
    this.watchEnabled = false;
    this.syncSchedulerObservability();
  }

  private resetWatchDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
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
    this.syncSchedulerObservability();
    await this.emit({
      kind: "watch-batch",
      root: this.rootDir,
      changedPaths,
      queueDepth: this.getQueueDepth(),
      message: `detected changes: ${changedPaths.join(", ")}`,
    });
    if (this.indexRunning) {
      if (!this.queuedWatchIndex) {
        this.queuedWatchIndex = true;
        this.syncSchedulerObservability();
        await this.emit({
          kind: "job",
          root: this.rootDir,
          job: "index",
          state: "queued",
          mode: DEFAULT_INDEX_MODE,
          source: "watch",
          pending: true,
          queueDepth: this.getQueueDepth(),
          rebuildReason: `watch changes: ${changedPaths.join(", ")}`,
          message: "queued reindex because one is already running",
        });
      } else {
        this.supersededJobs++;
        this.syncSchedulerObservability();
        this.emitLog(`watch batch superseded an already queued rebuild: ${changedPaths.join(", ")}`);
      }
      return;
    }
    void this.runAutomaticWatchIndex();
  }

  private async runAutomaticWatchIndex(): Promise<void> {
    try {
      await this.runIndex(DEFAULT_INDEX_MODE, "watch");
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
      this.stopWatcher();
      await this.emit({
        kind: "watch-state",
        root: this.rootDir,
        enabled: false,
        message: `watcher failed: ${toErrorMessage(error)}`,
      });
    } finally {
      this.scanRunning = false;
    }
  }

  private async runIndex(mode: IndexMode, source: "manual" | "watch"): Promise<string> {
    this.indexRunning = true;
    const rebuildReason = source === "watch"
      ? `watch-triggered full rebuild for ${this.lastWatchBatch.length > 0 ? this.lastWatchBatch.join(", ") : "pending file changes"}`
      : "manual operator-requested full rebuild";
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
      pending: this.queuedWatchIndex,
      message: source === "watch" ? "running watcher-triggered index" : "running manual index",
    });
    try {
      const output = await indexCodebase({
        rootDir: this.rootDir,
        mode,
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
            pending: this.queuedWatchIndex,
            message: progress.message,
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
        pending: this.queuedWatchIndex,
        message: summary,
      });
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
        pending: this.queuedWatchIndex,
        message,
      });
      throw error;
    } finally {
      this.indexRunning = false;
      this.syncSchedulerObservability();
      if (this.queuedWatchIndex) {
        this.queuedWatchIndex = false;
        this.syncSchedulerObservability();
        this.emitLog("running queued reindex after recent file changes");
        void this.runAutomaticWatchIndex();
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

  async index(rootDir: string, mode: IndexMode = DEFAULT_INDEX_MODE): Promise<string> {
    return this.getSession(rootDir).runManualIndex(mode);
  }

  async setWatchEnabled(rootDir: string, enabled: boolean, debounceMs?: number): Promise<WatchStatePayload> {
    return this.getSession(rootDir).setWatchEnabled(enabled, debounceMs);
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
