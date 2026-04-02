// Persisted hybrid retrieval indexes for chunk and identifier artifacts
// FEATURE: SQLite-backed lexical plus dense retrieval state for full-engine search

import {
  fetchEmbedding,
  inspectEmbeddingCacheCoverage,
  loadEmbeddingCacheEntries,
  type EmbeddingCacheCoverage,
} from "../core/embeddings.js";
import { loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION } from "./index-contract.js";
import type { ChunkArtifact, PersistedChunkIndexState } from "./chunk-index.js";

interface PersistedIdentifierDoc {
  id: string;
  path: string;
  header: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
  text: string;
}

interface PersistedIdentifierFileEntry {
  contentHash: string;
  docs: PersistedIdentifierDoc[];
  lines: string[];
}

interface PersistedIdentifierIndexState {
  generatedAt: string;
  files: Record<string, PersistedIdentifierFileEntry>;
}

export interface HybridRetrievalDocument {
  id: string;
  source: "chunk" | "identifier";
  entityType: "file" | "symbol";
  path: string;
  title: string;
  kind: string;
  line: number;
  endLine: number;
  parentName?: string;
  lexicalText: string;
  lexicalFingerprint: string;
  embeddingCacheKey: string;
  termFrequencies: Record<string, number>;
}

interface HybridLexicalPosting {
  id: string;
  frequency: number;
}

interface PersistedHybridLexicalIndex {
  documentCount: number;
  terms: Record<string, HybridLexicalPosting[]>;
}

export interface PersistedHybridRetrievalState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  source: "chunk" | "identifier";
  documents: Record<string, HybridRetrievalDocument>;
  lexicalIndex: PersistedHybridLexicalIndex;
}

export interface HybridRetrievalStats {
  indexedDocuments: number;
  changedDocuments: number;
  reusedDocuments: number;
  uniqueTerms: number;
}

export interface HybridSearchMatch {
  id: string;
  source: "chunk" | "identifier";
  entityType: "file" | "symbol";
  path: string;
  title: string;
  kind: string;
  line: number;
  endLine: number;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  matchedTerms: string[];
}

export interface HybridSearchOptions {
  topK?: number;
  semanticWeight?: number;
  lexicalWeight?: number;
  queryVector?: number[];
}

const MAX_LEXICAL_TERM_LENGTH = 64;
const MAX_LEXICAL_TERMS_PER_DOCUMENT = 256;

export interface HybridSearchDiagnostics {
  totalDocuments: number;
  lexicalCandidateCount: number;
  rerankCandidateCount: number;
  finalResultCount: number;
  retrievalMode: "semantic" | "keyword" | "both";
  vectorCoverage: HybridVectorCoverageDiagnostics;
}

export interface HybridSearchResult {
  matches: HybridSearchMatch[];
  diagnostics: HybridSearchDiagnostics;
}

export interface HybridVectorCoverageDiagnostics {
  state: "complete" | "explicit-lexical-only" | "missing-vectors";
  requestedVectorCount: number;
  loadedVectorCount: number;
  missingVectorCount: number;
  coverageRatio: number;
  missingVectorIds: string[];
}

export interface HybridVectorCoverageSummary {
  source: "chunk" | "identifier";
  totalDocuments: number;
  vectorCoverage: HybridVectorCoverageDiagnostics;
}

export interface HybridSearchRuntimeSourceStats {
  searchCalls: number;
  lexicalCandidateCount: number;
  rerankCandidateCount: number;
  finalResultCount: number;
  lastLexicalCandidateCount: number;
  lastRerankCandidateCount: number;
  lastFinalResultCount: number;
}

export interface HybridSearchRuntimeStats {
  chunk: HybridSearchRuntimeSourceStats;
  identifier: HybridSearchRuntimeSourceStats;
}

export class HybridVectorIntegrityError extends Error {
  readonly rootDir: string;
  readonly source: "chunk" | "identifier";
  readonly retrievalMode: "semantic" | "keyword" | "both";
  readonly diagnostics: HybridVectorCoverageDiagnostics;

  constructor(
    rootDir: string,
    source: "chunk" | "identifier",
    retrievalMode: "semantic" | "keyword" | "both",
    diagnostics: HybridVectorCoverageDiagnostics,
  ) {
    const preview = diagnostics.missingVectorIds.slice(0, 5).join(", ");
    super(
      `Hybrid ${source} search cannot continue: missing ${diagnostics.missingVectorCount}/${diagnostics.requestedVectorCount} vectors ` +
      `for retrievalMode=${retrievalMode}. Coverage=${diagnostics.coverageRatio.toFixed(2)}.` +
      (preview ? ` Missing ids: ${preview}` : ""),
    );
    this.name = "HybridVectorIntegrityError";
    this.rootDir = rootDir;
    this.source = source;
    this.retrievalMode = retrievalMode;
    this.diagnostics = diagnostics;
  }
}

