// Fast exact-query substrate over prepared index artifacts and git state
// FEATURE: Hot in-memory caches for exact symbol, word, outline, dependency, and change/status queries

import { simpleGit } from "simple-git";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { loadIndexArtifact } from "../core/index-database.js";
import { assertValidPreparedIndex } from "./index-reliability.js";

interface SearchDocument {
  path: string;
  header: string;
  symbols: string[];
  symbolEntries?: {
    name: string;
    kind?: string;
    line: number;
    endLine?: number;
    signature?: string;
  }[];
  content: string;
}

interface PersistedFileSearchState {
  generatedAt: string;
  files: Record<string, {
    contentHash: string;
    doc: SearchDocument;
  }>;
}

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

interface PersistedIdentifierIndexState {
  generatedAt: string;
  files: Record<string, {
    contentHash: string;
    docs: PersistedIdentifierDoc[];
    lines: string[];
  }>;
}

interface StructureArtifact {
  path: string;
  header: string;
  modulePath: string;
  language: string;
  lineCount: number;
  dependencyPaths: string[];
  imports: {
    source: string;
    names: string[];
    line: number;
  }[];
  exports: {
    name: string;
    kind: string;
    line: number;
  }[];
  calls: {
    caller: string;
    callee: string;
    line: number;
  }[];
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

interface PersistedStructureIndexState {
  generatedAt: string;
  files: Record<string, {
    contentHash: string;
    dependencyHash: string;
    artifact: StructureArtifact;
  }>;
  symbols: Record<string, StructureSymbolRecord>;
  fileToSymbolIds: Record<string, string[]>;
  moduleSummaries: Record<string, {
    modulePath: string;
    filePaths: string[];
    symbolIds: string[];
    exportedSymbolIds: string[];
    localDependencyPaths: string[];
    externalDependencySources: string[];
    ownedFilePaths: string[];
  }>;
}

export interface ExactSymbolHit {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
  header: string;
  modulePath: string;
}

export interface WordMatchHit {
  kind: "symbol" | "path" | "header" | "content";
  token: string;
  path: string;
  line?: number;
  title: string;
  snippet: string;
  score: number;
}

export interface FileOutlineSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
}

export interface FileOutline {
  path: string;
  header: string;
  language: string;
  modulePath: string;
  lineCount: number;
  imports: {
    source: string;
    names: string[];
    line: number;
  }[];
  exports: {
    name: string;
    kind: string;
    line: number;
  }[];
  symbols: FileOutlineSymbol[];
}

export interface DependencyInfo {
  targetPath: string;
  modulePath: string;
  directDependencies: string[];
  reverseDependencies: string[];
  exportedSymbolNames: string[];
  importedSources: string[];
}

export interface RepoStatusFile {
  path: string;
  staged: string;
  unstaged: string;
  index: string;
  workingTree: string;
}

export interface RepoStatusSummary {
  branch: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  modifiedCount: number;
  createdCount: number;
  deletedCount: number;
  renamedCount: number;
  files: RepoStatusFile[];
}

export interface ChangeRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangeEntry {
  path: string;
  staged: string;
  unstaged: string;
  additions: number;
  deletions: number;
  ranges?: ChangeRange[];
}

export interface RepoChangesSummary {
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  files: ChangeEntry[];
}

interface FastQueryState {
  cacheKey: string;
  symbolLookup: Map<string, ExactSymbolHit[]>;
  pathLookup: Map<string, string[]>;
  wordLookup: Map<string, WordMatchHit[]>;
  outlines: Map<string, FileOutline>;
  dependencies: Map<string, DependencyInfo>;
}

interface CachedRepoState {
  repoKey: string;
  updatedAtMs: number;
  status: RepoStatusSummary;
  changes: RepoChangesSummary;
  fileRanges: Map<string, ChangeRange[]>;
}

const FAST_QUERY_TTL_MS = 750;
const stateCache = new Map<string, FastQueryState>();
const repoCache = new Map<string, CachedRepoState>();

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

function normalizeExactKey(value: string): string {
  return value.trim().toLowerCase();
}

function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token.length > 1);
}

function buildLookupTokens(text: string): Set<string> {
  const raw = text.trim().toLowerCase();
  const tokens = new Set<string>();
  if (raw.length > 1) tokens.add(raw);
  for (const token of splitTerms(text)) tokens.add(token);
  return tokens;
}

