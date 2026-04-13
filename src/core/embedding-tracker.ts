// summary: Tracks source-file changes and schedules incremental embedding refresh work.
// FEATURE: Incremental embedding updates for changed files and identifiers.
// inputs: File watcher events, tracker configuration, and embedding refresh callbacks.
// outputs: Debounced changed-file batches and controlled embedding refresh execution.

import { watch, type FSWatcher } from "fs";
import { refreshFileSearchEmbeddings } from "../tools/semantic-search.js";
import { refreshIdentifierEmbeddings } from "../tools/semantic-identifiers.js";

export interface EmbeddingTrackerOptions {
  rootDir: string;
  debounceMs?: number;
  maxFilesPerTick?: number;
}

export interface EmbeddingTrackerController {
  ensureStarted: () => void;
  stop: () => void;
  isRunning: () => boolean;
}

export interface EmbeddingTrackerControllerOptions extends EmbeddingTrackerOptions {
  mode?: string;
  starter?: (options: EmbeddingTrackerOptions) => () => void;
}

const MIN_FILES_PER_TICK = 5;
const MAX_FILES_PER_TICK = 10;
const DEFAULT_FILES_PER_TICK = 8;
const DEFAULT_DEBOUNCE_MS = 1500;
const MAX_PENDING_FILES = 50;

const IGNORE_PREFIXES = [
  ".scplus/",
  ".git/",
  "node_modules/",
  "build/",
  "dist/",
  "landing/.next/",
];

// Purpose: Normalize watcher-relative paths into stable forward-slash repository paths.
// Inputs: A watcher-reported path that may contain platform-specific separators or leading slashes.
// Returns/Effects: Returns the normalized repository-relative path string.
function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

// Purpose: Decide whether a changed path should trigger embedding refresh work.
// Inputs: The normalized repository-relative path reported by the watcher.
// Returns/Effects: Returns true when the path is non-empty and not inside ignored prefixes.
function shouldTrack(path: string): boolean {
  if (!path) return false;
  return !IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// Purpose: Clamp the per-tick embedding refresh batch size into the supported range.
// Inputs: The optional configured maximum files per tick.
// Returns/Effects: Returns a bounded integer batch size for embedding refresh work.
function clampFilesPerTick(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_FILES_PER_TICK;
  return Math.max(MIN_FILES_PER_TICK, Math.min(MAX_FILES_PER_TICK, Math.floor(value ?? DEFAULT_FILES_PER_TICK)));
}

// Purpose: Clamp the embedding tracker debounce interval into the supported range.
// Inputs: The optional configured debounce duration in milliseconds.
// Returns/Effects: Returns a bounded integer debounce duration.
function clampDebounceMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DEBOUNCE_MS;
  return Math.max(500, Math.floor(value ?? DEFAULT_DEBOUNCE_MS));
}

// Purpose: Normalize the embedding tracker mode string into the supported runtime modes.
// Inputs: The optional embedding tracker mode string from configuration or environment.
// Returns/Effects: Returns the normalized tracker mode literal.
export function parseEmbeddingTrackerMode(value: string | undefined): "off" | "lazy" | "eager" {
  if (!value) return "lazy";
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no", "off", "disabled", "none"].includes(normalized)) return "off";
  if (["eager", "startup", "boot"].includes(normalized)) return "eager";
  return "lazy";
}

// Purpose: Start the filesystem-backed embedding tracker for changed source files.
// Inputs: Embedding tracker options including root directory, debounce interval, and batch size.
// Returns/Effects: Starts file watching and returns a stop function for the tracker.
export function startEmbeddingTracker(options: EmbeddingTrackerOptions): () => void {
  const pendingFiles = new Set<string>();
  const debounceMs = clampDebounceMs(options.debounceMs);
  const maxFilesPerTick = clampFilesPerTick(options.maxFilesPerTick);

  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let isProcessing = false;
  let closed = false;

  const schedule = (delay: number = debounceMs): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flushPending();
    }, delay);
    timer.unref();
  };

  const flushPending = async (): Promise<void> => {
    if (closed || isProcessing) return;
    if (pendingFiles.size === 0) return;

    isProcessing = true;
    const batch = Array.from(pendingFiles).slice(0, maxFilesPerTick);
    for (const file of batch) pendingFiles.delete(file);

    try {
      const [fileEmbeds, identifierEmbeds] = await Promise.all([
        refreshFileSearchEmbeddings({ rootDir: options.rootDir, relativePaths: batch }),
        refreshIdentifierEmbeddings({ rootDir: options.rootDir, relativePaths: batch }),
      ]);
      if (fileEmbeds > 0 || identifierEmbeds > 0) {
        console.error(
          `Embedding tracker refreshed ${batch.length} file(s) | file-vectors=${fileEmbeds}, identifier-vectors=${identifierEmbeds}`,
        );
      }
    } catch (error) {
      console.error("Embedding tracker refresh failed:", error);
    } finally {
      isProcessing = false;
      if (pendingFiles.size > 0) schedule(100);
    }
  };

  try {
    watcher = watch(options.rootDir, { recursive: true }, (_eventType, fileName) => {
      if (closed || !fileName) return;
      const relativePath = normalizeRelativePath(String(fileName));
      if (!shouldTrack(relativePath)) return;
      if (pendingFiles.size >= MAX_PENDING_FILES) return;
      pendingFiles.add(relativePath);
      schedule();
    });
  } catch (error) {
    console.error("Embedding tracker disabled: file watching is unavailable.", error);
    return () => { };
  }

  watcher.on("error", (error) => {
    console.error("Embedding tracker watcher error:", error);
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    watcher = null;
  };
}

// Purpose: Build a mode-aware embedding tracker controller with explicit start and stop operations.
// Inputs: Tracker controller options including runtime mode and optional custom starter.
// Returns/Effects: Returns a controller that manages tracker lifecycle according to the selected mode.
export function createEmbeddingTrackerController(options: EmbeddingTrackerControllerOptions): EmbeddingTrackerController {
  const { mode: rawMode, starter = startEmbeddingTracker, ...trackerOptions } = options;
  const mode = parseEmbeddingTrackerMode(rawMode);

  let running = false;
  let stopTracker = () => { };

  const ensureStarted = (): void => {
    if (running || mode === "off") return;
    stopTracker = starter(trackerOptions);
    running = true;
  };

  if (mode === "eager") ensureStarted();

  return {
    ensureStarted,
    stop: () => {
      if (!running) return;
      running = false;
      const stop = stopTracker;
      stopTracker = () => { };
      stop();
    },
    isRunning: () => running,
  };
}
