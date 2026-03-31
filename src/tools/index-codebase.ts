// Project indexing pipeline that materializes durable Context+ repo state
// FEATURE: Codebase indexing entrypoint for .contextplus project initialization

import { access, writeFile } from "fs/promises";
import { basename, join, relative, resolve } from "path";
import { getContextTree } from "./context-tree.js";
import { ensureContextplusLayout } from "../core/project-layout.js";
import { walkDirectory } from "../core/walker.js";
import { ensureFileSearchIndex, type FileSearchIndexProgress, type FileSearchIndexStats } from "./semantic-search.js";
import { ensureIdentifierSearchIndex, type IdentifierIndexProgress, type IdentifierIndexStats } from "./semantic-identifiers.js";
import { ensureFullIndexArtifacts, type FullIndexArtifactStats, type FullIndexProgress } from "./full-index-artifacts.js";
import {
  buildIndexContract,
  DEFAULT_INDEX_MODE,
  INDEX_ARTIFACT_VERSION,
  INDEX_STATUS_FILE,
  type FileManifest,
  type IndexMode,
  type IndexPhase,
  type ProjectIndexConfig,
} from "./index-contract.js";

export interface IndexCodebaseOptions {
  rootDir: string;
  mode?: IndexMode;
}

interface IndexStatus {
  state: "running" | "completed" | "failed";
  phase: IndexPhase;
  indexMode: IndexMode;
  contractVersion: number;
  artifactVersion: number;
  stageOrder: IndexPhase[];
  projectName: string;
  rootDir: string;
  startedAt: string;
  lastUpdatedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  bootstrap?: {
    files: number;
    directories: number;
  };
  fileSearch?: Partial<FileSearchIndexStats>;
  identifierSearch?: Partial<IdentifierIndexStats>;
  fullIndex?: {
    chunkIndex?: Partial<ChunkIndexStatus>;
    structureIndex?: Partial<StructureIndexStatus>;
  };
  error?: string;
}

export interface ChunkIndexStatus {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
}

interface StructureIndexStatus {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedStructures: number;
}

function buildProjectConfig(rootDir: string, mode: IndexMode): ProjectIndexConfig {
  return {
    indexedAt: new Date().toISOString(),
    projectName: basename(resolve(rootDir)),
    rootDir: resolve(rootDir),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    indexMode: mode,
    version: INDEX_ARTIFACT_VERSION,
    contract: buildIndexContract(),
  };
}

async function writeJsonIfMissing(path: string, value: unknown): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  }
}

async function writeIndexStatus(path: string, status: IndexStatus): Promise<void> {
  await writeFile(path, JSON.stringify(status, null, 2) + "\n", "utf8");
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
  ].join(" | ");
}

