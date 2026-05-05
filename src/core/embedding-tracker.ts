// summary: Refreshes embeddings from backend-owned change batches without native filesystem watches.
// purpose: Keep semantic caches current while avoiding recursive `fs.watch` and inotify pressure.
// inputs: Backend watch batches, tracker compatibility configuration, and embedding refresh callbacks.
// returns/effects: Refreshes changed-file embeddings or loudly rejects obsolete native tracker startup.

import { stat } from "node:fs/promises";
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

// Purpose: Return path prefixes excluded from backend-batch embedding refresh.
// Inputs: No direct inputs beyond the repository ignore policy encoded here.
// Returns/Effects: Returns a fresh immutable prefix list for path filtering.
function getIgnorePrefixes(): readonly string[] {
  return [
    ".scplus/",
    ".git/",
    "node_modules/",
    "build/",
    "dist/",
    "landing/.next/",
  ] as const;
}

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
  return !getIgnorePrefixes().some((prefix) => path.startsWith(prefix));
}

// Purpose: Normalize the embedding tracker mode string into the supported runtime modes.
// Inputs: The optional embedding tracker mode string from configuration or environment.
// Returns/Effects: Returns the normalized tracker mode literal.
export function parseEmbeddingTrackerMode(value: string | undefined): "off" | "lazy" | "eager" {
  if (!value) return "off";
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no", "off", "disabled", "none"].includes(normalized)) return "off";
  if (["eager", "startup", "boot"].includes(normalized)) return "eager";
  return "lazy";
}

// Purpose: Reject obsolete native embedding tracker startup paths.
// Inputs: Embedding tracker options retained for API compatibility during migration.
// Returns/Effects: Throws because recursive native watching is no longer allowed.
export function startEmbeddingTracker(options: EmbeddingTrackerOptions): () => void {
  throw new Error(
    `Native embedding tracker startup is disabled for ${options.rootDir}; use backend watch batches via refreshEmbeddingsForChangedPaths.`,
  );
}

// Purpose: Filter changed paths down to currently readable tracked files.
// Inputs: Repository root and the changed paths emitted by the backend scanner.
// Returns/Effects: Returns existing file paths that should refresh embedding caches.
async function filterExistingTrackedFiles(rootDir: string, relativePaths: string[]): Promise<string[]> {
  const uniquePaths = Array.from(new Set(relativePaths.map(normalizeRelativePath).filter(shouldTrack)));
  const results = await Promise.all(uniquePaths.map(async (relativePath) => {
    const info = await stat(`${rootDir}/${relativePath}`).catch((error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    return info?.isFile() ? relativePath : undefined;
  }));
  return results.filter((path): path is string => Boolean(path));
}

// Purpose: Refresh semantic embedding caches for a backend-owned watch batch.
// Inputs: Repository root and changed relative paths from the bounded backend scanner.
// Returns/Effects: Refreshes file and identifier embeddings for existing changed files.
export async function refreshEmbeddingsForChangedPaths(options: EmbeddingTrackerOptions & { relativePaths: string[] }): Promise<{
  fileEmbeddings: number;
  identifierEmbeddings: number;
  refreshedPaths: string[];
}> {
  const refreshedPaths = await filterExistingTrackedFiles(options.rootDir, options.relativePaths);
  if (refreshedPaths.length === 0) return { fileEmbeddings: 0, identifierEmbeddings: 0, refreshedPaths };
  const [fileEmbeddings, identifierEmbeddings] = await Promise.all([
    refreshFileSearchEmbeddings({ rootDir: options.rootDir, relativePaths: refreshedPaths }),
    refreshIdentifierEmbeddings({ rootDir: options.rootDir, relativePaths: refreshedPaths }),
  ]);
  return { fileEmbeddings, identifierEmbeddings, refreshedPaths };
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