let hybridSearchRuntimeStats: HybridSearchRuntimeStats = {
  chunk: {
    searchCalls: 0,
    lexicalCandidateCount: 0,
    rerankCandidateCount: 0,
    finalResultCount: 0,
    lastLexicalCandidateCount: 0,
    lastRerankCandidateCount: 0,
    lastFinalResultCount: 0,
  },
  identifier: {
    searchCalls: 0,
    lexicalCandidateCount: 0,
    rerankCandidateCount: 0,
    finalResultCount: 0,
    lastLexicalCandidateCount: 0,
    lastRerankCandidateCount: 0,
    lastFinalResultCount: 0,
  },
};

export function getHybridSearchRuntimeStats(): HybridSearchRuntimeStats {
  return {
    chunk: { ...hybridSearchRuntimeStats.chunk },
    identifier: { ...hybridSearchRuntimeStats.identifier },
  };
}

export function resetHybridSearchRuntimeStats(): void {
  hybridSearchRuntimeStats = {
    chunk: {
      searchCalls: 0,
      lexicalCandidateCount: 0,
      rerankCandidateCount: 0,
      finalResultCount: 0,
      lastLexicalCandidateCount: 0,
      lastRerankCandidateCount: 0,
      lastFinalResultCount: 0,
    },
    identifier: {
      searchCalls: 0,
      lexicalCandidateCount: 0,
      rerankCandidateCount: 0,
      finalResultCount: 0,
      lastLexicalCandidateCount: 0,
      lastRerankCandidateCount: 0,
      lastFinalResultCount: 0,
    },
  };
}