function pushUniquePath(map: Map<string, string[]>, key: string, path: string): void {
  const current = map.get(key) ?? [];
  if (!current.includes(path)) current.push(path);
  map.set(key, current);
}

function pushWordHit(map: Map<string, WordMatchHit[]>, key: string, hit: WordMatchHit): void {
  const current = map.get(key) ?? [];
  const duplicate = current.find((entry) => (
    entry.kind === hit.kind
    && entry.path === hit.path
    && entry.line === hit.line
    && entry.title === hit.title
  ));
  if (!duplicate) current.push(hit);
  map.set(key, current);
}

function parsePorcelainLine(line: string): RepoStatusFile | null {
  if (line.length < 4) return null;
  const index = line[0];
  const workingTree = line[1];
  const path = line.slice(3).replace(/^"+|"+$/g, "");
  return {
    path,
    staged: index,
    unstaged: workingTree,
    index,
    workingTree,
  };
}

function summarizeStatus(branch: string, ahead: number, behind: number, files: RepoStatusFile[]): RepoStatusSummary {
  const stagedCount = files.filter((file) => file.index !== " " && file.index !== "?").length;
  const unstagedCount = files.filter((file) => file.workingTree !== " " && file.workingTree !== "?").length;
  const untrackedCount = files.filter((file) => file.index === "?" || file.workingTree === "?").length;
  const conflictedCount = files.filter((file) => file.index === "U" || file.workingTree === "U").length;
  const modifiedCount = files.filter((file) => file.index === "M" || file.workingTree === "M").length;
  const createdCount = files.filter((file) => file.index === "A" || file.workingTree === "A" || file.index === "?").length;
  const deletedCount = files.filter((file) => file.index === "D" || file.workingTree === "D").length;
  const renamedCount = files.filter((file) => file.index === "R" || file.workingTree === "R").length;
  return {
    branch,
    ahead,
    behind,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    modifiedCount,
    createdCount,
    deletedCount,
    renamedCount,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function shouldIgnoreRepoStatusPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized === ".contextplus" || normalized.startsWith(".contextplus/");
}

function parseDiffRanges(diffText: string): ChangeRange[] {
  const ranges: ChangeRange[] = [];
  for (const line of diffText.split("\n")) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    ranges.push({
      oldStart: Number.parseInt(match[1], 10),
      oldLines: Number.parseInt(match[2] ?? "1", 10),
      newStart: Number.parseInt(match[3], 10),
      newLines: Number.parseInt(match[4] ?? "1", 10),
    });
  }
  return ranges;
}

async function loadPreparedArtifacts(rootDir: string): Promise<{
  fileState: PersistedFileSearchState;
  identifierState: PersistedIdentifierIndexState;
  structureState: PersistedStructureIndexState;
  cacheKey: string;
}> {
  await assertValidPreparedIndex({
    rootDir,
    mode: "full",
    consumer: "exact-query substrate",
  });
  const [fileState, identifierState, structureState] = await Promise.all([
    loadIndexArtifact(rootDir, "file-search-index", () => {
      throw new Error("file-search-index is required for exact queries.");
    }),
    loadIndexArtifact(rootDir, "identifier-search-index", () => {
      throw new Error("identifier-search-index is required for exact queries.");
    }),
    loadIndexArtifact(rootDir, "code-structure-index", () => {
      throw new Error("code-structure-index is required for exact queries.");
    }),
  ]) as [PersistedFileSearchState, PersistedIdentifierIndexState, PersistedStructureIndexState];

  return {
    fileState,
    identifierState,
    structureState,
    cacheKey: [
      fileState.generatedAt,
      identifierState.generatedAt,
      structureState.generatedAt,
      Object.keys(structureState.files).length,
    ].join("|"),
  };
}

