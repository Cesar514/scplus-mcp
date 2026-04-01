// Unified research surface over code, structure, clusters, and hubs
// FEATURE: Aggregated repository research from persisted full-engine artifacts

import { discoverHubs, parseHubFile } from "../core/hub.js";
import { loadIndexArtifact } from "../core/index-database.js";
import { loadSemanticClusterState, type PersistedSemanticClusterState, type SubsystemSummary } from "./cluster-artifacts.js";
import { loadHubSuggestionState, type HubSuggestion, type PersistedHubSuggestionState } from "./hub-suggestions.js";
import { assertValidPreparedIndex } from "./index-reliability.js";
import { rankUnifiedSearch, formatUnifiedSearchResults, type UnifiedRankedHit } from "./unified-ranking.js";

interface StructureArtifact {
  path: string;
  header: string;
  modulePath: string;
  dependencyPaths: string[];
}

interface PersistedStructureIndexState {
  files: Record<string, { artifact: StructureArtifact }>;
}

export interface ResearchOptions {
  rootDir: string;
  query: string;
  topK?: number;
  includeKinds?: string[];
  maxRelated?: number;
  maxSubsystems?: number;
  maxHubs?: number;
}

interface ResearchRelatedHit {
  path: string;
  score: number;
  reason: string;
  source: "cluster" | "dependency";
}

interface ResearchSubsystemHit {
  summary: SubsystemSummary;
  score: number;
}

interface ResearchHubHit {
  kind: "manual" | "suggested";
  label: string;
  path: string;
  score: number;
  linkedPaths: string[];
  rationale?: string;
}

export interface ResearchReport {
  query: string;
  codeHits: UnifiedRankedHit[];
  relatedHits: ResearchRelatedHit[];
  subsystemHits: ResearchSubsystemHit[];
  hubHits: ResearchHubHit[];
}

function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeTopK(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function computeCoverageScore(queryTerms: string[], text: string): { score: number; matchedTerms: string[] } {
  const lower = text.toLowerCase();
  const uniqueTerms = Array.from(new Set(queryTerms));
  if (uniqueTerms.length === 0) return { score: 0, matchedTerms: [] };
  const matchedTerms = uniqueTerms.filter((term) => lower.includes(term));
  return {
    score: matchedTerms.length / uniqueTerms.length,
    matchedTerms,
  };
}

async function loadStructureState(rootDir: string): Promise<PersistedStructureIndexState> {
  return loadIndexArtifact(rootDir, "code-structure-index", () => ({
    files: {},
  }));
}

function scoreSubsystem(
  queryTerms: string[],
  topPaths: Set<string>,
  subsystem: SubsystemSummary,
): ResearchSubsystemHit | null {
  const coverage = computeCoverageScore(
    queryTerms,
    [
      subsystem.label,
      subsystem.overarchingTheme,
      subsystem.distinguishingFeature,
      subsystem.pathPattern ?? "",
      subsystem.filePaths.join(" "),
    ].join(" "),
  );
  const overlapCount = subsystem.filePaths.filter((filePath) => topPaths.has(filePath)).length;
  const overlapBoost = topPaths.size > 0 ? overlapCount / topPaths.size : 0;
  const score = clamp01(coverage.score * 0.7 + overlapBoost * 0.3);
  if (score <= 0) return null;
  return { summary: subsystem, score };
}

function scoreSuggestedHub(
  queryTerms: string[],
  topPaths: Set<string>,
  suggestion: HubSuggestion,
): ResearchHubHit | null {
  const coverage = computeCoverageScore(
    queryTerms,
    [
      suggestion.label,
      suggestion.summary,
      suggestion.rationale,
      suggestion.pathPattern ?? "",
      suggestion.featureTags.join(" "),
      suggestion.filePaths.join(" "),
    ].join(" "),
  );
  const overlapCount = suggestion.filePaths.filter((filePath) => topPaths.has(filePath)).length;
  const overlapBoost = topPaths.size > 0 ? overlapCount / topPaths.size : 0;
  const score = clamp01(coverage.score * 0.6 + overlapBoost * 0.4);
  if (score <= 0) return null;
  return {
    kind: "suggested",
    label: suggestion.label,
    path: suggestion.markdownPath,
    score,
    linkedPaths: suggestion.filePaths.slice(0, 6),
    rationale: suggestion.rationale,
  };
}

async function collectManualHubHits(
  rootDir: string,
  queryTerms: string[],
  topPaths: Set<string>,
): Promise<ResearchHubHit[]> {
  const hubs = await discoverHubs(rootDir);
  const results: ResearchHubHit[] = [];
  for (const hubPath of hubs) {
    const hub = await parseHubFile(`${rootDir}/${hubPath}`);
    const linkedPaths = hub.links.map((link) => link.target);
    const coverage = computeCoverageScore(
      queryTerms,
      [
        hub.title,
        hub.hubPath,
        hub.links.map((link) => `${link.target} ${link.description ?? ""}`).join(" "),
        hub.crossLinks.map((link) => link.hubName).join(" "),
      ].join(" "),
    );
    const overlapCount = linkedPaths.filter((filePath) => topPaths.has(filePath)).length;
    const overlapBoost = topPaths.size > 0 ? overlapCount / topPaths.size : 0;
    const score = clamp01(coverage.score * 0.55 + overlapBoost * 0.45);
    if (score <= 0) continue;
    results.push({
      kind: "manual",
      label: hub.title,
      path: hubPath,
      score,
      linkedPaths: linkedPaths.slice(0, 6),
    });
  }
  return results;
}

function collectRelatedHits(
  codeHits: UnifiedRankedHit[],
  clusterState: PersistedSemanticClusterState,
  structureState: PersistedStructureIndexState,
  maxRelated: number,
): ResearchRelatedHit[] {
  const related = new Map<string, ResearchRelatedHit>();
  const topPaths = Array.from(new Set(codeHits.map((hit) => hit.path)));

  for (const path of topPaths) {
    for (const edge of clusterState.relatedFiles[path] ?? []) {
      if (topPaths.includes(edge.path)) continue;
      const current = related.get(edge.path);
      if (!current || edge.score > current.score) {
        related.set(edge.path, {
          path: edge.path,
          score: clamp01(edge.score),
          reason: edge.reason,
          source: "cluster",
        });
      }
    }

    for (const dependencyPath of structureState.files[path]?.artifact.dependencyPaths ?? []) {
      if (topPaths.includes(dependencyPath)) continue;
      const current = related.get(dependencyPath);
      const score = 0.72;
      if (!current || score > current.score) {
        related.set(dependencyPath, {
          path: dependencyPath,
          score,
          reason: `Imported by ${path}`,
          source: "dependency",
        });
      }
    }
  }

  return Array.from(related.values())
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, maxRelated);
}

