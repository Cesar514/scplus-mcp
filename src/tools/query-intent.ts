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
import { runCanonicalSearch } from "./unified-ranking.js";

export type SearchIntent = "exact" | "related";
export type SearchEntityType = "file" | "symbol" | "mixed";

interface SearchIntentOptions {
  rootDir: string;
  intent: SearchIntent;
  searchType: SearchEntityType;
  query: string;
  topK?: number;
  includeKinds?: string[];
}

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
  const topK = options.topK ?? 5;
  if (options.searchType === "symbol") {
    const symbolHits = filterSymbolHitsByKind(await lookupExactSymbol(options.rootDir, options.query, topK), options.includeKinds);
    return symbolHits.length > 0
      ? formatExactSymbolResults(options.query, symbolHits)
      : formatExactMiss(options.query, "symbol");
  }
  if (options.searchType === "file") {
    const pathHits = await lookupPathCandidates(options.rootDir, options.query, topK);
    return pathHits.length > 0
      ? formatPathCandidates(options.query, pathHits)
      : formatExactMiss(options.query, "file");
  }

  const symbolHits = filterSymbolHitsByKind(await lookupExactSymbol(options.rootDir, options.query, topK), options.includeKinds);
  if (symbolHits.length > 0) return formatExactSymbolResults(options.query, symbolHits);

  const pathHits = await lookupPathCandidates(options.rootDir, options.query, topK);
  if (pathHits.length > 0) return formatPathCandidates(options.query, pathHits);

  const wordHits = filterWordHitsByKind(await lookupWord(options.rootDir, options.query, topK), options.includeKinds);
  if (wordHits.length > 0) return formatWordMatches(options.query, wordHits);

  return formatExactMiss(options.query, "mixed");
}

export async function runSearchByIntent(options: SearchIntentOptions): Promise<string> {
  if (options.intent === "exact") {
    return runExactSearch(options);
  }
  return runCanonicalSearch({
    rootDir: options.rootDir,
    query: options.query,
    topK: options.topK,
    entityTypes: options.searchType === "mixed" ? ["file", "symbol"] : [options.searchType],
    includeKinds: options.includeKinds,
  });
}
