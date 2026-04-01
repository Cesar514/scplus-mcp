// Multi-provider vector embedding engine with cosine similarity search
// FEATURE: Provider-backed embeddings with sqlite vector persistence for file, identifier, and chunk retrieval
// Indexes file headers and symbols, persists vectors in sqlite collections

import {
  deleteVectorEntries,
  getIndexGenerationContext,
  loadIndexServingState,
  loadVectorCollection,
  loadVectorEntriesById,
  loadVectorCollectionMap,
  upsertVectorEntries,
  type VectorStoreEntry,
} from "./index-database.js";
import { resolve } from "node:path";

const EMBED_TIMEOUT_MS = 60_000;
let embedAbortController = new AbortController();

export function cancelAllEmbeddings(): void {
  embedAbortController.abort();
  embedAbortController = new AbortController();
}

export interface SearchDocument {
  path: string;
  header: string;
  symbols: string[];
  symbolEntries?: SymbolSearchEntry[];
  content: string;
}

export interface SymbolSearchEntry {
  name: string;
  kind?: string;
  line: number;
  endLine?: number;
  signature?: string;
}

export interface SearchResult {
  path: string;
  score: number;
  semanticScore: number;
  keywordScore: number;
  header: string;
  matchedSymbols: string[];
  matchedSymbolLocations: string[];
}

export interface SearchQueryOptions {
  topK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
}

export interface SearchIndexBuildStats {
  documents: number;
  embeddedDocuments: number;
  reusedDocuments: number;
}

interface ResolvedSearchQueryOptions {
  topK: number;
  semanticWeight: number;
  keywordWeight: number;
  minSemanticScore: number;
  minKeywordScore: number;
  minCombinedScore: number;
  requireKeywordMatch: boolean;
  requireSemanticMatch: boolean;
}

interface EmbedRuntimeOptions {
  num_gpu?: number;
  main_gpu?: number;
  num_thread?: number;
  num_batch?: number;
  num_ctx?: number;
  low_vram?: boolean;
}

export interface EmbeddingCache {
  [path: string]: { hash: string; vector: number[] };
}

interface EmbeddingCacheValue {
  hash: string;
  vector: number[];
}

interface NamespaceProcessCacheEntry {
  entries: Map<string, EmbeddingCacheValue>;
  fullyLoaded: boolean;
}

