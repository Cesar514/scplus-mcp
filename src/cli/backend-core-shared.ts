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

export function formatFileProgress(progress: FileSearchIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedDocuments} indexed docs`,
  ].join(" | ");
}

export function formatIdentifierProgress(progress: IdentifierIndexProgress): string {
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} files`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedIdentifiers} indexed identifiers`,
  ].join(" | ");
}

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

export function calculatePercentComplete(
  processedItems: number | undefined,
  totalItems: number | undefined,
): number | undefined {
  if (processedItems === undefined || totalItems === undefined || totalItems <= 0) return undefined;
  const raw = Math.round((processedItems / totalItems) * 100);
  return Math.max(0, Math.min(100, raw));
}

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
