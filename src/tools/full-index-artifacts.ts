// summary: Builds the full-index artifact layers for chunk and structural repository intelligence.
// FEATURE: Persisted full indexing mode state under .scplus/derived.
// inputs: Core index state, parsed repository data, and full-index stage dependencies.
// outputs: Persisted chunk, retrieval, structure, cluster, and hub-suggestion artifacts.

import { readFile } from "fs/promises";
import { dirname, extname, resolve } from "path";
import { flattenSymbols, analyzeFile, isSupportedFile } from "../core/parser.js";
import { ensureScplusLayout } from "../core/project-layout.js";
import { walkDirectory } from "../core/walker.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION, type FullArtifactManifest } from "./index-contract.js";
import { loadIndexArtifact, loadIndexServingState, saveIndexArtifact } from "../core/index-database.js";
import { refreshChunkIndexState, warmChunkEmbeddings, type ChunkArtifactStats, type ChunkIndexProgress } from "./chunk-index.js";
import { refreshHybridChunkIndex, refreshHybridIdentifierIndex, type HybridRetrievalStats } from "./hybrid-retrieval.js";
import { refreshSemanticClusterState, type SemanticClusterStats } from "./cluster-artifacts.js";
import { refreshHubSuggestionState, type HubSuggestionStats } from "./hub-suggestions.js";
import { refreshQueryExplanationState, type QueryExplanationStats } from "./query-engine.js";
import {
  buildDependencyHash,
  computeFileContentHash,
  normalizeRelativePath,
  resolveLocalDependencyPath,
} from "./invalidation.js";

export interface FullIndexArtifactOptions {
  rootDir: string;
}

export interface FullIndexProgress {
  phase: "chunk-scan" | "chunk-embeddings" | "hybrid-chunk-scan" | "hybrid-identifier-scan" | "structure-scan" | "cluster-scan" | "hub-scan" | "explanation-scan";
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedChunks: number;
  indexedStructures: number;
  indexedHybridChunks: number;
  indexedHybridIdentifiers: number;
  indexedClusters: number;
  indexedHubSuggestions: number;
  indexedQueryExplanations: number;
  currentFile?: string;
}

export interface StructureArtifactStats {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedStructures: number;
}

export interface FullIndexArtifactStats {
  chunkIndex: ChunkArtifactStats;
  structureIndex: StructureArtifactStats;
  hybridChunkIndex: HybridRetrievalStats;
  hybridIdentifierIndex: HybridRetrievalStats;
  semanticClusterIndex: SemanticClusterStats;
  hubSuggestionIndex: HubSuggestionStats;
  queryExplanationIndex: QueryExplanationStats;
}

interface ImportInfo {
  source: string;
  names: string[];
  line: number;
}

interface ExportInfo {
  name: string;
  kind: string;
  line: number;
}

interface CallInfo {
  caller: string;
  callee: string;
  line: number;
}

interface StructureArtifact {
  path: string;
  header: string;
  modulePath: string;
  language: string;
  lineCount: number;
  dependencyPaths: string[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  calls: CallInfo[];
  symbols: {
    name: string;
    kind: string;
    line: number;
    endLine: number;
    signature: string;
    parentName?: string;
  }[];
}

interface StructureSymbolRecord {
  id: string;
  filePath: string;
  modulePath: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
}

interface OwnershipEdge {
  sourceType: "file" | "module";
  sourcePath: string;
  targetType: "file" | "symbol";
  targetId: string;
  relation: "owns";
}

interface ModuleImportEdge {
  fromModule: string;
  toModule: string;
  filePath: string;
  dependencyPath: string;
}

interface ModuleStructureArtifact {
  modulePath: string;
  filePaths: string[];
  symbolIds: string[];
  exportedSymbolIds: string[];
  localDependencyPaths: string[];
  externalDependencySources: string[];
  ownedFilePaths: string[];
}

interface PersistedStructureFileEntry {
  contentHash: string;
  dependencyHash: string;
  artifact: StructureArtifact;
}

interface PersistedStructureIndexState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  files: Record<string, PersistedStructureFileEntry>;
  symbols: Record<string, StructureSymbolRecord>;
  fileToSymbolIds: Record<string, string[]>;
  ownershipEdges: OwnershipEdge[];
  moduleSummaries: Record<string, ModuleStructureArtifact>;
  moduleImportEdges: ModuleImportEdge[];
}