const EMBED_PROVIDER = (process.env.CONTEXTPLUS_EMBED_PROVIDER ?? "ollama").toLowerCase();
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b-32k";
const OPENAI_EMBED_MODEL = process.env.CONTEXTPLUS_OPENAI_EMBED_MODEL ?? process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";
const OPENAI_API_KEY = process.env.CONTEXTPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE_URL = process.env.CONTEXTPLUS_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const ACTIVE_EMBED_MODEL = EMBED_PROVIDER === "openai" ? OPENAI_EMBED_MODEL : EMBED_MODEL;
const CACHE_FILE = `embeddings-cache-${EMBED_PROVIDER}-${ACTIVE_EMBED_MODEL.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
const MIN_EMBED_BATCH_SIZE = 5;
const MAX_EMBED_BATCH_SIZE = 10;
const DEFAULT_EMBED_BATCH_SIZE = 8;
const MIN_EMBED_INPUT_CHARS = 1;
const SINGLE_INPUT_SHRINK_FACTOR = 0.75;
const MAX_SINGLE_INPUT_RETRIES = 40;
const MIN_EMBED_CHUNK_CHARS = 256;
const DEFAULT_EMBED_CHUNK_CHARS = 2000;
const MAX_EMBED_CHUNK_CHARS = 8000;
const FILE_SEARCH_VECTOR_NAMESPACE = "file-search";
const IDENTIFIER_VECTOR_NAMESPACE = "identifier-search";
const IDENTIFIER_CALLSITE_VECTOR_NAMESPACE = "identifier-callsite-search";
const CHUNK_VECTOR_NAMESPACE = "chunk-search";
const embeddingProcessCache = new Map<string, NamespaceProcessCacheEntry>();
const activeGenerationByRoot = new Map<string, number>();

type OllamaEmbedClient = { embed: (params: Record<string, unknown>) => Promise<{ embeddings: number[][] }> };
let ollamaClient: OllamaEmbedClient | null = null;

async function getOllamaClient(): Promise<OllamaEmbedClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST }) as unknown as OllamaEmbedClient;
  }
  return ollamaClient;
}

async function callOllamaEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  const client = await getOllamaClient();
  const options = getEmbedRuntimeOptions();
  const request: Record<string, unknown> = { model: EMBED_MODEL, input, signal, keep_alive: "10s" };
  if (options) request.options = options;
  const response = await client.embed(request);
  return response.embeddings;
}

async function callOpenAIEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  const url = `${OPENAI_BASE_URL.replace(/\/+$/, "")}/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI embed API error ${response.status}: ${body}`);
  }

  const data = await response.json() as { data: { embedding: number[] }[] };
  return data.data.map((item) => item.embedding);
}

function callMockEmbed(input: string[]): number[][] {
  return input.map((value) => {
    const vector = new Array<number>(64).fill(0);
    for (let i = 0; i < Math.min(value.length, vector.length); i++) {
      vector[i] = ((value.charCodeAt(i) % 101) + 1) / 101;
    }
    const norm = Math.sqrt(vector.reduce((sum, current) => sum + current * current, 0));
    return norm > 0 ? vector.map((entry) => entry / norm) : vector;
  });
}

async function callProviderEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  if (EMBED_PROVIDER === "mock") {
    return callMockEmbed(input);
  }
  if (EMBED_PROVIDER === "openai") {
    return callOpenAIEmbed(input, signal);
  }
  return callOllamaEmbed(input, signal);
}

function toIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
}

function getEmbedRuntimeOptions(): EmbedRuntimeOptions | undefined {
  if (EMBED_PROVIDER === "openai") return undefined;
  const options: EmbedRuntimeOptions = {
    num_gpu: toOptionalInteger(process.env.CONTEXTPLUS_EMBED_NUM_GPU),
    main_gpu: toOptionalInteger(process.env.CONTEXTPLUS_EMBED_MAIN_GPU),
    num_thread: toOptionalInteger(process.env.CONTEXTPLUS_EMBED_NUM_THREAD),
    num_batch: toOptionalInteger(process.env.CONTEXTPLUS_EMBED_NUM_BATCH),
    num_ctx: toOptionalInteger(process.env.CONTEXTPLUS_EMBED_NUM_CTX),
    low_vram: toOptionalBoolean(process.env.CONTEXTPLUS_EMBED_LOW_VRAM),
  };

  if (Object.values(options).every((value) => value === undefined)) return undefined;
  return options;
}

export function getEmbeddingBatchSize(): number {
  const requested = toIntegerOr(process.env.CONTEXTPLUS_EMBED_BATCH_SIZE, DEFAULT_EMBED_BATCH_SIZE);
  return Math.min(MAX_EMBED_BATCH_SIZE, Math.max(MIN_EMBED_BATCH_SIZE, requested));
}

export function getEmbedChunkChars(): number {
  const requested = toIntegerOr(process.env.CONTEXTPLUS_EMBED_CHUNK_CHARS, DEFAULT_EMBED_CHUNK_CHARS);
  return Math.min(MAX_EMBED_CHUNK_CHARS, Math.max(MIN_EMBED_CHUNK_CHARS, requested));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isContextLengthError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("input length exceeds context length")
    || (message.includes("context") && message.includes("exceed"))
    || message.includes("maximum context length");
}

function shrinkEmbeddingInput(input: string): string {
  if (input.length <= MIN_EMBED_INPUT_CHARS) return input;
  const nextLength = Math.max(MIN_EMBED_INPUT_CHARS, Math.floor(input.length * SINGLE_INPUT_SHRINK_FACTOR));
  if (nextLength >= input.length) return input.slice(0, input.length - 1);
  return input.slice(0, nextLength);
}

async function embedSingleAdaptive(input: string): Promise<number[]> {
  let candidate = input;

  for (let attempt = 0; attempt <= MAX_SINGLE_INPUT_RETRIES; attempt++) {
    try {
      const timeoutCtrl = AbortSignal.timeout(EMBED_TIMEOUT_MS);
      const signal = AbortSignal.any([embedAbortController.signal, timeoutCtrl]);
      const embeddings = await callProviderEmbed([candidate], signal);
      if (!embeddings[0]) throw new Error("Missing embedding vector in response");
      return embeddings[0];
    } catch (error) {
      if (!isContextLengthError(error)) throw error;
      const nextCandidate = shrinkEmbeddingInput(candidate);
      if (nextCandidate.length === candidate.length) throw error;
      candidate = nextCandidate;
    }
  }

  throw new Error("Unable to embed oversized input after adaptive retries");
}

async function embedBatchAdaptive(batch: string[]): Promise<number[][]> {
  try {
    const timeoutCtrl = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    const signal = AbortSignal.any([embedAbortController.signal, timeoutCtrl]);
    const embeddings = await callProviderEmbed(batch, signal);
    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding response size mismatch: expected ${batch.length}, got ${embeddings.length}`);
    }
    return embeddings;
  } catch (error) {
    if (!isContextLengthError(error)) throw error;
    if (batch.length === 1) {
      return [await embedSingleAdaptive(batch[0])];
    }
    const middle = Math.ceil(batch.length / 2);
    const left = await embedBatchAdaptive(batch.slice(0, middle));
    const right = await embedBatchAdaptive(batch.slice(middle));
    return [...left, ...right];
  }
}

