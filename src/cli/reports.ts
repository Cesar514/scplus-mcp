// Human CLI backend reports for dashboard, status, and health data
// FEATURE: Human terminal interface bridge over Context+ backend commands surface

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBackendSchedulerObservability, type BackendSchedulerObservability } from "../core/runtime-observability.js";
import { walkDirectory } from "../core/walker.js";
import { getEmbeddingRuntimeStats, type EmbeddingRuntimeStats } from "../core/embeddings.js";
import { loadHubSuggestionState } from "../tools/hub-suggestions.js";
import { getRepoStatus, type RepoStatusSummary } from "../tools/exact-query.js";
import { getHybridSearchRuntimeStats, inspectHybridVectorCoverage, type HybridSearchRuntimeStats, type HybridVectorCoverageSummary } from "../tools/hybrid-retrieval.js";
import { validatePreparedIndex, type IndexValidationReport } from "../tools/index-reliability.js";
import { createIndexRuntime, loadIndexStatus, type IndexStageObservabilityStatus } from "../tools/index-stages.js";
import { getFileSearchRuntimeStats, type FileSearchRuntimeStats } from "../tools/semantic-search.js";
import { getWriteFreshnessRuntimeStats, type WriteFreshnessRuntimeStats } from "../tools/write-freshness.js";
import { listRestorePoints } from "../git/shadow.js";
import { getTreeSitterRuntimeStats, type TreeSitterRuntimeStats } from "../core/tree-sitter.js";

const execFileAsync = promisify(execFile);

interface OllamaRuntimeModel {
  name: string;
  id?: string;
  size?: string;
  processor?: string;
  until?: string;
}

export interface OllamaRuntimeStatus {
  ok: boolean;
  models: OllamaRuntimeModel[];
  error?: string;
}

export interface BridgeDoctorReport {
  generatedAt: string;
  root: string;
  serving: {
    activeGeneration: number;
    pendingGeneration: number | null;
    latestGeneration: number;
    activeGenerationValidatedAt?: string;
    activeGenerationFreshness: "fresh" | "dirty" | "blocked";
    activeGenerationBlockedReason?: string;
  };
  repoStatus: RepoStatusSummary;
  indexValidation: IndexValidationReport;
  hubSummary: {
    suggestionCount: number;
    featureGroupCount: number;
    suggestions: string[];
    featureGroups: string[];
  };
  hybridVectors: {
    chunk: HybridVectorCoverageSummary;
    identifier: HybridVectorCoverageSummary;
  };
  treeSitter: TreeSitterRuntimeStats;
  observability: {
    indexing: {
      lastUpdatedAt?: string;
      elapsedMs?: number;
      stages: Partial<Record<"bootstrap" | "file-search" | "identifier-search" | "full-artifacts", IndexStageObservabilityStatus>>;
    };
    caches: {
      embeddings: EmbeddingRuntimeStats;
      hybridSearch: HybridSearchRuntimeStats;
      parserPoolReuseCount: number;
    };
    integrity: {
      staleGenerationAgeMs?: number;
      fallbackMarkerCount: number;
      fallbackFiles: string[];
      parseFailuresByLanguage: Record<string, number>;
      refreshFailures: {
        fileSearch: FileSearchRuntimeStats;
        writeFreshness: WriteFreshnessRuntimeStats;
      };
    };
    scheduler: BackendSchedulerObservability;
  };
  restorePointCount: number;
  ollama: OllamaRuntimeStatus;
}

function splitColumns(line: string): string[] {
  return line.trim().split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
}

async function getOllamaRuntimeStatus(): Promise<OllamaRuntimeStatus> {
  try {
    const { stdout } = await execFileAsync("ollama", ["ps"], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length <= 1) return { ok: true, models: [] };
    const models = lines.slice(1).map((line) => {
      const [name, id, size, processor, until] = splitColumns(line);
      return { name, id, size, processor, until };
    }).filter((entry) => entry.name);
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, models: [], error: message };
  }
}

const OBSERVABILITY_IGNORE_PREFIXES = [
  ".contextplus/",
  ".git/",
  ".pixi/",
  "build/",
  "dist/",
  "landing/.next/",
  "node_modules/",
];

