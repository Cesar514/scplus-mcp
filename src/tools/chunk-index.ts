// summary: Builds chunk-level indexing artifacts for durable sqlite-backed retrieval.
// FEATURE: First-class chunk index contract for full-engine code retrieval.
// inputs: Parsed files, symbol ranges, and full-index artifact write requests.
// outputs: Chunk records, chunk embeddings metadata, and retrieval-ready chunk artifacts.

import { readFile } from "fs/promises";
import { resolve } from "path";
import { buildEmbeddingCacheHash, fetchEmbedding, getEmbeddingBatchSize, loadEmbeddingCache, saveEmbeddingCache } from "../core/embeddings.js";
import { analyzeFile, flattenSymbols, isSupportedFile, type SymbolKind, type SymbolLocation } from "../core/parser.js";
import { loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import { walkDirectory } from "../core/walker.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION } from "./index-contract.js";
import { computeFileContentHash, hashTextContent, normalizeRelativePath } from "./invalidation.js";

export interface ChunkArtifact {
  id: string;
  path: string;
  header: string;
  chunkType: "symbol" | "file-fallback";
  symbolName?: string;
  symbolKind: SymbolKind | "file";
  symbolPath: string[];
  signature?: string;
  line: number;
  endLine: number;
  lineCount: number;
  content: string;
  contentHash: string;
}

export interface PersistedChunkFileEntry {
  contentHash: string;
  chunks: ChunkArtifact[];
}

export interface PersistedChunkIndexState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  files: Record<string, PersistedChunkFileEntry>;
}

export interface ChunkIndexProgress {
  phase: "chunk-scan" | "chunk-embeddings";
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedChunks: number;
  currentFile?: string;
}

export interface ChunkArtifactStats {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
}

export interface ChunkIndexRefreshResult {
  state: PersistedChunkIndexState;
  stats: Omit<ChunkArtifactStats, "embeddedChunks" | "reusedChunks">;
}

const CHUNK_CACHE_FILE = "chunk-embeddings-cache.json";
const MAX_CHUNK_CHARS = 6000;
const MAX_FALLBACK_FILE_CHARS = 6000;

function shouldReportProgress(processedFiles: number, totalFiles: number): boolean {
  return processedFiles === 1 || processedFiles === totalFiles || processedFiles % 25 === 0;
}

function isCurrentChunkArtifact(chunk: Partial<ChunkArtifact> | undefined): boolean {
  if (!chunk) return false;
  return typeof chunk.chunkType === "string"
    && Array.isArray(chunk.symbolPath)
    && typeof chunk.lineCount === "number"
    && typeof chunk.contentHash === "string";
}

function canReuseChunkEntry(entry: PersistedChunkFileEntry | undefined): boolean {
  if (!entry) return false;
  return typeof entry.contentHash === "string" && entry.chunks.every((chunk) => isCurrentChunkArtifact(chunk));
}

function getChunkId(relativePath: string, symbol: Pick<ChunkArtifact, "line" | "endLine" | "symbolName" | "signature">): string {
  return `${relativePath}:${symbol.line}:${symbol.endLine}:${symbol.symbolName ?? "file"}:${symbol.signature ?? ""}`;
}

function sliceLines(lines: string[], line: number, endLine: number): string {
  const start = Math.max(0, line - 1);
  const end = Math.max(start + 1, endLine);
  return lines.slice(start, end).join("\n").slice(0, MAX_CHUNK_CHARS).trim();
}

function buildSymbolPath(symbol: SymbolLocation): string[] {
  return symbol.parentName ? [symbol.parentName, symbol.name] : [symbol.name];
}

function buildSymbolChunks(relativePath: string, header: string, symbols: SymbolLocation[], lines: string[]): ChunkArtifact[] {
  const chunks: ChunkArtifact[] = [];
  for (const symbol of symbols) {
    const content = sliceLines(lines, symbol.line, symbol.endLine);
    if (!content) continue;
    chunks.push({
      id: getChunkId(relativePath, {
        line: symbol.line,
        endLine: symbol.endLine,
        symbolName: symbol.name,
        signature: symbol.signature,
      }),
      path: relativePath,
      header,
      chunkType: "symbol",
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      symbolPath: buildSymbolPath(symbol),
      signature: symbol.signature,
      line: symbol.line,
      endLine: symbol.endLine,
      lineCount: Math.max(1, symbol.endLine - symbol.line + 1),
      content,
      contentHash: hashTextContent(content),
    });
  }
  return chunks;
}

function buildFallbackChunk(relativePath: string, header: string, content: string, lineCount: number): ChunkArtifact[] {
  const trimmed = content.slice(0, MAX_FALLBACK_FILE_CHARS).trim();
  if (!trimmed) return [];
  return [{
    id: getChunkId(relativePath, { line: 1, endLine: Math.max(1, lineCount), symbolName: "file", signature: header }),
    path: relativePath,
    header,
    chunkType: "file-fallback",
    symbolName: "file",
    symbolKind: "file",
    symbolPath: [],
    signature: header,
    line: 1,
    endLine: Math.max(1, lineCount),
    lineCount: Math.max(1, lineCount),
    content: trimmed,
    contentHash: hashTextContent(trimmed),
  }];
}