export interface FullIndexArtifactResult {
  manifest: FullArtifactManifest;
  stats: FullIndexArtifactStats;
}

function shouldReportProgress(processedFiles: number, totalFiles: number): boolean {
  return processedFiles === 1 || processedFiles === totalFiles || processedFiles % 25 === 0;
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs") return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".java") return "java";
  if (ext === ".cs") return "csharp";
  return ext.replace(/^\./, "") || "unknown";
}

function getModulePath(filePath: string): string {
  const normalized = normalizeRelativePath(dirname(filePath));
  return normalized === "." ? "." : normalized;
}

function getStructureSymbolId(filePath: string, symbol: { name: string; line: number; parentName?: string }): string {
  return `${filePath}:${symbol.parentName ?? "root"}:${symbol.name}:${symbol.line}`;
}

function canReuseStructureEntry(entry: PersistedStructureFileEntry | undefined): boolean {
  if (!entry) return false;
  return typeof entry.contentHash === "string"
    && typeof entry.dependencyHash === "string"
    && typeof entry.artifact?.modulePath === "string"
    && Array.isArray(entry.artifact?.dependencyPaths);
}

async function loadStructureIndexState(rootDir: string): Promise<PersistedStructureIndexState> {
  return loadIndexArtifact(rootDir, "code-structure-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    files: {},
    symbols: {},
    fileToSymbolIds: {},
    ownershipEdges: [],
    moduleSummaries: {},
    moduleImportEdges: [],
  }));
}

async function saveStructureIndexState(rootDir: string, state: PersistedStructureIndexState): Promise<void> {
  await saveIndexArtifact(rootDir, "code-structure-index", state);
}

function extractImports(lines: string[], language: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  if (language === "typescript" || language === "javascript") {
    const importRe = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
    const requireRe = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;
    for (let i = 0; i < lines.length; i++) {
      for (const re of [importRe, requireRe]) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(lines[i])) !== null) {
          const names = (match[1] ?? match[2] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
          imports.push({ source: match[3], names, line: i + 1 });
        }
      }
      if (lines[i].startsWith("import ")) {
        const bare = lines[i].match(/import\s+['"]([^'"]+)['"]/);
        if (bare?.[1]) imports.push({ source: bare[1], names: [], line: i + 1 });
      }
    }
  } else if (language === "python") {
    for (let i = 0; i < lines.length; i++) {
      const fromMatch = lines[i].match(/from\s+([\w.]+)\s+import\s+(.+)/);
      if (fromMatch) {
        imports.push({
          source: fromMatch[1],
          names: fromMatch[2].split(",").map((value) => value.trim().split(/\s+as\s+/)[0]).filter(Boolean),
          line: i + 1,
        });
        continue;
      }
      const importMatch = lines[i].match(/^import\s+([\w.,\s]+)/);
      if (importMatch) {
        const names = importMatch[1].split(",").map((value) => value.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        imports.push({ source: names.join(", "), names, line: i + 1 });
      }
    }
  } else if (language === "go") {
    let inMultiImport = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^import\s*\(/.test(lines[i].trim())) {
        inMultiImport = true;
        continue;
      }
      if (inMultiImport) {
        if (lines[i].includes(")")) {
          inMultiImport = false;
          continue;
        }
        const match = lines[i].match(/"([^"]+)"/);
        if (match?.[1]) imports.push({ source: match[1], names: [match[1].split("/").pop() ?? match[1]], line: i + 1 });
        continue;
      }
      const match = lines[i].match(/^import\s+"([^"]+)"/);
      if (match?.[1]) imports.push({ source: match[1], names: [match[1].split("/").pop() ?? match[1]], line: i + 1 });
    }
  } else if (language === "rust") {
    const useRe = /use\s+([\w:]+)(?:::\{([^}]+)\})?;/g;
    for (let i = 0; i < lines.length; i++) {
      useRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = useRe.exec(lines[i])) !== null) {
        const names = match[2]
          ? match[2].split(",").map((value) => value.trim()).filter(Boolean)
          : [match[1].split("::").pop() ?? match[1]];
        imports.push({ source: match[1], names, line: i + 1 });
      }
    }
  }
  return imports;
}

