// Unified ranking engine over persisted full-index artifacts and memory evidence
// FEATURE: Canonical ranking layer for file and symbol search over sqlite state

import { loadIndexArtifact } from "../core/index-database.js";
import { searchGraph, type TraversalResult } from "../core/memory-graph.js";
import { ensureFileSearchIndex } from "./semantic-search.js";
import { searchHybridChunkIndex, searchHybridIdentifierIndex, type HybridSearchMatch } from "./hybrid-retrieval.js";

type EntityType = "file" | "symbol";

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

interface StructureArtifact {
  path: string;
  header: string;
  modulePath: string;
  language: string;
  lineCount: number;
  dependencyPaths: string[];
  imports: Array<{ source: string; names: string[]; line: number }>;
  exports: Array<{ name: string; kind: string; line: number }>;
  calls: Array<{ caller: string; callee: string; line: number }>;
  symbols: Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number;
    signature: string;
    parentName?: string;
  }>;
}

interface PersistedStructureIndexState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  files: Record<string, { contentHash: string; dependencyHash: string; artifact: StructureArtifact }>;
  symbols: Record<string, StructureSymbolRecord>;
  fileToSymbolIds: Record<string, string[]>;
  ownershipEdges: Array<{
    sourceType: "file" | "module";
    sourcePath: string;
    targetType: "file" | "symbol";
    targetId: string;
    relation: "owns";
  }>;
  moduleSummaries: Record<string, {
    modulePath: string;
    filePaths: string[];
    symbolIds: string[];
    exportedSymbolIds: string[];
    localDependencyPaths: string[];
    externalDependencySources: string[];
    ownedFilePaths: string[];
  }>;
  moduleImportEdges: Array<{
    fromModule: string;
    toModule: string;
    filePath: string;
    dependencyPath: string;
  }>;
}

export interface UnifiedRankingOptions {
  rootDir: string;
  query: string;
  topK?: number;
  entityTypes?: EntityType[];
  semanticWeight?: number;
  lexicalWeight?: number;
  fileWeight?: number;
  chunkWeight?: number;
  identifierWeight?: number;
  structureWeight?: number;
  memoryWeight?: number;
  topCallsPerIdentifier?: number;
  includeKinds?: string[];
}

export interface UnifiedSearchEvidence {
  file: number;
  chunk: number;
  identifier: number;
  structure: number;
  memory: number;
  lexical: number;
  semantic: number;
  matchedTerms: string[];
  supportingChunkIds: string[];
  supportingIdentifierIds: string[];
  supportingMemoryNodeIds: string[];
}

export interface UnifiedRankedHit {
  id: string;
  entityType: EntityType;
  path: string;
  title: string;
  kind: string;
  line: number;
  endLine: number;
  modulePath?: string;
  score: number;
  evidence: UnifiedSearchEvidence;
}

export interface CanonicalSearchOptions extends UnifiedRankingOptions {}

interface Candidate {
  id: string;
  entityType: EntityType;
  path: string;
  title: string;
  kind: string;
  line: number;
  endLine: number;
  modulePath?: string;
  fileScore: number;
  chunkScore: number;
  identifierScore: number;
  structureScore: number;
  memoryScore: number;
  semanticScore: number;
  lexicalScore: number;
  matchedTerms: Set<string>;
  supportingChunkIds: Set<string>;
  supportingIdentifierIds: Set<string>;
  supportingMemoryNodeIds: Set<string>;
}

interface MemoryContributionTarget {
  candidateId: string;
  path?: string;
  symbolName?: string;
  score: number;
  nodeId: string;
}

function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
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

function normalizeEvidenceScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

