// Full-index artifact builder for chunk and structural repo intelligence
// FEATURE: Persisted full indexing mode state under .contextplus/derived

import { readFile, stat, writeFile } from "fs/promises";
import { extname, join, resolve } from "path";
import { flattenSymbols, type SymbolLocation, analyzeFile, isSupportedFile } from "../core/parser.js";
import { getEmbeddingBatchSize, fetchEmbedding, loadEmbeddingCache, saveEmbeddingCache } from "../core/embeddings.js";
import { CONTEXTPLUS_DERIVED_DIR, ensureContextplusLayout } from "../core/project-layout.js";
import { walkDirectory } from "../core/walker.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION, type FullArtifactManifest } from "./index-contract.js";

export interface FullIndexArtifactOptions {
  rootDir: string;
}

export interface FullIndexProgress {
  phase: "chunk-scan" | "chunk-embeddings" | "structure-scan";
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  indexedChunks: number;
  indexedStructures: number;
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
}

interface ChunkArtifact {
  id: string;
  path: string;
  header: string;
  symbolName?: string;
  symbolKind?: string;
  parentName?: string;
  signature?: string;
  line: number;
  endLine: number;
  content: string;
}

interface PersistedChunkFileEntry {
  fingerprint: string;
  chunks: ChunkArtifact[];
}

interface PersistedChunkIndexState {
  generatedAt: string;
  files: Record<string, PersistedChunkFileEntry>;
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
  language: string;
  lineCount: number;
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

interface PersistedStructureFileEntry {
  fingerprint: string;
  artifact: StructureArtifact;
}

interface PersistedStructureIndexState {
  generatedAt: string;
  files: Record<string, PersistedStructureFileEntry>;
}

export interface FullIndexArtifactResult {
  manifest: FullArtifactManifest;
  stats: FullIndexArtifactStats;
}

const CHUNK_INDEX_FILE = "chunk-search-index.json";
const STRUCTURE_INDEX_FILE = "code-structure-index.json";
const FULL_MANIFEST_FILE = "full-index-manifest.json";
const CHUNK_CACHE_FILE = "chunk-embeddings-cache.json";
const MAX_CHUNK_CHARS = 6000;
const MAX_FALLBACK_FILE_CHARS = 6000;

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function buildFingerprint(size: number, mtimeMs: number): string {
  return `${size}:${Math.floor(mtimeMs)}`;
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash);
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

function getChunkId(relativePath: string, symbol: Pick<ChunkArtifact, "line" | "endLine" | "symbolName" | "signature">): string {
  return `${relativePath}:${symbol.line}:${symbol.endLine}:${symbol.symbolName ?? "file"}:${symbol.signature ?? ""}`;
}

function sliceLines(lines: string[], line: number, endLine: number): string {
  const start = Math.max(0, line - 1);
  const end = Math.max(start + 1, endLine);
  return lines.slice(start, end).join("\n").slice(0, MAX_CHUNK_CHARS).trim();
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
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      parentName: symbol.parentName,
      signature: symbol.signature,
      line: symbol.line,
      endLine: symbol.endLine,
      content,
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
    symbolName: "file",
    symbolKind: "file",
    signature: header,
    line: 1,
    endLine: Math.max(1, lineCount),
    content: trimmed,
  }];
}

async function loadChunkIndexState(rootDir: string): Promise<PersistedChunkIndexState> {
  try {
    return JSON.parse(await readFile(join(rootDir, CONTEXTPLUS_DERIVED_DIR, CHUNK_INDEX_FILE), "utf8"));
  } catch {
    return { generatedAt: "", files: {} };
  }
}