function extractExports(lines: string[], language: string): ExportInfo[] {
  const exports: ExportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (language === "typescript" || language === "javascript") {
      const match = lines[i].match(/export\s+(?:(default)\s+)?(?:(function|class|const|let|var|interface|type|enum)\s+)?(\w+)?/);
      if (match) exports.push({ name: match[3] ?? (match[1] ? "default" : "unknown"), kind: match[2] ?? "default", line: i + 1 });
      continue;
    }
    if (language === "python") {
      const allMatch = lines[i].match(/__all__\s*=\s*\[([^\]]+)\]/);
      if (allMatch) {
        for (const name of allMatch[1].split(",").map((value) => value.trim().replace(/['"]/g, "")).filter(Boolean)) {
          exports.push({ name, kind: "export", line: i + 1 });
        }
      }
      continue;
    }
    if (language === "go") {
      const match = lines[i].match(/^(?:func|type|var|const)\s+([A-Z]\w*)/);
      if (match?.[1]) exports.push({ name: match[1], kind: lines[i].trimStart().startsWith("func") ? "function" : "type", line: i + 1 });
      continue;
    }
    if (language === "rust") {
      const match = lines[i].match(/pub(?:\s*\([^)]*\))?\s+(fn|struct|enum|trait|type|mod|const)\s+(\w+)/);
      if (match?.[2]) exports.push({ name: match[2], kind: match[1], line: i + 1 });
    }
  }
  return exports;
}

function extractCalls(lines: string[], language: string): CallInfo[] {
  const calls: CallInfo[] = [];
  let current = "module";
  const functionStart = language === "python"
    ? /^(?:def|async\s+def)\s+(\w+)/
    : language === "go"
      ? /^func\s+(?:\([^)]+\)\s+)?(\w+)/
      : language === "rust"
        ? /fn\s+(\w+)/
        : /(?:function|async\s+function)\s+(\w+)|(\w+)\s*[:=]\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/;
  const callRe = /(\w+)\s*\(/g;

  for (let i = 0; i < lines.length; i++) {
    const fnMatch = lines[i].trimStart().match(functionStart);
    if (fnMatch) current = fnMatch[1] ?? fnMatch[2] ?? current;
    callRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(lines[i])) !== null) {
      const callee = match[1];
      if (callee && !["if", "for", "while", "switch", "catch", "function", "return", "new"].includes(callee)) {
        calls.push({ caller: current, callee, line: i + 1 });
      }
    }
  }
  return calls.slice(0, 100);
}

async function buildStructureArtifactForFile(
  rootDir: string,
  relativePath: string,
  availablePaths: Set<string>,
): Promise<StructureArtifact | null> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);
  if (!isSupportedFile(fullPath)) return null;

  try {
    const raw = await readFile(fullPath, "utf8");
    const lines = raw.split("\n");
    const analysis = await analyzeFile(fullPath);
    const language = detectLanguage(fullPath);
    const imports = extractImports(lines, language);
    const dependencyPaths = imports
      .map((entry) => resolveLocalDependencyPath(normalized, entry.source, availablePaths))
      .filter((entry): entry is string => Boolean(entry));
    const symbols = flattenSymbols(analysis.symbols).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      endLine: symbol.endLine,
      signature: symbol.signature,
      parentName: symbol.parentName,
    }));
    return {
      path: normalized,
      header: analysis.header,
      modulePath: getModulePath(normalized),
      language,
      lineCount: analysis.lineCount,
      dependencyPaths: Array.from(new Set(dependencyPaths)).sort(),
      imports,
      exports: extractExports(lines, language),
      calls: extractCalls(lines, language),
      symbols,
    };
  } catch {
    return null;
  }
}