export async function loadChunkIndexState(rootDir: string): Promise<PersistedChunkIndexState> {
  return loadIndexArtifact(rootDir, "chunk-search-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    files: {},
  }));
}

export async function saveChunkIndexState(rootDir: string, state: PersistedChunkIndexState): Promise<void> {
  await saveIndexArtifact(rootDir, "chunk-search-index", state);
}

export async function buildChunkArtifactsForFile(rootDir: string, relativePath: string): Promise<ChunkArtifact[] | null> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);
  if (!isSupportedFile(fullPath)) return null;

  try {
    const raw = await readFile(fullPath, "utf8");
    const lines = raw.split("\n");
    const analysis = await analyzeFile(fullPath);
    const flatSymbols = flattenSymbols(analysis.symbols);
    const chunks = buildSymbolChunks(normalized, analysis.header, flatSymbols, lines);
    if (chunks.length > 0) return chunks;
    return buildFallbackChunk(normalized, analysis.header, raw, analysis.lineCount);
  } catch {
    return null;
  }
}

export async function refreshChunkIndexState(
  rootDir: string,
  onProgress?: (progress: ChunkIndexProgress) => Promise<void> | void,
): Promise<ChunkIndexRefreshResult> {
  const previous = await loadChunkIndexState(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory && isSupportedFile(entry.path));
  const nextFiles: Record<string, PersistedChunkFileEntry> = {};
  const seen = new Set<string>();
  let processedFiles = 0;
  let changedFiles = 0;

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    const contentHash = await computeFileContentHash(file.path);
    const previousEntry = previous.files[relativePath];

    if (previousEntry && previousEntry.contentHash === contentHash && canReuseChunkEntry(previousEntry)) {
      nextFiles[relativePath] = previousEntry;
    } else {
      const chunks = await buildChunkArtifactsForFile(rootDir, relativePath);
      changedFiles++;
      if (chunks && chunks.length > 0) nextFiles[relativePath] = { contentHash, chunks };
    }

    seen.add(relativePath);
    processedFiles++;
    if (onProgress && shouldReportProgress(processedFiles, files.length)) {
      await onProgress({
        phase: "chunk-scan",
        totalFiles: files.length,
        processedFiles,
        changedFiles,
        removedFiles: 0,
        indexedChunks: Object.values(nextFiles).reduce((sum, entry) => sum + entry.chunks.length, 0),
        currentFile: relativePath,
      });
    }
  }

  const removedFiles = Object.keys(previous.files).filter((path) => !seen.has(path)).length;
  const state: PersistedChunkIndexState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    files: nextFiles,
  };
  await saveChunkIndexState(rootDir, state);
  return {
    state,
    stats: {
      totalFiles: files.length,
      processedFiles,
      changedFiles,
      removedFiles,
      indexedChunks: Object.values(nextFiles).reduce((sum, entry) => sum + entry.chunks.length, 0),
    },
  };
}

export async function warmChunkEmbeddings(
  rootDir: string,
  docs: ChunkArtifact[],
  onProgress?: (progress: ChunkIndexProgress) => Promise<void> | void,
): Promise<{ embeddedChunks: number; reusedChunks: number }> {
  const cache = await loadEmbeddingCache(rootDir, CHUNK_CACHE_FILE);
  const pending: { key: string; hash: string; text: string; path: string }[] = [];
  let reusedChunks = 0;

  for (const doc of docs) {
    const text = `${doc.header} ${doc.symbolName ?? ""} ${doc.signature ?? ""} ${doc.path} ${doc.content}`;
    const hash = buildEmbeddingCacheHash(text);
    if (cache[doc.id]?.hash === hash) reusedChunks++;
    else pending.push({ key: doc.id, hash, text, path: doc.path });
  }

  const batchSize = getEmbeddingBatchSize();
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await fetchEmbedding(batch.map((entry) => entry.text));
    for (let j = 0; j < batch.length; j++) {
      cache[batch[j].key] = { hash: batch[j].hash, vector: vectors[j] };
    }
    if (onProgress) {
      await onProgress({
        phase: "chunk-embeddings",
        totalFiles: docs.length,
        processedFiles: Math.min(i + batch.length, docs.length),
        changedFiles: pending.length,
        removedFiles: 0,
        indexedChunks: docs.length,
        currentFile: batch.length > 0 ? batch[batch.length - 1]?.path : undefined,
      });
    }
  }

  await saveEmbeddingCache(rootDir, cache, CHUNK_CACHE_FILE);
  return { embeddedChunks: pending.length, reusedChunks };
}
