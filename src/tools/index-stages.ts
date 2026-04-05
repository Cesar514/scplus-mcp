// summary: Runs the durable stage graph for the sqlite-backed scplus indexing pipeline.
// FEATURE: Rerunnable sqlite-only indexing stages with legacy artifact cleanup.
// inputs: Stage execution context, repo data, and generation-scoped artifact dependencies.
// outputs: Completed stage records, persisted artifacts, and stage progress updates.

import { readFile, readdir } from "fs/promises";
import { basename, join, resolve } from "path";
import {
  deleteLegacyArtifacts,
  loadIndexArtifact,
  loadIndexServingState,
  saveIndexArtifact,
  saveIndexTextArtifact,
  type IndexGenerationFreshness,
  type IndexServingState,
} from "../core/index-database.js";
import { getContextTree } from "./context-tree.js";
import { ensureScplusLayout, type ScplusLayout } from "../core/project-layout.js";
import { walkDirectory } from "../core/walker.js";
import { ensureFileSearchIndex, type FileSearchIndexProgress, type FileSearchIndexStats } from "./semantic-search.js";
import { ensureIdentifierSearchIndex, type IdentifierIndexProgress, type IdentifierIndexStats } from "./semantic-identifiers.js";
import { ensureFullIndexArtifacts, type FullIndexProgress } from "./full-index-artifacts.js";
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

export interface HybridRetrievalIndexStatus {
  indexedDocuments: number;
  changedDocuments: number;
  reusedDocuments: number;
  uniqueTerms: number;
}

export interface QueryExplanationIndexStatus {
  fileCardCount: number;
  moduleCardCount: number;
  subsystemCardCount: number;
  hubCardCount: number;
}

export interface IndexStageObservabilityStatus {
  durationMs: number;
  phaseDurationsMs: Partial<Record<IndexPhase, number>>;
  processedFiles?: number;
  indexedChunks?: number;
  embeddedCount?: number;
  filesPerSecond?: number;
  chunksPerSecond?: number;
  embedsPerSecond?: number;
}

export interface IndexObservabilityStatus {
  stages: Partial<Record<IndexStageName, IndexStageObservabilityStatus>>;
}

export interface IndexStatus {
  state: "running" | "completed" | "failed";
  phase: IndexPhase;
  runGeneration: number;
  activeGeneration: number;
  pendingGeneration: number | null;
  latestGeneration: number;
  activeGenerationValidatedAt?: string;
  activeGenerationFreshness: IndexGenerationFreshness;
  activeGenerationBlockedReason?: string;
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
  failedGeneration?: number;
  bootstrap?: {
    files: number;
    directories: number;
  };
  fileSearch?: Partial<FileSearchIndexStats>;
  identifierSearch?: Partial<IdentifierIndexStats>;
  fullIndex?: {
    chunkIndex?: Partial<ChunkIndexStatus>;
    structureIndex?: Partial<StructureIndexStatus>;
    hybridChunkIndex?: Partial<HybridRetrievalIndexStatus>;
    hybridIdentifierIndex?: Partial<HybridRetrievalIndexStatus>;
    queryExplanationIndex?: Partial<QueryExplanationIndexStatus>;
  };
  observability?: IndexObservabilityStatus;
  stages: PersistedIndexStageState["stages"];
  error?: string;
}

export interface IndexRuntimePaths {
  databasePath: string;
}

export interface IndexStageRuntime {
  rootDir: string;
  mode: IndexMode;
  generation: number;
  servingState: IndexServingState;
  layout: ScplusLayout;
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

function buildProjectConfig(rootDir: string, mode: IndexMode, generation: number): ProjectIndexConfig {
  return {
    indexedAt: new Date().toISOString(),
    generation,
    projectName: basename(resolve(rootDir)),
    rootDir: resolve(rootDir),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    indexMode: mode,
    version: INDEX_ARTIFACT_VERSION,
    contract: buildIndexContract(),
  };
}

function buildRuntimePaths(layout: ScplusLayout): IndexRuntimePaths {
  return {
    databasePath: join(layout.state, "index.sqlite"),
  };
}

function buildStageState(mode: IndexMode, generation: number): PersistedIndexStageState {
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
    generation,
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
    runGeneration: runtime.generation,
    activeGeneration: runtime.servingState.activeGeneration,
    pendingGeneration: runtime.servingState.pendingGeneration,
    latestGeneration: runtime.servingState.latestGeneration,
    activeGenerationValidatedAt: runtime.servingState.activeGenerationValidatedAt,
    activeGenerationFreshness: runtime.servingState.activeGenerationFreshness,
    activeGenerationBlockedReason: runtime.servingState.activeGenerationBlockedReason,
    indexMode: runtime.mode,
    contractVersion: runtime.config.contract.contractVersion,
    artifactVersion: runtime.config.artifactVersion,
    stageOrder: runtime.config.contract.stageOrder,
    projectName: runtime.config.projectName,
    rootDir: runtime.rootDir,
    startedAt,
    lastUpdatedAt: startedAt,
    observability: {
      stages: {},
    },
    stages: stageState.stages,
  };
}

