// summary: Provides bounded backend-owned repository scanning without native filesystem watches.
// purpose: Replace recursive native watch and full-tree polling with persisted, budgeted scan ticks.
// inputs: Repository roots, scanner budget environment variables, and sqlite-backed scanner state.
// returns/effects: Persists scanner cursors, reports changed paths, and guarantees zero native watch registrations.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import {
  formatFileFingerprint,
  shouldWatchPath,
} from "./backend-core-shared.js";
import { normalizeRelativePath } from "./backend-core-helpers.js";

export type ScannerStatus = "bootstrapping" | "enabled" | "blocked" | "disabled";

export interface BackendScannerBudgets {
  maxDirsPerTick: number;
  maxFilesPerTick: number;
  maxMsPerTick: number;
  statConcurrency: number;
  rescanIntervalMs: number;
}

export interface BackendScannerSnapshot {
  status: ScannerStatus;
  nativeWatchCount: number;
  directoryQueueSize: number;
  fileQueueSize: number;
  knownDirectoryCount: number;
  knownFileCount: number;
  scanGeneration: number;
  lastFullCoverageAt?: string;
  lastCursorCheckpoint?: string;
  lastScanFailure?: string;
  lastOverflowReason?: string;
  budgets: BackendScannerBudgets;
}

export interface BackendScanTickResult extends BackendScannerSnapshot {
  changedPaths: string[];
  discoveredDirectories: number;
  discoveredFiles: number;
  skippedIgnoredDirectories: number;
  elapsedMs: number;
  completedCoverage: boolean;
}

export interface BackendBoundedScannerController {
  snapshot(): BackendScannerSnapshot;
  scanTick(): Promise<BackendScanTickResult>;
  recordOverflow(reason: string): Promise<void>;
}

interface PersistedScannerState {
  rootDir: string;
  status: ScannerStatus;
  scanGeneration: number;
  startedAtMs: number;
  ignoreRuleHash: string;
  directoryQueue: string[];
  fileQueue: string[];
  directoryManifest: string[];
  fileManifest: Array<[string, string]>;
  lastFullCoverageAt?: string;
  lastCursorCheckpoint?: string;
  lastScanFailure?: string;
  lastOverflowReason?: string;
}

interface FileFingerprintResult {
  path: string;
  fingerprint?: string;
  mtimeMs?: number;
}

const SCANNER_ARTIFACT_KEY = "scanner-state";
const DEFAULT_SCAN_MAX_DIRS_PER_TICK = 32;
const DEFAULT_SCAN_MAX_FILES_PER_TICK = 256;
const DEFAULT_SCAN_MAX_MS_PER_TICK = 100;
const DEFAULT_SCAN_STAT_CONCURRENCY = 16;
const DEFAULT_SCAN_RESCAN_INTERVAL_MS = 1000;
const IGNORE_RULE_HASH = "watch-ignore-v1:.scplus,.git,.pixi,build,dist,landing/.next,node_modules";

// Purpose: Parse one positive integer scanner budget from the process environment.
// Inputs: Environment variable name plus its repository default value.
// Returns/Effects: Returns the parsed budget or throws on invalid configured values.
function parseBudget(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim() || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set. Received ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

// Purpose: Load and validate the scanner budgets used by every backend scan tick.
// Inputs: Current process environment variables.
// Returns/Effects: Returns explicit scan budgets or throws a fatal configuration error.
export function loadBackendScannerBudgets(): BackendScannerBudgets {
  return {
    maxDirsPerTick: parseBudget("SCPLUS_SCAN_MAX_DIRS_PER_TICK", DEFAULT_SCAN_MAX_DIRS_PER_TICK),
    maxFilesPerTick: parseBudget("SCPLUS_SCAN_MAX_FILES_PER_TICK", DEFAULT_SCAN_MAX_FILES_PER_TICK),
    maxMsPerTick: parseBudget("SCPLUS_SCAN_MAX_MS_PER_TICK", DEFAULT_SCAN_MAX_MS_PER_TICK),
    statConcurrency: parseBudget("SCPLUS_SCAN_STAT_CONCURRENCY", DEFAULT_SCAN_STAT_CONCURRENCY),
    rescanIntervalMs: parseBudget("SCPLUS_SCAN_RESCAN_INTERVAL_MS", DEFAULT_SCAN_RESCAN_INTERVAL_MS),
  };
}

// Purpose: Return the persisted scanner shape used when no sqlite state exists.
// Inputs: The normalized repository root being watched.
// Returns/Effects: Returns an initial bootstrapping scanner cursor.
function createInitialScannerState(rootDir: string): PersistedScannerState {
  return {
    rootDir,
    status: "bootstrapping",
    scanGeneration: 1,
    startedAtMs: Date.now(),
    ignoreRuleHash: IGNORE_RULE_HASH,
    directoryQueue: ["."],
    fileQueue: [],
    directoryManifest: ["."],
    fileManifest: [],
    lastCursorCheckpoint: new Date().toISOString(),
  };
}

// Purpose: Return the parent directory path for a repository-relative path.
// Inputs: A normalized repository-relative file or directory path.
// Returns/Effects: Returns "." for root children or the normalized parent directory.
function parentDirectoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return ".";
  return path.slice(0, index) || ".";
}

