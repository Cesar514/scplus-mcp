// Project indexing pipeline that materializes durable Context+ repo state
// FEATURE: Codebase indexing entrypoint for .contextplus project initialization

import { relative } from "path";
import { activateIndexGeneration, clearPendingIndexGeneration, reservePendingIndexGeneration, runWithIndexGenerationContext } from "../core/index-database.js";
import { type FileSearchIndexProgress } from "./semantic-search.js";
import { type IdentifierIndexProgress } from "./semantic-identifiers.js";
import { type FullIndexProgress } from "./full-index-artifacts.js";
import { DEFAULT_INDEX_MODE, getStageDefinitions, type IndexMode } from "./index-contract.js";
import { createIndexRuntime, executeIndexStage, loadIndexStageState, loadIndexStatus, saveIndexStageState, saveIndexStatus, type ChunkIndexStatus, type IndexStatus } from "./index-stages.js";

export interface IndexCodebaseOptions {
  rootDir: string;
  mode?: IndexMode;
  onProgress?: (event: IndexCodebaseProgressEvent) => Promise<void> | void;
}

export interface IndexCodebaseProgressEvent {
  elapsedMs: number;
  message: string;
  phase: string;
  rootDir: string;
  mode: IndexMode;
}

function formatProgressPrefix(startedAtMs: number): string {
  return `[${((Date.now() - startedAtMs) / 1000).toFixed(1)}s]`;
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
  const unit = progress.phase === "chunk-embeddings" ? "chunks" : "files";
  return [
    progress.phase,
    `${progress.processedFiles}/${progress.totalFiles} ${unit}`,
    `${progress.changedFiles} changed`,
    `${progress.removedFiles} removed`,
    `${progress.indexedChunks} indexed chunks`,
    `${progress.indexedStructures} indexed structures`,
    `${progress.indexedHybridChunks} hybrid chunk docs`,
    `${progress.indexedHybridIdentifiers} hybrid identifier docs`,
  ].join(" | ");
}

export async function indexCodebase(options: IndexCodebaseOptions): Promise<string> {
  const rootDir = options.rootDir;
  const mode = options.mode ?? DEFAULT_INDEX_MODE;
  const pendingGeneration = await reservePendingIndexGeneration(rootDir);
  const runtime = await createIndexRuntime({ rootDir, mode, generation: pendingGeneration });
  const { layout, paths, config } = runtime;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const progressLog: string[] = [];
  const stageState = await loadIndexStageState(runtime);
  const status = await loadIndexStatus(runtime, startedAt);
  status.state = "running";
  status.phase = "bootstrap";
  status.runGeneration = pendingGeneration;
  status.pendingGeneration = pendingGeneration;
  status.latestGeneration = Math.max(status.latestGeneration, pendingGeneration);
  status.indexMode = mode;
  status.error = undefined;
  status.completedAt = undefined;
  status.failedGeneration = undefined;

  const appendProgress = (message: string): void => {
    progressLog.push(`${formatProgressPrefix(startedAtMs)} ${message}`);
    void options.onProgress?.({
      elapsedMs: Date.now() - startedAtMs,
      message,
      phase: status.phase,
      rootDir,
      mode,
    });
  };

  const persistStatus = async (): Promise<void> => {
    await saveIndexStageState(runtime, stageState);
    await saveIndexStatus(runtime, status, startedAtMs);
  };

  try {
    await runWithIndexGenerationContext({
      readGeneration: runtime.servingState.activeGeneration,
      writeGeneration: pendingGeneration,
    }, async () => {
      await executeIndexStage({
      runtime,
      status,
      stageState,
      stage: "bootstrap",
      persist: persistStatus,
      });
      appendProgress(`bootstrap | ${status.bootstrap?.files ?? 0} files | ${status.bootstrap?.directories ?? 0} directories`);
      await persistStatus();

      await executeIndexStage({
        runtime,
        status,
        stageState,
        stage: "file-search",
        persist: persistStatus,
        onFileProgress: async (progress) => {
        status.phase = progress.phase;
        status.fileSearch = {
          ...status.fileSearch,
          totalFiles: progress.totalFiles,
          processedFiles: progress.processedFiles,
          changedFiles: progress.changedFiles,
          removedFiles: progress.removedFiles,
          indexedDocuments: progress.indexedDocuments,
        };
        appendProgress(formatFileProgress(progress));
        await persistStatus();
      },
      });
      appendProgress(
        `file-ready | ${status.fileSearch?.indexedDocuments ?? 0} docs | ` +
        `${status.fileSearch?.embeddedDocuments ?? 0} embedded | ${status.fileSearch?.reusedDocuments ?? 0} reused`,
      );
      await persistStatus();

      await executeIndexStage({
        runtime,
        status,
        stageState,
        stage: "identifier-search",
        persist: persistStatus,
        onIdentifierProgress: async (progress) => {
        status.phase = progress.phase;
        status.identifierSearch = {
          ...status.identifierSearch,
          totalFiles: progress.totalFiles,
          processedFiles: progress.processedFiles,
          changedFiles: progress.changedFiles,
          removedFiles: progress.removedFiles,
          indexedIdentifiers: progress.indexedIdentifiers,
        };
        appendProgress(formatIdentifierProgress(progress));
        await persistStatus();
      },
      });
      appendProgress(
        `identifier-ready | ${status.identifierSearch?.indexedIdentifiers ?? 0} identifiers | ` +
        `${status.identifierSearch?.embeddedIdentifiers ?? 0} embedded | ${status.identifierSearch?.reusedIdentifiers ?? 0} reused`,
      );
    });

    if (mode === "full") {
      await runWithIndexGenerationContext({
        readGeneration: pendingGeneration,
        writeGeneration: pendingGeneration,
      }, async () => {
        await executeIndexStage({
          runtime,
          status,
          stageState,
          stage: "full-artifacts",
          persist: persistStatus,
          onFullProgress: async (progress) => {
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
          };
          appendProgress(formatFullProgress(progress));
          await persistStatus();
        },
        });
        appendProgress(
          `full-ready | ${status.fullIndex?.chunkIndex?.indexedChunks ?? 0} chunks | ` +
          `${status.fullIndex?.structureIndex?.indexedStructures ?? 0} structures | ` +
          `${status.fullIndex?.chunkIndex?.embeddedChunks ?? 0} chunk embeddings | ` +
          `${status.fullIndex?.hybridChunkIndex?.indexedDocuments ?? 0} hybrid chunk docs | ` +
          `${status.fullIndex?.hybridIdentifierIndex?.indexedDocuments ?? 0} hybrid identifier docs`,
        );
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
    await persistStatus();
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
    await persistStatus();
    throw error;
  }

  const stageDefinitions = getStageDefinitions();
  return [
    `Indexed ${config.projectName}`,
    `Root: ${runtime.rootDir}`,
    `Context+ root: ${relative(rootDir, layout.root) || ".contextplus"}`,
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
}
