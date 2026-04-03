// summary: Produces the unified research surface over persisted candidates and explanations.
// FEATURE: Explanation-backed repository research from the layered query engine.
// inputs: Broad repository questions, ranked artifacts, cluster context, and hub evidence.
// outputs: Aggregated research summaries with supporting repository context.

import { assertValidPreparedIndex } from "./index-reliability.js";
import { generateStructuredChat } from "../core/chat.js";
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

export interface ResearchSemanticSummary {
  answer: string;
  keyFindings: string[];
  recommendedFiles: string[];
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
  semanticSummary: ResearchSemanticSummary;
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

interface ResearchSemanticSummaryResponse {
  answer: string;
  keyFindings: string[];
  recommendedFiles: string[];
}

function buildResearchSemanticSummarySchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["answer", "keyFindings", "recommendedFiles"],
    properties: {
      answer: { type: "string" },
      keyFindings: {
        type: "array",
        items: { type: "string" },
      },
      recommendedFiles: {
        type: "array",
        items: { type: "string" },
      },
    },
  };
}

function buildMockResearchSemanticSummary(report: Omit<ResearchReport, "semanticSummary">): ResearchSemanticSummary {
  const leadPaths = Array.from(new Set(report.codeHits.slice(0, 3).map((hit) => hit.path)));
  const subsystemLabel = report.subsystemHits.find((hit) => hit.card.label !== "Project")?.card.label ?? report.subsystemHits[0]?.card.label;
  const hubLabel = report.hubHits[0]?.card.label;
  return {
    answer: [
      `"${report.query}" is primarily grounded in ${leadPaths.join(", ") || "the prepared repository evidence"}.`,
      subsystemLabel ? `The strongest subsystem signal is ${subsystemLabel}.` : "",
      hubLabel ? `The strongest hub signal is ${hubLabel}.` : "",
    ].filter(Boolean).join(" "),
    keyFindings: [
      leadPaths[0] ? `Primary implementation evidence is ${leadPaths[0]}.` : "No primary code hit was available.",
      report.moduleCards[0] ? `Most relevant module is ${report.moduleCards[0].modulePath}.` : "No relevant module card was available.",
      subsystemLabel ? `Subsystem context is anchored by ${subsystemLabel}.` : "No subsystem summary matched strongly.",
    ],
    recommendedFiles: leadPaths,
  };
}

function normalizeResearchSemanticSummary(value: ResearchSemanticSummaryResponse): ResearchSemanticSummary {
  const answer = value.answer?.trim();
  if (!answer) throw new Error("Research chat summary is missing answer.");
  const keyFindings = Array.isArray(value.keyFindings)
    ? value.keyFindings.map((entry) => entry?.trim()).filter((entry): entry is string => Boolean(entry))
    : [];
  const recommendedFiles = Array.isArray(value.recommendedFiles)
    ? value.recommendedFiles.map((entry) => entry?.trim()).filter((entry): entry is string => Boolean(entry))
    : [];
  return {
    answer,
    keyFindings,
    recommendedFiles,
  };
}

async function buildSemanticResearchSummary(report: Omit<ResearchReport, "semanticSummary">): Promise<ResearchSemanticSummary> {
  const response = await generateStructuredChat<ResearchSemanticSummaryResponse>({
    system: [
      "You synthesize grounded repository research answers from ranked code evidence.",
      "Return strict JSON only.",
      "The answer must directly answer the user's question in 2 to 4 sentences and cite concrete file paths or module paths from the evidence.",
      "Do not invent files or subsystems that are not present in the prompt.",
      "keyFindings must be short standalone sentences grounded in the evidence.",
      "recommendedFiles must contain the most important file paths to inspect next.",
    ].join(" "),
    prompt: JSON.stringify({
      task: "semantic-research-summary",
      query: report.query,
      codeHits: report.codeHits.slice(0, 5).map((hit) => ({
        path: hit.path,
        score: Number(hit.score.toFixed(4)),
        title: hit.title,
        kind: hit.kind,
        matchedTerms: hit.evidence.matchedTerms.slice(0, 5),
      })),
      fileCards: report.fileCards.slice(0, 4).map((hit) => ({
        path: hit.path,
        purposeSummary: hit.card.purposeSummary,
        publicApiCard: hit.card.publicApiCard,
        changeRiskNote: hit.card.changeRiskNote,
      })),
      moduleCards: report.moduleCards.slice(0, 3).map((hit) => ({
        modulePath: hit.modulePath,
        purposeSummary: hit.card.purposeSummary,
      })),
      subsystemHits: report.subsystemHits.slice(0, 3).map((hit) => ({
        label: hit.card.label,
        overview: hit.card.overview,
        rationale: hit.card.rationale,
        filePaths: hit.card.filePaths.slice(0, 5),
      })),
      hubHits: report.hubHits.slice(0, 3).map((hit) => ({
        kind: hit.card.kind,
        label: hit.card.label,
        path: hit.card.path,
        overview: hit.card.overview,
      })),
      responseShape: {
        answer: "2-4 sentence grounded answer",
        keyFindings: ["finding one", "finding two"],
        recommendedFiles: ["src/example.ts"],
      },
    }, null, 2),
    mock: () => buildMockResearchSemanticSummary(report),
    temperature: 0.2,
    maxTokens: 900,
    schema: buildResearchSemanticSummarySchema(),
  });
  return normalizeResearchSemanticSummary(response);
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

  const partialReport = {
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
  return {
    ...partialReport,
    semanticSummary: await buildSemanticResearchSummary(partialReport),
  };
}

export function formatResearchReport(report: ResearchReport): string {
  const lines = [
    `Research: "${report.query}"`,
    "",
    "Semantic answer:",
    `  ${report.semanticSummary.answer}`,
  ];

  if (report.semanticSummary.keyFindings.length > 0) {
    lines.push("");
    lines.push("Key findings:");
    for (const finding of report.semanticSummary.keyFindings) {
      lines.push(`  - ${finding}`);
    }
  }
  if (report.semanticSummary.recommendedFiles.length > 0) {
    lines.push("");
    lines.push(`Recommended files: ${report.semanticSummary.recommendedFiles.join(", ")}`);
  }

  lines.push("");
  lines.push(
    "Code hits:",
  );

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
