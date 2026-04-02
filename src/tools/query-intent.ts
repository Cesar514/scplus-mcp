// Query-intent router for exact lookups, related discovery, and research
// FEATURE: Step 19 routing between fast exact tools and richer search

import {
  ExactSymbolHit,
  WordMatchHit,
  formatExactSymbolResults,
  formatPathCandidates,
  formatWordMatches,
  lookupExactSymbol,
  lookupPathCandidates,
  lookupWord,
} from "./exact-query.js";
import {
  buildUnifiedSearchReport,
  formatUnifiedSearchResults,
  type RetrievalMode,
  type UnifiedSearchDiagnostics,
  type UnifiedRankedHit,
} from "./unified-ranking.js";

export type SearchIntent = "exact" | "related";
export type SearchEntityType = "file" | "symbol" | "mixed";

export interface SearchIntentOptions {
  rootDir: string;
  intent: SearchIntent;
  searchType: SearchEntityType;
  query: string;
  topK?: number;
  includeKinds?: string[];
  retrievalMode?: RetrievalMode;
}

export interface ExactSearchReport {
  intent: "exact";
  searchType: SearchEntityType;
  query: string;
  topK: number;
  includeKinds?: string[];
  symbolHits: ExactSymbolHit[];
  pathHits: string[];
  wordHits: WordMatchHit[];
  text: string;
}

export interface RelatedSearchReport {
  intent: "related";
  searchType: SearchEntityType;
  query: string;
  topK: number;
  includeKinds?: string[];
  retrievalMode: RetrievalMode;
  hits: UnifiedRankedHit[];
  diagnostics: UnifiedSearchDiagnostics;
  text: string;
}

export type SearchIntentReport = ExactSearchReport | RelatedSearchReport;

function filterSymbolHitsByKind(hits: ExactSymbolHit[], includeKinds?: string[]): ExactSymbolHit[] {
  if (!includeKinds || includeKinds.length === 0) return hits;
  const allowed = new Set(includeKinds.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return hits;
  return hits.filter((hit) => allowed.has(hit.kind.toLowerCase()));
}

function filterWordHitsByKind(hits: WordMatchHit[], includeKinds?: string[]): WordMatchHit[] {
  if (!includeKinds || includeKinds.length === 0) return hits;
  const allowed = new Set(includeKinds.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return hits;
  return hits.filter((hit) => hit.kind === "symbol" ? allowed.has("symbol") || allowed.has("function") || allowed.has("class") || allowed.has("method") || allowed.has("variable") : true);
}

function formatExactMiss(query: string, scope: "symbol" | "file" | "mixed"): string {
  return [
    `No exact ${scope} matches for "${query}".`,
    'Next step: rerun search with intent="related" for related items and patterns, or use research for broader subsystem understanding.',
  ].join("\n");
}

async function runExactSearch(options: SearchIntentOptions): Promise<string> {
  return (await buildExactSearchReport(options)).text;
}

async function buildExactSearchReport(options: SearchIntentOptions): Promise<ExactSearchReport> {
  const topK = options.topK ?? 5;
  if (options.searchType === "symbol") {
    const symbolHits = filterSymbolHitsByKind(await lookupExactSymbol(options.rootDir, options.query, topK), options.includeKinds);
    return {
      intent: "exact",
      searchType: options.searchType,
      query: options.query,
      topK,
      includeKinds: options.includeKinds,
      symbolHits,
      pathHits: [],
      wordHits: [],
      text: symbolHits.length > 0
        ? formatExactSymbolResults(options.query, symbolHits)
        : formatExactMiss(options.query, "symbol"),
    };
  }
  if (options.searchType === "file") {
    const pathHits = await lookupPathCandidates(options.rootDir, options.query, topK);
    return {
      intent: "exact",
      searchType: options.searchType,
      query: options.query,
      topK,
      includeKinds: options.includeKinds,
      symbolHits: [],
      pathHits,
      wordHits: [],
      text: pathHits.length > 0
        ? formatPathCandidates(options.query, pathHits)
        : formatExactMiss(options.query, "file"),
    };
  }

  const symbolHits = filterSymbolHitsByKind(await lookupExactSymbol(options.rootDir, options.query, topK), options.includeKinds);
  const pathHits = await lookupPathCandidates(options.rootDir, options.query, topK);
  const wordHits = filterWordHitsByKind(await lookupWord(options.rootDir, options.query, topK), options.includeKinds);
  let text = formatExactMiss(options.query, "mixed");
  if (symbolHits.length > 0) {
    text = formatExactSymbolResults(options.query, symbolHits);
  } else if (pathHits.length > 0) {
    text = formatPathCandidates(options.query, pathHits);
  } else if (wordHits.length > 0) {
    text = formatWordMatches(options.query, wordHits);
  }
  return {
    intent: "exact",
    searchType: options.searchType,
    query: options.query,
    topK,
    includeKinds: options.includeKinds,
    symbolHits,
    pathHits,
    wordHits,
    text,
  };
}

function normalizeRelatedRetrievalMode(mode: RetrievalMode | undefined): RetrievalMode {
  return mode ?? "both";
}

async function buildRelatedSearchReport(options: SearchIntentOptions): Promise<RelatedSearchReport> {
  const topK = options.topK ?? 5;
  const retrievalMode = normalizeRelatedRetrievalMode(options.retrievalMode);
  const entityTypes: Array<"file" | "symbol"> = options.searchType === "mixed" ? ["file", "symbol"] : [options.searchType];
  const unifiedReport = await buildUnifiedSearchReport({
    rootDir: options.rootDir,
    query: options.query,
    topK,
    entityTypes,
    includeKinds: options.includeKinds,
    retrievalMode,
  });
  const hits = unifiedReport.hits;
  return {
    intent: "related",
    searchType: options.searchType,
    query: options.query,
    topK,
    includeKinds: options.includeKinds,
    retrievalMode,
    hits,
    diagnostics: unifiedReport.diagnostics,
    text: formatUnifiedSearchResults(options.query, entityTypes, hits, retrievalMode, unifiedReport.diagnostics),
  };
}

export async function buildSearchByIntentReport(options: SearchIntentOptions): Promise<SearchIntentReport> {
  if (options.intent === "exact") {
    return buildExactSearchReport(options);
  }
  return buildRelatedSearchReport(options);
}

export async function runSearchByIntent(options: SearchIntentOptions): Promise<string> {
  return (await buildSearchByIntentReport(options)).text;
}