function buildFastQueryState(
  fileState: PersistedFileSearchState,
  identifierState: PersistedIdentifierIndexState,
  structureState: PersistedStructureIndexState,
  cacheKey: string,
): FastQueryState {
  const symbolLookup = new Map<string, ExactSymbolHit[]>();
  const pathLookup = new Map<string, string[]>();
  const wordLookup = new Map<string, WordMatchHit[]>();
  const outlines = new Map<string, FileOutline>();
  const dependencies = new Map<string, DependencyInfo>();
  const reverseDependencies = new Map<string, string[]>();

  for (const [relativePath, fileEntry] of Object.entries(structureState.files)) {
    const artifact = fileEntry.artifact;
    outlines.set(relativePath, {
      path: relativePath,
      header: artifact.header,
      language: artifact.language,
      modulePath: artifact.modulePath,
      lineCount: artifact.lineCount,
      imports: artifact.imports,
      exports: artifact.exports,
      symbols: artifact.symbols,
    });
    dependencies.set(relativePath, {
      targetPath: relativePath,
      modulePath: artifact.modulePath,
      directDependencies: artifact.dependencyPaths.slice().sort(),
      reverseDependencies: [],
      exportedSymbolNames: artifact.exports.map((entry) => entry.name).sort(),
      importedSources: artifact.imports.map((entry) => entry.source).sort(),
    });

    for (const dependencyPath of artifact.dependencyPaths) {
      const current = reverseDependencies.get(dependencyPath) ?? [];
      if (!current.includes(relativePath)) current.push(relativePath);
      reverseDependencies.set(dependencyPath, current);
    }

    for (const token of buildLookupTokens(relativePath)) {
      pushUniquePath(pathLookup, token, relativePath);
      pushWordHit(wordLookup, token, {
        kind: "path",
        token,
        path: relativePath,
        title: relativePath,
        snippet: relativePath,
        score: relativePath === token ? 1 : 0.82,
      });
    }

    for (const token of buildLookupTokens(artifact.header)) {
      pushWordHit(wordLookup, token, {
        kind: "header",
        token,
        path: relativePath,
        title: artifact.header,
        snippet: artifact.header,
        score: 0.72,
      });
    }
  }

  for (const [relativePath, depInfo] of dependencies.entries()) {
    depInfo.reverseDependencies = (reverseDependencies.get(relativePath) ?? []).sort();
    dependencies.set(relativePath, depInfo);
  }

  for (const symbol of Object.values(structureState.symbols)) {
    const hit: ExactSymbolHit = {
      path: symbol.filePath,
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      endLine: symbol.endLine,
      signature: symbol.signature,
      parentName: symbol.parentName,
      header: structureState.files[symbol.filePath]?.artifact.header ?? "",
      modulePath: symbol.modulePath,
    };
    for (const token of buildLookupTokens(symbol.name)) {
      const current = symbolLookup.get(token) ?? [];
      current.push(hit);
      symbolLookup.set(token, current);
      pushWordHit(wordLookup, token, {
        kind: "symbol",
        token,
        path: symbol.filePath,
        line: symbol.line,
        title: symbol.name,
        snippet: symbol.signature,
        score: token === normalizeExactKey(symbol.name) ? 1 : 0.88,
      });
    }
    for (const token of buildLookupTokens(symbol.signature)) {
      pushWordHit(wordLookup, token, {
        kind: "symbol",
        token,
        path: symbol.filePath,
        line: symbol.line,
        title: symbol.name,
        snippet: symbol.signature,
        score: 0.74,
      });
    }
  }

  for (const fileEntry of Object.values(fileState.files)) {
    const doc = fileEntry.doc;
    const preview = doc.content.replace(/\s+/g, " ").trim().slice(0, 160);
    for (const token of buildLookupTokens(doc.content)) {
      pushWordHit(wordLookup, token, {
        kind: "content",
        token,
        path: doc.path,
        title: doc.header || doc.path,
        snippet: preview,
        score: 0.58,
      });
    }
  }

  for (const fileEntry of Object.values(identifierState.files)) {
    for (const doc of fileEntry.docs) {
      for (const token of buildLookupTokens(doc.text)) {
        pushWordHit(wordLookup, token, {
          kind: "symbol",
          token,
          path: doc.path,
          line: doc.line,
          title: doc.name,
          snippet: doc.signature,
          score: token === normalizeExactKey(doc.name) ? 0.96 : 0.76,
        });
      }
    }
  }

  for (const entries of symbolLookup.values()) {
    entries.sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.line - right.line
      || left.name.localeCompare(right.name)
    ));
  }
  for (const entries of wordLookup.values()) {
    entries.sort((left, right) => (
      right.score - left.score
      || left.path.localeCompare(right.path)
      || (left.line ?? 0) - (right.line ?? 0)
      || left.title.localeCompare(right.title)
    ));
  }

  return {
    cacheKey,
    symbolLookup,
    pathLookup,
    wordLookup,
    outlines,
    dependencies,
  };
}