export async function refreshStructureIndexState(
  rootDir: string,
  onProgress?: (progress: FullIndexProgress) => Promise<void> | void,
): Promise<{ state: PersistedStructureIndexState; stats: StructureArtifactStats }> {
  const previous = await loadStructureIndexState(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory && isSupportedFile(entry.path));
  const availablePaths = new Set(files.map((entry) => normalizeRelativePath(entry.relativePath)));
  const contentHashes: Record<string, string> = {};
  const nextFiles: Record<string, PersistedStructureFileEntry> = {};
  const symbols: Record<string, StructureSymbolRecord> = {};
  const fileToSymbolIds: Record<string, string[]> = {};
  const ownershipEdges: OwnershipEdge[] = [];
  const moduleSummaries: Record<string, ModuleStructureArtifact> = {};
  const moduleImportEdges: ModuleImportEdge[] = [];
  const seen = new Set<string>();
  let processedFiles = 0;
  let changedFiles = 0;

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    contentHashes[relativePath] = await computeFileContentHash(file.path);
  }

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    const contentHash = contentHashes[relativePath];
    const previousEntry = previous.files[relativePath];
    const dependencyHash = previousEntry
      ? buildDependencyHash(previousEntry.artifact.dependencyPaths ?? [], contentHashes)
      : "";

    if (
      canReuseStructureEntry(previousEntry)
      && previousEntry.contentHash === contentHash
      && previousEntry.dependencyHash === dependencyHash
    ) {
      nextFiles[relativePath] = previousEntry;
    } else {
      const artifact = await buildStructureArtifactForFile(rootDir, relativePath, availablePaths);
      changedFiles++;
      if (artifact) {
        nextFiles[relativePath] = {
          contentHash,
          dependencyHash: buildDependencyHash(artifact.dependencyPaths, contentHashes),
          artifact,
        };
      }
    }

    const fileEntry = nextFiles[relativePath];
    if (fileEntry) {
      const modulePath = fileEntry.artifact.modulePath;
      const symbolIds: string[] = [];

      for (const symbol of fileEntry.artifact.symbols) {
        const symbolId = getStructureSymbolId(relativePath, symbol);
        symbols[symbolId] = {
          id: symbolId,
          filePath: relativePath,
          modulePath,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          endLine: symbol.endLine,
          signature: symbol.signature,
          parentName: symbol.parentName,
        };
        symbolIds.push(symbolId);
        ownershipEdges.push({
          sourceType: "file",
          sourcePath: relativePath,
          targetType: "symbol",
          targetId: symbolId,
          relation: "owns",
        });
      }

      fileToSymbolIds[relativePath] = symbolIds;
      const moduleSummary = moduleSummaries[modulePath] ?? {
        modulePath,
        filePaths: [],
        symbolIds: [],
        exportedSymbolIds: [],
        localDependencyPaths: [],
        externalDependencySources: [],
        ownedFilePaths: [],
      };
      moduleSummary.filePaths.push(relativePath);
      moduleSummary.ownedFilePaths.push(relativePath);
      moduleSummary.symbolIds.push(...symbolIds);
      moduleSummary.localDependencyPaths.push(...fileEntry.artifact.dependencyPaths);
      moduleSummary.externalDependencySources.push(
        ...fileEntry.artifact.imports
          .map((entry) => entry.source)
          .filter((source) => !source.startsWith(".")),
      );
      moduleSummary.exportedSymbolIds.push(
        ...symbolIds.filter((symbolId) => {
          const symbol = symbols[symbolId];
          return fileEntry.artifact.exports.some((entry) => entry.name === symbol.name);
        }),
      );
      moduleSummaries[modulePath] = moduleSummary;
    }

    seen.add(relativePath);
    processedFiles++;
    if (onProgress && shouldReportProgress(processedFiles, files.length)) {
      await onProgress({
        phase: "structure-scan",
        totalFiles: files.length,
        processedFiles,
        changedFiles,
        removedFiles: 0,
        indexedChunks: 0,
        indexedStructures: Object.keys(nextFiles).length,
        indexedHybridChunks: 0,
        indexedHybridIdentifiers: 0,
        indexedClusters: 0,
        indexedHubSuggestions: 0,
        indexedQueryExplanations: 0,
        currentFile: relativePath,
      });
  }
  }

  const removedFiles = Object.keys(previous.files).filter((path) => !seen.has(path)).length;
  for (const [modulePath, moduleSummary] of Object.entries(moduleSummaries)) {
    moduleSummary.filePaths = Array.from(new Set(moduleSummary.filePaths)).sort();
    moduleSummary.ownedFilePaths = Array.from(new Set(moduleSummary.ownedFilePaths)).sort();
    moduleSummary.symbolIds = Array.from(new Set(moduleSummary.symbolIds)).sort();
    moduleSummary.exportedSymbolIds = Array.from(new Set(moduleSummary.exportedSymbolIds)).sort();
    moduleSummary.localDependencyPaths = Array.from(new Set(moduleSummary.localDependencyPaths)).sort();
    moduleSummary.externalDependencySources = Array.from(new Set(moduleSummary.externalDependencySources)).sort();
    for (const dependencyPath of moduleSummary.localDependencyPaths) {
      const dependencyModulePath = getModulePath(dependencyPath);
      if (dependencyModulePath !== modulePath) {
        moduleImportEdges.push({
          fromModule: modulePath,
          toModule: dependencyModulePath,
          filePath: moduleSummary.filePaths[0],
          dependencyPath,
        });
      }
    }
    for (const filePath of moduleSummary.filePaths) {
      ownershipEdges.push({
        sourceType: "module",
        sourcePath: modulePath,
        targetType: "file",
        targetId: filePath,
        relation: "owns",
      });
    }
  }
  const state: PersistedStructureIndexState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    files: nextFiles,
    symbols,
    fileToSymbolIds,
    ownershipEdges,
    moduleSummaries,
    moduleImportEdges: moduleImportEdges
      .sort((a, b) => `${a.fromModule}:${a.toModule}:${a.filePath}`.localeCompare(`${b.fromModule}:${b.toModule}:${b.filePath}`)),
  };
  await saveStructureIndexState(rootDir, state);
  return {
    state,
    stats: {
      totalFiles: files.length,
      processedFiles,
      changedFiles,
      removedFiles,
      indexedStructures: Object.keys(nextFiles).length,
    },
  };
}

