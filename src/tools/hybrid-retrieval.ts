// Persisted hybrid retrieval indexes for chunk and identifier artifacts
// FEATURE: SQLite-backed lexical plus dense retrieval state for full-engine search

import { fetchEmbedding, loadEmbeddingCache, type EmbeddingCache } from "../core/embeddings.js";
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

export interface PersistedHybridRetrievalState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  source: "chunk" | "identifier";
  documents: Record<string, HybridRetrievalDocument>;
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
    frequencies[term] = (frequencies[term] ?? 0) + 1;
  }
  return frequencies;
}

function computeLexicalScore(query: string, queryTerms: string[], document: HybridRetrievalDocument): { score: number; matchedTerms: string[] } {
  if (queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const uniqueQueryTerms = Array.from(new Set(queryTerms));
  let matched = 0;
  let frequencyBoost = 0;
  const matchedTerms: string[] = [];

  for (const term of uniqueQueryTerms) {
    const frequency = document.termFrequencies[term] ?? 0;
    if (frequency > 0) {
      matched++;
      matchedTerms.push(term);
      frequencyBoost += Math.min(0.12, frequency * 0.04);
    }
  }

  const coverage = matched / uniqueQueryTerms.length;
  const phraseBoost = query.trim().length > 0 && document.lexicalText.toLowerCase().includes(query.trim().toLowerCase()) ? 0.18 : 0;
  return {
    score: clamp01(coverage * 0.72 + frequencyBoost + phraseBoost),
    matchedTerms,
  };
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

export async function loadHybridChunkIndexState(rootDir: string): Promise<PersistedHybridRetrievalState> {
  return loadIndexArtifact(rootDir, "hybrid-chunk-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    source: "chunk",
    documents: {},
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
  cache: EmbeddingCache,
  query: string,
  options?: HybridSearchOptions,
): Promise<HybridSearchMatch[]> {
  const documents = Object.values(state.documents);
  if (documents.length === 0) return [];

  const [queryVector] = await fetchEmbedding(query);
  const queryTerms = splitTerms(query);
  const semanticWeight = normalizeWeight(options?.semanticWeight, 0.68);
  const lexicalWeight = normalizeWeight(options?.lexicalWeight, 0.32);
  const totalWeight = semanticWeight + lexicalWeight;

  const ranked: HybridSearchMatch[] = [];
  for (const document of documents) {
    const vector = cache[document.embeddingCacheKey]?.vector;
    const semanticScore = vector ? Math.max(cosine(queryVector, vector), 0) : 0;
    const lexical = computeLexicalScore(query, queryTerms, document);
    const score = totalWeight > 0
      ? clamp01((semanticWeight * semanticScore + lexicalWeight * lexical.score) / totalWeight)
      : semanticScore;
    ranked.push({
      id: document.id,
      source: document.source,
      path: document.path,
      title: document.title,
      kind: document.kind,
      line: document.line,
      endLine: document.endLine,
      score,
      semanticScore,
      lexicalScore: lexical.score,
      matchedTerms: lexical.matchedTerms,
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || b.lexicalScore - a.lexicalScore || b.semanticScore - a.semanticScore)
    .slice(0, normalizeTopK(options?.topK, 5));
}

export async function searchHybridChunkIndex(rootDir: string, query: string, options?: HybridSearchOptions): Promise<HybridSearchMatch[]> {
  const state = await loadHybridChunkIndexState(rootDir);
  const cache = await loadEmbeddingCache(rootDir, "chunk-embeddings-cache.json");
  return searchHybridState(rootDir, state, cache, query, options);
}

export async function searchHybridIdentifierIndex(rootDir: string, query: string, options?: HybridSearchOptions): Promise<HybridSearchMatch[]> {
  const state = await loadHybridIdentifierIndexState(rootDir);
  const cache = await loadEmbeddingCache(rootDir, "identifier-embeddings-cache.json");
  return searchHybridState(rootDir, state, cache, query, options);
}