async function getFastQueryState(rootDir: string): Promise<FastQueryState> {
  const normalizedRootDir = resolve(rootDir);
  const prepared = await loadPreparedArtifacts(normalizedRootDir);
  const cached = stateCache.get(normalizedRootDir);
  if (cached && cached.cacheKey === prepared.cacheKey) return cached;
  const nextState = buildFastQueryState(prepared.fileState, prepared.identifierState, prepared.structureState, prepared.cacheKey);
  stateCache.set(normalizedRootDir, nextState);
  return nextState;
}

async function getRepoState(rootDir: string): Promise<CachedRepoState> {
  const normalizedRootDir = resolve(rootDir);
  const cached = repoCache.get(normalizedRootDir);
  if (cached && (Date.now() - cached.updatedAtMs) < FAST_QUERY_TTL_MS) return cached;

  const git = simpleGit(normalizedRootDir);
  if (!(await git.checkIsRepo())) {
    throw new Error(`Git status queries require a git repository: ${normalizedRootDir}`);
  }

  const branch = (await git.branchLocal()).current;
  const status = await git.status();
  const porcelain = await git.raw(["status", "--short", "--branch"]);
  const files = porcelain
    .split("\n")
    .slice(1)
    .map((line) => parsePorcelainLine(line))
    .filter((entry): entry is RepoStatusFile => Boolean(entry))
    .filter((entry) => !shouldIgnoreRepoStatusPath(entry.path));
  const statusSummary = summarizeStatus(branch, status.ahead, status.behind, files);

  const unstagedSummary = await git.diffSummary();
  const stagedSummary = await git.diffSummary(["--cached"]);
  const changeMap = new Map<string, ChangeEntry>();
  for (const file of statusSummary.files) {
    changeMap.set(file.path, {
      path: file.path,
      staged: file.index,
      unstaged: file.workingTree,
      additions: 0,
      deletions: 0,
    });
  }
  for (const file of [...unstagedSummary.files, ...stagedSummary.files]) {
    if (shouldIgnoreRepoStatusPath(file.file)) continue;
    const additions = "insertions" in file ? file.insertions : 0;
    const deletions = "deletions" in file ? file.deletions : 0;
    const current = changeMap.get(file.file) ?? {
      path: file.file,
      staged: " ",
      unstaged: " ",
      additions: 0,
      deletions: 0,
    };
    current.additions += additions;
    current.deletions += deletions;
    changeMap.set(file.file, current);
  }

  const fileRanges = new Map<string, ChangeRange[]>();
  for (const path of changeMap.keys()) {
    const diff = await git.diff(["--unified=0", "--no-ext-diff", "--", path]);
    const ranges = parseDiffRanges(diff);
    if (ranges.length > 0) fileRanges.set(path, ranges);
    const current = changeMap.get(path);
    if (current && ranges.length > 0) current.ranges = ranges;
  }

  const changes: RepoChangesSummary = {
    changedFiles: changeMap.size,
    stagedFiles: Array.from(changeMap.values()).filter((entry) => entry.staged !== " " && entry.staged !== "?").length,
    unstagedFiles: Array.from(changeMap.values()).filter((entry) => entry.unstaged !== " " && entry.unstaged !== "?").length,
    untrackedFiles: Array.from(changeMap.values()).filter((entry) => entry.staged === "?" || entry.unstaged === "?").length,
    files: Array.from(changeMap.values()).sort((left, right) => left.path.localeCompare(right.path)),
  };

  const repoState: CachedRepoState = {
    repoKey: `${branch}|${statusSummary.files.map((file) => `${file.index}${file.workingTree}:${file.path}`).join("|")}`,
    updatedAtMs: Date.now(),
    status: statusSummary,
    changes,
    fileRanges,
  };
  repoCache.set(normalizedRootDir, repoState);
  return repoState;
}

export function invalidateFastQueryCache(rootDir?: string): void {
  if (!rootDir) {
    stateCache.clear();
    repoCache.clear();
    return;
  }
  const normalizedRootDir = resolve(rootDir);
  stateCache.delete(normalizedRootDir);
  repoCache.delete(normalizedRootDir);
}

