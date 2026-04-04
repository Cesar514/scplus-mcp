// summary: Orchestrates the codebase indexing pipeline that materializes durable scplus state.
// FEATURE: Codebase indexing entrypoint for .scplus project initialization.
// inputs: Repository roots, indexing mode selection, and stage execution dependencies.
// outputs: Fresh generations of durable scplus index artifacts and status metadata.

import { relative } from "path";
import { acquireRepoRuntimeLock } from "../core/runtime-locks.js";
import { activateIndexGeneration, clearPendingIndexGeneration, reservePendingIndexGeneration, runWithIndexGenerationContext } from "../core/index-database.js";
import { type FileSearchIndexProgress } from "./semantic-search.js";
import { type IdentifierIndexProgress } from "./semantic-identifiers.js";
import { type FullIndexProgress } from "./full-index-artifacts.js";
import { DEFAULT_INDEX_MODE, getStageDefinitions, type IndexMode, type PersistedIndexStageState } from "./index-contract.js";
import {
  createIndexRuntime,
  executeIndexStage,
  loadIndexStageState,
  loadIndexStatus,
  saveIndexStageState,
  saveIndexStatus,
  type IndexObservabilityStatus,
  type IndexStageObservabilityStatus,
  type IndexStatus,
  type IndexStageRuntime,
} from "./index-stages.js";

export interface IndexCodebaseOptions {
  rootDir: string;
  mode?: IndexMode;
  onProgress?: (event: IndexCodebaseProgressEvent) => Promise<void> | void;
  skipRuntimeMutationLock?: boolean;
}

export interface IndexCodebaseProgressEvent {
  elapsedMs: number;
  message: string;
  phase: string;
  rootDir: string;
  mode: IndexMode;
  processedItems?: number;
  totalItems?: number;
  percentComplete?: number;
  currentFile?: string;
}

interface StageTimingRecorder {
  currentPhase?: IndexCodebaseProgressEvent["phase"];
  phaseDurationsMs: Partial<Record<IndexCodebaseProgressEvent["phase"], number>>;
  phaseStartedAtMs?: number;
  startedAtMs: number;
}

export interface IndexProgressPersistenceControllerOptions {
  persist: () => Promise<void> | void;
  now?: () => number;
  minIntervalMs?: number;
}

const DEFAULT_PROGRESS_PERSIST_INTERVAL_MS = 1000;

function createStageTimingRecorder(startedAtMs: number): StageTimingRecorder {
  return {
    phaseDurationsMs: {},
    startedAtMs,
  };
}

function noteStagePhase(recorder: StageTimingRecorder, phase: IndexCodebaseProgressEvent["phase"], nowMs: number = Date.now()): void {
  if (recorder.currentPhase === phase) return;
  if (recorder.currentPhase && recorder.phaseStartedAtMs !== undefined) {
    recorder.phaseDurationsMs[recorder.currentPhase] = (recorder.phaseDurationsMs[recorder.currentPhase] ?? 0) + (nowMs - recorder.phaseStartedAtMs);
  }
  recorder.currentPhase = phase;
  recorder.phaseStartedAtMs = nowMs;
}

function finalizeStageTiming(recorder: StageTimingRecorder, nowMs: number = Date.now()): {
  durationMs: number;
  phaseDurationsMs: Partial<Record<IndexCodebaseProgressEvent["phase"], number>>;
} {
  if (recorder.currentPhase && recorder.phaseStartedAtMs !== undefined) {
    recorder.phaseDurationsMs[recorder.currentPhase] = (recorder.phaseDurationsMs[recorder.currentPhase] ?? 0) + (nowMs - recorder.phaseStartedAtMs);
    recorder.phaseStartedAtMs = nowMs;
  }
  return {
    durationMs: Math.max(0, nowMs - recorder.startedAtMs),
    phaseDurationsMs: { ...recorder.phaseDurationsMs },
  };
}

function ratePerSecond(count: number | undefined, durationMs: number | undefined): number | undefined {
  if (!count || count <= 0 || !durationMs || durationMs <= 0) return undefined;
  return Number(((count / durationMs) * 1000).toFixed(2));
}