async function cleanupLegacyArtifacts(layout: ScplusLayout): Promise<void> {
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
    join(layout.root, "memories", "memory-graph.json"),
    join(layout.checkpoints, "restore-points.json"),
    join(layout.checkpoints, "backups"),
    join(layout.derived, "chunk-search-index.json"),
    join(layout.derived, "code-structure-index.json"),
    join(layout.derived, "full-index-manifest.json"),
    ...legacyEmbeddingArtifacts,
    ...legacyCheckpointArtifacts,
    layout.embeddings,
    layout.config,
    layout.checkpoints,
    layout.derived,
  ]);
}

async function loadLegacyJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed legacy JSON state at ${path}: ${error.message}`);
    }
    throw error;
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
    generation: runtime.generation,
    directories: directories.map((entry) => entry.relativePath),
    files: files.map((entry) => entry.relativePath),
    generatedAt: runtime.config.indexedAt,
    indexMode: runtime.mode,
    rootDir: runtime.rootDir,
  };

  await saveIndexArtifact(runtime.rootDir, "project-config", runtime.config, { generation: runtime.generation });
  await saveIndexTextArtifact(runtime.rootDir, "context-tree", tree + "\n", { generation: runtime.generation });
  await saveIndexArtifact(runtime.rootDir, "file-manifest", manifest, { generation: runtime.generation });
  const restorePoints = await loadIndexArtifact(runtime.rootDir, "restore-points", () => []);
  await saveIndexArtifact(runtime.rootDir, "restore-points", restorePoints.length === 0 && legacyRestorePoints ? legacyRestorePoints : restorePoints);
  await cleanupLegacyArtifacts(runtime.layout);

  status.bootstrap = {
    files: files.length,
    directories: directories.length,
  };
}

export async function createIndexRuntime(options: { rootDir: string; mode?: IndexMode; generation?: number }): Promise<IndexStageRuntime> {
  const rootDir = resolve(options.rootDir);
  const mode = options.mode ?? DEFAULT_INDEX_MODE;
  const layout = await ensureScplusLayout(rootDir);
  const servingState = await loadIndexServingState(rootDir);
  const generation = options.generation ?? servingState.activeGeneration;
  return {
    rootDir,
    mode,
    generation,
    servingState,
    layout,
    config: buildProjectConfig(rootDir, mode, generation),
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
  await saveIndexArtifact(runtime.rootDir, "index-stage-state", stageState, { generation: runtime.generation });
}

export async function loadIndexStageState(runtime: IndexStageRuntime): Promise<PersistedIndexStageState> {
  const persisted = await loadIndexArtifact(
    runtime.rootDir,
    "index-stage-state",
    () => buildStageState(runtime.mode, runtime.generation),
    { generation: runtime.generation },
  );
  const current = buildStageState(runtime.mode, runtime.generation);

  for (const definition of Object.values(getStageDefinitions())) {
    const prior = persisted.stages[definition.name];
    if (!prior) continue;
    current.stages[definition.name] = {
      ...current.stages[definition.name],
      state: prior.state,
      runCount: prior.runCount,
      lastRunAt: prior.lastRunAt,
      lastCompletedAt: prior.lastCompletedAt,
      lastError: prior.lastError,
    };
  }

  current.generatedAt = persisted.generatedAt;
  return current;
}

export async function loadIndexStatus(runtime: IndexStageRuntime, startedAt: string): Promise<IndexStatus> {
  const persisted = await loadIndexArtifact(
    runtime.rootDir,
    "index-status",
    () => buildIndexStatus(runtime, startedAt, buildStageState(runtime.mode, runtime.generation)),
  );
  const current = buildIndexStatus(runtime, startedAt, buildStageState(runtime.mode, runtime.generation));
  return {
    ...current,
    ...persisted,
    runGeneration: persisted.runGeneration ?? runtime.generation,
    activeGeneration: persisted.activeGeneration ?? runtime.servingState.activeGeneration,
    pendingGeneration: persisted.pendingGeneration ?? runtime.servingState.pendingGeneration,
    latestGeneration: persisted.latestGeneration ?? runtime.servingState.latestGeneration,
    activeGenerationValidatedAt: persisted.activeGenerationValidatedAt ?? runtime.servingState.activeGenerationValidatedAt,
    activeGenerationFreshness: persisted.activeGenerationFreshness ?? runtime.servingState.activeGenerationFreshness,
    activeGenerationBlockedReason: persisted.activeGenerationBlockedReason ?? runtime.servingState.activeGenerationBlockedReason,
    indexMode: runtime.mode,
    contractVersion: runtime.config.contract.contractVersion,
    artifactVersion: runtime.config.artifactVersion,
    stageOrder: runtime.config.contract.stageOrder,
    projectName: runtime.config.projectName,
    rootDir: runtime.rootDir,
    stages: current.stages,
  };
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
      status.phase = "explanation-scan";
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
