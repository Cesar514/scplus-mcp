// Unified research surface over persisted candidate and explanation artifacts.
// FEATURE: Explanation-backed repository research from the layered query engine.

import { assertValidPreparedIndex } from "./index-reliability.js";
import {
  loadQueryExplanationState,
  type FileExplanationCard,
  type HubExplanationCard,
  type ModuleExplanationCard,
  type PersistedQueryExplanationState,
  type QueryEngineContract,
  type SubsystemExplanationCard,
} from "./query-engine.js";
import {
  buildUnifiedSearchReport,
  formatUnifiedSearchResults,
  type UnifiedRankedHit,
  type UnifiedSearchDiagnostics,
} from "./unified-ranking.js";

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
  source: "cluster" | "dependency" | "reverse-dependency" | "module-peer";
}

interface ResearchSubsystemHit {
  card: SubsystemExplanationCard;
  score: number;
}

interface ResearchHubHit {
  card: HubExplanationCard;
  score: number;
}

interface ResearchFileCardHit {
  path: string;
  score: number;
  card: FileExplanationCard;
}

interface ResearchModuleCardHit {
  modulePath: string;
  score: number;
  card: ModuleExplanationCard;
}

export interface ResearchReport {
  query: string;
  layers: QueryEngineContract;
  searchDiagnostics: UnifiedSearchDiagnostics;
  codeHits: UnifiedRankedHit[];
  fileCards: ResearchFileCardHit[];
  moduleCards: ResearchModuleCardHit[];
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

function collectRelatedHits(
  codeHits: UnifiedRankedHit[],
  explanationState: PersistedQueryExplanationState,
  maxRelated: number,
): ResearchRelatedHit[] {
  const topPaths = new Set(codeHits.map((hit) => hit.path));
  const related = new Map<string, ResearchRelatedHit>();
  for (const path of topPaths) {
    const fileCard = explanationState.fileCards[path];
    if (!fileCard) continue;
    for (const context of fileCard.relatedContexts) {
      if (topPaths.has(context.path)) continue;
      const current = related.get(context.path);
      if (!current || context.score > current.score) {
        related.set(context.path, {
          path: context.path,
          score: clamp01(context.score),
          reason: context.reason,
          source: context.source,
        });
      }
    }
  }
  return Array.from(related.values())
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, maxRelated);
}

function collectFileCardHits(codeHits: UnifiedRankedHit[], explanationState: PersistedQueryExplanationState): ResearchFileCardHit[] {
  const seen = new Set<string>();
  const hits: ResearchFileCardHit[] = [];
  for (const hit of codeHits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    const card = explanationState.fileCards[hit.path];
    if (!card) continue;
    hits.push({
      path: hit.path,
      score: hit.score,
      card,
    });
  }
  return hits;
}

function collectModuleCardHits(
  fileCards: ResearchFileCardHit[],
  explanationState: PersistedQueryExplanationState,
): ResearchModuleCardHit[] {
  const moduleScores = new Map<string, number>();
  for (const hit of fileCards) {
    const current = moduleScores.get(hit.card.modulePath) ?? 0;
    moduleScores.set(hit.card.modulePath, Math.max(current, hit.score));
  }
  return Array.from(moduleScores.entries())
    .map(([modulePath, score]) => {
      const card = explanationState.moduleCards[modulePath];
      return card ? { modulePath, score, card } : null;
    })
    .filter((value): value is ResearchModuleCardHit => Boolean(value))
    .sort((left, right) => right.score - left.score || left.modulePath.localeCompare(right.modulePath));
}

function scoreSubsystem(
  queryTerms: string[],
  topPaths: Set<string>,
  card: SubsystemExplanationCard,
): ResearchSubsystemHit | null {
  const coverage = computeCoverageScore(
    queryTerms,
    [
      card.label,
      card.overview,
      card.rationale,
      card.pathPattern ?? "",
      card.filePaths.join(" "),
      card.modulePaths.join(" "),
    ].join(" "),
  );
  const overlapCount = card.filePaths.filter((filePath) => topPaths.has(filePath)).length;
  const overlapBoost = topPaths.size > 0 ? overlapCount / topPaths.size : 0;
  const score = clamp01(coverage.score * 0.7 + overlapBoost * 0.3);
  if (score <= 0) return null;
  return { card, score };
}

function scoreHub(
  queryTerms: string[],
  topPaths: Set<string>,
  card: HubExplanationCard,
): ResearchHubHit | null {
  const coverage = computeCoverageScore(
    queryTerms,
    [
      card.label,
      card.overview,
      card.rationale,
      card.linkedPaths.join(" "),
      card.modulePaths.join(" "),
      card.featureTags.join(" "),
    ].join(" "),
  );
  const overlapCount = card.linkedPaths.filter((filePath) => topPaths.has(filePath)).length;
  const overlapBoost = topPaths.size > 0 ? overlapCount / topPaths.size : 0;
  const score = clamp01(coverage.score * 0.6 + overlapBoost * 0.4);
  if (score <= 0) return null;
  return { card, score };
}