function buildStageObservabilityStatus(
  stage: "bootstrap" | "file-search" | "identifier-search" | "full-artifacts",
  timing: ReturnType<typeof finalizeStageTiming>,
  status: IndexStatus,
): IndexStageObservabilityStatus {
  if (stage === "bootstrap") {
    return {
      durationMs: timing.durationMs,
      phaseDurationsMs: timing.phaseDurationsMs,
      processedFiles: status.bootstrap?.files,
      filesPerSecond: ratePerSecond(status.bootstrap?.files, timing.phaseDurationsMs.bootstrap ?? timing.durationMs),
    };
  }
  if (stage === "file-search") {
    return {
      durationMs: timing.durationMs,
      phaseDurationsMs: timing.phaseDurationsMs,
      processedFiles: status.fileSearch?.processedFiles,
      embeddedCount: status.fileSearch?.embeddedDocuments,
      filesPerSecond: ratePerSecond(status.fileSearch?.processedFiles, timing.phaseDurationsMs["file-scan"] ?? timing.durationMs),
      embedsPerSecond: ratePerSecond(status.fileSearch?.embeddedDocuments, timing.phaseDurationsMs["file-embeddings"] ?? timing.durationMs),
    };
  }
  if (stage === "identifier-search") {
    return {
      durationMs: timing.durationMs,
      phaseDurationsMs: timing.phaseDurationsMs,
      processedFiles: status.identifierSearch?.processedFiles,
      embeddedCount: status.identifierSearch?.embeddedIdentifiers,
      filesPerSecond: ratePerSecond(status.identifierSearch?.processedFiles, timing.phaseDurationsMs["identifier-scan"] ?? timing.durationMs),
      embedsPerSecond: ratePerSecond(status.identifierSearch?.embeddedIdentifiers, timing.phaseDurationsMs["identifier-embeddings"] ?? timing.durationMs),
    };
  }
  return {
    durationMs: timing.durationMs,
    phaseDurationsMs: timing.phaseDurationsMs,
    processedFiles: status.fullIndex?.chunkIndex?.processedFiles ?? status.fullIndex?.structureIndex?.processedFiles,
    indexedChunks: status.fullIndex?.chunkIndex?.indexedChunks,
    embeddedCount: status.fullIndex?.chunkIndex?.embeddedChunks,
    filesPerSecond: ratePerSecond(
      status.fullIndex?.chunkIndex?.processedFiles ?? status.fullIndex?.structureIndex?.processedFiles,
      timing.phaseDurationsMs["chunk-scan"] ?? timing.phaseDurationsMs["structure-scan"] ?? timing.durationMs,
    ),
    chunksPerSecond: ratePerSecond(status.fullIndex?.chunkIndex?.indexedChunks, timing.phaseDurationsMs["chunk-scan"] ?? timing.durationMs),
    embedsPerSecond: ratePerSecond(status.fullIndex?.chunkIndex?.embeddedChunks, timing.phaseDurationsMs["chunk-embeddings"] ?? timing.durationMs),
  };
}

function ensureObservabilityStatus(status: IndexStatus): IndexObservabilityStatus {
  const existing = status.observability ?? { stages: {} };
  status.observability = existing;
  return existing;
}

export function createIndexProgressPersistenceController(options: IndexProgressPersistenceControllerOptions): {
  persist(phase: string): Promise<boolean>;
} {
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_PROGRESS_PERSIST_INTERVAL_MS;
  let lastPersistedAt = Number.NEGATIVE_INFINITY;
  let lastPersistedPhase = "";
  return {
    async persist(phase: string): Promise<boolean> {
      const persistedAt = now();
      if (phase === lastPersistedPhase && persistedAt - lastPersistedAt < minIntervalMs) return false;
      await options.persist();
      lastPersistedAt = persistedAt;
      lastPersistedPhase = phase;
      return true;
    },
  };
}

function formatProgressPrefix(startedAtMs: number): string {
  return `[${((Date.now() - startedAtMs) / 1000).toFixed(1)}s]`;
}

function calculatePercentComplete(processedItems: number | undefined, totalItems: number | undefined): number | undefined {
  if (processedItems === undefined || totalItems === undefined || totalItems <= 0) return undefined;
  const raw = Math.round((processedItems / totalItems) * 100);
  return Math.max(0, Math.min(100, raw));
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
  const unit = progress.phase === "chunk-embeddings"
    ? "chunks"
    : progress.phase === "explanation-scan"
      ? "cards"
      : "files";
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} ${unit}`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedChunks} indexed chunks`,
    `${progress.indexedStructures} indexed structures`,
    `${progress.indexedHybridChunks} hybrid chunk docs`,
    `${progress.indexedHybridIdentifiers} hybrid identifier docs`,
    `${progress.indexedQueryExplanations} explanation cards`,
  ].join(" | ");
}