// Purpose: Check whether a manifest path is inside or equal to a removed directory.
// Inputs: A manifest path and the directory path that disappeared.
// Returns/Effects: Returns true when the manifest entry belongs to the removed subtree.
function isWithinDirectory(path: string, directoryPath: string): boolean {
  return path === directoryPath || path.startsWith(`${directoryPath}/`);
}

// Purpose: Normalize and de-duplicate a queue while preserving stable sorted processing.
// Inputs: The raw queue values loaded from state or discovered during scanning.
// Returns/Effects: Returns a sorted queue of non-empty normalized paths.
function normalizeQueue(paths: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(paths).map(normalizeRelativePath).filter(Boolean))).sort();
}

// Purpose: Create one bounded backend scanner for a repository root.
// Inputs: The repository root that should be scanned.
// Returns/Effects: Returns a scanner with sqlite-backed cursor state.
export async function createBackendBoundedScanner(rootDir: string): Promise<BackendBoundedScannerController> {
  return BackendBoundedScanner.create(rootDir);
}

class BackendBoundedScanner {
  private state: PersistedScannerState;
  private readonly fileManifest = new Map<string, string>();
  private readonly directoryManifest = new Set<string>();

  // Purpose: Construct a scanner from normalized sqlite-backed state.
  // Inputs: Repository root, explicit scan budgets, and persisted scanner state.
  // Returns/Effects: Hydrates in-memory manifests from the persisted scanner state.
  private constructor(
    private readonly rootDir: string,
    private readonly budgets: BackendScannerBudgets,
    state: PersistedScannerState,
  ) {
    this.state = state;
    for (const [path, fingerprint] of state.fileManifest) this.fileManifest.set(path, fingerprint);
    for (const path of state.directoryManifest) this.directoryManifest.add(path);
  }

  // Purpose: Load the sqlite-backed scanner state or initialize one for a repository root.
  // Inputs: The repository root that should be scanned.
  // Returns/Effects: Persists an initial cursor when no compatible state exists.
  static async create(rootDir: string): Promise<BackendBoundedScanner> {
    const normalizedRoot = resolve(rootDir);
    const budgets = loadBackendScannerBudgets();
    const persisted = await loadIndexArtifact<PersistedScannerState>(
      normalizedRoot,
      SCANNER_ARTIFACT_KEY,
      () => createInitialScannerState(normalizedRoot),
      { global: true },
    );
    const scanner = new BackendBoundedScanner(normalizedRoot, budgets, normalizePersistedState(normalizedRoot, persisted));
    await scanner.persist();
    return scanner;
  }

  // Purpose: Return a defensive runtime snapshot for diagnostics and backend event payloads.
  // Inputs: No direct inputs beyond the current scanner state and in-memory manifests.
  // Returns/Effects: Returns current scanner status, queues, manifest counts, and native watch count.
  snapshot(): BackendScannerSnapshot {
    return {
      status: this.state.status,
      nativeWatchCount: 0,
      directoryQueueSize: this.state.directoryQueue.length,
      fileQueueSize: this.state.fileQueue.length,
      knownDirectoryCount: this.directoryManifest.size,
      knownFileCount: this.fileManifest.size,
      scanGeneration: this.state.scanGeneration,
      lastFullCoverageAt: this.state.lastFullCoverageAt,
      lastCursorCheckpoint: this.state.lastCursorCheckpoint,
      lastScanFailure: this.state.lastScanFailure,
      lastOverflowReason: this.state.lastOverflowReason,
      budgets: { ...this.budgets },
    };
  }

