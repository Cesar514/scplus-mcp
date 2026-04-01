// Durable stage runners for the Context+ indexing pipeline
// FEATURE: Rerunnable sqlite-only indexing stages with legacy artifact cleanup

import { readFile, readdir } from "fs/promises";
import { basename, join, resolve } from "path";
import { deleteLegacyArtifacts, loadIndexArtifact, saveIndexArtifact, saveIndexTextArtifact } from "../core/index-database.js";
import { getContextTree } from "./context-tree.js";
import { ensureContextplusLayout, type ContextplusLayout } from "../core/project-layout.js";
import { walkDirectory } from "../core/walker.js";
import { ensureFileSearchIndex, type FileSearchIndexProgress, type FileSearchIndexStats } from "./semantic-search.js";
import { ensureIdentifierSearchIndex, type IdentifierIndexProgress, type IdentifierIndexStats } from "./semantic-identifiers.js";
import { ensureFullIndexArtifacts, type FullIndexArtifactStats, type FullIndexProgress } from "./full-index-artifacts.js";
import {
  buildIndexContract,
  DEFAULT_INDEX_MODE,
  INDEX_ARTIFACT_VERSION,
  INDEX_STAGE_STATE_FILE,
  INDEX_STATUS_FILE,
  getStageDefinitions,
  type FileManifest,
  type IndexMode,
  type IndexPhase,
  type IndexStageName,
  type PersistedIndexStageRecord,
  type PersistedIndexStageState,
  type ProjectIndexConfig,
} from "./index-contract.js";

export interface ChunkIndexStatus {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
}

export interface StructureIndexStatus {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedStructures: number;
}

export interface IndexStatus {
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
  stages: PersistedIndexStageState["stages"];
  error?: string;
}

export interface IndexRuntimePaths {
  databasePath: string;
}

export interface IndexStageRuntime {
  rootDir: string;
  mode: IndexMode;
  layout: ContextplusLayout;
  config: ProjectIndexConfig;
  paths: IndexRuntimePaths;
}

export interface ExecuteIndexStageOptions {
  runtime: IndexStageRuntime;
  status: IndexStatus;
  stageState: PersistedIndexStageState;
  stage: IndexStageName;
  onFileProgress?: (progress: FileSearchIndexProgress) => Promise<void> | void;
  onIdentifierProgress?: (progress: IdentifierIndexProgress) => Promise<void> | void;
  onFullProgress?: (progress: FullIndexProgress) => Promise<void> | void;
  persist?: () => Promise<void> | void;
}

export interface RerunIndexStageOptions {
  rootDir: string;
  stage: IndexStageName;
  mode?: IndexMode;
}

