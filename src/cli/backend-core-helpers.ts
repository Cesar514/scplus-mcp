// summary: Provides shared helper functions for backend watch planning and observability summaries.
// FEATURE: Shared CLI backend watch decisions and doctor formatting utilities.
// inputs: Backend scheduler state, watch plans, and doctor report source data.
// outputs: Derived watch decisions and formatted observability summary structures.

import { DEFAULT_INDEX_MODE, type IndexMode } from "../tools/index-contract.js";
import type { BridgeDoctorReport } from "./reports.js";

export interface WatchExecutionPlan {
  job: "index" | "refresh";
  mode: IndexMode;
  changedPaths: string[];
  reason: string;
}

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

// Purpose: Summarize a changed-path list into a compact human-readable watch message.
// Inputs: The changed repository-relative paths collected for the current watch batch.
// Returns/Effects: Returns a short textual summary of the changed path set.
export function summarizeChangedPaths(paths: string[]): string {
  if (paths.length === 0) return "no changed paths";
  if (paths.length <= 4) return paths.join(", ");
  return `${paths.slice(0, 4).join(", ")} +${paths.length - 4} more`;
}

export function dedupePaths(paths: Iterable<string>): string[] {
  return Array.from(new Set(paths)).sort();
}

// Purpose: Classify a changed path that should force a full watch-triggered rebuild.
// Inputs: One repository-relative path emitted by the background watcher.
// Returns/Effects: Returns a rebuild reason string when the path requires a full rebuild.
function getWatchFullRebuildReasonForPath(path: string): string | null {
  const normalized = normalizeRelativePath(path);
  const baseName = normalized.split("/").at(-1) ?? normalized;
  if (
    normalized === "package.json"
    || normalized === "package-lock.json"
    || normalized === "pnpm-lock.yaml"
    || normalized === "yarn.lock"
    || normalized === "bun.lock"
    || normalized === "bun.lockb"
    || normalized === "pixi.toml"
    || normalized === "pixi.lock"
    || normalized === "go.mod"
    || normalized === "go.sum"
    || normalized === "Cargo.toml"
    || normalized === "Cargo.lock"
    || normalized === "pyproject.toml"
    || normalized === "poetry.lock"
    || normalized === "uv.lock"
    || normalized === "requirements.txt"
    || normalized === "requirements-dev.txt"
    || normalized === "requirements-dev.lock"
    || normalized === ".gitignore"
  ) {
    return `${normalized} changed dependency or workspace configuration`;
  }
  if (
    baseName === "tsconfig.json"
    || baseName === "jsconfig.json"
    || /^tsconfig\..+\.json$/.test(baseName)
  ) {
    return `${normalized} changed TypeScript or JavaScript compilation settings`;
  }
  return null;
}

// Purpose: Build the watch execution plan for the current set of changed repository paths.
// Inputs: The raw changed paths collected from the file watcher batch.
// Returns/Effects: Returns the watch job kind, mode, changed paths, and reason for execution.
export function buildWatchExecutionPlan(changedPaths: string[]): WatchExecutionPlan {
  const normalizedPaths = dedupePaths(changedPaths);
  const rebuildReasons = normalizedPaths
    .map((path) => getWatchFullRebuildReasonForPath(path))
    .filter((reason): reason is string => Boolean(reason));
  if (rebuildReasons.length > 0) {
    return {
      job: "index",
      mode: DEFAULT_INDEX_MODE,
      changedPaths: normalizedPaths,
      reason: `full rebuild required after watch changes: ${rebuildReasons.join(" | ")}`,
    };
  }
  return {
    job: "refresh",
    mode: DEFAULT_INDEX_MODE,
    changedPaths: normalizedPaths,
    reason: `background incremental refresh for ${summarizeChangedPaths(normalizedPaths)}`,
  };
}

// Purpose: Format indexing-stage observability metrics into a single doctor-report summary line.
// Inputs: The bridge doctor report that includes indexing stage timing and throughput data.
// Returns/Effects: Returns a human-readable summary of indexing observability metrics.
export function formatStageObservabilitySummary(report: BridgeDoctorReport): string {
  const entries = Object.entries(report.observability.indexing.stages);
  if (entries.length === 0) return "observability indexing: no completed stage metrics";
  const stageParts = entries.map(([stage, metrics]) => {
    const throughput = [
      metrics.filesPerSecond ? `files/s=${metrics.filesPerSecond}` : "",
      metrics.chunksPerSecond ? `chunks/s=${metrics.chunksPerSecond}` : "",
      metrics.embedsPerSecond ? `embeds/s=${metrics.embedsPerSecond}` : "",
    ].filter(Boolean).join(" | ");
    return `${stage}=${metrics.durationMs}ms${throughput ? ` (${throughput})` : ""}`;
  });
  return `observability indexing: ${stageParts.join(" ; ")}`;
}

// Purpose: Format integrity observability data from the doctor report into one summary line.
// Inputs: The bridge doctor report that contains vector coverage and integrity metrics.
// Returns/Effects: Returns a human-readable summary of integrity observability state.
export function formatIntegrityObservabilitySummary(report: BridgeDoctorReport): string {
  const parseFailuresByLanguage = Object.entries(report.observability.integrity.parseFailuresByLanguage)
    .map(([language, failures]) => `${language}:${failures}`)
    .join(", ");
  const chunkCoverage = report.hybridVectors.chunk.vectorCoverage;
  const identifierCoverage = report.hybridVectors.identifier.vectorCoverage;
  return [
    "observability integrity:",
    `chunkVectors=${chunkCoverage.loadedVectorCount}/${chunkCoverage.requestedVectorCount} ${chunkCoverage.state}`,
    `identifierVectors=${identifierCoverage.loadedVectorCount}/${identifierCoverage.requestedVectorCount} ${identifierCoverage.state}`,
    `staleAgeMs=${report.observability.integrity.staleGenerationAgeMs ?? "none"}`,
    `fallbackMarkers=${report.observability.integrity.fallbackMarkerCount}`,
    `parseFailuresByLanguage=${parseFailuresByLanguage || "none"}`,
    `fileRefreshFailures=${report.observability.integrity.refreshFailures.fileSearch.refreshFailures}`,
    `writeRefreshFailures=${report.observability.integrity.refreshFailures.writeFreshness.refreshFailures}`,
  ].join(" | ");
}

// Purpose: Format scheduler observability counters into a compact doctor-report summary line.
// Inputs: The bridge doctor report that includes watcher and scheduler observability metrics.
// Returns/Effects: Returns a human-readable summary of scheduler observability state.
export function formatSchedulerObservabilitySummary(report: BridgeDoctorReport): string {
  const scheduler = report.observability.scheduler;
  return [
    "observability scheduler:",
    `watch=${scheduler.watchEnabled ? "enabled" : "disabled"}`,
    `queueDepth=${scheduler.queueDepth}`,
    `pendingChanges=${scheduler.pendingChangeCount}`,
    `pendingJob=${scheduler.pendingJobKind ?? "none"}`,
    `maxQueueDepth=${scheduler.maxQueueDepth}`,
    `batches=${scheduler.batchCount}`,
    `deduped=${scheduler.dedupedPathEvents}`,
    `canceled=${scheduler.canceledJobs}`,
    `superseded=${scheduler.supersededJobs}`,
  ].join(" | ");
}
