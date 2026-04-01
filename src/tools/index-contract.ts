// Shared indexing contract definitions for durable Context+ repo-local artifacts
// FEATURE: Explicit schemas for core and full indexing pipeline state

import { join } from "path";
import {
  CONTEXTPLUS_INDEX_DB_FILE,
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
  | "hybrid-chunk-scan"
  | "hybrid-identifier-scan"
  | "structure-scan"
  | "completed"
  | "failed";

export interface IndexInvalidationContract {
  fileArtifacts: "content-hash";
  identifierArtifacts: "content-hash";
  structureArtifacts: "content-hash-plus-dependency-hash";
  chunkArtifacts: "content-hash-plus-chunk-content-hash";
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
  mirrorPolicy: "sqlite-only";
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
  hybridChunkIndexPath: string;
  hybridIdentifierIndexPath: string;
  structureIndexPath: string;
  chunkCount: number;
  hybridChunkCount: number;
  hybridIdentifierCount: number;
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
    hybridChunkIndex: {
      indexedDocuments: number;
      changedDocuments: number;
      reusedDocuments: number;
      uniqueTerms: number;
    };
    hybridIdentifierIndex: {
      indexedDocuments: number;
      changedDocuments: number;
      reusedDocuments: number;
      uniqueTerms: number;
    };
  };
}

export const INDEX_CONTRACT_VERSION = 5;
export const INDEX_ARTIFACT_VERSION = 7;
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
  "hybrid-chunk-scan",
  "hybrid-identifier-scan",
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
  fileArtifacts: "content-hash",
  identifierArtifacts: "content-hash",
  structureArtifacts: "content-hash-plus-dependency-hash",
  chunkArtifacts: "content-hash-plus-chunk-content-hash",
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
  mirrorPolicy: "sqlite-only",
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
        "sqlite:index_artifacts/project-config",
        "sqlite:index_text_artifacts/context-tree",
        "sqlite:index_artifacts/file-manifest",
        "sqlite:index_artifacts/index-status",
        "sqlite:index_artifacts/index-stage-state",
        "sqlite:index_artifacts/memory-graph",
        "sqlite:index_artifacts/restore-points",
      ],
    },
    "file-search": {
      name: "file-search",
      phases: ["file-scan", "file-embeddings"],
      dependencies: ["bootstrap"],
      modes: ["core", "full"],
      outputs: [
        "sqlite:index_artifacts/file-search-index",
        "sqlite:index_artifacts/embedding-cache:file-search",
      ],
    },
    "identifier-search": {
      name: "identifier-search",
      phases: ["identifier-scan", "identifier-embeddings"],
      dependencies: ["bootstrap"],
      modes: ["core", "full"],
      outputs: [
        "sqlite:index_artifacts/identifier-search-index",
        "sqlite:index_artifacts/embedding-cache:identifier-search",
      ],
    },
    "full-artifacts": {
      name: "full-artifacts",
      phases: ["chunk-scan", "chunk-embeddings", "hybrid-chunk-scan", "hybrid-identifier-scan", "structure-scan"],
      dependencies: ["bootstrap", "file-search", "identifier-search"],
      modes: ["full"],
      outputs: [
        "sqlite:index_artifacts/chunk-search-index",
        "sqlite:index_artifacts/hybrid-chunk-index",
        "sqlite:index_artifacts/hybrid-identifier-index",
        "sqlite:index_artifacts/code-structure-index",
        "sqlite:index_artifacts/full-index-manifest",
        "sqlite:index_artifacts/embedding-cache:chunk-search",
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