function recordHybridSearchRuntimeStats(
  source: "chunk" | "identifier",
  diagnostics: HybridSearchDiagnostics,
): void {
  const current = hybridSearchRuntimeStats[source];
  current.searchCalls++;
  current.lexicalCandidateCount += diagnostics.lexicalCandidateCount;
  current.rerankCandidateCount += diagnostics.rerankCandidateCount;
  current.finalResultCount += diagnostics.finalResultCount;
  current.lastLexicalCandidateCount = diagnostics.lexicalCandidateCount;
  current.lastRerankCandidateCount = diagnostics.rerankCandidateCount;
  current.lastFinalResultCount = diagnostics.finalResultCount;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function normalizeTopK(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function resolveHybridRetrievalMode(semanticWeight: number, lexicalWeight: number): "semantic" | "keyword" | "both" {
  if (semanticWeight > 0 && lexicalWeight > 0) return "both";
  if (semanticWeight > 0) return "semantic";
  return "keyword";
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash}`;
}

function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

function buildTermFrequencies(text: string): Record<string, number> {
  const frequencies: Record<string, number> = {};
  for (const term of splitTerms(text)) {
    if (term.length > MAX_LEXICAL_TERM_LENGTH) continue;
    if (!/[a-z_]/.test(term)) continue;
    frequencies[term] = (frequencies[term] ?? 0) + 1;
  }
  const entries = Object.entries(frequencies);
  if (entries.length <= MAX_LEXICAL_TERMS_PER_DOCUMENT) return frequencies;
  return Object.fromEntries(
    entries
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_LEXICAL_TERMS_PER_DOCUMENT),
  );
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function buildChunkLexicalText(chunk: ChunkArtifact): string {
  if (chunk.chunkType === "file-fallback") {
    return [
      chunk.path,
      chunk.header,
      chunk.symbolKind,
      chunk.signature ?? "",
    ].join(" ").trim();
  }
  return [
    chunk.path,
    chunk.header,
    chunk.symbolName ?? "",
    chunk.symbolKind,
    chunk.signature ?? "",
    Array.isArray(chunk.symbolPath) ? chunk.symbolPath.join(" ") : "",
    chunk.content,
  ].join(" ").trim();
}

function buildChunkHybridDocument(chunk: ChunkArtifact): HybridRetrievalDocument {
  const lexicalText = buildChunkLexicalText(chunk);
  return {
    id: chunk.id,
    source: "chunk",
    entityType: chunk.chunkType === "file-fallback" ? "file" : "symbol",
    path: chunk.path,
    title: chunk.symbolName ?? "file",
    kind: chunk.symbolKind,
    line: chunk.line,
    endLine: chunk.endLine,
    lexicalText,
    lexicalFingerprint: hashText(lexicalText),
    embeddingCacheKey: chunk.id,
    termFrequencies: buildTermFrequencies(lexicalText),
  };
}

function buildIdentifierHybridDocument(doc: PersistedIdentifierDoc): HybridRetrievalDocument {
  const lexicalText = [
    doc.path,
    doc.header,
    doc.name,
    doc.kind,
    doc.signature,
    doc.parentName ?? "",
    doc.text,
  ].join(" ").trim();
  return {
    id: doc.id,
    source: "identifier",
    entityType: "symbol",
    path: doc.path,
    title: doc.name,
    kind: doc.kind,
    line: doc.line,
    endLine: doc.endLine,
    parentName: doc.parentName,
    lexicalText,
    lexicalFingerprint: hashText(lexicalText),
    embeddingCacheKey: `id:${doc.id}`,
    termFrequencies: buildTermFrequencies(lexicalText),
  };
}

function countUniqueTerms(documents: Record<string, HybridRetrievalDocument>): number {
  const terms = new Set<string>();
  for (const document of Object.values(documents)) {
    for (const term of Object.keys(document.termFrequencies)) terms.add(term);
  }
  return terms.size;
}

function buildLexicalIndex(documents: Record<string, HybridRetrievalDocument>): PersistedHybridLexicalIndex {
  const terms = new Map<string, HybridLexicalPosting[]>();
  for (const document of Object.values(documents)) {
    for (const [term, frequency] of Object.entries(document.termFrequencies)) {
      const postings = terms.get(term) ?? [];
      postings.push({ id: document.id, frequency });
      terms.set(term, postings);
    }
  }

  return {
    documentCount: Object.keys(documents).length,
    terms: Object.fromEntries(
      Array.from(terms.entries(), ([term, postings]) => [
        term,
        postings.sort((left, right) => right.frequency - left.frequency || left.id.localeCompare(right.id)),
      ]),
    ),
  };
}

export async function loadHybridChunkIndexState(rootDir: string): Promise<PersistedHybridRetrievalState> {
  return loadIndexArtifact(rootDir, "hybrid-chunk-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    source: "chunk",
    documents: {},
    lexicalIndex: {
      documentCount: 0,
      terms: {},
    },
  }));
}

export async function loadHybridIdentifierIndexState(rootDir: string): Promise<PersistedHybridRetrievalState> {
  return loadIndexArtifact(rootDir, "hybrid-identifier-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    source: "identifier",
    documents: {},
    lexicalIndex: {
      documentCount: 0,
      terms: {},
    },
  }));
}

export async function refreshHybridChunkIndex(rootDir: string, chunkState?: PersistedChunkIndexState): Promise<{ state: PersistedHybridRetrievalState; stats: HybridRetrievalStats }> {
  const previous = await loadHybridChunkIndexState(rootDir);
  const chunks = (chunkState ?? await loadIndexArtifact(rootDir, "chunk-search-index", () => {
    throw new Error("Chunk index is required before building the hybrid chunk retrieval index.");
  })).files;
  const documents: Record<string, HybridRetrievalDocument> = {};
  let changedDocuments = 0;
  let reusedDocuments = 0;

  for (const entry of Object.values(chunks)) {
    for (const chunk of entry.chunks) {
      const document = buildChunkHybridDocument(chunk);
      const previousDocument = previous.documents[document.id];
      if (previousDocument?.lexicalFingerprint === document.lexicalFingerprint) reusedDocuments++;
      else changedDocuments++;
      documents[document.id] = document;
    }
  }

  const state: PersistedHybridRetrievalState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    source: "chunk",
    documents,
    lexicalIndex: buildLexicalIndex(documents),
  };
  await saveIndexArtifact(rootDir, "hybrid-chunk-index", state);
  return {
    state,
    stats: {
      indexedDocuments: Object.keys(documents).length,
      changedDocuments,
      reusedDocuments,
      uniqueTerms: countUniqueTerms(documents),
    },
  };
}

export async function refreshHybridIdentifierIndex(rootDir: string): Promise<{ state: PersistedHybridRetrievalState; stats: HybridRetrievalStats }> {
  const previous = await loadHybridIdentifierIndexState(rootDir);
  const identifierState = await loadIndexArtifact<PersistedIdentifierIndexState>(rootDir, "identifier-search-index", () => {
    throw new Error("Identifier index is required before building the hybrid identifier retrieval index.");
  });
  const documents: Record<string, HybridRetrievalDocument> = {};
  let changedDocuments = 0;
  let reusedDocuments = 0;

  for (const entry of Object.values(identifierState.files)) {
    for (const doc of entry.docs) {
      const document = buildIdentifierHybridDocument(doc);
      const previousDocument = previous.documents[document.id];
      if (previousDocument?.lexicalFingerprint === document.lexicalFingerprint) reusedDocuments++;
      else changedDocuments++;
      documents[document.id] = document;
    }
  }

  const state: PersistedHybridRetrievalState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    source: "identifier",
    documents,
    lexicalIndex: buildLexicalIndex(documents),
  };
  await saveIndexArtifact(rootDir, "hybrid-identifier-index", state);
  return {
    state,
    stats: {
      indexedDocuments: Object.keys(documents).length,
      changedDocuments,
      reusedDocuments,
      uniqueTerms: countUniqueTerms(documents),
    },
  };
}

async function searchHybridState(
  rootDir: string,
  state: PersistedHybridRetrievalState,
  fileName: "chunk-embeddings-cache.json" | "identifier-embeddings-cache.json",
  query: string,
  options?: HybridSearchOptions,
): Promise<HybridSearchResult> {
  const documents = Object.values(state.documents);
  const semanticWeight = normalizeWeight(options?.semanticWeight, 0.68);
  const lexicalWeight = normalizeWeight(options?.lexicalWeight, 0.32);
  const retrievalMode = resolveHybridRetrievalMode(semanticWeight, lexicalWeight);
  if (documents.length === 0) {
    const diagnostics: HybridSearchDiagnostics = {
      totalDocuments: 0,
      lexicalCandidateCount: 0,
      rerankCandidateCount: 0,
      finalResultCount: 0,
      retrievalMode,
      vectorCoverage: {
        state: retrievalMode === "keyword" ? "explicit-lexical-only" : "complete",
        requestedVectorCount: 0,
        loadedVectorCount: 0,
        missingVectorCount: 0,
        coverageRatio: 1,
        missingVectorIds: [],
      },
    };
    recordHybridSearchRuntimeStats(state.source, diagnostics);
    return {
      matches: [],
      diagnostics,
    };
  }

  const queryVector = retrievalMode === "keyword"
    ? null
    : (options?.queryVector ?? (await fetchEmbedding(query))[0]);
  const queryTerms = Array.from(new Set(splitTerms(query)));
  const topK = normalizeTopK(options?.topK, 5);
  const totalWeight = semanticWeight + lexicalWeight;
  const candidateAccumulator = new Map<string, { matchedTerms: Set<string>; frequencyBoost: number }>();
  for (const term of queryTerms) {
    const postings = state.lexicalIndex.terms[term] ?? [];
    for (const posting of postings) {
      const candidate = candidateAccumulator.get(posting.id) ?? {
        matchedTerms: new Set<string>(),
        frequencyBoost: 0,
      };
      candidate.matchedTerms.add(term);
      candidate.frequencyBoost += Math.min(0.12, posting.frequency * 0.04);
      candidateAccumulator.set(posting.id, candidate);
    }
  }
  const lexicalCandidates = Array.from(candidateAccumulator.entries())
    .map(([documentId, lexicalCandidate]) => {
      const document = state.documents[documentId];
      if (!document) throw new Error(`Hybrid lexical index referenced missing document ${documentId}.`);
      const coverage = queryTerms.length === 0 ? 0 : lexicalCandidate.matchedTerms.size / queryTerms.length;
      const phraseBoost = query.trim().length > 0 && document.lexicalText.toLowerCase().includes(query.trim().toLowerCase()) ? 0.18 : 0;
      return {
        document,
        lexicalScore: clamp01(coverage * 0.72 + lexicalCandidate.frequencyBoost + phraseBoost),
        matchedTerms: Array.from(lexicalCandidate.matchedTerms).sort(),
      };
    })
    .sort((left, right) => right.lexicalScore - left.lexicalScore || left.document.path.localeCompare(right.document.path));
  const rerankCandidateCount = Math.min(lexicalCandidates.length, Math.max(topK * 12, 64));
  const selectedCandidates = lexicalCandidates.slice(0, rerankCandidateCount);
  const candidateVectorIds = selectedCandidates.map((candidate) => candidate.document.embeddingCacheKey);
  const candidateVectors = retrievalMode === "keyword"
    ? {}
    : await loadEmbeddingCacheEntries(
      rootDir,
      fileName,
      candidateVectorIds,
    );
  const missingVectorIds = retrievalMode === "keyword"
    ? []
    : candidateVectorIds.filter((entryId) => !candidateVectors[entryId]);
  const vectorCoverage: HybridVectorCoverageDiagnostics = retrievalMode === "keyword"
    ? {
      state: "explicit-lexical-only",
      requestedVectorCount: 0,
      loadedVectorCount: 0,
      missingVectorCount: 0,
      coverageRatio: 1,
      missingVectorIds: [],
    }
    : {
      state: missingVectorIds.length > 0 ? "missing-vectors" : "complete",
      requestedVectorCount: candidateVectorIds.length,
      loadedVectorCount: candidateVectorIds.length - missingVectorIds.length,
      missingVectorCount: missingVectorIds.length,
      coverageRatio: candidateVectorIds.length === 0 ? 1 : (candidateVectorIds.length - missingVectorIds.length) / candidateVectorIds.length,
      missingVectorIds,
    };
  if (vectorCoverage.state === "missing-vectors") {
    throw new HybridVectorIntegrityError(rootDir, state.source, retrievalMode, vectorCoverage);
  }

  const ranked: HybridSearchMatch[] = [];
  for (const candidate of selectedCandidates) {
    const { document } = candidate;
    const vector = candidateVectors[document.embeddingCacheKey]?.vector;
    const semanticScore = queryVector && vector ? Math.max(cosine(queryVector, vector), 0) : 0;
    const score = totalWeight > 0
      ? clamp01((semanticWeight * semanticScore + lexicalWeight * candidate.lexicalScore) / totalWeight)
      : semanticScore;
    ranked.push({
      id: document.id,
      source: document.source,
      entityType: document.entityType,
      path: document.path,
      title: document.title,
      kind: document.kind,
      line: document.line,
      endLine: document.endLine,
      score,
      semanticScore,
      lexicalScore: candidate.lexicalScore,
      matchedTerms: candidate.matchedTerms,
    });
  }

  const matches = ranked
    .sort((a, b) => b.score - a.score || b.lexicalScore - a.lexicalScore || b.semanticScore - a.semanticScore)
    .slice(0, topK);
  const diagnostics: HybridSearchDiagnostics = {
    totalDocuments: documents.length,
    lexicalCandidateCount: lexicalCandidates.length,
    rerankCandidateCount: selectedCandidates.length,
    finalResultCount: matches.length,
    retrievalMode,
    vectorCoverage,
  };
  recordHybridSearchRuntimeStats(state.source, diagnostics);
  return {
    matches,
    diagnostics,
  };
}

function mapCoverageToDiagnostics(coverage: EmbeddingCacheCoverage): HybridVectorCoverageDiagnostics {
  return {
    state: coverage.missingEntryCount > 0 ? "missing-vectors" : "complete",
    requestedVectorCount: coverage.requestedEntryCount,
    loadedVectorCount: coverage.availableEntryCount,
    missingVectorCount: coverage.missingEntryCount,
    coverageRatio: coverage.coverageRatio,
    missingVectorIds: coverage.missingEntryIds,
  };
}

async function inspectSingleHybridVectorCoverage(
  rootDir: string,
  state: PersistedHybridRetrievalState,
  fileName: "chunk-embeddings-cache.json" | "identifier-embeddings-cache.json",
): Promise<HybridVectorCoverageSummary> {
  const coverage = await inspectEmbeddingCacheCoverage(
    rootDir,
    fileName,
    Object.values(state.documents).map((document) => document.embeddingCacheKey),
  );
  return {
    source: state.source,
    totalDocuments: Object.keys(state.documents).length,
    vectorCoverage: mapCoverageToDiagnostics(coverage),
  };
}

export async function searchHybridChunkIndex(rootDir: string, query: string, options?: HybridSearchOptions): Promise<HybridSearchResult> {
  const state = await loadHybridChunkIndexState(rootDir);
  return searchHybridState(rootDir, state, "chunk-embeddings-cache.json", query, options);
}

export async function searchHybridIdentifierIndex(rootDir: string, query: string, options?: HybridSearchOptions): Promise<HybridSearchResult> {
  const state = await loadHybridIdentifierIndexState(rootDir);
  return searchHybridState(rootDir, state, "identifier-embeddings-cache.json", query, options);
}

export async function inspectHybridVectorCoverage(rootDir: string): Promise<{
  chunk: HybridVectorCoverageSummary;
  identifier: HybridVectorCoverageSummary;
}> {
  const [chunkState, identifierState] = await Promise.all([
    loadHybridChunkIndexState(rootDir),
    loadHybridIdentifierIndexState(rootDir),
  ]);
  const [chunk, identifier] = await Promise.all([
    inspectSingleHybridVectorCoverage(rootDir, chunkState, "chunk-embeddings-cache.json"),
    inspectSingleHybridVectorCoverage(rootDir, identifierState, "identifier-embeddings-cache.json"),
  ]);
  return { chunk, identifier };
}