interface StageExecutionContext {
  runtime: IndexStageRuntime;
  status: IndexStatus;
  stageState: PersistedIndexStageState;
  persistStatusImmediately: () => Promise<void>;
  progressPersistence: { persist(phase: string): Promise<boolean> };
  appendProgress: (message: string, progress?: Partial<Pick<IndexCodebaseProgressEvent, "processedItems" | "totalItems" | "currentFile">>) => void;
}

async function runBootstrapStage(ctx: StageExecutionContext): Promise<void> {
  const { runtime, status, stageState, persistStatusImmediately, appendProgress } = ctx;
  const bootstrapTiming = createStageTimingRecorder(Date.now());
  noteStagePhase(bootstrapTiming, "bootstrap", bootstrapTiming.startedAtMs);
  await executeIndexStage({
    runtime,
    status,
    stageState,
    stage: "bootstrap",
    persist: persistStatusImmediately,
  });
  appendProgress(
    `bootstrap | ${status.bootstrap?.files ?? 0} files | ${status.bootstrap?.directories ?? 0} directories`,
    {
      processedItems: status.bootstrap?.files,
      totalItems: status.bootstrap?.files,
    },
  );
  status.observability!.stages.bootstrap = buildStageObservabilityStatus("bootstrap", finalizeStageTiming(bootstrapTiming), status);
  await persistStatusImmediately();
}

async function runFileSearchStage(ctx: StageExecutionContext): Promise<void> {
  const { runtime, status, stageState, persistStatusImmediately, progressPersistence, appendProgress } = ctx;
  const fileSearchTiming = createStageTimingRecorder(Date.now());
  await executeIndexStage({
    runtime,
    status,
    stageState,
    stage: "file-search",
    persist: persistStatusImmediately,
    onFileProgress: async (progress) => {
      noteStagePhase(fileSearchTiming, progress.phase);
      status.phase = progress.phase;
      status.fileSearch = {
        ...status.fileSearch,
        totalFiles: progress.totalFiles,
        processedFiles: progress.processedFiles,
        changedFiles: progress.changedFiles,
        removedFiles: progress.removedFiles,
        indexedDocuments: progress.indexedDocuments,
      };
      appendProgress(formatFileProgress(progress), {
        processedItems: progress.processedFiles,
        totalItems: progress.totalFiles,
        currentFile: progress.currentFile,
      });
      await progressPersistence.persist(status.phase);
    },
  });
  noteStagePhase(fileSearchTiming, "file-embeddings");
  appendProgress(
    `file-ready | ${status.fileSearch?.indexedDocuments ?? 0} docs | ` +
    `${status.fileSearch?.embeddedDocuments ?? 0} embedded | ${status.fileSearch?.reusedDocuments ?? 0} reused`,
    {
      processedItems: status.fileSearch?.processedFiles,
      totalItems: status.fileSearch?.totalFiles,
    },
  );
  status.observability!.stages["file-search"] = buildStageObservabilityStatus("file-search", finalizeStageTiming(fileSearchTiming), status);
  await persistStatusImmediately();
}

async function runIdentifierSearchStage(ctx: StageExecutionContext): Promise<void> {
  const { runtime, status, stageState, persistStatusImmediately, progressPersistence, appendProgress } = ctx;
  const identifierTiming = createStageTimingRecorder(Date.now());
  await executeIndexStage({
    runtime,
    status,
    stageState,
    stage: "identifier-search",
    persist: persistStatusImmediately,
    onIdentifierProgress: async (progress) => {
      noteStagePhase(identifierTiming, progress.phase);
      status.phase = progress.phase;
      status.identifierSearch = {
        ...status.identifierSearch,
        totalFiles: progress.totalFiles,
        processedFiles: progress.processedFiles,
        changedFiles: progress.changedFiles,
        removedFiles: progress.removedFiles,
        indexedIdentifiers: progress.indexedIdentifiers,
      };
      appendProgress(formatIdentifierProgress(progress), {
        processedItems: progress.processedFiles,
        totalItems: progress.totalFiles,
        currentFile: progress.currentFile,
      });
      await progressPersistence.persist(status.phase);
    },
  });
  noteStagePhase(identifierTiming, "identifier-embeddings");
  appendProgress(
    `identifier-ready | ${status.identifierSearch?.indexedIdentifiers ?? 0} identifiers | ` +
    `${status.identifierSearch?.embeddedIdentifiers ?? 0} embedded | ${status.identifierSearch?.reusedIdentifiers ?? 0} reused`,
    {
      processedItems: status.identifierSearch?.processedFiles,
      totalItems: status.identifierSearch?.totalFiles,
    },
  );
  status.observability!.stages["identifier-search"] = buildStageObservabilityStatus("identifier-search", finalizeStageTiming(identifierTiming), status);
}

