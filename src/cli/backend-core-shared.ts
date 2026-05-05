// summary: Shares backend core event types and pure formatting helpers across backend modules.
// FEATURE: Typed backend event contracts and watch or progress formatting utilities.
// inputs: Backend progress objects, changed paths, and typed backend payload values.
// outputs: Normalized event payload types, watch filtering decisions, and user-facing progress summaries.

import type { FullIndexProgress } from "../tools/full-index-artifacts.js";
import type { IndexMode } from "../tools/index-contract.js";
import type { IdentifierIndexProgress } from "../tools/semantic-identifiers.js";
import type { FileSearchIndexProgress } from "../tools/semantic-search.js";

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
export type BackendJobName = "cluster" | "index" | "refresh";
export type ManualIndexMode = IndexMode | "auto";

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
  changedPathsTruncated?: boolean;
  totalChangedPathCount?: number;
  queueDepth?: number;
  rebuildReason?: string;
  processedItems?: number;
  totalItems?: number;
  percentComplete?: number;
  currentFile?: string;
  pendingChangeCount?: number;
  pendingPaths?: string[];
  pendingJobKind?: BackendJobName;
  scannerStatus?: "bootstrapping" | "enabled" | "blocked" | "disabled";
  nativeWatchCount?: number;
  scannerDirectoryQueueSize?: number;
  scannerFileQueueSize?: number;
  scannerKnownDirectoryCount?: number;
  scannerKnownFileCount?: number;
  scannerGeneration?: number;
  scannerLastFullCoverageAt?: string;
  scannerLastFailure?: string;
  scannerLastOverflowReason?: string;
}

export interface TextPayload {
  root: string;
  text: string;
}

export interface WatchStatePayload {
  root: string;
  enabled: boolean;
}

export interface JobControlPayload {
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

export type EventSink = (event: BackendEvent) => Promise<void> | void;

export function shouldWatchPath(path: string): boolean {
  if (!path) return false;
  return !WATCH_IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Purpose: Return the first non-empty trimmed line from a block of report text.
// Inputs: The multi-line text block that should be summarized.
// Returns/Effects: Returns the first non-empty trimmed line or an empty string.
export function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function formatFileFingerprint(size: number, mtimeMs: number): string {
  return `${size}:${mtimeMs}`;
}

// Purpose: Format file-search progress into a compact line for backend job events.
// Inputs: The file-search indexing progress payload emitted by the backend.
// Returns/Effects: Returns a human-readable summary of file-search progress.
export function formatFileProgress(progress: FileSearchIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedDocuments} indexed docs`,
  ].join(" | ");
}

// Purpose: Format identifier-search progress into a compact line for backend job events.
// Inputs: The identifier indexing progress payload emitted by the backend.
// Returns/Effects: Returns a human-readable summary of identifier indexing progress.
export function formatIdentifierProgress(progress: IdentifierIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedIdentifiers} indexed identifiers`,
  ].join(" | ");
}

// Purpose: Format full-index progress into a compact line for backend job events.
// Inputs: The full-index progress payload emitted by the backend.
// Returns/Effects: Returns a human-readable summary of full-index progress.
export function formatFullProgress(progress: FullIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedChunks} indexed chunks`,
    `${progress.indexedStructures} indexed structures`,
  ].join(" | ");
}

// Purpose: Convert processed and total counts into an integer completion percentage.
// Inputs: The processed item count and the total item count for a backend job stage.
// Returns/Effects: Returns the bounded completion percentage when both counts are usable.
export function calculatePercentComplete(
  processedItems: number | undefined,
  totalItems: number | undefined,
): number | undefined {
  if (processedItems === undefined || totalItems === undefined || totalItems <= 0) return undefined;
  const raw = Math.round((processedItems / totalItems) * 100);
  return Math.max(0, Math.min(100, raw));
}

// Purpose: Scale one stage-local percentage into the overall refresh job percentage range.
// Inputs: The stage index, total stage count, and the percentage reported for the current stage.
// Returns/Effects: Returns the bounded overall refresh percentage for the current stage.
export function scaleRefreshPercent(
  stageIndex: number,
  stageCount: number,
  stagePercent: number | undefined,
): number | undefined {
  if (stagePercent === undefined) return undefined;
  const start = Math.floor((100 * stageIndex) / stageCount);
  const end = stageIndex === stageCount - 1
    ? 100
    : Math.floor((100 * (stageIndex + 1)) / stageCount);
  return Math.max(start, Math.min(end, start + Math.round(((end - start) * stagePercent) / 100)));
}