export async function indexCodebase(options: IndexCodebaseOptions): Promise<string> {
  const rootDir = resolve(options.rootDir);
  const mode = options.mode ?? DEFAULT_INDEX_MODE;
  const layout = await ensureContextplusLayout(rootDir);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory);
  const directories = entries.filter((entry) => entry.isDirectory);
  const tree = await getContextTree({
    rootDir,
    includeSymbols: true,
    maxTokens: 50_000,
  });
  const config = buildProjectConfig(rootDir, mode);
  const configPath = join(layout.config, "project.json");
  const treePath = join(layout.config, "context-tree.txt");
  const manifestPath = join(layout.config, "file-manifest.json");
  const indexStatusPath = join(layout.config, INDEX_STATUS_FILE);
  const graphPath = join(layout.memories, "memory-graph.json");
  const restorePath = join(layout.checkpoints, "restore-points.json");
  const fileIndexPath = join(layout.embeddings, "file-search-index.json");
  const identifierIndexPath = join(layout.embeddings, "identifier-search-index.json");
  const chunkIndexPath = join(layout.derived, "chunk-search-index.json");
  const structureIndexPath = join(layout.derived, "code-structure-index.json");
  const fullManifestPath = join(layout.derived, "full-index-manifest.json");
  const manifest: FileManifest = {
    artifactVersion: config.artifactVersion,
    contractVersion: config.contract.contractVersion,
    directories: directories.map((entry) => entry.relativePath),
    files: files.map((entry) => entry.relativePath),
    generatedAt: config.indexedAt,
    indexMode: mode,
    rootDir,
  };
  const progressLog: string[] = [];
  const status: IndexStatus = {
    state: "running",
    phase: "bootstrap",
    indexMode: mode,
    contractVersion: config.contract.contractVersion,
    artifactVersion: config.artifactVersion,
    stageOrder: config.contract.stageOrder,
    projectName: config.projectName,
    rootDir,
    startedAt,
    lastUpdatedAt: startedAt,
    bootstrap: {
      files: files.length,
      directories: directories.length,
    },
  };

  const appendProgress = (message: string): void => {
    progressLog.push(`${formatProgressPrefix(startedAtMs)} ${message}`);
  };

  const persistStatus = async (): Promise<void> => {
    status.lastUpdatedAt = new Date().toISOString();
    status.elapsedMs = Date.now() - startedAtMs;
    await writeIndexStatus(indexStatusPath, status);
  };

  try {
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    await writeFile(treePath, tree + "\n", "utf8");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await writeJsonIfMissing(graphPath, { nodes: {}, edges: {} });
    await writeJsonIfMissing(restorePath, []);
    appendProgress(`bootstrap | ${files.length} files | ${directories.length} directories`);
    await persistStatus();

    const fileIndexResult = await ensureFileSearchIndex(rootDir, async (progress) => {
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
    });
    status.fileSearch = fileIndexResult.stats;
    appendProgress(
      `file-ready | ${fileIndexResult.stats.indexedDocuments} docs | ${fileIndexResult.stats.embeddedDocuments} embedded | ${fileIndexResult.stats.reusedDocuments} reused`,
    );
    await persistStatus();

    const identifierIndexResult = await ensureIdentifierSearchIndex(rootDir, async (progress) => {
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
    });
    status.identifierSearch = identifierIndexResult.stats;
    appendProgress(
      `identifier-ready | ${identifierIndexResult.stats.indexedIdentifiers} identifiers | ${identifierIndexResult.stats.embeddedIdentifiers} embedded | ${identifierIndexResult.stats.reusedIdentifiers} reused`,
    );

    if (mode === "full") {
      const fullIndexResult = await ensureFullIndexArtifacts({ rootDir }, async (progress) => {
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
        };
        appendProgress(formatFullProgress(progress));
        await persistStatus();
      });
      status.fullIndex = fullIndexResult.stats;
      appendProgress(
        `full-ready | ${fullIndexResult.stats.chunkIndex.indexedChunks} chunks | ` +
        `${fullIndexResult.stats.structureIndex.indexedStructures} structures | ` +
        `${fullIndexResult.stats.chunkIndex.embeddedChunks} chunk embeddings`,
      );
    }

    status.state = "completed";
    status.phase = "completed";
    status.completedAt = new Date().toISOString();
    await persistStatus();
  } catch (error) {
    status.state = "failed";
    status.phase = "failed";
    status.completedAt = new Date().toISOString();
    status.error = error instanceof Error ? error.message : String(error);
    await persistStatus();
    throw error;
  }

  return [
    `Indexed ${config.projectName}`,
    `Root: ${rootDir}`,
    `Context+ root: ${relative(rootDir, layout.root) || ".contextplus"}`,
    `Mode: ${mode}`,
    `Files: ${files.length}`,
    `Directories: ${directories.length}`,
    "",
    "Created or updated:",
    `  ${relative(rootDir, configPath)}`,
    `  ${relative(rootDir, treePath)}`,
    `  ${relative(rootDir, manifestPath)}`,
    `  ${relative(rootDir, indexStatusPath)}`,
    `  ${relative(rootDir, fileIndexPath)}`,
    `  ${relative(rootDir, identifierIndexPath)}`,
    ...(mode === "full"
      ? [
          `  ${relative(rootDir, chunkIndexPath)}`,
          `  ${relative(rootDir, structureIndexPath)}`,
          `  ${relative(rootDir, fullManifestPath)}`,
        ]
      : []),
    `  ${relative(rootDir, graphPath)}`,
    `  ${relative(rootDir, restorePath)}`,
    "",
    "Progress log:",
    ...progressLog.map((line) => `  ${line}`),
  ].join("\n");
}
