// summary: Provides pure query-scoring helpers for embedding-backed semantic search.
// FEATURE: Search option normalization, lexical term extraction, and keyword score calculation.
// inputs: Search queries, candidate documents, and optional search tuning parameters.
// outputs: Normalized search options, matched symbols, and combined ranking scores.

export interface SearchDocumentLike {
  path: string;
  header: string;
  symbols: string[];
  content: string;
}

export interface SearchQueryOptionsLike {
  topK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
  queryVector?: number[];
}

export interface ResolvedSearchQueryOptions {
  topK: number;
  semanticWeight: number;
  keywordWeight: number;
  minSemanticScore: number;
  minKeywordScore: number;
  minCombinedScore: number;
  requireKeywordMatch: boolean;
  requireSemanticMatch: boolean;
  queryVector?: number[];
}

export function splitCamelCase(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((term) => term.length > 1);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value > 1) return clamp01(value / 100);
  return clamp01(value);
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function normalizeTopK(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function getTermCoverage(queryTerms: Set<string>, docTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) matched++;
  }
  return matched / queryTerms.size;
}

export function resolveSearchOptions(
  optionsOrTopK?: number | SearchQueryOptionsLike,
): ResolvedSearchQueryOptions {
  const raw = typeof optionsOrTopK === "number" ? { topK: optionsOrTopK } : (optionsOrTopK ?? {});
  return {
    topK: normalizeTopK(raw.topK, 5),
    semanticWeight: normalizeWeight(raw.semanticWeight, 0.72),
    keywordWeight: normalizeWeight(raw.keywordWeight, 0.28),
    minSemanticScore: normalizeThreshold(raw.minSemanticScore, 0),
    minKeywordScore: normalizeThreshold(raw.minKeywordScore, 0),
    minCombinedScore: normalizeThreshold(raw.minCombinedScore, 0.1),
    requireKeywordMatch: raw.requireKeywordMatch ?? false,
    requireSemanticMatch: raw.requireSemanticMatch ?? false,
    queryVector: raw.queryVector,
  };
}

export function getMatchedSymbols(symbols: string[], queryTerms: Set<string>): string[] {
  if (queryTerms.size === 0) return [];
  return symbols.filter((symbol) => splitCamelCase(symbol).some((term) => queryTerms.has(term)));
}

export function computeKeywordScore(
  query: string,
  queryTerms: Set<string>,
  doc: SearchDocumentLike,
  matchedSymbols: string[],
): number {
  if (queryTerms.size === 0) return 0;
  const docText = `${doc.path} ${doc.header} ${doc.symbols.join(" ")} ${doc.content}`;
  const docTerms = new Set(splitCamelCase(docText));
  const queryLower = query.trim().toLowerCase();
  const phraseBoost = queryLower.length > 0 && docText.toLowerCase().includes(queryLower) ? 0.15 : 0;
  const symbolTerms = new Set(splitCamelCase(matchedSymbols.join(" ")));
  const termCoverage = getTermCoverage(queryTerms, docTerms);
  const symbolCoverage = getTermCoverage(queryTerms, symbolTerms);
  return clamp01(termCoverage * 0.65 + symbolCoverage * 0.2 + phraseBoost);
}

export function computeCombinedScore(
  semanticScore: number,
  keywordScore: number,
  options: ResolvedSearchQueryOptions,
): number {
  const semanticComponent = Math.max(semanticScore, 0);
  const totalWeight = options.semanticWeight + options.keywordWeight;
  if (totalWeight <= 0) return semanticComponent;
  return clamp01((options.semanticWeight * semanticComponent + options.keywordWeight * keywordScore) / totalWeight);
}
