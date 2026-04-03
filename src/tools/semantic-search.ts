// Persisted file-level semantic search with eager indexing and refresh support
// FEATURE: File-level semantic retrieval over persisted prepared-index artifacts

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
  currentFile?: string;
}

export interface FileSearchIndexStats {
  totalFiles: number;
  processedFiles: number;
  indexedDocuments: number;
  changedFiles: number;
  removedFiles: number;
  hashedFiles: number;
  embeddedDocuments: number;
  reusedDocuments: number;
}

export interface FileSearchRefreshFailure {
  path: string;
  reason: string;
  previousEntryExisted: boolean;
}

export interface FileSearchRuntimeStats {
  refreshFailures: number;
  refreshFailedFiles: number;
  lastRefreshFailure?: {
    rootDir: string;
    fileCount: number;
    paths: string[];
    at: string;
  };
}

interface PersistedFileSearchEntry {
  contentHash: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  doc: SearchDocument;
}

interface PersistedFileSearchState {
  generatedAt: string;
  files: Record<string, PersistedFileSearchEntry>;
}

type SearchDocumentBuildResult =
  | { kind: "indexed"; doc: SearchDocument }
  | { kind: "ignored"; reason: string }
  | { kind: "failed"; reason: string };

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
let fileSearchRuntimeStats: FileSearchRuntimeStats = {
  refreshFailures: 0,
  refreshFailedFiles: 0,
};

export class FileSearchRefreshError extends Error {
  readonly rootDir: string;
  readonly failures: FileSearchRefreshFailure[];

  constructor(rootDir: string, failures: FileSearchRefreshFailure[]) {
    const detail = failures.map((failure) => `${failure.path}: ${failure.reason}`).join("; ");
    super(`File search refresh blocked for ${rootDir}: ${detail}`);
    this.name = "FileSearchRefreshError";
    this.rootDir = rootDir;
    this.failures = failures;
  }
}

export function getFileSearchRuntimeStats(): FileSearchRuntimeStats {
  return {
    refreshFailures: fileSearchRuntimeStats.refreshFailures,
    refreshFailedFiles: fileSearchRuntimeStats.refreshFailedFiles,
    lastRefreshFailure: fileSearchRuntimeStats.lastRefreshFailure
      ? {
        ...fileSearchRuntimeStats.lastRefreshFailure,
        paths: [...fileSearchRuntimeStats.lastRefreshFailure.paths],
      }
      : undefined,
  };
}

export function resetFileSearchRuntimeStats(): void {
  fileSearchRuntimeStats = {
    refreshFailures: 0,
    refreshFailedFiles: 0,
  };
}

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