async function runFullArtifactsStage(ctx: StageExecutionContext): Promise<void> {
  const { runtime, status, stageState, persistStatusImmediately, progressPersistence, appendProgress } = ctx;
  const fullArtifactsTiming = createStageTimingRecorder(Date.now());
  await executeIndexStage({
    runtime,
    status,
    stageState,
    stage: "full-artifacts",
    persist: persistStatusImmediately,
    onFullProgress: async (progress) => {
      noteStagePhase(fullArtifactsTiming, progress.phase);
      status.phase = progress.phase;
      status.fullIndex = {
        ...status.fullIndex,
        chunkIndex: {
          ...(status.fullIndex?.chunkIndex ?? {}),
          totalFiles: progress.totalFiles,
          processedFiles: progress.processedFiles,
          changedFiles: progress.changedFiles,
          removedFiles: progress.removedFiles,
          indexedChunks: progress.indexedChunks,
        },
        structureIndex: {
          ...(status.fullIndex?.structureIndex ?? {}),
          totalFiles: progress.totalFiles,
          processedFiles: progress.processedFiles,
          changedFiles: progress.changedFiles,
          removedFiles: progress.removedFiles,
          indexedStructures: progress.indexedStructures,
        },
        hybridChunkIndex: {
          ...(status.fullIndex?.hybridChunkIndex ?? {}),
          indexedDocuments: progress.indexedHybridChunks,
        },
        hybridIdentifierIndex: {
          ...(status.fullIndex?.hybridIdentifierIndex ?? {}),
          indexedDocuments: progress.indexedHybridIdentifiers,
        },
        queryExplanationIndex: {
          ...(status.fullIndex?.queryExplanationIndex ?? {}),
          fileCardCount: progress.indexedQueryExplanations,
        },
      };
      appendProgress(formatFullProgress(progress), {
        processedItems: progress.processedFiles,
        totalItems: progress.totalFiles,
        currentFile: progress.currentFile,
      });
      await progressPersistence.persist(status.phase);
    },
  });
  noteStagePhase(fullArtifactsTiming, "explanation-scan");
  appendProgress(
    `full-ready | ${status.fullIndex?.chunkIndex?.indexedChunks ?? 0} chunks | ` +
    `${status.fullIndex?.structureIndex?.indexedStructures ?? 0} structures | ` +
    `${status.fullIndex?.chunkIndex?.embeddedChunks ?? 0} chunk embeddings | ` +
    `${status.fullIndex?.hybridChunkIndex?.indexedDocuments ?? 0} hybrid chunk docs | ` +
    `${status.fullIndex?.hybridIdentifierIndex?.indexedDocuments ?? 0} hybrid identifier docs | ` +
    `${status.fullIndex?.queryExplanationIndex?.fileCardCount ?? 0} explanation cards`,
    {
      processedItems: status.fullIndex?.chunkIndex?.processedFiles ?? status.fullIndex?.structureIndex?.processedFiles,
      totalItems: status.fullIndex?.chunkIndex?.totalFiles ?? status.fullIndex?.structureIndex?.totalFiles,
    },
  );
  status.observability!.stages["full-artifacts"] = buildStageObservabilityStatus("full-artifacts", finalizeStageTiming(fullArtifactsTiming), status);
}

