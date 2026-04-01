// Persisted file-level semantic search with eager indexing and refresh support
// Builds reusable file search state under .contextplus for fast queries

import { readFile, stat } from "fs/promises";
import { extname, resolve } from "path";
import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import {
  getEmbeddingBatchSize,
  materializeFileSearchEmbeddingCache,
  SearchIndex,
  type SearchDocument,
  type SearchIndexBuildStats,
  type SearchQueryOptions,
} from "../core/embeddings.js";
import { getIndexGenerationContext, loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import { computeFileContentHash, normalizeRelativePath } from "./invalidation.js";

export interface SemanticSearchOptions {
  rootDir: string;
  query: string;
  topK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
}

export interface FileSearchIndexProgress {
  phase: "file-scan" | "file-embeddings";
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedDocuments: number;
}

export interface FileSearchIndexStats {
  totalFiles: number;
  processedFiles: number;
  indexedDocuments: number;
  changedFiles: number;
  removedFiles: number;
  embeddedDocuments: number;
  reusedDocuments: number;
}

interface PersistedFileSearchEntry {
  contentHash: string;
  doc: SearchDocument;
}

interface PersistedFileSearchState {
  generatedAt: string;
  files: Record<string, PersistedFileSearchEntry>;
}

const SEARCH_INDEX_STATE_FILE = "file-search-index.json";
const TEXT_INDEX_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".geojson",
  ".csv",
  ".tsv",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".lock",
  ".env",
]);
const MAX_TEXT_DOC_CHARS = 4000;
const DEFAULT_MAX_EMBED_FILE_SIZE = 50 * 1024;

let cachedIndex: SearchIndex | null = null;
let cachedRootDir: string | null = null;

function isTextIndexCandidate(filePath: string): boolean {
  return TEXT_INDEX_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function toIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxEmbedFileSize(): number {
  return Math.max(1024, toIntegerOr(process.env.CONTEXTPLUS_MAX_EMBED_FILE_SIZE, DEFAULT_MAX_EMBED_FILE_SIZE));
}

function extractPlainTextHeader(content: string): string {
  const lines = content.split("\n");
  const headerLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    headerLines.push(trimmed.slice(0, 120));
    if (headerLines.length >= 2) break;
  }
  return headerLines.join(" | ");
}

function shouldReportProgress(processedFiles: number, totalFiles: number): boolean {
  return processedFiles === 1 || processedFiles === totalFiles || processedFiles % 25 === 0;
}

async function loadPersistedFileSearchState(rootDir: string): Promise<PersistedFileSearchState> {
  return loadIndexArtifact(rootDir, "file-search-index", () => ({ generatedAt: "", files: {} }));
}

async function savePersistedFileSearchState(rootDir: string, state: PersistedFileSearchState): Promise<void> {
  await saveIndexArtifact(rootDir, "file-search-index", state);
}

async function buildSearchDocumentForFile(rootDir: string, relativePath: string): Promise<SearchDocument | null> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);

  if (isTextIndexCandidate(fullPath)) {
    try {
      if ((await stat(fullPath)).size > getMaxEmbedFileSize()) return null;
      const raw = await readFile(fullPath, "utf-8");
      const content = raw.slice(0, MAX_TEXT_DOC_CHARS);
      return {
        path: normalized,
        header: extractPlainTextHeader(content),
        symbols: [],
        content,
      };
    } catch {
      return null;
    }
  }

  if (!isSupportedFile(fullPath)) return null;

  try {
    const analysis = await analyzeFile(fullPath);
    const flatSymbols = flattenSymbols(analysis.symbols);
    return {
      path: normalized,
      header: analysis.header,
      symbols: flatSymbols.map((symbol) => symbol.name),
      symbolEntries: flatSymbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        endLine: symbol.endLine,
        signature: symbol.signature,
      })),
      content: flatSymbols.map((symbol) => symbol.signature).join(" "),
    };
  } catch {
    return null;
  }
}

async function refreshPersistedFileSearchState(
  rootDir: string,
  onProgress?: (progress: FileSearchIndexProgress) => Promise<void> | void,
): Promise<{ state: PersistedFileSearchState; stats: Omit<FileSearchIndexStats, "embeddedDocuments" | "reusedDocuments"> }> {
  const previous = await loadPersistedFileSearchState(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory);
  const nextFiles: Record<string, PersistedFileSearchEntry> = {};
  const seen = new Set<string>();
  let processedFiles = 0;
  let changedFiles = 0;

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    const fullPath = resolve(rootDir, relativePath);
    const contentHash = await computeFileContentHash(fullPath);
    const previousEntry = previous.files[relativePath];

    if (previousEntry && previousEntry.contentHash === contentHash) {
      nextFiles[relativePath] = previousEntry;
    } else {
      const doc = await buildSearchDocumentForFile(rootDir, relativePath);
      changedFiles++;
      if (doc) {
        nextFiles[relativePath] = { contentHash, doc };
      }
    }

    seen.add(relativePath);
    processedFiles++;
    if (onProgress && shouldReportProgress(processedFiles, files.length)) {
      await onProgress({
        phase: "file-scan",
        totalFiles: files.length,
        processedFiles,
        changedFiles,
        removedFiles: 0,
        indexedDocuments: Object.keys(nextFiles).length,
      });
    }
  }

  const removedFiles = Object.keys(previous.files).filter((path) => !seen.has(path)).length;
  const state: PersistedFileSearchState = {
    generatedAt: new Date().toISOString(),
    files: nextFiles,
  };
  await savePersistedFileSearchState(rootDir, state);

  return {
    state,
    stats: {
      totalFiles: files.length,
      processedFiles,
      indexedDocuments: Object.keys(nextFiles).length,
      changedFiles,
      removedFiles,
    },
  };
}

