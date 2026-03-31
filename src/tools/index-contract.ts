// Shared indexing contract definitions for durable Context+ repo-local artifacts
// FEATURE: Explicit schemas for core and full indexing pipeline state

import { join } from "path";
import { CONTEXTPLUS_CHECKPOINTS_DIR, CONTEXTPLUS_CONFIG_DIR, CONTEXTPLUS_DERIVED_DIR, CONTEXTPLUS_EMBEDDINGS_DIR, CONTEXTPLUS_MEMORIES_DIR } from "../core/project-layout.js";

export type IndexMode = "core" | "full";

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

export interface IndexContractMetadata {
  contractVersion: number;
  artifactVersion: number;
  defaultMode: "full";
  supportedModes: IndexMode[];
  stageOrder: IndexPhase[];
  invalidation: IndexInvalidationContract;
  failureSemantics: IndexFailureSemantics;
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

export const INDEX_CONTRACT_VERSION = 1;
export const INDEX_ARTIFACT_VERSION = 3;
export const DEFAULT_INDEX_MODE = "full" as const satisfies IndexMode;
export const INDEX_STATUS_FILE = "index-status.json";
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

export function buildIndexContract(): IndexContractMetadata {
  return {
    contractVersion: INDEX_CONTRACT_VERSION,
    artifactVersion: INDEX_ARTIFACT_VERSION,
    defaultMode: DEFAULT_INDEX_MODE,
    supportedModes: ["core", "full"],
    stageOrder: INDEX_STAGE_ORDER,
    invalidation: INDEX_INVALIDATION_CONTRACT,
    failureSemantics: INDEX_FAILURE_SEMANTICS,
  };
}

export function getCoreArtifactPaths(): string[] {
  return [
    join(CONTEXTPLUS_CONFIG_DIR, "project.json"),
    join(CONTEXTPLUS_CONFIG_DIR, "context-tree.txt"),
    join(CONTEXTPLUS_CONFIG_DIR, "file-manifest.json"),
    join(CONTEXTPLUS_CONFIG_DIR, INDEX_STATUS_FILE),
    join(CONTEXTPLUS_EMBEDDINGS_DIR, "file-search-index.json"),
    join(CONTEXTPLUS_EMBEDDINGS_DIR, "identifier-search-index.json"),
    join(CONTEXTPLUS_MEMORIES_DIR, "memory-graph.json"),
    join(CONTEXTPLUS_CHECKPOINTS_DIR, "restore-points.json"),
  ];
}

export function getFullArtifactPaths(): string[] {
  return [
    ...getCoreArtifactPaths(),
    join(CONTEXTPLUS_DERIVED_DIR, "chunk-search-index.json"),
    join(CONTEXTPLUS_DERIVED_DIR, "code-structure-index.json"),
    join(CONTEXTPLUS_DERIVED_DIR, "full-index-manifest.json"),
  ];
}