  // Purpose: Execute one bounded scanner tick and persist the updated cursor.
  // Inputs: No direct inputs beyond queued scanner work and configured budgets.
  // Returns/Effects: Scans a bounded slice, persists state, and returns detected changed paths.
  async scanTick(): Promise<BackendScanTickResult> {
    const startedAt = Date.now();
    const changedPaths = new Set<string>();
    let discoveredDirectories = 0;
    let discoveredFiles = 0;
    let skippedIgnoredDirectories = 0;
    try {
      const dirStats = await this.processDirectoryBudget(startedAt, changedPaths);
      discoveredDirectories += dirStats.discoveredDirectories;
      discoveredFiles += dirStats.discoveredFiles;
      skippedIgnoredDirectories += dirStats.skippedIgnoredDirectories;
      await this.processFileBudget(startedAt, changedPaths);
      const completedCoverage = this.rotateCoverageIfNeeded();
      await this.persistCheckpoint(undefined);
      return {
        ...this.snapshot(),
        changedPaths: normalizeQueue(changedPaths),
        discoveredDirectories,
        discoveredFiles,
        skippedIgnoredDirectories,
        elapsedMs: Date.now() - startedAt,
        completedCoverage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.persistCheckpoint(message);
      throw error;
    }
  }

  // Purpose: Persist an explicit scanner overflow reason for later diagnostics.
  // Inputs: The overflow reason emitted by the backend scheduler.
  // Returns/Effects: Stores the overflow reason in sqlite-backed scanner state.
  async recordOverflow(reason: string): Promise<void> {
    this.state.lastOverflowReason = reason;
    await this.persistCheckpoint(undefined);
  }

  // Purpose: Process a bounded number of directory reads from the scanner queue.
  // Inputs: Tick start time plus the changed-path accumulator.
  // Returns/Effects: Discovers directories, enqueues files, and removes deleted manifest entries.
  private async processDirectoryBudget(startedAt: number, changedPaths: Set<string>): Promise<{
    discoveredDirectories: number;
    discoveredFiles: number;
    skippedIgnoredDirectories: number;
  }> {
    let processedDirs = 0;
    let discoveredDirectories = 0;
    let discoveredFiles = 0;
    let skippedIgnoredDirectories = 0;
    while (this.state.directoryQueue.length > 0 && processedDirs < this.budgets.maxDirsPerTick && !this.isOverTimeBudget(startedAt)) {
      const directoryPath = this.state.directoryQueue.shift();
      if (!directoryPath) continue;
      const stats = await this.scanDirectory(directoryPath, changedPaths);
      processedDirs++;
      discoveredDirectories += stats.discoveredDirectories;
      discoveredFiles += stats.discoveredFiles;
      skippedIgnoredDirectories += stats.skippedIgnoredDirectories;
    }
    return { discoveredDirectories, discoveredFiles, skippedIgnoredDirectories };
  }

  // Purpose: Scan one directory and update child file or directory manifest entries.
  // Inputs: The repository-relative directory path plus changed-path accumulator.
  // Returns/Effects: Enqueues discovered children and records removed direct children.
  private async scanDirectory(directoryPath: string, changedPaths: Set<string>): Promise<{
    discoveredDirectories: number;
    discoveredFiles: number;
    skippedIgnoredDirectories: number;
  }> {
    const entries = await this.readDirectoryEntries(directoryPath);
    const seenFiles = new Set<string>();
    const seenDirectories = new Set<string>();
    let discoveredDirectories = 0;
    let discoveredFiles = 0;
    let skippedIgnoredDirectories = 0;
    for (const entry of entries) {
      const childPath = normalizeRelativePath(directoryPath === "." ? entry.name : `${directoryPath}/${entry.name}`);
      if (!shouldWatchPath(childPath)) {
        if (entry.isDirectory()) skippedIgnoredDirectories++;
        continue;
      }
      if (entry.isDirectory()) {
        const wasKnown = this.directoryManifest.has(childPath);
        this.directoryManifest.add(childPath);
        seenDirectories.add(childPath);
        if (!wasKnown) discoveredDirectories++;
        this.enqueueDirectory(childPath);
        continue;
      }
      if (entry.isFile()) {
        seenFiles.add(childPath);
        discoveredFiles++;
        this.enqueueFile(childPath);
      }
    }
    this.removeMissingDirectChildren(directoryPath, seenFiles, seenDirectories, changedPaths);
    return { discoveredDirectories, discoveredFiles, skippedIgnoredDirectories };
  }

  // Purpose: Process a bounded number of file stat checks from the scanner queue.
  // Inputs: Tick start time plus the changed-path accumulator.
  // Returns/Effects: Updates file fingerprints and records changed or removed files.
  private async processFileBudget(startedAt: number, changedPaths: Set<string>): Promise<void> {
    let processedFiles = 0;
    while (this.state.fileQueue.length > 0 && processedFiles < this.budgets.maxFilesPerTick && !this.isOverTimeBudget(startedAt)) {
      const batch = this.state.fileQueue.splice(0, Math.min(this.budgets.statConcurrency, this.budgets.maxFilesPerTick - processedFiles));
      const results = await Promise.all(batch.map((path) => this.fingerprintFile(path)));
      for (const result of results) {
        processedFiles++;
        if (!result.fingerprint) {
          if (this.fileManifest.delete(result.path)) changedPaths.add(result.path);
          continue;
        }
        const previous = this.fileManifest.get(result.path);
        if (previous !== undefined && previous !== result.fingerprint) changedPaths.add(result.path);
        if (previous === undefined && this.shouldReportNewFile(result.mtimeMs)) changedPaths.add(result.path);
        this.fileManifest.set(result.path, result.fingerprint);
      }
    }
  }

  // Purpose: Read directory entries while tolerating directories removed during scanning.
  // Inputs: Repository-relative directory path to inspect.
  // Returns/Effects: Returns directory entries or an empty list for already-removed paths.
  private async readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
    const absolutePath = directoryPath === "." ? this.rootDir : join(this.rootDir, directoryPath);
    return readdir(absolutePath, { withFileTypes: true }).catch((error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
  }

  // Purpose: Build a stable file fingerprint while tolerating concurrent file removal.
  // Inputs: Repository-relative file path from the scanner file queue.
  // Returns/Effects: Returns the fingerprint or undefined when the file disappeared.
  private async fingerprintFile(path: string): Promise<FileFingerprintResult> {
    const absolutePath = join(this.rootDir, path);
    const info = await stat(absolutePath).catch((error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!info || !info.isFile()) return { path };
    return { path, fingerprint: formatFileFingerprint(info.size, info.mtimeMs), mtimeMs: info.mtimeMs };
  }

  // Purpose: Decide whether a newly observed path should be emitted as changed.
  // Inputs: Optional modification time value returned by the filesystem stat call.
  // Returns/Effects: Returns true for enabled scans or bootstrap edits after watcher startup.
  private shouldReportNewFile(mtimeMs: number | undefined): boolean {
    if (this.state.status === "enabled") return true;
    return mtimeMs !== undefined && mtimeMs >= this.state.startedAtMs;
  }

  // Purpose: Remove manifest entries for children that disappeared from a scanned directory.
  // Inputs: Directory path, currently seen direct children, and changed-path accumulator.
  // Returns/Effects: Drops stale entries and records affected paths for the backend queue.
  private removeMissingDirectChildren(
    directoryPath: string,
    seenFiles: Set<string>,
    seenDirectories: Set<string>,
    changedPaths: Set<string>,
  ): void {
    for (const path of Array.from(this.fileManifest.keys())) {
      if (parentDirectoryOf(path) === directoryPath && !seenFiles.has(path)) {
        this.fileManifest.delete(path);
        changedPaths.add(path);
      }
    }
    for (const path of Array.from(this.directoryManifest.values())) {
      if (path !== "." && parentDirectoryOf(path) === directoryPath && !seenDirectories.has(path)) {
        this.removeDirectorySubtree(path, changedPaths);
      }
    }
  }

  // Purpose: Remove one deleted directory subtree from scanner manifests and queues.
  // Inputs: The removed directory path plus changed-path accumulator.
  // Returns/Effects: Drops files and directories inside the subtree and records changed paths.
  private removeDirectorySubtree(directoryPath: string, changedPaths: Set<string>): void {
    for (const path of Array.from(this.fileManifest.keys())) {
      if (isWithinDirectory(path, directoryPath)) {
        this.fileManifest.delete(path);
        changedPaths.add(path);
      }
    }
    for (const path of Array.from(this.directoryManifest.values())) {
      if (isWithinDirectory(path, directoryPath)) this.directoryManifest.delete(path);
    }
    this.state.directoryQueue = this.state.directoryQueue.filter((path) => !isWithinDirectory(path, directoryPath));
    this.state.fileQueue = this.state.fileQueue.filter((path) => !isWithinDirectory(path, directoryPath));
    changedPaths.add(directoryPath);
  }

  // Purpose: Start the next coverage generation when all queued directory and file checks finish.
  // Inputs: No direct inputs beyond the current queues and manifests.
  // Returns/Effects: Records full coverage and requeues every known directory for the next pass.
  private rotateCoverageIfNeeded(): boolean {
    if (this.state.directoryQueue.length > 0 || this.state.fileQueue.length > 0) return false;
    this.state.status = "enabled";
    this.state.scanGeneration++;
    this.state.lastFullCoverageAt = new Date().toISOString();
    this.state.directoryQueue = normalizeQueue(this.directoryManifest);
    return true;
  }

  // Purpose: Enqueue one directory path if it is not already pending.
  // Inputs: Repository-relative directory path.
  // Returns/Effects: Adds the directory to the scanner queue once.
  private enqueueDirectory(path: string): void {
    if (this.state.directoryQueue.includes(path)) return;
    this.state.directoryQueue.push(path);
    this.state.directoryQueue.sort();
  }

  // Purpose: Enqueue one file path if it is not already pending.
  // Inputs: Repository-relative file path.
  // Returns/Effects: Adds the file to the scanner queue once.
  private enqueueFile(path: string): void {
    if (this.state.fileQueue.includes(path)) return;
    this.state.fileQueue.push(path);
    this.state.fileQueue.sort();
  }

  // Purpose: Decide whether the current scan tick exceeded its elapsed-time budget.
  // Inputs: The millisecond timestamp captured at tick start.
  // Returns/Effects: Returns true once the configured budget is exhausted.
  private isOverTimeBudget(startedAt: number): boolean {
    return Date.now() - startedAt >= this.budgets.maxMsPerTick;
  }

  // Purpose: Persist a normal or failed scanner checkpoint to sqlite.
  // Inputs: Optional failure message for blocked scanner state.
  // Returns/Effects: Updates scanner status, cursor timestamp, and durable artifact state.
  private async persistCheckpoint(failure: string | undefined): Promise<void> {
    this.state.status = failure ? "blocked" : this.state.status === "disabled" ? "disabled" : this.state.status;
    this.state.lastScanFailure = failure;
    this.state.lastCursorCheckpoint = new Date().toISOString();
    await this.persist();
  }

  // Purpose: Save the current scanner state into the sqlite artifact store.
  // Inputs: No direct inputs beyond in-memory scanner queues and manifests.
  // Returns/Effects: Writes a global scanner-state artifact under `.scplus/state/index.sqlite`.
  private async persist(): Promise<void> {
    this.state.fileManifest = Array.from(this.fileManifest.entries()).sort(([a], [b]) => a.localeCompare(b));
    this.state.directoryManifest = normalizeQueue(this.directoryManifest);
    this.state.directoryQueue = normalizeQueue(this.state.directoryQueue);
    this.state.fileQueue = normalizeQueue(this.state.fileQueue);
    await saveIndexArtifact(this.rootDir, SCANNER_ARTIFACT_KEY, this.state, { global: true });
  }
}

// Purpose: Normalize persisted scanner state and discard incompatible cursors.
// Inputs: Repository root and the scanner state loaded from sqlite.
// Returns/Effects: Returns a safe scanner state with current ignore-rule semantics.
function normalizePersistedState(rootDir: string, state: PersistedScannerState): PersistedScannerState {
  if (state.rootDir !== rootDir || state.ignoreRuleHash !== IGNORE_RULE_HASH) {
    return createInitialScannerState(rootDir);
  }
  return {
    ...state,
    rootDir,
    status: state.status === "disabled" ? "bootstrapping" : state.status,
    startedAtMs: Number.isFinite(state.startedAtMs) ? state.startedAtMs : Date.now(),
    directoryQueue: normalizeQueue(state.directoryQueue.length > 0 ? state.directoryQueue : state.directoryManifest),
    fileQueue: normalizeQueue(state.fileQueue),
    directoryManifest: normalizeQueue([".", ...state.directoryManifest]),
    fileManifest: state.fileManifest
      .map(([path, fingerprint]) => [normalizeRelativePath(path), fingerprint] as [string, string])
      .filter(([path, fingerprint]) => Boolean(path && fingerprint)),
    ignoreRuleHash: IGNORE_RULE_HASH,
  };
}