function shouldInspectFallbackMarkers(path: string): boolean {
  return !OBSERVABILITY_IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function inspectFallbackMarkers(rootDir: string): Promise<{ count: number; files: string[] }> {
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory && shouldInspectFallbackMarkers(entry.relativePath));
  const markerFiles: string[] = [];
  let count = 0;
  for (const file of files) {
    const content = await readFile(file.path, "utf8").catch(() => "");
    if (!content.includes("// FALLBACK")) continue;
    markerFiles.push(file.relativePath.replace(/\\/g, "/"));
    const matches = content.match(/\/\/ FALLBACK/g);
    count += matches?.length ?? 0;
  }
  return {
    count,
    files: markerFiles.sort(),
  };
}

function getStaleGenerationAgeMs(validatedAt: string | undefined): number | undefined {
  if (!validatedAt) return undefined;
  const parsed = Date.parse(validatedAt);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Date.now() - parsed);
}

function getParseFailuresByLanguage(treeSitter: TreeSitterRuntimeStats): Record<string, number> {
  return Object.fromEntries(
    Object.entries(treeSitter.languages)
      .filter(([, stats]) => stats.parseFailures > 0)
      .map(([language, stats]) => [language, stats.parseFailures]),
  );
}

export async function buildDoctorReport(rootDir: string): Promise<BridgeDoctorReport> {
  const runtime = await createIndexRuntime({ rootDir, mode: "full" });
  const [repoStatus, indexValidation, hubState, restorePoints, ollama, treeSitter, hybridVectors, indexStatus, fallbackMarkers] = await Promise.all([
    getRepoStatus(rootDir),
    validatePreparedIndex({ rootDir, mode: "full" }),
    loadHubSuggestionState(rootDir),
    listRestorePoints(rootDir),
    getOllamaRuntimeStatus(),
    Promise.resolve(getTreeSitterRuntimeStats()),
    inspectHybridVectorCoverage(rootDir),
    loadIndexStatus(runtime, new Date().toISOString()),
    inspectFallbackMarkers(rootDir),
  ]);
  const scheduler = getBackendSchedulerObservability(rootDir);
  return {
    generatedAt: new Date().toISOString(),
    root: rootDir,
    serving: {
      activeGeneration: indexValidation.activeGeneration,
      pendingGeneration: indexValidation.pendingGeneration,
      latestGeneration: indexValidation.latestGeneration,
      activeGenerationValidatedAt: indexValidation.activeGenerationValidatedAt,
      activeGenerationFreshness: indexValidation.activeGenerationFreshness,
      activeGenerationBlockedReason: indexValidation.activeGenerationBlockedReason,
    },
    repoStatus,
    indexValidation,
    hubSummary: {
      suggestionCount: Object.keys(hubState.suggestions).length,
      featureGroupCount: Object.keys(hubState.featureGroups).length,
      suggestions: Object.values(hubState.suggestions).map((entry) => entry.label).sort(),
      featureGroups: Object.values(hubState.featureGroups).map((entry) => entry.label).sort(),
    },
    hybridVectors,
    treeSitter,
    observability: {
      indexing: {
        lastUpdatedAt: indexStatus.lastUpdatedAt,
        elapsedMs: indexStatus.elapsedMs,
        stages: indexStatus.observability?.stages ?? {},
      },
      caches: {
        embeddings: getEmbeddingRuntimeStats(),
        hybridSearch: getHybridSearchRuntimeStats(),
        parserPoolReuseCount: treeSitter.totalParserReuses,
      },
      integrity: {
        staleGenerationAgeMs: getStaleGenerationAgeMs(indexValidation.activeGenerationValidatedAt),
        fallbackMarkerCount: fallbackMarkers.count,
        fallbackFiles: fallbackMarkers.files,
        parseFailuresByLanguage: getParseFailuresByLanguage(treeSitter),
        refreshFailures: {
          fileSearch: getFileSearchRuntimeStats(),
          writeFreshness: getWriteFreshnessRuntimeStats(),
        },
      },
      scheduler,
    },
    restorePointCount: restorePoints.length,
    ollama,
  };
}