function dedupeHubHits(hits: ResearchHubHit[]): ResearchHubHit[] {
  const deduped = new Map<string, ResearchHubHit>();
  for (const hit of hits) {
    const key = `${hit.card.kind}:${hit.card.path}`;
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

  const [unifiedReport, explanationState] = await Promise.all([
    buildUnifiedSearchReport({
      rootDir: options.rootDir,
      query: options.query,
      topK,
      entityTypes: ["file", "symbol"],
      includeKinds: options.includeKinds,
    }),
    loadQueryExplanationState(options.rootDir),
  ]);

  const codeHits = unifiedReport.hits;
  const topPaths = new Set(codeHits.map((hit) => hit.path));
  const fileCards = collectFileCardHits(codeHits, explanationState);
  const moduleCards = collectModuleCardHits(fileCards, explanationState);
  const relatedHits = collectRelatedHits(codeHits, explanationState, maxRelated);
  const subsystemHits = Object.values(explanationState.subsystemCards)
    .map((card) => scoreSubsystem(queryTerms, topPaths, card))
    .filter((value): value is ResearchSubsystemHit => Boolean(value))
    .sort((left, right) => right.score - left.score || left.card.label.localeCompare(right.card.label))
    .slice(0, maxSubsystems);
  const hubHits = dedupeHubHits(Object.values(explanationState.hubCards)
    .map((card) => scoreHub(queryTerms, topPaths, card))
    .filter((value): value is ResearchHubHit => Boolean(value))
  )
    .sort((left, right) => right.score - left.score || left.card.path.localeCompare(right.card.path))
    .slice(0, maxHubs);

  return {
    query: options.query,
    layers: explanationState.queryEngine,
    searchDiagnostics: unifiedReport.diagnostics,
    codeHits,
    fileCards,
    moduleCards,
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
    lines.push(formatUnifiedSearchResults(report.query, ["file", "symbol"], report.codeHits, "both", report.searchDiagnostics));
  }

  lines.push("");
  lines.push("Explanation context:");
  if (report.fileCards.length === 0) {
    lines.push("  No explanation cards matched the ranked file set.");
  } else {
    for (const hit of report.fileCards) {
      lines.push(`  [${hit.path}] score=${hit.score.toFixed(2)} | ${hit.card.purposeSummary}`);
      lines.push(`    ${hit.card.publicApiCard}`);
      lines.push(`    ${hit.card.dependencyNeighborhoodSummary}`);
      lines.push(`    ${hit.card.hotPathSummary}`);
      lines.push(`    ${hit.card.ownershipSummary}`);
      lines.push(`    ${hit.card.changeRiskNote}`);
    }
  }

  lines.push("");
  lines.push("Module context:");
  if (report.moduleCards.length === 0) {
    lines.push("  No module explanation cards matched the ranked file set.");
  } else {
    for (const hit of report.moduleCards) {
      lines.push(`  [${hit.modulePath}] score=${hit.score.toFixed(2)} | ${hit.card.purposeSummary}`);
      lines.push(`    ${hit.card.publicApiCard}`);
      lines.push(`    ${hit.card.dependencyNeighborhoodSummary}`);
      lines.push(`    ${hit.card.hotPathSummary}`);
      lines.push(`    ${hit.card.ownershipSummary}`);
      lines.push(`    ${hit.card.changeRiskNote}`);
    }
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
      lines.push(`  [${hit.card.label}] score=${hit.score.toFixed(2)} | ${hit.card.overview}`);
      lines.push(`    ${hit.card.rationale}`);
      lines.push(`    files: ${hit.card.filePaths.slice(0, 4).join(", ")}`);
      if (hit.card.modulePaths.length > 0) {
        lines.push(`    modules: ${hit.card.modulePaths.slice(0, 4).join(", ")}`);
      }
    }
  }

  lines.push("");
  lines.push("Hub context:");
  if (report.hubHits.length === 0) {
    lines.push("  No relevant manual or suggested hubs found.");
  } else {
    for (const hit of report.hubHits) {
      lines.push(`  [${hit.card.kind}] ${hit.card.path} | ${hit.card.label} | score=${hit.score.toFixed(2)}`);
      lines.push(`    ${hit.card.overview}`);
      lines.push(`    rationale: ${hit.card.rationale}`);
      if (hit.card.linkedPaths.length > 0) lines.push(`    linked files: ${hit.card.linkedPaths.join(", ")}`);
      if (hit.card.modulePaths.length > 0) lines.push(`    modules: ${hit.card.modulePaths.join(", ")}`);
    }
  }

  return lines.join("\n");
}

export async function runResearch(options: ResearchOptions): Promise<string> {
  return formatResearchReport(await buildResearchReport(options));
}