export interface RerunIndexStageResult {
  runtime: IndexStageRuntime;
  status: IndexStatus;
  stageState: PersistedIndexStageState;
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

function buildRuntimePaths(layout: ContextplusLayout): IndexRuntimePaths {
  return {
    databasePath: join(layout.state, "index.sqlite"),
  };
}

function buildStageState(mode: IndexMode): PersistedIndexStageState {
  const definitions = getStageDefinitions();
  const stages = Object.fromEntries(
    Object.values(definitions).map((definition) => [
      definition.name,
      {
        name: definition.name,
        state: "pending",
        modes: definition.modes,
        dependencies: definition.dependencies,
        outputs: definition.outputs,
        phases: definition.phases,
        runCount: 0,
      } satisfies PersistedIndexStageRecord,
    ]),
  ) as PersistedIndexStageState["stages"];

  return {
    generatedAt: new Date().toISOString(),
    contractVersion: buildIndexContract().contractVersion,
    artifactVersion: INDEX_ARTIFACT_VERSION,
    mode,
    stages,
  };
}

function buildIndexStatus(runtime: IndexStageRuntime, startedAt: string, stageState: PersistedIndexStageState): IndexStatus {
  return {
    state: "running",
    phase: "bootstrap",
    indexMode: runtime.mode,
    contractVersion: runtime.config.contract.contractVersion,
    artifactVersion: runtime.config.artifactVersion,
    stageOrder: runtime.config.contract.stageOrder,
    projectName: runtime.config.projectName,
    rootDir: runtime.rootDir,
    startedAt,
    lastUpdatedAt: startedAt,
    stages: stageState.stages,
  };
}

async function cleanupLegacyArtifacts(layout: ContextplusLayout): Promise<void> {
  const embeddingEntries = await readdir(layout.embeddings, { withFileTypes: true }).catch(() => []);
  const checkpointEntries = await readdir(layout.checkpoints, { withFileTypes: true }).catch(() => []);
  const legacyEmbeddingArtifacts = embeddingEntries
    .map((entry) => join(layout.embeddings, entry.name))
    .filter((path) => path.endsWith(".json"));
  const legacyCheckpointArtifacts = checkpointEntries
    .map((entry) => join(layout.checkpoints, entry.name))
    .filter((path) => path.endsWith(".json") || path.endsWith("/backups"));

  await deleteLegacyArtifacts([
    join(layout.config, "project.json"),
    join(layout.config, "context-tree.txt"),
    join(layout.config, "file-manifest.json"),
    join(layout.config, INDEX_STATUS_FILE),
    join(layout.config, INDEX_STAGE_STATE_FILE),
    join(layout.memories, "memory-graph.json"),
    join(layout.checkpoints, "restore-points.json"),
    join(layout.checkpoints, "backups"),
    join(layout.derived, "chunk-search-index.json"),
    join(layout.derived, "code-structure-index.json"),
    join(layout.derived, "full-index-manifest.json"),
    ...legacyEmbeddingArtifacts,
    ...legacyCheckpointArtifacts,
  ]);
}

async function loadLegacyJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function touchRunningStage(record: PersistedIndexStageRecord): PersistedIndexStageRecord {
  return {
    ...record,
    state: "running",
    runCount: record.runCount + 1,
    lastRunAt: new Date().toISOString(),
    lastError: undefined,
  };
}

function touchCompletedStage(record: PersistedIndexStageRecord): PersistedIndexStageRecord {
  return {
    ...record,
    state: "completed",
    lastCompletedAt: new Date().toISOString(),
    lastError: undefined,
  };
}

function touchFailedStage(record: PersistedIndexStageRecord, error: unknown): PersistedIndexStageRecord {
  return {
    ...record,
    state: "failed",
    lastError: error instanceof Error ? error.message : String(error),
  };
}

function assertStageCanRun(stageState: PersistedIndexStageState, stage: IndexStageName, mode: IndexMode): void {
  const record = stageState.stages[stage];
  if (!record.modes.includes(mode)) {
    throw new Error(`Index stage "${stage}" does not support mode "${mode}".`);
  }
  for (const dependency of record.dependencies) {
    if (stageState.stages[dependency].state !== "completed") {
      throw new Error(`Index stage "${stage}" requires completed dependency "${dependency}".`);
    }
  }
}

async function persistBootstrapArtifacts(runtime: IndexStageRuntime, status: IndexStatus): Promise<void> {
  const legacyGraph = await loadLegacyJsonIfPresent<{ nodes?: Record<string, unknown>; edges?: Record<string, unknown> }>(
    join(runtime.layout.memories, "memory-graph.json"),
  );
  const legacyRestorePoints = await loadLegacyJsonIfPresent<unknown[]>(
    join(runtime.layout.checkpoints, "restore-points.json"),
  );
  const entries = await walkDirectory({ rootDir: runtime.rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory);
  const directories = entries.filter((entry) => entry.isDirectory);
  const tree = await getContextTree({
    rootDir: runtime.rootDir,
    includeSymbols: true,
    maxTokens: 50_000,
  });
  const manifest: FileManifest = {
    artifactVersion: runtime.config.artifactVersion,
    contractVersion: runtime.config.contract.contractVersion,
    directories: directories.map((entry) => entry.relativePath),
    files: files.map((entry) => entry.relativePath),
    generatedAt: runtime.config.indexedAt,
    indexMode: runtime.mode,
    rootDir: runtime.rootDir,
  };

  await saveIndexArtifact(runtime.rootDir, "project-config", runtime.config);
  await saveIndexTextArtifact(runtime.rootDir, "context-tree", tree + "\n");
  await saveIndexArtifact(runtime.rootDir, "file-manifest", manifest);
  const graph = await loadIndexArtifact(runtime.rootDir, "memory-graph", () => ({ nodes: {}, edges: {} }));
  await saveIndexArtifact(
    runtime.rootDir,
    "memory-graph",
    Object.keys(graph.nodes).length === 0 && Object.keys(graph.edges).length === 0 && legacyGraph
      ? { nodes: legacyGraph.nodes ?? {}, edges: legacyGraph.edges ?? {} }
      : graph,
  );
  const restorePoints = await loadIndexArtifact(runtime.rootDir, "restore-points", () => []);
  await saveIndexArtifact(runtime.rootDir, "restore-points", restorePoints.length === 0 && legacyRestorePoints ? legacyRestorePoints : restorePoints);
  await cleanupLegacyArtifacts(runtime.layout);

  status.bootstrap = {
    files: files.length,
    directories: directories.length,
  };
}

export async function createIndexRuntime(options: { rootDir: string; mode?: IndexMode }): Promise<IndexStageRuntime> {
  const rootDir = resolve(options.rootDir);
  const mode = options.mode ?? DEFAULT_INDEX_MODE;
  const layout = await ensureContextplusLayout(rootDir);
  return {
    rootDir,
    mode,
    layout,
    config: buildProjectConfig(rootDir, mode),
    paths: buildRuntimePaths(layout),
  };
}

export async function saveIndexStatus(runtime: IndexStageRuntime, status: IndexStatus, startedAtMs: number): Promise<void> {
  status.lastUpdatedAt = new Date().toISOString();
  status.elapsedMs = Date.now() - startedAtMs;
  await saveIndexArtifact(runtime.rootDir, "index-status", status);
}

export async function saveIndexStageState(runtime: IndexStageRuntime, stageState: PersistedIndexStageState): Promise<void> {
  stageState.generatedAt = new Date().toISOString();
  await saveIndexArtifact(runtime.rootDir, "index-stage-state", stageState);
}

export async function loadIndexStageState(runtime: IndexStageRuntime): Promise<PersistedIndexStageState> {
  return loadIndexArtifact(runtime.rootDir, "index-stage-state", () => buildStageState(runtime.mode));
}

export async function loadIndexStatus(runtime: IndexStageRuntime, startedAt: string): Promise<IndexStatus> {
  return loadIndexArtifact(
    runtime.rootDir,
    "index-status",
    () => buildIndexStatus(runtime, startedAt, buildStageState(runtime.mode)),
  );
}

export async function executeIndexStage(options: ExecuteIndexStageOptions): Promise<void> {
  const { runtime, status, stageState, stage, onFileProgress, onIdentifierProgress, onFullProgress, persist } = options;
  assertStageCanRun(stageState, stage, runtime.mode);
  stageState.stages[stage] = touchRunningStage(stageState.stages[stage]);
  status.stages = stageState.stages;
  await persist?.();

  try {
    if (stage === "bootstrap") {
      status.phase = "bootstrap";
      await persistBootstrapArtifacts(runtime, status);
    } else if (stage === "file-search") {
      const result = await ensureFileSearchIndex(runtime.rootDir, onFileProgress);
      status.phase = "file-embeddings";
      status.fileSearch = result.stats;
    } else if (stage === "identifier-search") {
      const result = await ensureIdentifierSearchIndex(runtime.rootDir, onIdentifierProgress);
      status.phase = "identifier-embeddings";
      status.identifierSearch = result.stats;
    } else {
      const result = await ensureFullIndexArtifacts({ rootDir: runtime.rootDir }, onFullProgress);
      status.phase = "structure-scan";
      status.fullIndex = result.stats;
    }

    stageState.stages[stage] = touchCompletedStage(stageState.stages[stage]);
    status.stages = stageState.stages;
    await persist?.();
  } catch (error) {
    stageState.stages[stage] = touchFailedStage(stageState.stages[stage], error);
    status.stages = stageState.stages;
    await persist?.();
    throw error;
  }
}

export async function rerunIndexStage(options: RerunIndexStageOptions): Promise<RerunIndexStageResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runtime = await createIndexRuntime({ rootDir: options.rootDir, mode: options.mode });
  const stageState = await loadIndexStageState(runtime);
  const status = await loadIndexStatus(runtime, startedAt);
  status.state = "running";
  status.phase = getStageDefinitions()[options.stage].phases[0];
  status.completedAt = undefined;
  status.error = undefined;

  const persist = async (): Promise<void> => {
    await saveIndexStageState(runtime, stageState);
    await saveIndexStatus(runtime, status, startedAtMs);
  };

  await executeIndexStage({
    runtime,
    status,
    stageState,
    stage: options.stage,
    persist,
  });

  status.state = "completed";
  status.phase = "completed";
  status.completedAt = new Date().toISOString();
  await persist();
  return { runtime, status, stageState };
}