export async function lookupExactSymbol(rootDir: string, query: string, topK: number = 10): Promise<ExactSymbolHit[]> {
  const state = await getFastQueryState(rootDir);
  const hits = state.symbolLookup.get(normalizeExactKey(query)) ?? [];
  return hits.slice(0, Math.max(1, topK));
}

export async function lookupPathCandidates(rootDir: string, query: string, topK: number = 10): Promise<string[]> {
  const state = await getFastQueryState(rootDir);
  const normalizedQuery = normalizePath(query).toLowerCase();
  const exact = state.outlines.has(normalizedQuery) ? [normalizedQuery] : [];
  if (exact.length > 0) return exact;
  const candidates = new Set<string>(state.pathLookup.get(normalizedQuery) ?? []);
  for (const [path] of state.outlines) {
    if (path.toLowerCase().includes(normalizedQuery)) candidates.add(path);
  }
  return Array.from(candidates).sort().slice(0, Math.max(1, topK));
}

export async function lookupWord(rootDir: string, query: string, topK: number = 10): Promise<WordMatchHit[]> {
  const state = await getFastQueryState(rootDir);
  const keys = Array.from(buildLookupTokens(query));
  const merged = new Map<string, WordMatchHit>();
  for (const key of keys) {
    for (const hit of state.wordLookup.get(key) ?? []) {
      const id = `${hit.kind}:${hit.path}:${hit.line ?? 0}:${hit.title}`;
      const current = merged.get(id);
      if (!current || current.score < hit.score) merged.set(id, hit);
    }
  }
  return Array.from(merged.values())
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0))
    .slice(0, Math.max(1, topK));
}

export async function getOutline(rootDir: string, filePath: string): Promise<FileOutline> {
  const state = await getFastQueryState(rootDir);
  const normalizedPath = normalizePath(filePath);
  const outline = state.outlines.get(normalizedPath);
  if (!outline) {
    throw new Error(`No indexed outline found for "${filePath}".`);
  }
  return outline;
}

export async function getDependencyInfo(rootDir: string, target: string): Promise<DependencyInfo> {
  const state = await getFastQueryState(rootDir);
  const candidates = await lookupPathCandidates(rootDir, target, 5);
  const resolved = candidates.find((candidate) => state.dependencies.has(candidate));
  if (!resolved) {
    throw new Error(`No indexed dependency target found for "${target}".`);
  }
  const dependencyInfo = state.dependencies.get(resolved);
  if (!dependencyInfo) {
    throw new Error(`Dependency info for "${resolved}" is missing from the fast-query cache.`);
  }
  return dependencyInfo;
}

export async function getRepoStatus(rootDir: string): Promise<RepoStatusSummary> {
  const repoState = await getRepoState(rootDir);
  return repoState.status;
}

export async function getRepoChanges(rootDir: string, options?: { path?: string; limit?: number }): Promise<RepoChangesSummary> {
  const repoState = await getRepoState(rootDir);
  const limit = Math.max(1, Math.floor(options?.limit ?? 20));
  if (!options?.path) {
    return {
      ...repoState.changes,
      files: repoState.changes.files.slice(0, limit),
    };
  }

  const candidates = await lookupPathCandidates(rootDir, options.path, 5);
  const resolvedPath = candidates.find((candidate) => repoState.changes.files.some((entry) => entry.path === candidate))
    ?? normalizePath(options.path);
  const entry = repoState.changes.files.find((file) => file.path === resolvedPath);
  if (!entry) {
    throw new Error(`No tracked git changes found for "${options.path}".`);
  }
  return {
    changedFiles: 1,
    stagedFiles: entry.staged !== " " && entry.staged !== "?" ? 1 : 0,
    unstagedFiles: entry.unstaged !== " " && entry.unstaged !== "?" ? 1 : 0,
    untrackedFiles: entry.staged === "?" || entry.unstaged === "?" ? 1 : 0,
    files: [{
      ...entry,
      ranges: repoState.fileRanges.get(entry.path) ?? entry.ranges,
    }],
  };
}

export async function lookupExactPathContent(rootDir: string, filePath: string): Promise<string> {
  const [resolvedPath] = await lookupPathCandidates(rootDir, filePath, 1);
  if (!resolvedPath) {
    throw new Error(`No indexed file path found for "${filePath}".`);
  }
  return readFile(resolve(rootDir, resolvedPath), "utf8");
}
