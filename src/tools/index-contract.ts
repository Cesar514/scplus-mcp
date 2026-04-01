// Shared indexing contract definitions for durable Context+ repo-local artifacts
// FEATURE: Explicit schemas for core and full indexing pipeline state

import { join } from "path";
import {
  CONTEXTPLUS_CHECKPOINTS_DIR,
  CONTEXTPLUS_CONFIG_DIR,
  CONTEXTPLUS_DERIVED_DIR,
  CONTEXTPLUS_EMBEDDINGS_DIR,
  CONTEXTPLUS_INDEX_DB_FILE,
  CONTEXTPLUS_MEMORIES_DIR,
} from "../core/project-layout.js";

export type IndexMode = "core" | "full";
export type IndexStageName = "bootstrap" | "file-search" | "identifier-search" | "full-artifacts";

export type IndexPhase =
  | "bootstrap"
  | "file-scan"
  | "file-embeddings"
  | "identifier-scan"
  | "identifier-embeddings"
  | "chunk-scan"
  | "chunk-embeddings"
  | "structure-scan"
  | "completed"
  | "failed";

export interface IndexInvalidationContract {
  fileArtifacts: "size-mtime-fingerprint";
  identifierArtifacts: "size-mtime-fingerprint";
  structureArtifacts: "size-mtime-fingerprint";
  chunkArtifacts: "size-mtime-fingerprint";
  embeddingReuse: "content-hash";
  removedPaths: "drop-missing-entries-on-refresh";
}

export interface IndexFailureSemantics {
  policy: "crash-only";
  onFailure: "write-failed-status-and-throw";
  partialState: "preserve-last-successful-stage-files";
  recovery: "rerun-from-persisted-artifacts";
}

export interface IndexStorageContract {
  substrate: "sqlite";
  databasePath: string;
  mirrorPolicy: "sqlite-authoritative-json-mirrors";
}

export interface IndexContractMetadata {
  contractVersion: number;
  artifactVersion: number;
  defaultMode: "full";
  supportedModes: IndexMode[];
  stageOrder: IndexPhase[];
  stageNames: IndexStageName[];
  storage: IndexStorageContract;
  invalidation: IndexInvalidationContract;
  failureSemantics: IndexFailureSemantics;
}

export interface IndexStageDefinition {
  name: IndexStageName;
  phases: IndexPhase[];
  dependencies: IndexStageName[];
  modes: IndexMode[];
  outputs: string[];
}

export interface PersistedIndexStageRecord {
  name: IndexStageName;
  state: "pending" | "running" | "completed" | "failed";
  modes: IndexMode[];
  dependencies: IndexStageName[];
  outputs: string[];
  phases: IndexPhase[];
  runCount: number;
  lastRunAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
}

export interface PersistedIndexStageState {
  generatedAt: string;
  contractVersion: number;
  artifactVersion: number;
  mode: IndexMode;
  stages: Record<IndexStageName, PersistedIndexStageRecord>;
}

export interface ProjectIndexConfig {
  indexedAt: string;
  projectName: string;
  rootDir: string;
  artifactVersion: number;
  indexMode: IndexMode;
  version: number;
  contract: IndexContractMetadata;
}

export interface FileManifest {
  artifactVersion: number;
  contractVersion: number;
  directories: string[];
  files: string[];
  generatedAt: string;
  indexMode: IndexMode;
  rootDir: string;
}

export interface FullArtifactManifest {
  generatedAt: string;
  mode: "full";
  artifactVersion: number;
  contractVersion: number;
  chunkIndexPath: string;
  structureIndexPath: string;
  chunkCount: number;
  structureCount: number;
  contract: IndexContractMetadata;
  stats: {
    chunkIndex: {
      totalFiles: number;
      processedFiles: number;
      changedFiles: number;
      removedFiles: number;
      indexedChunks: number;
      embeddedChunks: number;
      reusedChunks: number;
    };
    structureIndex: {
      totalFiles: number;
      processedFiles: number;
      changedFiles: number;
      removedFiles: number;
      indexedStructures: number;
    };
  };
}

export const INDEX_CONTRACT_VERSION = 2;
export const INDEX_ARTIFACT_VERSION = 4;
export const DEFAULT_INDEX_MODE = "full" as const satisfies IndexMode;
export const INDEX_STATUS_FILE = "index-status.json";
export const INDEX_STAGE_STATE_FILE = "index-stages.json";
export const INDEX_STAGE_ORDER: IndexPhase[] = [
  "bootstrap",
  "file-scan",
  "file-embeddings",
  "identifier-scan",
  "identifier-embeddings",
  "chunk-scan",
  "chunk-embeddings",
  "structure-scan",
  "completed",
  "failed",
];
export const INDEX_STAGE_NAMES: IndexStageName[] = [
  "bootstrap",
  "file-search",
  "identifier-search",
  "full-artifacts",
];