export async function ensureFileSearchIndex(
  rootDir: string,
  onProgress?: (progress: FileSearchIndexProgress) => Promise<void> | void,
): Promise<{ index: SearchIndex; stats: FileSearchIndexStats }> {
  const normalizedRootDir = resolve(rootDir);
  const { state, stats: refreshStats } = await refreshPersistedFileSearchState(normalizedRootDir, onProgress);
  const docs = Object.values(state.files).map((entry) => entry.doc);
  const canReuseCachedIndex = cachedIndex
    && cachedRootDir === normalizedRootDir
    && refreshStats.changedFiles === 0
    && refreshStats.removedFiles === 0
    && docs.length > 0;

  if (canReuseCachedIndex) {
    const reusableIndex = cachedIndex;
    if (!reusableIndex) throw new Error("File search cache was expected but missing.");
    const generationContext = getIndexGenerationContext();
    if (generationContext?.writeGeneration !== undefined && generationContext.writeGeneration !== generationContext.readGeneration) {
      await materializeFileSearchEmbeddingCache(normalizedRootDir);
    }
    if (onProgress) {
      await onProgress({
        phase: "file-embeddings",
        totalFiles: refreshStats.totalFiles,
        processedFiles: refreshStats.processedFiles,
        changedFiles: refreshStats.changedFiles,
        removedFiles: refreshStats.removedFiles,
        indexedDocuments: docs.length,
      });
    }
    return {
      index: reusableIndex,
      stats: {
        ...refreshStats,
        embeddedDocuments: 0,
        reusedDocuments: docs.length,
      },
    };
  }

  const index = new SearchIndex();
  const embeddingStats: SearchIndexBuildStats = await index.index(docs, normalizedRootDir);

  if (onProgress) {
    await onProgress({
      phase: "file-embeddings",
      totalFiles: refreshStats.totalFiles,
      processedFiles: refreshStats.processedFiles,
      changedFiles: refreshStats.changedFiles,
      removedFiles: refreshStats.removedFiles,
      indexedDocuments: docs.length,
    });
  }

  cachedIndex = index;
  cachedRootDir = normalizedRootDir;

  return {
    index,
    stats: {
      ...refreshStats,
      embeddedDocuments: embeddingStats.embeddedDocuments,
      reusedDocuments: embeddingStats.reusedDocuments,
    },
  };
}

export async function semanticCodeSearch(options: SemanticSearchOptions): Promise<string> {
  const { index, stats } = await ensureFileSearchIndex(options.rootDir);
  const searchOptions: SearchQueryOptions = {
    topK: options.topK,
    semanticWeight: options.semanticWeight,
    keywordWeight: options.keywordWeight,
    minSemanticScore: options.minSemanticScore,
    minKeywordScore: options.minKeywordScore,
    minCombinedScore: options.minCombinedScore,
    requireKeywordMatch: options.requireKeywordMatch,
    requireSemanticMatch: options.requireSemanticMatch,
  };
  const results = await index.search(options.query, searchOptions);

  if (results.length === 0) return "No matching files found for the given query.";

  const lines: string[] = [`Top ${results.length} hybrid matches for: "${options.query}"\n`];
  if (stats.changedFiles > 0 || stats.removedFiles > 0) {
    lines.push(`Index refresh: ${stats.changedFiles} changed, ${stats.removedFiles} removed, ${stats.indexedDocuments} indexed documents.\n`);
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    lines.push(`${i + 1}. ${result.path} (${result.score}% total)`);
    lines.push(`   Semantic: ${result.semanticScore}% | Keyword: ${result.keywordScore}%`);
    if (result.header) lines.push(`   Header: ${result.header}`);
    if (result.matchedSymbols.length > 0) lines.push(`   Matched symbols: ${result.matchedSymbols.join(", ")}`);
    if (result.matchedSymbolLocations.length > 0) lines.push(`   Definition lines: ${result.matchedSymbolLocations.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function invalidateSearchCache(): void {
  cachedIndex = null;
  cachedRootDir = null;
}

export async function refreshFileSearchEmbeddings(options: { rootDir: string; relativePaths: string[] }): Promise<number> {
  const uniquePaths = Array.from(new Set(options.relativePaths.map(normalizeRelativePath).filter(Boolean)));
  if (uniquePaths.length === 0) return 0;

  let embeddedDocuments = 0;
  for (let i = 0; i < uniquePaths.length; i += getEmbeddingBatchSize()) {
    const batch = uniquePaths.slice(i, i + getEmbeddingBatchSize());
    const docs = await Promise.all(batch.map((relativePath) => buildSearchDocumentForFile(options.rootDir, relativePath)));
    const validDocs = docs.filter((doc): doc is SearchDocument => doc !== null);
    if (validDocs.length > 0) {
      const index = new SearchIndex();
      const stats = await index.index(validDocs, options.rootDir);
      embeddedDocuments += stats.embeddedDocuments;
    }
  }

  invalidateSearchCache();
  return embeddedDocuments;
}