export async function ensureFullIndexArtifacts(
  options: FullIndexArtifactOptions,
  onProgress?: (progress: FullIndexProgress) => Promise<void> | void,
): Promise<FullIndexArtifactResult> {
  const rootDir = resolve(options.rootDir);
  const servingState = await loadIndexServingState(rootDir);
  await ensureScplusLayout(rootDir);

  const chunkResult = await refreshChunkIndexState(rootDir, async (progress: ChunkIndexProgress) => {
    await onProgress?.({
      ...progress,
      indexedStructures: 0,
      indexedHybridChunks: 0,
      indexedHybridIdentifiers: 0,
      indexedClusters: 0,
      indexedHubSuggestions: 0,
      indexedQueryExplanations: 0,
    });
  });
  const allChunks = Object.values(chunkResult.state.files).flatMap((entry) => entry.chunks);
  const embeddingStats = await warmChunkEmbeddings(rootDir, allChunks, async (progress: ChunkIndexProgress) => {
    await onProgress?.({
      ...progress,
      indexedStructures: 0,
      indexedHybridChunks: 0,
      indexedHybridIdentifiers: 0,
      indexedClusters: 0,
      indexedHubSuggestions: 0,
      indexedQueryExplanations: 0,
    });
  });
  const hybridChunkResult = await refreshHybridChunkIndex(rootDir, chunkResult.state);
  await onProgress?.({
    phase: "hybrid-chunk-scan",
    totalFiles: hybridChunkResult.stats.indexedDocuments,
    processedFiles: hybridChunkResult.stats.indexedDocuments,
    changedFiles: hybridChunkResult.stats.changedDocuments,
    removedFiles: 0,
    indexedChunks: chunkResult.stats.indexedChunks,
    indexedStructures: 0,
    indexedHybridChunks: hybridChunkResult.stats.indexedDocuments,
    indexedHybridIdentifiers: 0,
    indexedClusters: 0,
    indexedHubSuggestions: 0,
    indexedQueryExplanations: 0,
  });
  const hybridIdentifierResult = await refreshHybridIdentifierIndex(rootDir);
  await onProgress?.({
    phase: "hybrid-identifier-scan",
    totalFiles: hybridIdentifierResult.stats.indexedDocuments,
    processedFiles: hybridIdentifierResult.stats.indexedDocuments,
    changedFiles: hybridIdentifierResult.stats.changedDocuments,
    removedFiles: 0,
    indexedChunks: chunkResult.stats.indexedChunks,
    indexedStructures: 0,
    indexedHybridChunks: hybridChunkResult.stats.indexedDocuments,
    indexedHybridIdentifiers: hybridIdentifierResult.stats.indexedDocuments,
    indexedClusters: 0,
    indexedHubSuggestions: 0,
    indexedQueryExplanations: 0,
  });
  const structureResult = await refreshStructureIndexState(rootDir, onProgress);
  const semanticClusterResult = await refreshSemanticClusterState(rootDir);
  await onProgress?.({
    phase: "cluster-scan",
    totalFiles: semanticClusterResult.stats.indexedFiles,
    processedFiles: semanticClusterResult.stats.indexedFiles,
    changedFiles: semanticClusterResult.stats.clusterCount,
    removedFiles: 0,
    indexedChunks: chunkResult.stats.indexedChunks,
    indexedStructures: structureResult.stats.indexedStructures,
    indexedHybridChunks: hybridChunkResult.stats.indexedDocuments,
    indexedHybridIdentifiers: hybridIdentifierResult.stats.indexedDocuments,
    indexedClusters: semanticClusterResult.stats.clusterCount,
    indexedHubSuggestions: 0,
    indexedQueryExplanations: 0,
  });

  const hubSuggestionResult = await refreshHubSuggestionState(rootDir);
  await onProgress?.({
    phase: "hub-scan",
    totalFiles: hubSuggestionResult.stats.suggestionCount,
    processedFiles: hubSuggestionResult.stats.suggestionCount,
    changedFiles: hubSuggestionResult.stats.suggestionCount,
    removedFiles: 0,
    indexedChunks: chunkResult.stats.indexedChunks,
    indexedStructures: structureResult.stats.indexedStructures,
    indexedHybridChunks: hybridChunkResult.stats.indexedDocuments,
    indexedHybridIdentifiers: hybridIdentifierResult.stats.indexedDocuments,
    indexedClusters: semanticClusterResult.stats.clusterCount,
    indexedHubSuggestions: hubSuggestionResult.stats.suggestionCount,
    indexedQueryExplanations: 0,
  });
  const queryExplanationResult = await refreshQueryExplanationState(rootDir);
  await onProgress?.({
    phase: "explanation-scan",
    totalFiles: queryExplanationResult.stats.fileCardCount,
    processedFiles: queryExplanationResult.stats.fileCardCount,
    changedFiles: queryExplanationResult.stats.fileCardCount,
    removedFiles: 0,
    indexedChunks: chunkResult.stats.indexedChunks,
    indexedStructures: structureResult.stats.indexedStructures,
    indexedHybridChunks: hybridChunkResult.stats.indexedDocuments,
    indexedHybridIdentifiers: hybridIdentifierResult.stats.indexedDocuments,
    indexedClusters: semanticClusterResult.stats.clusterCount,
    indexedHubSuggestions: hubSuggestionResult.stats.suggestionCount,
    indexedQueryExplanations: queryExplanationResult.stats.fileCardCount,
  });

  const stats: FullIndexArtifactStats = {
    chunkIndex: {
      ...chunkResult.stats,
      ...embeddingStats,
    },
    structureIndex: structureResult.stats,
    hybridChunkIndex: hybridChunkResult.stats,
    hybridIdentifierIndex: hybridIdentifierResult.stats,
    semanticClusterIndex: semanticClusterResult.stats,
    hubSuggestionIndex: hubSuggestionResult.stats,
    queryExplanationIndex: queryExplanationResult.stats,
  };

  const manifest: FullArtifactManifest = {
    generatedAt: new Date().toISOString(),
    generation: servingState.pendingGeneration ?? servingState.activeGeneration,
    mode: "full",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    chunkIndexPath: "sqlite:index_artifacts/chunk-search-index",
    hybridChunkIndexPath: "sqlite:index_artifacts/hybrid-chunk-index",
    hybridIdentifierIndexPath: "sqlite:index_artifacts/hybrid-identifier-index",
    structureIndexPath: "sqlite:index_artifacts/code-structure-index",
    semanticClusterIndexPath: "sqlite:index_artifacts/semantic-cluster-index",
    hubSuggestionIndexPath: "sqlite:index_artifacts/hub-suggestion-index",
    queryExplanationIndexPath: "sqlite:index_artifacts/query-explanation-index",
    chunkCount: stats.chunkIndex.indexedChunks,
    hybridChunkCount: stats.hybridChunkIndex.indexedDocuments,
    hybridIdentifierCount: stats.hybridIdentifierIndex.indexedDocuments,
    structureCount: stats.structureIndex.indexedStructures,
    semanticClusterCount: stats.semanticClusterIndex.clusterCount,
    hubSuggestionCount: stats.hubSuggestionIndex.suggestionCount,
    queryExplanationCount: stats.queryExplanationIndex.fileCardCount,
    featureGroupCount: stats.hubSuggestionIndex.featureGroupCount,
    contract: buildIndexContract(),
    stats,
  };

  await saveIndexArtifact(rootDir, "full-index-manifest", manifest);

  return { manifest, stats };
}