function normalizeTopK(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function createCandidate(id: string, entityType: EntityType, path: string, title: string, kind: string, line: number, endLine: number, modulePath?: string): Candidate {
  return {
    id,
    entityType,
    path,
    title,
    kind,
    line,
    endLine,
    modulePath,
    fileScore: 0,
    chunkScore: 0,
    identifierScore: 0,
    structureScore: 0,
    memoryScore: 0,
    semanticScore: 0,
    lexicalScore: 0,
    matchedTerms: new Set<string>(),
    supportingChunkIds: new Set<string>(),
    supportingIdentifierIds: new Set<string>(),
    supportingMemoryNodeIds: new Set<string>(),
  };
}

function computeCoverageScore(query: string, terms: string[], text: string): { score: number; matchedTerms: string[] } {
  const normalizedText = text.toLowerCase();
  if (terms.length === 0) return { score: 0, matchedTerms: [] };
  const uniqueTerms = Array.from(new Set(terms));
  const matchedTerms = uniqueTerms.filter((term) => normalizedText.includes(term));
  const coverage = matchedTerms.length / uniqueTerms.length;
  const phraseBoost = query.trim().length > 0 && normalizedText.includes(query.trim().toLowerCase()) ? 0.18 : 0;
  return { score: clamp01(coverage * 0.82 + phraseBoost), matchedTerms };
}

function pickLine(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 1;
}

function getSymbolCandidateId(path: string, title: string, line: number): string {
  return `symbol:${path}:${title}:${line}`;
}

function getFileCandidateId(path: string): string {
  return `file:${path}`;
}

function getMemoryTarget(result: TraversalResult): { path?: string; symbolName?: string; candidateId?: string } {
  const metadata = result.node.metadata ?? {};
  const path = metadata.path || metadata.filePath;
  const symbolName = metadata.symbolName || metadata.symbol;
  if (path && symbolName) return { path, symbolName, candidateId: getSymbolCandidateId(path, symbolName, pickLine(Number(metadata.line) || 1)) };
  if (path) return { path, candidateId: getFileCandidateId(path) };
  if (/\.[a-z0-9]+$/i.test(result.node.label)) return { path: result.node.label, candidateId: getFileCandidateId(result.node.label) };
  return { path, symbolName };
}

function applyHybridEvidence(candidate: Candidate, match: HybridSearchMatch, source: "chunk" | "identifier"): void {
  if (source === "chunk") {
    candidate.chunkScore = Math.max(candidate.chunkScore, match.score);
    candidate.supportingChunkIds.add(match.id);
  } else {
    candidate.identifierScore = Math.max(candidate.identifierScore, match.score);
    candidate.supportingIdentifierIds.add(match.id);
  }
  candidate.semanticScore = Math.max(candidate.semanticScore, match.semanticScore);
  candidate.lexicalScore = Math.max(candidate.lexicalScore, match.lexicalScore);
  for (const term of match.matchedTerms) candidate.matchedTerms.add(term);
}

async function loadStructureState(rootDir: string): Promise<PersistedStructureIndexState> {
  return loadIndexArtifact(rootDir, "code-structure-index", () => ({
    generatedAt: "",
    artifactVersion: 0,
    contractVersion: 0,
    mode: "full",
    files: {},
    symbols: {},
    fileToSymbolIds: {},
    ownershipEdges: [],
    moduleSummaries: {},
    moduleImportEdges: [],
  }));
}

function computeStructureScoreForFile(
  query: string,
  queryTerms: string[],
  path: string,
  state: PersistedStructureIndexState,
  hasSymbolEvidence: boolean,
): { score: number; matchedTerms: string[]; modulePath?: string } {
  const entry = state.files[path];
  if (!entry) return { score: hasSymbolEvidence ? 0.12 : 0, matchedTerms: [] };
  const artifact = entry.artifact;
  const moduleSummary = state.moduleSummaries[artifact.modulePath];
  const structureText = [
    artifact.path,
    artifact.header,
    artifact.modulePath,
    artifact.language,
    artifact.dependencyPaths.join(" "),
    artifact.imports.map((entry) => `${entry.source} ${entry.names.join(" ")}`).join(" "),
    artifact.exports.map((entry) => `${entry.name} ${entry.kind}`).join(" "),
    artifact.calls.map((entry) => `${entry.caller} ${entry.callee}`).join(" "),
    artifact.symbols.map((symbol) => `${symbol.name} ${symbol.kind} ${symbol.signature} ${symbol.parentName ?? ""}`).join(" "),
    moduleSummary?.externalDependencySources.join(" ") ?? "",
  ].join(" ");
  const coverage = computeCoverageScore(query, queryTerms, structureText);
  const ownershipBoost = hasSymbolEvidence ? 0.12 : 0;
  return {
    score: clamp01(coverage.score + ownershipBoost),
    matchedTerms: coverage.matchedTerms,
    modulePath: artifact.modulePath,
  };
}

function computeStructureScoreForSymbol(
  query: string,
  queryTerms: string[],
  symbol: StructureSymbolRecord | undefined,
  fileEntry: PersistedStructureIndexState["files"][string] | undefined,
  hasHybridEvidence: boolean,
): { score: number; matchedTerms: string[]; modulePath?: string } {
  if (!symbol) return { score: hasHybridEvidence ? 0.12 : 0, matchedTerms: [] };
  const structureText = [
    symbol.filePath,
    symbol.modulePath,
    symbol.name,
    symbol.kind,
    symbol.signature,
    symbol.parentName ?? "",
    fileEntry?.artifact.header ?? "",
    fileEntry?.artifact.dependencyPaths.join(" ") ?? "",
  ].join(" ");
  const coverage = computeCoverageScore(query, queryTerms, structureText);
  const ownershipBoost = hasHybridEvidence ? 0.12 : 0;
  return {
    score: clamp01(coverage.score + ownershipBoost),
    matchedTerms: coverage.matchedTerms,
    modulePath: symbol.modulePath,
  };
}

function finalizeCandidate(candidate: Candidate, options: UnifiedRankingOptions): UnifiedRankedHit {
  const fileWeight = normalizeWeight(options.fileWeight, 0.2);
  const chunkWeight = normalizeWeight(options.chunkWeight, 0.22);
  const identifierWeight = normalizeWeight(options.identifierWeight, 0.24);
  const structureWeight = normalizeWeight(options.structureWeight, 0.18);
  const memoryWeight = normalizeWeight(options.memoryWeight, 0.16);
  const total = fileWeight + chunkWeight + identifierWeight + structureWeight + memoryWeight;
  const score = total > 0
    ? clamp01((
      candidate.fileScore * fileWeight
      + candidate.chunkScore * chunkWeight
      + candidate.identifierScore * identifierWeight
      + candidate.structureScore * structureWeight
      + candidate.memoryScore * memoryWeight
    ) / total)
    : clamp01(candidate.fileScore + candidate.chunkScore + candidate.identifierScore + candidate.structureScore + candidate.memoryScore);

  return {
    id: candidate.id,
    entityType: candidate.entityType,
    path: candidate.path,
    title: candidate.title,
    kind: candidate.kind,
    line: candidate.line,
    endLine: candidate.endLine,
    modulePath: candidate.modulePath,
    score,
    evidence: {
      file: candidate.fileScore,
      chunk: candidate.chunkScore,
      identifier: candidate.identifierScore,
      structure: candidate.structureScore,
      memory: candidate.memoryScore,
      lexical: candidate.lexicalScore,
      semantic: candidate.semanticScore,
      matchedTerms: Array.from(candidate.matchedTerms).sort(),
      supportingChunkIds: Array.from(candidate.supportingChunkIds).sort(),
      supportingIdentifierIds: Array.from(candidate.supportingIdentifierIds).sort(),
      supportingMemoryNodeIds: Array.from(candidate.supportingMemoryNodeIds).sort(),
    },
  };
}

function formatEvidenceSummary(hit: UnifiedRankedHit): string {
  return [
    `evidence file=${hit.evidence.file.toFixed(2)}`,
    `chunk=${hit.evidence.chunk.toFixed(2)}`,
    `identifier=${hit.evidence.identifier.toFixed(2)}`,
    `structure=${hit.evidence.structure.toFixed(2)}`,
    `memory=${hit.evidence.memory.toFixed(2)}`,
    `semantic=${hit.evidence.semantic.toFixed(2)}`,
    `lexical=${hit.evidence.lexical.toFixed(2)}`,
  ].join(" | ");
}

export function formatUnifiedSearchResults(query: string, entityTypes: EntityType[], hits: UnifiedRankedHit[]): string {
  const requested = entityTypes.join(", ");
  if (hits.length === 0) {
    return `Search: "${query}"\nRequested result types: ${requested}\nNo matching results found in the prepared full-engine artifacts.`;
  }

  const lines = [
    `Search: "${query}"`,
    `Requested result types: ${requested}`,
    `Ranked hits: ${hits.length}`,
    "",
  ];

  for (const hit of hits) {
    const lineRange = hit.endLine > hit.line ? `L${hit.line}-L${hit.endLine}` : `L${hit.line}`;
    lines.push(`${hit.path}:${lineRange} [${hit.entityType}] ${hit.title} (${hit.kind}) score=${hit.score.toFixed(3)}`);
    if (hit.modulePath) lines.push(`  module: ${hit.modulePath}`);
    lines.push(`  ${formatEvidenceSummary(hit)}`);
    if (hit.evidence.matchedTerms.length > 0) lines.push(`  matched terms: ${hit.evidence.matchedTerms.join(", ")}`);
    if (hit.evidence.supportingChunkIds.length > 0) lines.push(`  supporting chunks: ${hit.evidence.supportingChunkIds.slice(0, 3).join(", ")}`);
    if (hit.evidence.supportingIdentifierIds.length > 0) lines.push(`  supporting identifiers: ${hit.evidence.supportingIdentifierIds.slice(0, 3).join(", ")}`);
    if (hit.evidence.supportingMemoryNodeIds.length > 0) lines.push(`  supporting memory nodes: ${hit.evidence.supportingMemoryNodeIds.slice(0, 3).join(", ")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export async function runCanonicalSearch(options: CanonicalSearchOptions): Promise<string> {
  const entityTypes = options.entityTypes ?? ["file", "symbol"];
  const hits = await rankUnifiedSearch(options);
  return formatUnifiedSearchResults(options.query, entityTypes, hits);
}

export async function rankUnifiedSearch(options: UnifiedRankingOptions): Promise<UnifiedRankedHit[]> {
  const rootDir = options.rootDir;
  const queryTerms = splitTerms(options.query);
  const topK = normalizeTopK(options.topK, 5);
  const entityTypes = new Set(options.entityTypes ?? ["file", "symbol"]);
  const structureState = await loadStructureState(rootDir);
  const candidates = new Map<string, Candidate>();

  const { index } = await ensureFileSearchIndex(rootDir);
  const fileResults = await index.search(options.query, {
    topK: Math.max(topK * 8, 20),
    semanticWeight: options.semanticWeight,
    keywordWeight: options.lexicalWeight,
  });

  for (const result of fileResults) {
    const id = getFileCandidateId(result.path);
    const candidate = candidates.get(id) ?? createCandidate(id, "file", result.path, result.path, "file", 1, 1);
    candidate.fileScore = Math.max(candidate.fileScore, normalizeEvidenceScore(result.score));
    candidate.semanticScore = Math.max(candidate.semanticScore, normalizeEvidenceScore(result.semanticScore));
    candidate.lexicalScore = Math.max(candidate.lexicalScore, normalizeEvidenceScore(result.keywordScore));
    for (const term of [...result.matchedSymbols, ...queryTerms.filter((term) => result.path.toLowerCase().includes(term) || result.header.toLowerCase().includes(term))]) {
      candidate.matchedTerms.add(term.toLowerCase());
    }
    candidates.set(id, candidate);
  }

  const chunkMatches = await searchHybridChunkIndex(rootDir, options.query, {
    topK: Math.max(topK * 10, 40),
    semanticWeight: options.semanticWeight,
    lexicalWeight: options.lexicalWeight,
  });
  for (const match of chunkMatches) {
    const candidateId = match.title === "file"
      ? getFileCandidateId(match.path)
      : getSymbolCandidateId(match.path, match.title, match.line);
    const entityType: EntityType = match.title === "file" ? "file" : "symbol";
    const candidate = candidates.get(candidateId) ?? createCandidate(candidateId, entityType, match.path, match.title, match.kind, match.line, match.endLine);
    applyHybridEvidence(candidate, match, "chunk");
    candidates.set(candidateId, candidate);

    const fileCandidateId = getFileCandidateId(match.path);
    const fileCandidate = candidates.get(fileCandidateId) ?? createCandidate(fileCandidateId, "file", match.path, match.path, "file", 1, 1);
    applyHybridEvidence(fileCandidate, match, "chunk");
    candidates.set(fileCandidateId, fileCandidate);
  }

  const identifierMatches = await searchHybridIdentifierIndex(rootDir, options.query, {
    topK: Math.max(topK * 10, 40),
    semanticWeight: options.semanticWeight,
    lexicalWeight: options.lexicalWeight,
  });
  for (const match of identifierMatches) {
    const candidateId = getSymbolCandidateId(match.path, match.title, match.line);
    const candidate = candidates.get(candidateId) ?? createCandidate(candidateId, "symbol", match.path, match.title, match.kind, match.line, match.endLine);
    applyHybridEvidence(candidate, match, "identifier");
    candidates.set(candidateId, candidate);

    const fileCandidateId = getFileCandidateId(match.path);
    const fileCandidate = candidates.get(fileCandidateId) ?? createCandidate(fileCandidateId, "file", match.path, match.path, "file", 1, 1);
    fileCandidate.identifierScore = Math.max(fileCandidate.identifierScore, match.score);
    fileCandidate.semanticScore = Math.max(fileCandidate.semanticScore, match.semanticScore);
    fileCandidate.lexicalScore = Math.max(fileCandidate.lexicalScore, match.lexicalScore);
    for (const term of match.matchedTerms) fileCandidate.matchedTerms.add(term);
    fileCandidate.supportingIdentifierIds.add(match.id);
    candidates.set(fileCandidateId, fileCandidate);
  }

  const memoryResults = await searchGraph(rootDir, options.query, 1, Math.max(topK * 3, 10));
  const memoryTargets: MemoryContributionTarget[] = [];
  for (const result of [...memoryResults.direct, ...memoryResults.neighbors]) {
    const target = getMemoryTarget(result);
    const score = clamp01(result.relevanceScore / 100);
    if (target.candidateId) {
      memoryTargets.push({
        candidateId: target.candidateId,
        path: target.path,
        symbolName: target.symbolName,
        score,
        nodeId: result.node.id,
      });
    } else if (target.path) {
      memoryTargets.push({
        candidateId: getFileCandidateId(target.path),
        path: target.path,
        symbolName: target.symbolName,
        score,
        nodeId: result.node.id,
      });
    }
  }

  for (const contribution of memoryTargets) {
    const candidate = candidates.get(contribution.candidateId)
      ?? (contribution.symbolName && contribution.path
        ? createCandidate(contribution.candidateId, "symbol", contribution.path, contribution.symbolName, "memory", 1, 1)
        : contribution.path
          ? createCandidate(contribution.candidateId, "file", contribution.path, contribution.path, "file", 1, 1)
          : null);
    if (!candidate) continue;
    candidate.memoryScore = Math.max(candidate.memoryScore, contribution.score);
    candidate.supportingMemoryNodeIds.add(contribution.nodeId);
    candidates.set(contribution.candidateId, candidate);
  }

  for (const candidate of candidates.values()) {
    if (candidate.entityType === "file") {
      const structure = computeStructureScoreForFile(
        options.query,
        queryTerms,
        candidate.path,
        structureState,
        candidate.chunkScore > 0 || candidate.identifierScore > 0,
      );
      candidate.structureScore = Math.max(candidate.structureScore, structure.score);
      candidate.modulePath = structure.modulePath ?? candidate.modulePath;
      for (const term of structure.matchedTerms) candidate.matchedTerms.add(term);

      const fileSymbolIds = structureState.fileToSymbolIds[candidate.path] ?? [];
      for (const symbolId of fileSymbolIds) {
        const symbol = structureState.symbols[symbolId];
        if (symbol && (candidate.title === candidate.path || candidate.identifierScore > 0 || candidate.chunkScore > 0)) {
          candidate.kind = "file";
        }
      }
    } else {
      const fileEntry = structureState.files[candidate.path];
      const fileSymbolIds = structureState.fileToSymbolIds[candidate.path] ?? [];
      const matchingSymbolId = fileSymbolIds.find((symbolId) => {
        const symbol = structureState.symbols[symbolId];
        return symbol?.name === candidate.title && symbol?.line === candidate.line;
      }) ?? fileSymbolIds.find((symbolId) => structureState.symbols[symbolId]?.name === candidate.title);
      const structure = computeStructureScoreForSymbol(
        options.query,
        queryTerms,
        matchingSymbolId ? structureState.symbols[matchingSymbolId] : undefined,
        fileEntry,
        candidate.chunkScore > 0 || candidate.identifierScore > 0,
      );
      candidate.structureScore = Math.max(candidate.structureScore, structure.score);
      candidate.modulePath = structure.modulePath ?? candidate.modulePath;
      for (const term of structure.matchedTerms) candidate.matchedTerms.add(term);

      const fileCandidate = candidates.get(getFileCandidateId(candidate.path));
      if (fileCandidate) {
        candidate.fileScore = Math.max(candidate.fileScore, fileCandidate.fileScore * 0.7);
        candidate.semanticScore = Math.max(candidate.semanticScore, fileCandidate.semanticScore);
        candidate.lexicalScore = Math.max(candidate.lexicalScore, fileCandidate.lexicalScore * 0.85);
        for (const term of fileCandidate.matchedTerms) candidate.matchedTerms.add(term);
      }
    }
  }

  const normalizedKinds = options.includeKinds?.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const kindFilter = normalizedKinds && normalizedKinds.length > 0 ? new Set(normalizedKinds) : null;

  return Array.from(candidates.values())
    .filter((candidate) => entityTypes.has(candidate.entityType))
    .filter((candidate) => !kindFilter || candidate.entityType !== "symbol" || kindFilter.has(candidate.kind.toLowerCase()))
    .map((candidate) => finalizeCandidate(candidate, options))
    .sort((a, b) =>
      b.score - a.score
      || b.evidence.identifier - a.evidence.identifier
      || b.evidence.chunk - a.evidence.chunk
      || b.evidence.file - a.evidence.file
      || a.path.localeCompare(b.path)
      || a.title.localeCompare(b.title))
    .slice(0, topK);
}