function splitEmbeddingInput(input: string): string[] {
  const chunkChars = getEmbedChunkChars();
  if (input.length <= chunkChars) return [input];
  const chunks: string[] = [];
  for (let start = 0; start < input.length; start += chunkChars) {
    chunks.push(input.slice(start, start + chunkChars));
  }
  return chunks;
}

function mergeEmbeddingVectors(vectors: number[][], weights: number[]): number[] {
  if (vectors.length === 0) throw new Error("Cannot merge empty embedding vectors");
  if (vectors.length === 1) return vectors[0];

  const dimension = vectors[0].length;
  const merged = new Array<number>(dimension).fill(0);
  let totalWeight = 0;

  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    if (vector.length !== dimension) {
      throw new Error(`Embedding dimension mismatch: expected ${dimension}, got ${vector.length}`);
    }
    const weight = Math.max(1, weights[i] ?? 1);
    totalWeight += weight;
    for (let d = 0; d < dimension; d++) merged[d] += vector[d] * weight;
  }

  if (totalWeight <= 0) return vectors[0];
  for (let d = 0; d < merged.length; d++) merged[d] /= totalWeight;
  return merged;
}

export async function fetchEmbedding(input: string | string[]): Promise<number[][]> {
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) return [];

  const chunkedInputs = inputs.map(splitEmbeddingInput);
  const flattenedInputs = chunkedInputs.flat();
  const batchSize = getEmbeddingBatchSize();
  const flattenedEmbeddings: number[][] = [];

  for (let i = 0; i < flattenedInputs.length; i += batchSize) {
    const batch = flattenedInputs.slice(i, i + batchSize);
    flattenedEmbeddings.push(...await embedBatchAdaptive(batch));
  }

  const embeddings: number[][] = [];
  let offset = 0;
  for (const chunks of chunkedInputs) {
    const vectors = flattenedEmbeddings.slice(offset, offset + chunks.length);
    if (vectors.length !== chunks.length) {
      throw new Error(`Merged embedding size mismatch: expected ${chunks.length}, got ${vectors.length}`);
    }
    embeddings.push(mergeEmbeddingVectors(vectors, chunks.map((chunk) => chunk.length)));
    offset += chunks.length;
  }

  return embeddings;
}

function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

export function buildEmbeddingCacheHash(text: string): string {
  return hashContent(`${EMBED_PROVIDER}:${ACTIVE_EMBED_MODEL}:${text}`);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function splitCamelCase(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((t) => t.length > 1);
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

function resolveSearchOptions(optionsOrTopK?: number | SearchQueryOptions): ResolvedSearchQueryOptions {
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
  };
}

function getTermCoverage(queryTerms: Set<string>, docTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) matched++;
  }
  return matched / queryTerms.size;
}

function getMatchedSymbols(symbols: string[], queryTerms: Set<string>): string[] {
  if (queryTerms.size === 0) return [];
  return symbols.filter((symbol) => splitCamelCase(symbol).some((term) => queryTerms.has(term)));
}