export const INDEX_INVALIDATION_CONTRACT: IndexInvalidationContract = {
  fileArtifacts: "size-mtime-fingerprint",
  identifierArtifacts: "size-mtime-fingerprint",
  structureArtifacts: "size-mtime-fingerprint",
  chunkArtifacts: "size-mtime-fingerprint",
  embeddingReuse: "content-hash",
  removedPaths: "drop-missing-entries-on-refresh",
};

export const INDEX_FAILURE_SEMANTICS: IndexFailureSemantics = {
  policy: "crash-only",
  onFailure: "write-failed-status-and-throw",
  partialState: "preserve-last-successful-stage-files",
  recovery: "rerun-from-persisted-artifacts",
};

export const INDEX_STORAGE_CONTRACT: IndexStorageContract = {
  substrate: "sqlite",
  databasePath: CONTEXTPLUS_INDEX_DB_FILE,
  mirrorPolicy: "sqlite-authoritative-json-mirrors",
};

export function buildIndexContract(): IndexContractMetadata {
  return {
    contractVersion: INDEX_CONTRACT_VERSION,
    artifactVersion: INDEX_ARTIFACT_VERSION,
    defaultMode: DEFAULT_INDEX_MODE,
    supportedModes: ["core", "full"],
    stageOrder: INDEX_STAGE_ORDER,
    stageNames: INDEX_STAGE_NAMES,
    storage: INDEX_STORAGE_CONTRACT,
    invalidation: INDEX_INVALIDATION_CONTRACT,
    failureSemantics: INDEX_FAILURE_SEMANTICS,
  };
}

export function getStageDefinitions(): Record<IndexStageName, IndexStageDefinition> {
  return {
    bootstrap: {
      name: "bootstrap",
      phases: ["bootstrap"],
      dependencies: [],
      modes: ["core", "full"],
      outputs: [
        CONTEXTPLUS_INDEX_DB_FILE,
        join(CONTEXTPLUS_CONFIG_DIR, "project.json"),
        join(CONTEXTPLUS_CONFIG_DIR, "context-tree.txt"),
        join(CONTEXTPLUS_CONFIG_DIR, "file-manifest.json"),
        join(CONTEXTPLUS_CONFIG_DIR, INDEX_STATUS_FILE),
        join(CONTEXTPLUS_CONFIG_DIR, INDEX_STAGE_STATE_FILE),
        join(CONTEXTPLUS_MEMORIES_DIR, "memory-graph.json"),
        join(CONTEXTPLUS_CHECKPOINTS_DIR, "restore-points.json"),
      ],
    },
    "file-search": {
      name: "file-search",
      phases: ["file-scan", "file-embeddings"],
      dependencies: ["bootstrap"],
      modes: ["core", "full"],
      outputs: [
        join(CONTEXTPLUS_EMBEDDINGS_DIR, "file-search-index.json"),
      ],
    },
    "identifier-search": {
      name: "identifier-search",
      phases: ["identifier-scan", "identifier-embeddings"],
      dependencies: ["bootstrap"],
      modes: ["core", "full"],
      outputs: [
        join(CONTEXTPLUS_EMBEDDINGS_DIR, "identifier-search-index.json"),
      ],
    },
    "full-artifacts": {
      name: "full-artifacts",
      phases: ["chunk-scan", "chunk-embeddings", "structure-scan"],
      dependencies: ["bootstrap", "file-search", "identifier-search"],
      modes: ["full"],
      outputs: [
        join(CONTEXTPLUS_DERIVED_DIR, "chunk-search-index.json"),
        join(CONTEXTPLUS_DERIVED_DIR, "code-structure-index.json"),
        join(CONTEXTPLUS_DERIVED_DIR, "full-index-manifest.json"),
      ],
    },
  };
}

export function getCoreArtifactPaths(): string[] {
  const definitions = getStageDefinitions();
  return [
    ...definitions.bootstrap.outputs,
    ...definitions["file-search"].outputs,
    ...definitions["identifier-search"].outputs,
  ];
}

export function getFullArtifactPaths(): string[] {
  return [...getCoreArtifactPaths(), ...getStageDefinitions()["full-artifacts"].outputs];
}