function normalizeMtimeMs(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Expected finite mtimeMs, received ${String(value)}.`);
  return Math.trunc(value);
}

function normalizeCtimeMs(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Expected finite ctimeMs, received ${String(value)}.`);
  return Math.trunc(value);
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildSearchDocumentForFile(rootDir: string, relativePath: string): Promise<SearchDocumentBuildResult> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);

  if (isTextIndexCandidate(fullPath)) {
    try {
      const fileSize = (await stat(fullPath)).size;
      const maxEmbedFileSize = getMaxEmbedFileSize();
      if (fileSize > maxEmbedFileSize) {
        return {
          kind: "ignored",
          reason: `text index candidate exceeds max embed file size (${fileSize} > ${maxEmbedFileSize})`,
        };
      }
      const raw = await readFile(fullPath, "utf-8");
      const content = raw.slice(0, MAX_TEXT_DOC_CHARS);
      return {
        kind: "indexed",
        doc: {
          path: normalized,
          header: extractPlainTextHeader(content),
          symbols: [],
          content,
        },
      };
    } catch (error) {
      return {
        kind: "failed",
        reason: `failed to build text search document: ${toErrorMessage(error)}`,
      };
    }
  }

  if (!isSupportedFile(fullPath)) {
    return {
      kind: "ignored",
      reason: `unsupported file extension for file search: ${extname(fullPath).toLowerCase() || "<none>"}`,
    };
  }

  try {
    const analysis = await analyzeFile(fullPath);
    const flatSymbols = flattenSymbols(analysis.symbols);
    return {
      kind: "indexed",
      doc: {
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
      },
    };
  } catch (error) {
    return {
      kind: "failed",
      reason: `failed to analyze supported source file: ${toErrorMessage(error)}`,
    };
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
  const failures: FileSearchRefreshFailure[] = [];
  const seen = new Set<string>();
  let processedFiles = 0;
  let changedFiles = 0;
  let hashedFiles = 0;

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    const fullPath = resolve(rootDir, relativePath);
    const fileStats = await stat(fullPath);
    const mtimeMs = normalizeMtimeMs(fileStats.mtimeMs);
    const ctimeMs = normalizeCtimeMs(fileStats.ctimeMs);
    const size = fileStats.size;
    const previousEntry = previous.files[relativePath];

    if (
      previousEntry
      && previousEntry.mtimeMs === mtimeMs
      && previousEntry.ctimeMs === ctimeMs
      && previousEntry.size === size
    ) {
      nextFiles[relativePath] = previousEntry;
    } else {
      const contentHash = await computeFileContentHash(fullPath);
      hashedFiles++;
      if (previousEntry && previousEntry.contentHash === contentHash) {
        nextFiles[relativePath] = {
          ...previousEntry,
          mtimeMs,
          ctimeMs,
          size,
        };
      } else {
        const buildResult = await buildSearchDocumentForFile(rootDir, relativePath);
        changedFiles++;
        if (buildResult.kind === "indexed") {
          nextFiles[relativePath] = {
            contentHash,
            mtimeMs,
            ctimeMs,
            size,
            doc: buildResult.doc,
          };
        } else if (buildResult.kind === "ignored") {
          if (previousEntry) {
            failures.push({
              path: relativePath,
              reason: `refresh would remove an indexed file without replacement: ${buildResult.reason}`,
              previousEntryExisted: true,
            });
          }
        } else {
          failures.push({
            path: relativePath,
            reason: buildResult.reason,
            previousEntryExisted: Boolean(previousEntry),
          });
        }
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
        currentFile: relativePath,
      });
    }
  }

  if (failures.length > 0) {
    fileSearchRuntimeStats.refreshFailures++;
    fileSearchRuntimeStats.refreshFailedFiles += failures.length;
    fileSearchRuntimeStats.lastRefreshFailure = {
      rootDir,
      fileCount: failures.length,
      paths: failures.map((failure) => failure.path),
      at: new Date().toISOString(),
    };
    throw new FileSearchRefreshError(rootDir, failures);
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
      hashedFiles,
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
        currentFile: docs.length > 0 ? docs[docs.length - 1]?.path : undefined,
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
      currentFile: docs.length > 0 ? docs[docs.length - 1]?.path : undefined,
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
  const failures: FileSearchRefreshFailure[] = [];
  for (let i = 0; i < uniquePaths.length; i += getEmbeddingBatchSize()) {
    const batch = uniquePaths.slice(i, i + getEmbeddingBatchSize());
    const docs = await Promise.all(batch.map((relativePath) => buildSearchDocumentForFile(options.rootDir, relativePath)));
    const validDocs: SearchDocument[] = [];
    for (let index = 0; index < docs.length; index++) {
      const result = docs[index];
      if (result.kind === "indexed") {
        validDocs.push(result.doc);
      } else if (result.kind === "failed") {
        failures.push({
          path: batch[index],
          reason: result.reason,
          previousEntryExisted: false,
        });
      }
    }
    if (validDocs.length > 0) {
      const index = new SearchIndex();
      const stats = await index.index(validDocs, options.rootDir);
      embeddedDocuments += stats.embeddedDocuments;
    }
  }

  if (failures.length > 0) {
    fileSearchRuntimeStats.refreshFailures++;
    fileSearchRuntimeStats.refreshFailedFiles += failures.length;
    fileSearchRuntimeStats.lastRefreshFailure = {
      rootDir: options.rootDir,
      fileCount: failures.length,
      paths: failures.map((failure) => failure.path),
      at: new Date().toISOString(),
    };
    throw new FileSearchRefreshError(options.rootDir, failures);
  }

  invalidateSearchCache();
  return embeddedDocuments;
}
