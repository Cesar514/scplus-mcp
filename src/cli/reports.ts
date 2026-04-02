// Human CLI backend reports for dashboard, status, and health data
// FEATURE: Human terminal interface bridge over Context+ backend commands surface

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadHubSuggestionState } from "../tools/hub-suggestions.js";
import { getRepoStatus, type RepoStatusSummary } from "../tools/exact-query.js";
import { inspectHybridVectorCoverage, type HybridVectorCoverageSummary } from "../tools/hybrid-retrieval.js";
import { validatePreparedIndex, type IndexValidationReport } from "../tools/index-reliability.js";
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

export async function buildDoctorReport(rootDir: string): Promise<BridgeDoctorReport> {
  const [repoStatus, indexValidation, hubState, restorePoints, ollama, treeSitter, hybridVectors] = await Promise.all([
    getRepoStatus(rootDir),
    validatePreparedIndex({ rootDir, mode: "full" }),
    loadHubSuggestionState(rootDir),
    listRestorePoints(rootDir),
    getOllamaRuntimeStatus(),
    Promise.resolve(getTreeSitterRuntimeStats()),
    inspectHybridVectorCoverage(rootDir),
  ]);
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
    restorePointCount: restorePoints.length,
    ollama,
  };
}