function dedupeHubHits(hits: ResearchHubHit[]): ResearchHubHit[] {
  const deduped = new Map<string, ResearchHubHit>();
  for (const hit of hits) {
    const key = `${hit.kind}:${hit.path}`;
    const current = deduped.get(key);
    if (!current || hit.score > current.score) deduped.set(key, hit);
  }
  return Array.from(deduped.values());
}

export async function buildResearchReport(options: ResearchOptions): Promise<ResearchReport> {
  await assertValidPreparedIndex({
    rootDir: options.rootDir,
    mode: "full",
    consumer: "research",
  });
  const queryTerms = splitTerms(options.query);
  const topK = normalizeTopK(options.topK, 5);
  const maxRelated = normalizeTopK(options.maxRelated, 6);
  const maxSubsystems = normalizeTopK(options.maxSubsystems, 3);
  const maxHubs = normalizeTopK(options.maxHubs, 4);

  const [codeHits, clusterState, structureState, hubSuggestionState] = await Promise.all([
    rankUnifiedSearch({
      rootDir: options.rootDir,
      query: options.query,
      topK,
      entityTypes: ["file", "symbol"],
      includeKinds: options.includeKinds,
    }),
    loadSemanticClusterState(options.rootDir),
    loadStructureState(options.rootDir),
    loadHubSuggestionState(options.rootDir),
  ]);

  const topPaths = new Set(codeHits.map((hit) => hit.path));
  const relatedHits = collectRelatedHits(codeHits, clusterState, structureState, maxRelated);
  const subsystemHits = Object.values(clusterState.subsystemSummaries)
    .map((summary) => scoreSubsystem(queryTerms, topPaths, summary))
    .filter((value): value is ResearchSubsystemHit => Boolean(value))
    .sort((left, right) => right.score - left.score || left.summary.label.localeCompare(right.summary.label))
    .slice(0, maxSubsystems);

  const suggestedHubHits = Object.values(hubSuggestionState.suggestions)
    .map((suggestion) => scoreSuggestedHub(queryTerms, topPaths, suggestion))
    .filter((value): value is ResearchHubHit => Boolean(value));
  const manualHubHits = await collectManualHubHits(options.rootDir, queryTerms, topPaths);
  const hubHits = dedupeHubHits([...manualHubHits, ...suggestedHubHits])
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, maxHubs);

  return {
    query: options.query,
    codeHits,
    relatedHits,
    subsystemHits,
    hubHits,
  };
}

export function formatResearchReport(report: ResearchReport): string {
  const lines = [
    `Research: "${report.query}"`,
    "",
    "Code hits:",
  ];

  if (report.codeHits.length === 0) {
    lines.push("  No ranked code hits found in the prepared full-engine artifacts.");
  } else {
    lines.push(formatUnifiedSearchResults(report.query, ["file", "symbol"], report.codeHits));
  }

  lines.push("");
  lines.push("Related context:");
  if (report.relatedHits.length === 0) {
    lines.push("  No additional related files found.");
  } else {
    for (const hit of report.relatedHits) {
      lines.push(`  ${hit.path} | ${hit.source} | score=${hit.score.toFixed(2)} | ${hit.reason}`);
    }
  }

  lines.push("");
  lines.push("Subsystem context:");
  if (report.subsystemHits.length === 0) {
    lines.push("  No matching subsystem summaries found.");
  } else {
    for (const hit of report.subsystemHits) {
      lines.push(`  [${hit.summary.label}] score=${hit.score.toFixed(2)} | ${hit.summary.overarchingTheme}`);
      lines.push(`    ${hit.summary.distinguishingFeature}`);
      lines.push(`    files: ${hit.summary.filePaths.slice(0, 4).join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Hub context:");
  if (report.hubHits.length === 0) {
    lines.push("  No relevant manual or suggested hubs found.");
  } else {
    for (const hit of report.hubHits) {
      lines.push(`  [${hit.kind}] ${hit.path} | ${hit.label} | score=${hit.score.toFixed(2)}`);
      if (hit.linkedPaths.length > 0) lines.push(`    linked files: ${hit.linkedPaths.join(", ")}`);
      if (hit.rationale) lines.push(`    rationale: ${hit.rationale}`);
    }
  }

  return lines.join("\n");
}

export async function runResearch(options: ResearchOptions): Promise<string> {
  return formatResearchReport(await buildResearchReport(options));
}
