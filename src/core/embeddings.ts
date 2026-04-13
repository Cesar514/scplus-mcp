// summary: Runs provider-backed embedding generation and cosine retrieval over persisted vectors.
// FEATURE: Provider-backed embeddings with sqlite vector persistence for file, identifier, and chunk retrieval.
// inputs: Text documents, embedding provider settings, and sqlite vector storage state.
// outputs: Embedded vectors, similarity search results, and persisted vector namespace updates.
// Indexes file headers and symbols, persists vectors in sqlite collections

import {
  deleteVectorEntries,
  getIndexGenerationContext,
  loadIndexServingState,
  loadPresentVectorEntryIds,
  loadVectorCollection,
  loadVectorEntriesById,
  loadVectorCollectionMap,
  upsertVectorEntries,
  type VectorStoreEntry,
} from "./index-database.js";
import { resolve } from "node:path";
import {
  computeCombinedScore,
  computeKeywordScore,
  getMatchedSymbols,
  resolveSearchOptions,
  splitCamelCase,
  type ResolvedSearchQueryOptions,
} from "./embeddings-search-utils.js";

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
  queryVector?: number[];
}

export interface SearchIndexBuildStats {
  documents: number;
  embeddedDocuments: number;
  reusedDocuments: number;
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

export interface EmbeddingCacheCoverage {
  requestedEntryCount: number;
  availableEntryCount: number;
  missingEntryCount: number;
  coverageRatio: number;
  missingEntryIds: string[];
}

interface EmbeddingCacheValue {
  hash: string;
  vector: number[];
}

interface NamespaceProcessCacheEntry {
  entries: Map<string, EmbeddingCacheValue>;
  fullyLoaded: boolean;
}

export interface EmbeddingRuntimeStats {
  processNamespaceHits: number;
  processNamespaceMisses: number;
  processVectorHits: number;
  processVectorMisses: number;
  sqliteNamespaceLoads: number;
  sqliteEntryLoads: number;
  generationInvalidations: number;
}

const EMBED_PROVIDER = (process.env.SCPLUS_EMBED_PROVIDER ?? "ollama").toLowerCase();
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b-32k";
const OPENAI_EMBED_MODEL = process.env.SCPLUS_OPENAI_EMBED_MODEL ?? process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";
const OPENAI_API_KEY = process.env.SCPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE_URL = process.env.SCPLUS_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const ACTIVE_EMBED_MODEL = EMBED_PROVIDER === "openai" ? OPENAI_EMBED_MODEL : EMBED_MODEL;
const CACHE_FILE = `embeddings-cache-${EMBED_PROVIDER}-${ACTIVE_EMBED_MODEL.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
const MIN_EMBED_BATCH_SIZE = 5;
const MAX_EMBED_BATCH_SIZE = 10;
const DEFAULT_EMBED_BATCH_SIZE = 8;
const FALLBACK_EMBED_CONCURRENCY = 3;
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
let embeddingRuntimeStats: EmbeddingRuntimeStats = {
  processNamespaceHits: 0,
  processNamespaceMisses: 0,
  processVectorHits: 0,
  processVectorMisses: 0,
  sqliteNamespaceLoads: 0,
  sqliteEntryLoads: 0,
  generationInvalidations: 0,
};

type OllamaEmbedClient = { embed: (params: Record<string, unknown>) => Promise<{ embeddings: number[][] }> };
let ollamaClient: OllamaEmbedClient | null = null;

// Purpose: Lazily create and cache the Ollama embedding client.
// Inputs: No direct inputs beyond the configured Ollama host environment.
// Returns/Effects: Returns the cached Ollama embedding client instance.
async function getOllamaClient(): Promise<OllamaEmbedClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST }) as unknown as OllamaEmbedClient;
  }
  return ollamaClient;
}

// Purpose: Request embeddings from the Ollama provider for a batch of inputs.
// Inputs: The input texts to embed and the abort signal for the provider call.
// Returns/Effects: Returns the embedding vectors produced by Ollama.
async function callOllamaEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  const client = await getOllamaClient();
  const options = getEmbedRuntimeOptions();
  const request: Record<string, unknown> = { model: EMBED_MODEL, input, signal, keep_alive: "10s" };
  if (options) request.options = options;
  const response = await client.embed(request);
  return response.embeddings;
}

// Purpose: Request embeddings from the OpenAI embeddings endpoint for a batch of inputs.
// Inputs: The input texts to embed and the abort signal for the HTTP request.
// Returns/Effects: Returns the embedding vectors produced by the OpenAI provider.
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

// Purpose: Produce deterministic mock embeddings for tests and offline workflows.
// Inputs: The input texts to embed.
// Returns/Effects: Returns normalized mock embedding vectors for each input.
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

// Purpose: Dispatch one embedding batch to the configured provider implementation.
// Inputs: The input texts to embed and the abort signal for provider calls.
// Returns/Effects: Returns the embedding vectors produced by the selected provider.
async function callProviderEmbed(input: string[], signal: AbortSignal): Promise<number[][]> {
  if (EMBED_PROVIDER === "mock") {
    return callMockEmbed(input);
  }
  if (EMBED_PROVIDER === "openai") {
    return callOpenAIEmbed(input, signal);
  }
  return callOllamaEmbed(input, signal);
}

// Purpose: Parse an integer environment variable with a fallback value.
// Inputs: The raw environment value and the fallback integer to use when invalid.
// Returns/Effects: Returns the parsed integer or the fallback when parsing fails.
function toIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Purpose: Parse an optional integer environment variable.
// Inputs: The raw environment value to parse.
// Returns/Effects: Returns the parsed integer or undefined when absent or invalid.
function toOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Purpose: Parse an optional boolean environment variable.
// Inputs: The raw environment value to parse.
// Returns/Effects: Returns the parsed boolean or undefined when absent or invalid.
function toOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
}

// Purpose: Build provider runtime options from embedding-related environment variables.
// Inputs: No direct inputs beyond the current process environment.
// Returns/Effects: Returns the provider runtime options or undefined when none were set.
function getEmbedRuntimeOptions(): EmbedRuntimeOptions | undefined {
  if (EMBED_PROVIDER === "openai") return undefined;
  const options: EmbedRuntimeOptions = {
    num_gpu: toOptionalInteger(process.env.SCPLUS_EMBED_NUM_GPU),
    main_gpu: toOptionalInteger(process.env.SCPLUS_EMBED_MAIN_GPU),
    num_thread: toOptionalInteger(process.env.SCPLUS_EMBED_NUM_THREAD),
    num_batch: toOptionalInteger(process.env.SCPLUS_EMBED_NUM_BATCH),
    num_ctx: toOptionalInteger(process.env.SCPLUS_EMBED_NUM_CTX),
    low_vram: toOptionalBoolean(process.env.SCPLUS_EMBED_LOW_VRAM),
  };

  if (Object.values(options).every((value) => value === undefined)) return undefined;
  return options;
}

export function getEmbeddingBatchSize(): number {
  const requested = toIntegerOr(process.env.SCPLUS_EMBED_BATCH_SIZE, DEFAULT_EMBED_BATCH_SIZE);
  return Math.min(MAX_EMBED_BATCH_SIZE, Math.max(MIN_EMBED_BATCH_SIZE, requested));
}

export function getEmbedChunkChars(): number {
  const requested = toIntegerOr(process.env.SCPLUS_EMBED_CHUNK_CHARS, DEFAULT_EMBED_CHUNK_CHARS);
  return Math.min(MAX_EMBED_CHUNK_CHARS, Math.max(MIN_EMBED_CHUNK_CHARS, requested));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Purpose: Detect whether an embedding error indicates the input exceeded context length.
// Inputs: The unknown error value raised during embedding.
// Returns/Effects: Returns whether the error message matches context-length failures.
function isContextLengthError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("input length exceeds context length")
    || (message.includes("context") && message.includes("exceed"))
    || message.includes("maximum context length");
}

// Purpose: Fetch fallback embeddings one item at a time when batch embedding cannot continue.
// Inputs: The failed batch items plus an optional single-item embedding function.
// Returns/Effects: Returns the successfully embedded fallback vectors keyed by original batch index.
export async function fetchFallbackEmbeddings(
  batch: { idx: number; text: string; hash: string }[],
  fetchOne: (text: string) => Promise<number[]> = async (text) => {
    const [vector] = await fetchEmbedding(text);
    return vector;
  },
): Promise<Map<number, number[]>> {
  const fallbackVectors = new Map<number, number[]>();
  let nextIndex = 0;
  let hardFailure: unknown = null;

  const worker = async (): Promise<void> => {
    while (!hardFailure) {
      const itemIndex = nextIndex;
      nextIndex++;
      if (itemIndex >= batch.length) return;

      const item = batch[itemIndex];
      try {
        const vector = await fetchOne(item.text);
        fallbackVectors.set(item.idx, vector);
      } catch (itemError) {
        if (isContextLengthError(itemError)) continue;
        hardFailure = itemError;
        return;
      }
    }
  };

  const workerCount = Math.min(FALLBACK_EMBED_CONCURRENCY, batch.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (hardFailure) throw hardFailure;
  return fallbackVectors;
}

// Purpose: Shrink one embedding input after a context-length failure.
// Inputs: The oversized embedding input text.
// Returns/Effects: Returns the shortened input to retry with.
function shrinkEmbeddingInput(input: string): string {
  if (input.length <= MIN_EMBED_INPUT_CHARS) return input;
  const nextLength = Math.max(MIN_EMBED_INPUT_CHARS, Math.floor(input.length * SINGLE_INPUT_SHRINK_FACTOR));
  if (nextLength >= input.length) return input.slice(0, input.length - 1);
  return input.slice(0, nextLength);
}

// Purpose: Embed one input with retries that progressively shrink oversized content.
// Inputs: The raw input text to embed.
// Returns/Effects: Returns the embedding vector or throws if retries still fail.
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

// Purpose: Embed a batch of inputs and recursively split or retry on context-length failures.
// Inputs: The batch of input texts to embed.
// Returns/Effects: Returns embedding vectors for every input in the original order.
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

// Purpose: Split one embedding input into provider-sized text chunks.
// Inputs: The raw input text to chunk.
// Returns/Effects: Returns the ordered text chunks that should be embedded separately.
function splitEmbeddingInput(input: string): string[] {
  const chunkChars = getEmbedChunkChars();
  if (input.length <= chunkChars) return [input];
  const chunks: string[] = [];
  for (let start = 0; start < input.length; start += chunkChars) {
    chunks.push(input.slice(start, start + chunkChars));
  }
  return chunks;
}

// Purpose: Merge chunk-level embedding vectors back into one document embedding.
// Inputs: The chunk embedding vectors and their relative chunk weights.
// Returns/Effects: Returns the weighted merged embedding vector.
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

// Purpose: Fetch embeddings for one string or batch of strings using adaptive chunking.
// Inputs: One input string or an array of input strings.
// Returns/Effects: Returns embedding vectors aligned with the original input order.
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

// Purpose: Build a compact hash for one raw embedding input string.
// Inputs: The raw text to hash.
// Returns/Effects: Returns the deterministic hash string used in embedding caches.
function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

export function buildEmbeddingCacheHash(text: string): string {
  return hashContent(`${EMBED_PROVIDER}:${ACTIVE_EMBED_MODEL}:${text}`);
}

// Purpose: Compute cosine similarity between two embedding vectors.
// Inputs: The left and right numeric vectors to compare.
// Returns/Effects: Returns their cosine similarity score or zero when undefined.
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

async function loadCache(rootDir: string): Promise<EmbeddingCache> {
  return loadEmbeddingCache(rootDir, CACHE_FILE);
}

async function saveCache(rootDir: string, cache: EmbeddingCache): Promise<void> {
  await saveEmbeddingCache(rootDir, cache, CACHE_FILE);
}

// Purpose: Decide whether the current embedding write should force cache materialization.
// Inputs: No direct inputs beyond the active generation context.
// Returns/Effects: Returns whether writes target a non-serving generation that should be materialized.
function shouldMaterializeCurrentGenerationWrite(): boolean {
  const generationContext = getIndexGenerationContext();
  return generationContext?.writeGeneration !== undefined
    && generationContext.writeGeneration !== generationContext.readGeneration;
}

// Purpose: Clone one embedding cache value before exposing it to callers.
// Inputs: The cached embedding value to duplicate.
// Returns/Effects: Returns a defensive copy of the embedding cache value.
function cloneEmbeddingCacheValue(value: EmbeddingCacheValue): EmbeddingCacheValue {
  return {
    hash: value.hash,
    vector: [...value.vector],
  };
}

export function getEmbeddingRuntimeStats(): EmbeddingRuntimeStats {
  return { ...embeddingRuntimeStats };
}

// Purpose: Reset the in-memory embedding runtime counters back to an empty baseline.
// Inputs: No direct inputs beyond the mutable runtime stats container.
// Returns/Effects: Replaces the stored embedding runtime stats with a zeroed object.
export function resetEmbeddingRuntimeStats(): void {
  embeddingRuntimeStats = {
    processNamespaceHits: 0,
    processNamespaceMisses: 0,
    processVectorHits: 0,
    processVectorMisses: 0,
    sqliteNamespaceLoads: 0,
    sqliteEntryLoads: 0,
    generationInvalidations: 0,
  };
}

function buildProcessCacheKey(rootDir: string, generation: number, namespace: string): string {
  return `${resolve(rootDir)}::${generation}::${namespace}`;
}

// Purpose: Invalidate stale process-cache namespaces when the active generation changes.
// Inputs: The repository root and the latest active generation number.
// Returns/Effects: Drops process-cache entries for outdated generations and updates runtime stats.
function invalidateRootGenerationCache(rootDir: string, activeGeneration: number): void {
  const normalizedRootDir = resolve(rootDir);
  const previousGeneration = activeGenerationByRoot.get(normalizedRootDir);
  if (previousGeneration === activeGeneration) return;
  activeGenerationByRoot.set(normalizedRootDir, activeGeneration);
  if (previousGeneration !== undefined) embeddingRuntimeStats.generationInvalidations++;
  for (const cacheKey of embeddingProcessCache.keys()) {
    if (cacheKey.startsWith(`${normalizedRootDir}::`) && !cacheKey.startsWith(`${normalizedRootDir}::${activeGeneration}::`)) {
      embeddingProcessCache.delete(cacheKey);
    }
  }
}

// Purpose: Resolve the read generation that embedding cache loads should use.
// Inputs: The repository root whose serving generation should be consulted.
// Returns/Effects: Returns the generation number for read operations and refreshes cache invalidation state.
async function resolveReadGeneration(rootDir: string): Promise<number> {
  const generationContext = getIndexGenerationContext();
  if (generationContext?.readGeneration !== undefined) return generationContext.readGeneration;
  const serving = await loadIndexServingState(rootDir);
  invalidateRootGenerationCache(rootDir, serving.activeGeneration);
  return serving.activeGeneration;
}

// Purpose: Resolve the write generation that embedding cache writes should use.
// Inputs: The repository root whose serving generation should be consulted.
// Returns/Effects: Returns the generation number for write operations and refreshes cache invalidation state.
async function resolveWriteGeneration(rootDir: string): Promise<number> {
  const generationContext = getIndexGenerationContext();
  if (generationContext?.writeGeneration !== undefined) return generationContext.writeGeneration;
  const serving = await loadIndexServingState(rootDir);
  invalidateRootGenerationCache(rootDir, serving.activeGeneration);
  return serving.activeGeneration;
}

// Purpose: Load embedding cache entries for one namespace from process cache and sqlite.
// Inputs: The repository root, logical namespace, and optional entry ids to restrict the load.
// Returns/Effects: Returns the selected embedding cache entries as a defensive map copy.
async function loadEmbeddingNamespaceEntries(
  rootDir: string,
  namespace: string,
  entryIds?: string[],
): Promise<Map<string, EmbeddingCacheValue>> {
  const generation = await resolveReadGeneration(rootDir);
  const cacheKey = buildProcessCacheKey(rootDir, generation, namespace);
  let namespaceCache = embeddingProcessCache.get(cacheKey);
  if (!namespaceCache) {
    embeddingRuntimeStats.processNamespaceMisses++;
    namespaceCache = {
      entries: new Map<string, EmbeddingCacheValue>(),
      fullyLoaded: false,
    };
    embeddingProcessCache.set(cacheKey, namespaceCache);
  } else {
    embeddingRuntimeStats.processNamespaceHits++;
  }

  if (!entryIds) {
    if (!namespaceCache.fullyLoaded) {
      embeddingRuntimeStats.sqliteNamespaceLoads++;
      const entries = await loadVectorCollection(rootDir, namespace, { generation });
      namespaceCache.entries = new Map(entries.map((entry) => [
        entry.id,
        { hash: entry.contentHash, vector: [...entry.vector] },
      ]));
      namespaceCache.fullyLoaded = true;
    }
    embeddingRuntimeStats.processVectorHits += namespaceCache.entries.size;
    return new Map(Array.from(namespaceCache.entries.entries(), ([id, value]) => [id, cloneEmbeddingCacheValue(value)]));
  }

  const uniqueEntryIds = Array.from(new Set(entryIds));
  const missingIds = namespaceCache.fullyLoaded
    ? []
    : uniqueEntryIds.filter((entryId) => !namespaceCache.entries.has(entryId));
  embeddingRuntimeStats.processVectorHits += uniqueEntryIds.length - missingIds.length;
  embeddingRuntimeStats.processVectorMisses += missingIds.length;
  if (missingIds.length > 0) {
    embeddingRuntimeStats.sqliteEntryLoads += missingIds.length;
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

// Purpose: Merge freshly written vector entries into the in-memory embedding process cache.
// Inputs: The repository root, generation, namespace, written entries, and merge mode.
// Returns/Effects: Updates the process cache for the selected namespace in place.
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

// Purpose: Resolve the vector namespaces associated with one embedding cache file name.
// Inputs: The logical embedding cache file name.
// Returns/Effects: Returns the primary and optional secondary vector namespaces.
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

// Purpose: Load the full embedding cache represented by one logical cache file.
// Inputs: The repository root and logical embedding cache file name.
// Returns/Effects: Returns the merged embedding cache for the corresponding namespaces.
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

// Purpose: Load selected embedding cache entries represented by one logical cache file.
// Inputs: The repository root, logical cache file name, and requested entry ids.
// Returns/Effects: Returns the subset of embedding cache entries found for those ids.
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

// Purpose: Inspect vector coverage for selected embedding cache entry ids.
// Inputs: The repository root, logical cache file name, and requested entry ids.
// Returns/Effects: Returns the embedding cache coverage summary for those ids.
export async function inspectEmbeddingCacheCoverage(
  rootDir: string,
  fileName: string,
  entryIds: string[],
): Promise<EmbeddingCacheCoverage> {
  const namespaces = resolveEmbeddingNamespaces(fileName);
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) {
    return {
      requestedEntryCount: 0,
      availableEntryCount: 0,
      missingEntryCount: 0,
      coverageRatio: 1,
      missingEntryIds: [],
    };
  }

  const primaryEntryIds = namespaces.secondary
    ? uniqueEntryIds.filter((entryId) => !entryId.startsWith("callsite:"))
    : uniqueEntryIds;
  const secondaryEntryIds = namespaces.secondary
    ? uniqueEntryIds.filter((entryId) => entryId.startsWith("callsite:"))
    : [];
  const presentEntryIds = new Set<string>();
  const primaryPresent = await loadPresentVectorEntryIds(rootDir, namespaces.primary, primaryEntryIds);
  for (const entryId of primaryPresent) presentEntryIds.add(entryId);
  if (namespaces.secondary && secondaryEntryIds.length > 0) {
    const secondaryPresent = await loadPresentVectorEntryIds(rootDir, namespaces.secondary, secondaryEntryIds);
    for (const entryId of secondaryPresent) presentEntryIds.add(entryId);
  }
  const missingEntryIds = uniqueEntryIds.filter((entryId) => !presentEntryIds.has(entryId));
  return {
    requestedEntryCount: uniqueEntryIds.length,
    availableEntryCount: presentEntryIds.size,
    missingEntryCount: missingEntryIds.length,
    coverageRatio: uniqueEntryIds.length === 0 ? 1 : presentEntryIds.size / uniqueEntryIds.length,
    missingEntryIds,
  };
}

// Purpose: Upsert selected embedding cache entries into the backing vector namespaces.
// Inputs: The repository root, logical embedding cache object, and logical cache file name.
// Returns/Effects: Persists the supplied entries and updates the in-memory process cache.
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

// Purpose: Replace the persisted embedding cache contents for one logical cache file.
// Inputs: The repository root, logical embedding cache object, and logical cache file name.
// Returns/Effects: Persists the full cache and refreshes the in-memory process cache.
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

// Purpose: Persist one namespace worth of embedding vectors by diffing current and next entries.
// Inputs: The repository root, logical namespace, next entries, and target generation.
// Returns/Effects: Upserts changed vectors and deletes stale vectors for that namespace.
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

// Purpose: Compare two embedding vectors for exact element-wise equality.
// Inputs: The left and right vectors to compare.
// Returns/Effects: Returns whether the vectors have identical dimensions and values.
function vectorsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// Purpose: Materialize one logical embedding cache through its backing vector namespaces.
// Inputs: The repository root and logical cache file name to materialize.
// Returns/Effects: Reloads and fully rewrites the corresponding embedding cache.
export async function materializeEmbeddingCache(rootDir: string, fileName: string): Promise<void> {
  const cache = await loadEmbeddingCache(rootDir, fileName);
  await saveEmbeddingCache(rootDir, cache, fileName);
}

// Purpose: Materialize the default file-search embedding cache through sqlite vector storage.
// Inputs: The repository root whose file-search embedding cache should be materialized.
// Returns/Effects: Reloads and fully rewrites the default file-search embedding cache.
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

// Purpose: Build and persist the search-index vectors for a document set.
// Inputs: The search-index instance, source documents, and repository root for cache access.
// Returns/Effects: Updates the instance documents and vectors and returns build stats.
async function buildSearchIndexVectors(index: SearchIndex, docs: SearchDocument[], rootDir: string): Promise<SearchIndexBuildStats> {
  index.documents = docs;
  const cache = await loadCache(rootDir);
  const uncached: { idx: number; text: string; hash: string }[] = [];
  let reusedDocuments = 0;

  index.vectors = new Array(docs.length);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const rawText = `${doc.header} ${doc.symbols.join(" ")} ${doc.content}`;
    const hash = buildEmbeddingCacheHash(rawText);

    if (cache[doc.path]?.hash === hash) {
      index.vectors[i] = cache[doc.path].vector;
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
          index.vectors[batch[j].idx] = embeddings[j];
          cache[docs[batch[j].idx].path] = { hash: batch[j].hash, vector: embeddings[j] };
        }
      } catch (error) {
        if (!isContextLengthError(error)) throw error;
        const fallbackVectors = await fetchFallbackEmbeddings(batch);
        for (const item of batch) {
          const vector = fallbackVectors.get(item.idx);
          if (!vector) {
            delete cache[docs[item.idx].path];
            continue;
          }
          index.vectors[item.idx] = vector;
          cache[docs[item.idx].path] = { hash: item.hash, vector };
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

// Purpose: Search the indexed document vectors for the best matches to a query.
// Inputs: The search-index instance, query text, and optional search options.
// Returns/Effects: Returns the bounded ranked search results for the current index contents.
async function searchSearchIndex(index: SearchIndex, query: string, optionsOrTopK?: number | SearchQueryOptions): Promise<SearchResult[]> {
  const options = resolveSearchOptions(optionsOrTopK);
  const queryVec = options.queryVector ?? (await fetchEmbedding(query))[0];
  const queryTerms = new Set(splitCamelCase(query));
  const scores: {
    idx: number;
    score: number;
    semanticScore: number;
    keywordScore: number;
    matchedSymbols: string[];
    matchedSymbolLocations: string[];
  }[] = [];

  for (let i = 0; i < index.vectors.length; i++) {
    if (!index.vectors[i]) continue;
    const doc = index.documents[i];
    const semanticScore = cosine(queryVec, index.vectors[i]);
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
      const doc = index.documents[idx];
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

export class SearchIndex {
  documents: SearchDocument[] = [];
  vectors: number[][] = [];
  // Purpose: Build and persist the search-index vectors for a document set.
  // Inputs: The source documents to index and the repository root for cache access.
  // Returns/Effects: Updates the instance documents and vectors and returns build stats.
  async index(docs: SearchDocument[], rootDir: string): Promise<SearchIndexBuildStats> {
    return buildSearchIndexVectors(this, docs, rootDir);
  }

  // Purpose: Search the indexed document vectors for the best matches to a query.
  // Inputs: The query text and optional search options.
  // Returns/Effects: Returns the bounded ranked search results for the current index contents.
  async search(query: string, optionsOrTopK?: number | SearchQueryOptions): Promise<SearchResult[]> {
    return searchSearchIndex(this, query, optionsOrTopK);
  }

  getDocumentCount(): number {
    return this.documents.length;
  }
}
