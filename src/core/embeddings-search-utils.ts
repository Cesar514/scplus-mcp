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

// Purpose: Split camelCase, PascalCase, and delimiter-separated text into normalized search terms.
// Inputs: The raw text that should be tokenized into searchable terms.
// Returns/Effects: Returns normalized lowercase terms longer than one character.
export function splitCamelCase(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((term) => term.length > 1);
}

// Purpose: Clamp a numeric score into the inclusive `[0, 1]` range.
// Inputs: The numeric value that should be clamped.
// Returns/Effects: Returns the bounded value within the normalized score range.
function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

// Purpose: Normalize threshold options expressed as ratios or percentages into `[0, 1]`.
// Inputs: The optional raw threshold value plus the fallback threshold.
// Returns/Effects: Returns a normalized threshold value within `[0, 1]`.
function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value > 1) return clamp01(value / 100);
  return clamp01(value);
}

// Purpose: Normalize weight options by rejecting invalid or negative values in favor of a fallback.
// Inputs: The optional raw weight value plus the fallback weight.
// Returns/Effects: Returns the validated non-negative weight value.
function normalizeWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

// Purpose: Normalize the requested top-K result count to a positive integer.
// Inputs: The optional raw top-K value plus the fallback result count.
// Returns/Effects: Returns a positive integer top-K value.
function normalizeTopK(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

// Purpose: Measure how much of the query term set appears in a document term set.
// Inputs: The normalized query terms plus the normalized document terms.
// Returns/Effects: Returns the matched-term coverage ratio between 0 and 1.
function getTermCoverage(queryTerms: Set<string>, docTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) matched++;
  }
  return matched / queryTerms.size;
}

// Purpose: Resolve flexible search options into the normalized embedding-search option shape.
// Inputs: Either a numeric top-K value or a partial search-options object.
// Returns/Effects: Returns the fully resolved search option object used by ranking code.
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

// Purpose: Identify which symbol names contain one or more query terms after normalization.
// Inputs: The symbol names from one document plus the normalized query term set.
// Returns/Effects: Returns the subset of symbol names that match the query terms.
export function getMatchedSymbols(symbols: string[], queryTerms: Set<string>): string[] {
  if (queryTerms.size === 0) return [];
  return symbols.filter((symbol) => splitCamelCase(symbol).some((term) => queryTerms.has(term)));
}

// Purpose: Compute the lexical keyword score for one document against the current query.
// Inputs: The raw query, normalized query terms, the candidate document, and matched symbol names.
// Returns/Effects: Returns the combined lexical score for the document in `[0, 1]`.
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

// Purpose: Combine semantic and lexical scores using the configured search weights.
// Inputs: The semantic score, keyword score, and resolved search options.
// Returns/Effects: Returns the weighted combined ranking score in `[0, 1]`.
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