async function saveChunkIndexState(rootDir: string, state: PersistedChunkIndexState): Promise<void> {
  await ensureContextplusLayout(rootDir);
  await writeFile(join(rootDir, CONTEXTPLUS_DERIVED_DIR, CHUNK_INDEX_FILE), JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function loadStructureIndexState(rootDir: string): Promise<PersistedStructureIndexState> {
  try {
    return JSON.parse(await readFile(join(rootDir, CONTEXTPLUS_DERIVED_DIR, STRUCTURE_INDEX_FILE), "utf8"));
  } catch {
    return { generatedAt: "", files: {} };
  }
}

async function saveStructureIndexState(rootDir: string, state: PersistedStructureIndexState): Promise<void> {
  await ensureContextplusLayout(rootDir);
  await writeFile(join(rootDir, CONTEXTPLUS_DERIVED_DIR, STRUCTURE_INDEX_FILE), JSON.stringify(state, null, 2) + "\n", "utf8");
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

async function buildChunkArtifactsForFile(rootDir: string, relativePath: string): Promise<ChunkArtifact[] | null> {
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

async function refreshChunkIndexState(
  rootDir: string,
  onProgress?: (progress: FullIndexProgress) => Promise<void> | void,
): Promise<{ state: PersistedChunkIndexState; stats: Omit<ChunkArtifactStats, "embeddedChunks" | "reusedChunks"> }> {
  const previous = await loadChunkIndexState(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory && isSupportedFile(entry.path));
  const nextFiles: Record<string, PersistedChunkFileEntry> = {};
  const seen = new Set<string>();
  let processedFiles = 0;
  let changedFiles = 0;

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    const fileStat = await stat(file.path);
    const fingerprint = buildFingerprint(fileStat.size, fileStat.mtimeMs);
    const previousEntry = previous.files[relativePath];

    if (previousEntry && previousEntry.fingerprint === fingerprint) {
      nextFiles[relativePath] = previousEntry;
    } else {
      const chunks = await buildChunkArtifactsForFile(rootDir, relativePath);
      changedFiles++;
      if (chunks && chunks.length > 0) nextFiles[relativePath] = { fingerprint, chunks };
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
        indexedStructures: 0,
      });
    }
  }

  const removedFiles = Object.keys(previous.files).filter((path) => !seen.has(path)).length;
  const state: PersistedChunkIndexState = {
    generatedAt: new Date().toISOString(),
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

async function warmChunkEmbeddings(
  rootDir: string,
  docs: ChunkArtifact[],
  onProgress?: (progress: FullIndexProgress) => Promise<void> | void,
): Promise<{ embeddedChunks: number; reusedChunks: number }> {
  const cache = await loadEmbeddingCache(rootDir, CHUNK_CACHE_FILE);
  const pending: { key: string; hash: string; text: string }[] = [];
  let reusedChunks = 0;

  for (const doc of docs) {
    const text = `${doc.header} ${doc.symbolName ?? ""} ${doc.signature ?? ""} ${doc.path} ${doc.content}`;
    const hash = `${text.length}:${hashText(text)}`;
    if (cache[doc.id]?.hash === hash) reusedChunks++;
    else pending.push({ key: doc.id, hash, text });
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
        indexedStructures: 0,
      });
    }
  }

  await saveEmbeddingCache(rootDir, cache, CHUNK_CACHE_FILE);
  return { embeddedChunks: pending.length, reusedChunks };
}

async function buildStructureArtifactForFile(rootDir: string, relativePath: string): Promise<StructureArtifact | null> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);
  if (!isSupportedFile(fullPath)) return null;

  try {
    const raw = await readFile(fullPath, "utf8");
    const lines = raw.split("\n");
    const analysis = await analyzeFile(fullPath);
    const language = detectLanguage(fullPath);
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
      language,
      lineCount: analysis.lineCount,
      imports: extractImports(lines, language),
      exports: extractExports(lines, language),
      calls: extractCalls(lines, language),
      symbols,
    };
  } catch {
    return null;
  }
}

async function refreshStructureIndexState(
  rootDir: string,
  onProgress?: (progress: FullIndexProgress) => Promise<void> | void,
): Promise<{ state: PersistedStructureIndexState; stats: StructureArtifactStats }> {
  const previous = await loadStructureIndexState(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory && isSupportedFile(entry.path));
  const nextFiles: Record<string, PersistedStructureFileEntry> = {};
  const seen = new Set<string>();
  let processedFiles = 0;
  let changedFiles = 0;

  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath);
    const fileStat = await stat(file.path);
    const fingerprint = buildFingerprint(fileStat.size, fileStat.mtimeMs);
    const previousEntry = previous.files[relativePath];

    if (previousEntry && previousEntry.fingerprint === fingerprint) {
      nextFiles[relativePath] = previousEntry;
    } else {
      const artifact = await buildStructureArtifactForFile(rootDir, relativePath);
      changedFiles++;
      if (artifact) nextFiles[relativePath] = { fingerprint, artifact };
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
      });
    }
  }

  const removedFiles = Object.keys(previous.files).filter((path) => !seen.has(path)).length;
  const state: PersistedStructureIndexState = {
    generatedAt: new Date().toISOString(),
    files: nextFiles,
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
  await ensureContextplusLayout(rootDir);

  const chunkResult = await refreshChunkIndexState(rootDir, onProgress);
  const allChunks = Object.values(chunkResult.state.files).flatMap((entry) => entry.chunks);
  const embeddingStats = await warmChunkEmbeddings(rootDir, allChunks, onProgress);
  const structureResult = await refreshStructureIndexState(rootDir, onProgress);

  const stats: FullIndexArtifactStats = {
    chunkIndex: {
      ...chunkResult.stats,
      ...embeddingStats,
    },
    structureIndex: structureResult.stats,
  };

  const manifest: FullArtifactManifest = {
    generatedAt: new Date().toISOString(),
    mode: "full",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    chunkIndexPath: join(CONTEXTPLUS_DERIVED_DIR, CHUNK_INDEX_FILE),
    structureIndexPath: join(CONTEXTPLUS_DERIVED_DIR, STRUCTURE_INDEX_FILE),
    chunkCount: stats.chunkIndex.indexedChunks,
    structureCount: stats.structureIndex.indexedStructures,
    contract: buildIndexContract(),
    stats,
  };

  await writeFile(
    join(rootDir, CONTEXTPLUS_DERIVED_DIR, FULL_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  return { manifest, stats };
}