export async function indexCodebase(options: IndexCodebaseOptions): Promise<string> {
  const rootDir = options.rootDir;
  const mode = options.mode ?? DEFAULT_INDEX_MODE;
  const mutationLock = options.skipRuntimeMutationLock
    ? null
    : await acquireRepoRuntimeLock(rootDir, "mutation", {
      holder: `prepared ${mode} index build`,
      timeoutMs: 0,
    });
  try {
  const pendingGeneration = await reservePendingIndexGeneration(rootDir);
  const runtime = await createIndexRuntime({ rootDir, mode, generation: pendingGeneration });
  const { layout, paths, config } = runtime;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const progressLog: string[] = [];
  const stageState = await loadIndexStageState(runtime);
  const status = await loadIndexStatus(runtime, startedAt);
  ensureObservabilityStatus(status);
  status.state = "running";
  status.phase = "bootstrap";
  status.runGeneration = pendingGeneration;
  status.pendingGeneration = pendingGeneration;
  status.latestGeneration = Math.max(status.latestGeneration, pendingGeneration);
  status.indexMode = mode;
  status.error = undefined;
  status.completedAt = undefined;
  status.failedGeneration = undefined;

  const appendProgress = (
    message: string,
    progress: Partial<Pick<IndexCodebaseProgressEvent, "processedItems" | "totalItems" | "currentFile">> = {},
  ): void => {
    progressLog.push(`${formatProgressPrefix(startedAtMs)} ${message}`);
    void options.onProgress?.({
      elapsedMs: Date.now() - startedAtMs,
      message,
      phase: status.phase,
      rootDir,
      mode,
      processedItems: progress.processedItems,
      totalItems: progress.totalItems,
      currentFile: progress.currentFile,
      percentComplete: calculatePercentComplete(progress.processedItems, progress.totalItems),
    });
  };

  const persistStatusImmediately = async (): Promise<void> => {
    await saveIndexStageState(runtime, stageState);
    await saveIndexStatus(runtime, status, startedAtMs);
  };
  const progressPersistence = createIndexProgressPersistenceController({
    persist: persistStatusImmediately,
  });

  try {
    const ctx: StageExecutionContext = {
      runtime,
      status,
      stageState,
      persistStatusImmediately,
      progressPersistence,
      appendProgress,
    };

    await runWithIndexGenerationContext({
      readGeneration: runtime.servingState.activeGeneration,
      writeGeneration: pendingGeneration,
    }, async () => {
      await runBootstrapStage(ctx);
      await runFileSearchStage(ctx);
      await runIdentifierSearchStage(ctx);
    });

    if (mode === "full") {
      await runWithIndexGenerationContext({
        readGeneration: pendingGeneration,
        writeGeneration: pendingGeneration,
      }, async () => {
        await runFullArtifactsStage(ctx);
      });
    }

    const { formatIndexValidationReport, validatePreparedIndex } = await import("./index-reliability.js");
    const validation = await validatePreparedIndex({ rootDir, mode, generation: pendingGeneration });
    if (!validation.ok) {
      throw new Error(`Indexed generation ${pendingGeneration} failed validation.\n${formatIndexValidationReport(validation)}`);
    }
    const activated = await activateIndexGeneration(rootDir, pendingGeneration, validation.checkedAt);
    status.state = "completed";
    status.phase = "completed";
    status.activeGeneration = activated.activeGeneration;
    status.pendingGeneration = activated.pendingGeneration;
    status.latestGeneration = activated.latestGeneration;
    status.activeGenerationValidatedAt = activated.activeGenerationValidatedAt;
    status.activeGenerationFreshness = activated.activeGenerationFreshness;
    status.activeGenerationBlockedReason = activated.activeGenerationBlockedReason;
    status.runGeneration = pendingGeneration;
    status.completedAt = new Date().toISOString();
    await persistStatusImmediately();
  } catch (error) {
    const servingState = await clearPendingIndexGeneration(rootDir, pendingGeneration);
    status.state = "failed";
    status.phase = "failed";
    status.activeGeneration = servingState.activeGeneration;
    status.pendingGeneration = servingState.pendingGeneration;
    status.latestGeneration = servingState.latestGeneration;
    status.activeGenerationValidatedAt = servingState.activeGenerationValidatedAt;
    status.activeGenerationFreshness = servingState.activeGenerationFreshness;
    status.activeGenerationBlockedReason = servingState.activeGenerationBlockedReason;
    status.failedGeneration = pendingGeneration;
    status.completedAt = new Date().toISOString();
    status.error = error instanceof Error ? error.message : String(error);
    await persistStatusImmediately();
    throw error;
  }

    const stageDefinitions = getStageDefinitions();
    return [
      `Indexed ${config.projectName}`,
      `Root: ${runtime.rootDir}`,
      `scplus root: ${relative(rootDir, layout.root) || ".scplus"}`,
      `Mode: ${mode}`,
      `Files: ${status.bootstrap?.files ?? 0}`,
      `Directories: ${status.bootstrap?.directories ?? 0}`,
      "",
      "Created or updated:",
      ...stageDefinitions.bootstrap.outputs.map((path) => `  ${path}`),
      ...stageDefinitions["file-search"].outputs.map((path) => `  ${path}`),
      ...stageDefinitions["identifier-search"].outputs.map((path) => `  ${path}`),
      ...(mode === "full"
        ? stageDefinitions["full-artifacts"].outputs.map((path) => `  ${path}`)
        : []),
      "",
      "Progress log:",
      ...progressLog.map((line) => `  ${line}`),
    ].join("\n");
  } finally {
    await mutationLock?.release();
  }
}