function computeKeywordScore(query: string, queryTerms: Set<string>, doc: SearchDocument, matchedSymbols: string[]): number {
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

function computeCombinedScore(semanticScore: number, keywordScore: number, options: ResolvedSearchQueryOptions): number {
  const semanticComponent = Math.max(semanticScore, 0);
  const totalWeight = options.semanticWeight + options.keywordWeight;
  if (totalWeight <= 0) return semanticComponent;
  return clamp01((options.semanticWeight * semanticComponent + options.keywordWeight * keywordScore) / totalWeight);
}

async function loadCache(rootDir: string): Promise<EmbeddingCache> {
  return loadEmbeddingCache(rootDir, CACHE_FILE);
}

async function saveCache(rootDir: string, cache: EmbeddingCache): Promise<void> {
  await saveEmbeddingCache(rootDir, cache, CACHE_FILE);
}

function shouldMaterializeCurrentGenerationWrite(): boolean {
  const generationContext = getIndexGenerationContext();
  return generationContext?.writeGeneration !== undefined
    && generationContext.writeGeneration !== generationContext.readGeneration;
}

function cloneEmbeddingCacheValue(value: EmbeddingCacheValue): EmbeddingCacheValue {
  return {
    hash: value.hash,
    vector: [...value.vector],
  };
}

function buildProcessCacheKey(rootDir: string, generation: number, namespace: string): string {
  return `${resolve(rootDir)}::${generation}::${namespace}`;
}

function invalidateRootGenerationCache(rootDir: string, activeGeneration: number): void {
  const normalizedRootDir = resolve(rootDir);
  const previousGeneration = activeGenerationByRoot.get(normalizedRootDir);
  if (previousGeneration === activeGeneration) return;
  activeGenerationByRoot.set(normalizedRootDir, activeGeneration);
  for (const cacheKey of embeddingProcessCache.keys()) {
    if (cacheKey.startsWith(`${normalizedRootDir}::`) && !cacheKey.startsWith(`${normalizedRootDir}::${activeGeneration}::`)) {
      embeddingProcessCache.delete(cacheKey);
    }
  }
}

async function resolveReadGeneration(rootDir: string): Promise<number> {
  const generationContext = getIndexGenerationContext();
  if (generationContext?.readGeneration !== undefined) return generationContext.readGeneration;
  const serving = await loadIndexServingState(rootDir);
  invalidateRootGenerationCache(rootDir, serving.activeGeneration);
  return serving.activeGeneration;
}

async function resolveWriteGeneration(rootDir: string): Promise<number> {
  const generationContext = getIndexGenerationContext();
  if (generationContext?.writeGeneration !== undefined) return generationContext.writeGeneration;
  const serving = await loadIndexServingState(rootDir);
  invalidateRootGenerationCache(rootDir, serving.activeGeneration);
  return serving.activeGeneration;
}

async function loadEmbeddingNamespaceEntries(
  rootDir: string,
  namespace: string,
  entryIds?: string[],
): Promise<Map<string, EmbeddingCacheValue>> {
  const generation = await resolveReadGeneration(rootDir);
  const cacheKey = buildProcessCacheKey(rootDir, generation, namespace);
  let namespaceCache = embeddingProcessCache.get(cacheKey);
  if (!namespaceCache) {
    namespaceCache = {
      entries: new Map<string, EmbeddingCacheValue>(),
      fullyLoaded: false,
    };
    embeddingProcessCache.set(cacheKey, namespaceCache);
  }

  if (!entryIds) {
    if (!namespaceCache.fullyLoaded) {
      const entries = await loadVectorCollection(rootDir, namespace, { generation });
      namespaceCache.entries = new Map(entries.map((entry) => [
        entry.id,
        { hash: entry.contentHash, vector: [...entry.vector] },
      ]));
      namespaceCache.fullyLoaded = true;
    }
    return new Map(Array.from(namespaceCache.entries.entries(), ([id, value]) => [id, cloneEmbeddingCacheValue(value)]));
  }

  const uniqueEntryIds = Array.from(new Set(entryIds));
  const missingIds = namespaceCache.fullyLoaded
    ? []
    : uniqueEntryIds.filter((entryId) => !namespaceCache.entries.has(entryId));
  if (missingIds.length > 0) {
    const fetchedEntries = await loadVectorEntriesById(rootDir, namespace, missingIds, { generation });
    for (const entry of fetchedEntries) {
      namespaceCache.entries.set(entry.id, {
        hash: entry.contentHash,
        vector: [...entry.vector],
      });
    }
  }

  const selectedEntries = new Map<string, EmbeddingCacheValue>();
  for (const entryId of uniqueEntryIds) {
    const value = namespaceCache.entries.get(entryId);
    if (value) selectedEntries.set(entryId, cloneEmbeddingCacheValue(value));
  }
  return selectedEntries;
}

function mergeEntriesIntoProcessCache(
  rootDir: string,
  generation: number,
  namespace: string,
  entries: VectorStoreEntry<null>[],
  mode: "replace" | "upsert",
): void {
  const cacheKey = buildProcessCacheKey(rootDir, generation, namespace);
  const current = embeddingProcessCache.get(cacheKey);
  const nextEntries = new Map(entries.map((entry) => [
    entry.id,
    { hash: entry.contentHash, vector: [...entry.vector] },
  ]));
  if (mode === "replace") {
    embeddingProcessCache.set(cacheKey, {
      entries: nextEntries,
      fullyLoaded: true,
    });
    return;
  }

  if (!current) {
    embeddingProcessCache.set(cacheKey, {
      entries: nextEntries,
      fullyLoaded: false,
    });
    return;
  }

  for (const [entryId, entry] of nextEntries) current.entries.set(entryId, entry);
}

export async function ensureEmbeddingCacheDir(rootDir: string): Promise<void> {
  await loadEmbeddingCache(rootDir, CACHE_FILE);
}

function resolveEmbeddingNamespaces(fileName: string): { primary: string; secondary?: string } {
  if (fileName === CACHE_FILE) return { primary: FILE_SEARCH_VECTOR_NAMESPACE };
  if (fileName === "identifier-embeddings-cache.json") {
    return {
      primary: IDENTIFIER_VECTOR_NAMESPACE,
      secondary: IDENTIFIER_CALLSITE_VECTOR_NAMESPACE,
    };
  }
  if (fileName === "chunk-embeddings-cache.json") return { primary: CHUNK_VECTOR_NAMESPACE };
  throw new Error(`Unsupported embedding cache namespace for "${fileName}".`);
}

export async function loadEmbeddingCache(rootDir: string, fileName: string): Promise<EmbeddingCache> {
  const namespaces = resolveEmbeddingNamespaces(fileName);
  const cache: EmbeddingCache = {};
  const primaryEntries = await loadEmbeddingNamespaceEntries(rootDir, namespaces.primary);
  for (const [entryId, entry] of primaryEntries) {
    cache[entryId] = entry;
  }
  if (namespaces.secondary) {
    const secondaryEntries = await loadEmbeddingNamespaceEntries(rootDir, namespaces.secondary);
    for (const [entryId, entry] of secondaryEntries) {
      cache[entryId] = entry;
    }
  }
  return cache;
}

export async function loadEmbeddingCacheEntries(
  rootDir: string,
  fileName: string,
  entryIds: string[],
): Promise<EmbeddingCache> {
  const namespaces = resolveEmbeddingNamespaces(fileName);
  const cache: EmbeddingCache = {};
  const primaryEntryIds = namespaces.secondary
    ? entryIds.filter((entryId) => !entryId.startsWith("callsite:"))
    : entryIds;
  const primaryEntries = await loadEmbeddingNamespaceEntries(rootDir, namespaces.primary, primaryEntryIds);
  for (const [entryId, entry] of primaryEntries) cache[entryId] = entry;

  if (namespaces.secondary) {
    const secondaryEntryIds = entryIds.filter((entryId) => entryId.startsWith("callsite:"));
    const secondaryEntries = await loadEmbeddingNamespaceEntries(rootDir, namespaces.secondary, secondaryEntryIds);
    for (const [entryId, entry] of secondaryEntries) cache[entryId] = entry;
  }

  return cache;
}

export async function upsertEmbeddingCacheEntries(rootDir: string, cache: EmbeddingCache, fileName: string): Promise<void> {
  const namespaces = resolveEmbeddingNamespaces(fileName);
  const generation = await resolveWriteGeneration(rootDir);
  const primaryEntries = Object.entries(cache)
    .filter(([key]) => !namespaces.secondary || !key.startsWith("callsite:"))
    .map(([key, value]) => ({
      id: key,
      contentHash: value.hash,
      searchText: key,
      vector: value.vector,
      metadata: null,
    }));
  if (primaryEntries.length > 0) {
    await upsertVectorEntries(rootDir, namespaces.primary, primaryEntries, { generation });
    mergeEntriesIntoProcessCache(rootDir, generation, namespaces.primary, primaryEntries, "upsert");
  }

  if (namespaces.secondary) {
    const secondaryEntries = Object.entries(cache)
      .filter(([key]) => key.startsWith("callsite:"))
      .map(([key, value]) => ({
        id: key,
        contentHash: value.hash,
        searchText: key,
        vector: value.vector,
        metadata: null,
      }));
    if (secondaryEntries.length > 0) {
      await upsertVectorEntries(rootDir, namespaces.secondary, secondaryEntries, { generation });
      mergeEntriesIntoProcessCache(rootDir, generation, namespaces.secondary, secondaryEntries, "upsert");
    }
  }
}

export async function saveEmbeddingCache(rootDir: string, cache: EmbeddingCache, fileName: string): Promise<void> {
  const namespaces = resolveEmbeddingNamespaces(fileName);
  const generation = await resolveWriteGeneration(rootDir);
  const primaryEntries = Object.entries(cache)
    .filter(([key]) => !namespaces.secondary || !key.startsWith("callsite:"))
    .map(([key, value]) => ({
      id: key,
      contentHash: value.hash,
      searchText: key,
      vector: value.vector,
      metadata: null,
    }));
  await saveEmbeddingNamespace(
    rootDir,
    namespaces.primary,
    primaryEntries,
    generation,
  );
  mergeEntriesIntoProcessCache(rootDir, generation, namespaces.primary, primaryEntries, "replace");

  if (namespaces.secondary) {
    const secondaryEntries = Object.entries(cache)
      .filter(([key]) => key.startsWith("callsite:"))
      .map(([key, value]) => ({
        id: key,
        contentHash: value.hash,
        searchText: key,
        vector: value.vector,
        metadata: null,
      }));
    await saveEmbeddingNamespace(
      rootDir,
      namespaces.secondary,
      secondaryEntries,
      generation,
    );
    mergeEntriesIntoProcessCache(rootDir, generation, namespaces.secondary, secondaryEntries, "replace");
  }
}

async function saveEmbeddingNamespace(
  rootDir: string,
  namespace: string,
  nextEntries: VectorStoreEntry<null>[],
  generation: number,
): Promise<void> {
  const currentEntries = await loadVectorCollectionMap<null>(rootDir, namespace, { generation });
  const nextEntryMap = new Map(nextEntries.map((entry) => [entry.id, entry]));
  const entriesToUpsert: VectorStoreEntry<null>[] = [];
  const entryIdsToDelete: string[] = [];

  for (const nextEntry of nextEntries) {
    const currentEntry = currentEntries.get(nextEntry.id);
    if (
      !currentEntry
      || currentEntry.contentHash !== nextEntry.contentHash
      || currentEntry.searchText !== nextEntry.searchText
      || !vectorsEqual(currentEntry.vector, nextEntry.vector)
    ) {
      entriesToUpsert.push(nextEntry);
    }
  }

  for (const currentEntryId of currentEntries.keys()) {
    if (!nextEntryMap.has(currentEntryId)) {
      entryIdsToDelete.push(currentEntryId);
    }
  }

  await upsertVectorEntries(rootDir, namespace, entriesToUpsert, { generation });
  await deleteVectorEntries(rootDir, namespace, entryIdsToDelete, { generation });
}

function vectorsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function materializeEmbeddingCache(rootDir: string, fileName: string): Promise<void> {
  const cache = await loadEmbeddingCache(rootDir, fileName);
  await saveEmbeddingCache(rootDir, cache, fileName);
}

export async function materializeFileSearchEmbeddingCache(rootDir: string): Promise<void> {
  await materializeEmbeddingCache(rootDir, CACHE_FILE);
}

function formatLineRange(line: number, endLine?: number): string {
  if (endLine && endLine > line) return `L${line}-L${endLine}`;
  return `L${line}`;
}

function getMatchedSymbolEntries(symbols: SymbolSearchEntry[], queryTerms: Set<string>): SymbolSearchEntry[] {
  if (queryTerms.size === 0) return [];
  return symbols.filter((symbol) => splitCamelCase(symbol.name).some((term) => queryTerms.has(term)));
}

export class SearchIndex {
  private documents: SearchDocument[] = [];
  private vectors: number[][] = [];
  async index(docs: SearchDocument[], rootDir: string): Promise<SearchIndexBuildStats> {
    this.documents = docs;
    const cache = await loadCache(rootDir);
    const uncached: { idx: number; text: string; hash: string }[] = [];
    let reusedDocuments = 0;

    this.vectors = new Array(docs.length);

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const rawText = `${doc.header} ${doc.symbols.join(" ")} ${doc.content}`;
      const hash = buildEmbeddingCacheHash(rawText);

      if (cache[doc.path]?.hash === hash) {
        this.vectors[i] = cache[doc.path].vector;
        reusedDocuments++;
      } else {
        uncached.push({ idx: i, text: rawText, hash });
      }
    }

    if (uncached.length > 0) {
      const batchSize = getEmbeddingBatchSize();
      for (let b = 0; b < uncached.length; b += batchSize) {
        const batch = uncached.slice(b, b + batchSize);
        try {
          const embeddings = await fetchEmbedding(batch.map((u) => u.text));
          for (let j = 0; j < batch.length; j++) {
            this.vectors[batch[j].idx] = embeddings[j];
            cache[docs[batch[j].idx].path] = { hash: batch[j].hash, vector: embeddings[j] };
          }
        } catch (error) {
          if (!isContextLengthError(error)) throw error;
          for (const item of batch) {
            try {
              const [vector] = await fetchEmbedding(item.text);
              this.vectors[item.idx] = vector;
              cache[docs[item.idx].path] = { hash: item.hash, vector };
            } catch (itemError) {
              if (!isContextLengthError(itemError)) throw itemError;
              delete cache[docs[item.idx].path];
            }
          }
        }
      }
    }

    if (uncached.length > 0 || shouldMaterializeCurrentGenerationWrite()) {
      await saveCache(rootDir, cache);
    }

    return {
      documents: docs.length,
      embeddedDocuments: uncached.length,
      reusedDocuments,
    };
  }

  async search(query: string, optionsOrTopK?: number | SearchQueryOptions): Promise<SearchResult[]> {
    const options = resolveSearchOptions(optionsOrTopK);
    const [queryVec] = await fetchEmbedding(query);
    const queryTerms = new Set(splitCamelCase(query));
    const scores: {
      idx: number;
      score: number;
      semanticScore: number;
      keywordScore: number;
      matchedSymbols: string[];
      matchedSymbolLocations: string[];
    }[] = [];

    for (let i = 0; i < this.vectors.length; i++) {
      if (!this.vectors[i]) continue;
      const doc = this.documents[i];
      const semanticScore = cosine(queryVec, this.vectors[i]);
      const matchedEntries = doc.symbolEntries ? getMatchedSymbolEntries(doc.symbolEntries, queryTerms) : [];
      const matchedSymbols = matchedEntries.length > 0
        ? matchedEntries.map((entry) => entry.name)
        : getMatchedSymbols(doc.symbols, queryTerms);
      const matchedSymbolLocations = matchedEntries.map((entry) => `${entry.name}@${formatLineRange(entry.line, entry.endLine)}`);
      const keywordScore = computeKeywordScore(query, queryTerms, doc, matchedSymbols);
      const score = computeCombinedScore(semanticScore, keywordScore, options);

      if (options.requireSemanticMatch && semanticScore <= 0) continue;
      if (options.requireKeywordMatch && keywordScore <= 0) continue;
      if (Math.max(semanticScore, 0) < options.minSemanticScore) continue;
      if (keywordScore < options.minKeywordScore) continue;
      if (score < options.minCombinedScore) continue;

      scores.push({ idx: i, score, semanticScore, keywordScore, matchedSymbols, matchedSymbolLocations });
    }

    return scores
      .sort((a, b) => b.score - a.score || b.keywordScore - a.keywordScore || b.semanticScore - a.semanticScore)
      .slice(0, options.topK)
      .map(({ idx, score, semanticScore, keywordScore, matchedSymbols, matchedSymbolLocations }) => {
        const doc = this.documents[idx];
        return {
          path: doc.path,
          score: Math.round(score * 1000) / 10,
          semanticScore: Math.round(Math.max(semanticScore, 0) * 1000) / 10,
          keywordScore: Math.round(keywordScore * 1000) / 10,
          header: doc.header,
          matchedSymbols,
          matchedSymbolLocations,
        };
      });
  }

  getDocumentCount(): number {
    return this.documents.length;
  }
}
