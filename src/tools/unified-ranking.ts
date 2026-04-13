// summary: Combines retrieval and structure evidence into the canonical ranking layer.
// FEATURE: Canonical ranking layer for file and symbol search over sqlite state.
// inputs: File, chunk, identifier, and structure scoring evidence from prepared artifacts.
// outputs: Ranked file and symbol candidates for canonical search surfaces.

import { loadIndexArtifact } from "../core/index-database.js";
import { fetchEmbedding } from "../core/embeddings.js";
import { assertValidPreparedIndex } from "./index-reliability.js";
import { ensureFileSearchIndex } from "./semantic-search.js";
import {
  searchHybridChunkIndex,
  searchHybridIdentifierIndex,
  type HybridSearchDiagnostics,
  type HybridSearchMatch,
} from "./hybrid-retrieval.js";

type EntityType = "file" | "symbol";
export type RetrievalMode = "semantic" | "keyword" | "both";

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
  retrievalMode?: RetrievalMode;
  semanticWeight?: number;
  lexicalWeight?: number;
  fileWeight?: number;
  chunkWeight?: number;
  identifierWeight?: number;
  structureWeight?: number;
  topCallsPerIdentifier?: number;
  includeKinds?: string[];
}

export interface UnifiedSearchEvidence {
  file: number;
  chunk: number;
  identifier: number;
  structure: number;
  lexical: number;
  semantic: number;
  matchedTerms: string[];
  supportingChunkIds: string[];
  supportingIdentifierIds: string[];
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

export interface UnifiedSearchDiagnostics {
  retrievalMode: RetrievalMode;
  chunk: HybridSearchDiagnostics;
  identifier: HybridSearchDiagnostics;
}

export interface UnifiedSearchReport {
  hits: UnifiedRankedHit[];
  diagnostics: UnifiedSearchDiagnostics;
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
  semanticScore: number;
  lexicalScore: number;
  matchedTerms: Set<string>;
  supportingChunkIds: Set<string>;
  supportingIdentifierIds: Set<string>;
}

// Purpose: Split free-form search queries into normalized lexical terms.
// Inputs: Arbitrary query or title text that may contain camelCase and punctuation.
// Returns/Effects: Returns lowercase tokens longer than one character.
function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

// Purpose: Clamp a numeric score into the inclusive `[0, 1]` range.
// Inputs: Any numeric score produced by canonical ranking heuristics.
// Returns/Effects: Returns the bounded score value.
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

function normalizeRetrievalMode(value: RetrievalMode | undefined): RetrievalMode {
  return value ?? "both";
}

// Purpose: Create a zeroed candidate record for file or symbol ranking evidence.
// Inputs: Candidate identity fields including entity type, path, title, kind, lines, and module path.
// Returns/Effects: Returns a fresh mutable candidate accumulator.
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
    semanticScore: 0,
    lexicalScore: 0,
    matchedTerms: new Set<string>(),
    supportingChunkIds: new Set<string>(),
    supportingIdentifierIds: new Set<string>(),
  };
}

// Purpose: Score lexical coverage between the query vocabulary and a candidate text blob.
// Inputs: The raw query text, normalized query terms, and the candidate text.
// Returns/Effects: Returns a bounded lexical score and the matched query terms.
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

// Purpose: Merge hybrid retrieval evidence into a mutable ranking candidate.
// Inputs: The mutable candidate, one hybrid search match, and the evidence source label.
// Returns/Effects: Updates candidate scores, matched terms, and supporting ids in place.
function applyHybridEvidence(candidate: Candidate, match: HybridSearchMatch, source: "chunk" | "identifier"): void {
  const normalizedScore = normalizeEvidenceScore(match.score);
  const normalizedSemantic = normalizeEvidenceScore(match.semanticScore);
  const normalizedLexical = normalizeEvidenceScore(match.lexicalScore);
  if (source === "chunk") {
    candidate.chunkScore = Math.max(candidate.chunkScore, normalizedScore);
    candidate.supportingChunkIds.add(match.id);
  } else {
    candidate.identifierScore = Math.max(candidate.identifierScore, normalizedScore);
    candidate.supportingIdentifierIds.add(match.id);
  }
  candidate.semanticScore = Math.max(candidate.semanticScore, normalizedSemantic);
  candidate.lexicalScore = Math.max(candidate.lexicalScore, normalizedLexical);
  for (const term of match.matchedTerms) candidate.matchedTerms.add(term);
}

// Purpose: Load the persisted structure index state used for structure-aware ranking signals.
// Inputs: The repo root whose `code-structure-index` artifact should be read.
// Returns/Effects: Returns the persisted structure state or an empty baseline.
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

// Purpose: Compute structure evidence for one file candidate from persisted structure artifacts.
// Inputs: The query, normalized terms, file path, structure state, hybrid-evidence flag, and retrieval mode.
// Returns/Effects: Returns a structure score, matched terms, and optional module path.
function computeStructureScoreForFile(
  query: string,
  queryTerms: string[],
  path: string,
  state: PersistedStructureIndexState,
  hasSymbolEvidence: boolean,
  retrievalMode: RetrievalMode,
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
  const coverage = retrievalMode === "semantic"
    ? { score: 0, matchedTerms: [] as string[] }
    : computeCoverageScore(query, queryTerms, structureText);
  const ownershipBoost = hasSymbolEvidence ? 0.12 : 0;
  return {
    score: clamp01(coverage.score + ownershipBoost),
    matchedTerms: coverage.matchedTerms,
    modulePath: artifact.modulePath,
  };
}

// Purpose: Compute structure evidence for one symbol candidate from persisted structure artifacts.
// Inputs: The query, normalized terms, symbol record, optional file entry, hybrid-evidence flag, and retrieval mode.
// Returns/Effects: Returns a structure score, matched terms, and optional module path.
function computeStructureScoreForSymbol(
  query: string,
  queryTerms: string[],
  symbol: StructureSymbolRecord | undefined,
  fileEntry: PersistedStructureIndexState["files"][string] | undefined,
  hasHybridEvidence: boolean,
  retrievalMode: RetrievalMode,
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
  const coverage = retrievalMode === "semantic"
    ? { score: 0, matchedTerms: [] as string[] }
    : computeCoverageScore(query, queryTerms, structureText);
  const ownershipBoost = hasHybridEvidence ? 0.12 : 0;
  return {
    score: clamp01(coverage.score + ownershipBoost),
    matchedTerms: coverage.matchedTerms,
    modulePath: symbol.modulePath,
  };
}

// Purpose: Finalize one mutable candidate into the stable ranked-hit output shape.
// Inputs: The mutable candidate accumulator and the current unified ranking options.
// Returns/Effects: Returns a normalized ranked hit with aggregated evidence.
function finalizeCandidate(candidate: Candidate, options: UnifiedRankingOptions): UnifiedRankedHit {
  const fileWeight = normalizeWeight(options.fileWeight, 0.2);
  const chunkWeight = normalizeWeight(options.chunkWeight, 0.22);
  const identifierWeight = normalizeWeight(options.identifierWeight, 0.24);
  const structureWeight = normalizeWeight(options.structureWeight, 0.18);
  const total = fileWeight + chunkWeight + identifierWeight + structureWeight;
  const score = total > 0
    ? clamp01((
      candidate.fileScore * fileWeight
      + candidate.chunkScore * chunkWeight
      + candidate.identifierScore * identifierWeight
      + candidate.structureScore * structureWeight
    ) / total)
    : clamp01(candidate.fileScore + candidate.chunkScore + candidate.identifierScore + candidate.structureScore);

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
      lexical: candidate.lexicalScore,
      semantic: candidate.semanticScore,
      matchedTerms: Array.from(candidate.matchedTerms).sort(),
      supportingChunkIds: Array.from(candidate.supportingChunkIds).sort(),
      supportingIdentifierIds: Array.from(candidate.supportingIdentifierIds).sort(),
    },
  };
}

// Purpose: Format the evidence scores attached to one ranked hit.
// Inputs: The ranked hit whose evidence fields should be rendered.
// Returns/Effects: Returns a concise evidence summary string.
function formatEvidenceSummary(hit: UnifiedRankedHit): string {
  return [
    `evidence file=${hit.evidence.file.toFixed(2)}`,
    `chunk=${hit.evidence.chunk.toFixed(2)}`,
    `identifier=${hit.evidence.identifier.toFixed(2)}`,
    `structure=${hit.evidence.structure.toFixed(2)}`,
    `semantic=${hit.evidence.semantic.toFixed(2)}`,
    `lexical=${hit.evidence.lexical.toFixed(2)}`,
  ].join(" | ");
}

// Purpose: Format vector coverage diagnostics for one hybrid retrieval subsystem.
// Inputs: The subsystem label and its hybrid retrieval diagnostics payload.
// Returns/Effects: Returns a concise vector coverage summary string.
function formatVectorCoverageLine(label: string, diagnostics: HybridSearchDiagnostics): string {
  const coverage = diagnostics.vectorCoverage;
  if (coverage.state === "explicit-lexical-only") {
    return `${label} lexical-only-explicit`;
  }
  return `${label} ${coverage.loadedVectorCount}/${coverage.requestedVectorCount} (${coverage.coverageRatio.toFixed(2)})`;
}

// Purpose: Format canonical ranked hits and diagnostics into the user-facing report text.
// Inputs: The query, requested entity types, ranked hits, retrieval mode, and optional diagnostics.
// Returns/Effects: Returns a printable canonical search report string.
export function formatUnifiedSearchResults(
  query: string,
  entityTypes: EntityType[],
  hits: UnifiedRankedHit[],
  retrievalMode: RetrievalMode,
  diagnostics?: UnifiedSearchDiagnostics,
): string {
  const requested = entityTypes.join(", ");
  if (hits.length === 0) {
    const lines = [
      `Search: "${query}"`,
      `Requested result types: ${requested}`,
      `Retrieval mode: ${retrievalMode}`,
    ];
    if (diagnostics) {
      lines.push(`Vector coverage: ${formatVectorCoverageLine("chunk", diagnostics.chunk)} | ${formatVectorCoverageLine("identifier", diagnostics.identifier)}`);
    }
    lines.push("No matching results found in the prepared full-engine artifacts.");
    return lines.join("\n");
  }

  const lines = [
    `Search: "${query}"`,
    `Requested result types: ${requested}`,
    `Retrieval mode: ${retrievalMode}`,
  ];
  if (diagnostics) {
    lines.push(`Vector coverage: ${formatVectorCoverageLine("chunk", diagnostics.chunk)} | ${formatVectorCoverageLine("identifier", diagnostics.identifier)}`);
    lines.push(
      `Hybrid candidates: chunk ${diagnostics.chunk.lexicalCandidateCount}->${diagnostics.chunk.rerankCandidateCount}->${diagnostics.chunk.finalResultCount}` +
      ` | identifier ${diagnostics.identifier.lexicalCandidateCount}->${diagnostics.identifier.rerankCandidateCount}->${diagnostics.identifier.finalResultCount}`,
    );
  }
  lines.push(
    `Ranked hits: ${hits.length}`,
    "",
  );

  for (const hit of hits) {
    const lineRange = hit.endLine > hit.line ? `L${hit.line}-L${hit.endLine}` : `L${hit.line}`;
    lines.push(`${hit.path}:${lineRange} [${hit.entityType}] ${hit.title} (${hit.kind}) score=${hit.score.toFixed(3)}`);
    if (hit.modulePath) lines.push(`  module: ${hit.modulePath}`);
    lines.push(`  ${formatEvidenceSummary(hit)}`);
    if (hit.evidence.matchedTerms.length > 0) lines.push(`  matched terms: ${hit.evidence.matchedTerms.join(", ")}`);
    if (hit.evidence.supportingChunkIds.length > 0) lines.push(`  supporting chunks: ${hit.evidence.supportingChunkIds.slice(0, 3).join(", ")}`);
    if (hit.evidence.supportingIdentifierIds.length > 0) lines.push(`  supporting identifiers: ${hit.evidence.supportingIdentifierIds.slice(0, 3).join(", ")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// Purpose: Execute canonical search and return the formatted user-facing results.
// Inputs: Canonical search options describing the repo root, query, ranking weights, and filters.
// Returns/Effects: Returns a formatted canonical search report string.
export async function runCanonicalSearch(options: CanonicalSearchOptions): Promise<string> {
  const entityTypes = options.entityTypes ?? ["file", "symbol"];
  const report = await buildUnifiedSearchReport(options);
  return formatUnifiedSearchResults(options.query, entityTypes, report.hits, normalizeRetrievalMode(options.retrievalMode), report.diagnostics);
}

// Purpose: Gather file-search evidence and merge it into the candidate accumulator map.
// Inputs: Candidate map, repo root, query text, query terms, topK, weights, and query vector.
// Returns/Effects: Updates file candidates in place from semantic file-search results.
async function processFileSearchEvidence(
  candidates: Map<string, Candidate>,
  rootDir: string,
  query: string,
  queryTerms: string[],
  topK: number,
  semanticWeight: number | undefined,
  lexicalWeight: number | undefined,
  queryVector: number[]
) {
  const { index } = await ensureFileSearchIndex(rootDir);
  const fileResults = await index.search(query, {
    topK: Math.max(topK * 8, 20),
    semanticWeight,
    keywordWeight: lexicalWeight,
    queryVector,
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
}

// Purpose: Gather hybrid chunk-search evidence and merge it into the candidate accumulator map.
// Inputs: Candidate map, repo root, query text, topK, weights, and query vector.
// Returns/Effects: Updates file and symbol candidates in place and returns chunk diagnostics.
async function processChunkSearchEvidence(
  candidates: Map<string, Candidate>,
  rootDir: string,
  query: string,
  topK: number,
  semanticWeight: number | undefined,
  lexicalWeight: number | undefined,
  queryVector: number[]
): Promise<HybridSearchDiagnostics> {
  const chunkSearch = await searchHybridChunkIndex(rootDir, query, {
    topK: Math.max(topK * 10, 40),
    semanticWeight,
    lexicalWeight,
    queryVector,
  });
  for (const match of chunkSearch.matches) {
    const candidateId = match.entityType === "file"
      ? getFileCandidateId(match.path)
      : getSymbolCandidateId(match.path, match.title, match.line);
    const entityType: EntityType = match.entityType;
    const candidate = candidates.get(candidateId) ?? createCandidate(candidateId, entityType, match.path, match.title, match.kind, match.line, match.endLine);
    applyHybridEvidence(candidate, match, "chunk");
    candidates.set(candidateId, candidate);

    const fileCandidateId = getFileCandidateId(match.path);
    const fileCandidate = candidates.get(fileCandidateId) ?? createCandidate(fileCandidateId, "file", match.path, match.path, "file", 1, 1);
    applyHybridEvidence(fileCandidate, match, "chunk");
    candidates.set(fileCandidateId, fileCandidate);
  }
  return chunkSearch.diagnostics;
}

// Purpose: Gather hybrid identifier-search evidence and merge it into the candidate accumulator map.
// Inputs: Candidate map, repo root, query text, topK, weights, and query vector.
// Returns/Effects: Updates file and symbol candidates in place and returns identifier diagnostics.
async function processIdentifierSearchEvidence(
  candidates: Map<string, Candidate>,
  rootDir: string,
  query: string,
  topK: number,
  semanticWeight: number | undefined,
  lexicalWeight: number | undefined,
  queryVector: number[]
): Promise<HybridSearchDiagnostics> {
  const identifierSearch = await searchHybridIdentifierIndex(rootDir, query, {
    topK: Math.max(topK * 10, 40),
    semanticWeight,
    lexicalWeight,
    queryVector,
  });
  for (const match of identifierSearch.matches) {
    const candidateId = getSymbolCandidateId(match.path, match.title, match.line);
    const candidate = candidates.get(candidateId) ?? createCandidate(candidateId, "symbol", match.path, match.title, match.kind, match.line, match.endLine);
    applyHybridEvidence(candidate, match, "identifier");
    candidates.set(candidateId, candidate);

    const fileCandidateId = getFileCandidateId(match.path);
    const fileCandidate = candidates.get(fileCandidateId) ?? createCandidate(fileCandidateId, "file", match.path, match.path, "file", 1, 1);
    fileCandidate.identifierScore = Math.max(fileCandidate.identifierScore, normalizeEvidenceScore(match.score));
    fileCandidate.semanticScore = Math.max(fileCandidate.semanticScore, normalizeEvidenceScore(match.semanticScore));
    fileCandidate.lexicalScore = Math.max(fileCandidate.lexicalScore, normalizeEvidenceScore(match.lexicalScore));
    for (const term of match.matchedTerms) fileCandidate.matchedTerms.add(term);
    fileCandidate.supportingIdentifierIds.add(match.id);
    candidates.set(fileCandidateId, fileCandidate);
  }
  return identifierSearch.diagnostics;
}

// Purpose: Apply persisted structure evidence to every candidate accumulated so far.
// Inputs: Candidate map, query text, query terms, structure state, and retrieval mode.
// Returns/Effects: Mutates candidates in place with structure scores and module context.
function processStructureEvidence(
  candidates: Map<string, Candidate>,
  query: string,
  queryTerms: string[],
  structureState: PersistedStructureIndexState,
  retrievalMode: RetrievalMode
) {
  for (const candidate of candidates.values()) {
    if (candidate.entityType === "file") {
      const structure = computeStructureScoreForFile(
        query,
        queryTerms,
        candidate.path,
        structureState,
        candidate.chunkScore > 0 || candidate.identifierScore > 0,
        retrievalMode,
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
        query,
        queryTerms,
        matchingSymbolId ? structureState.symbols[matchingSymbolId] : undefined,
        fileEntry,
        candidate.chunkScore > 0 || candidate.identifierScore > 0,
        retrievalMode,
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
}

// Purpose: Build the canonical ranked-hit report from retrieval and structure evidence.
// Inputs: Unified ranking options describing the repo root, query, filters, and scoring weights.
// Returns/Effects: Returns ranked hits plus hybrid retrieval diagnostics.
export async function buildUnifiedSearchReport(options: UnifiedRankingOptions): Promise<UnifiedSearchReport> {
  await assertValidPreparedIndex({
    rootDir: options.rootDir,
    mode: "full",
    consumer: "search",
  });
  const rootDir = options.rootDir;
  const queryTerms = splitTerms(options.query);
  const topK = normalizeTopK(options.topK, 5);
  const entityTypes = new Set(options.entityTypes ?? ["file", "symbol"]);
  const retrievalMode = normalizeRetrievalMode(options.retrievalMode);
  const semanticWeight = retrievalMode === "keyword" ? 0 : options.semanticWeight;
  const lexicalWeight = retrievalMode === "semantic" ? 0 : options.lexicalWeight;
  const structureState = await loadStructureState(rootDir);
  const candidates = new Map<string, Candidate>();
  const [queryVector] = await fetchEmbedding(options.query);

  await processFileSearchEvidence(candidates, rootDir, options.query, queryTerms, topK, semanticWeight, lexicalWeight, queryVector);
  const chunkDiagnostics = await processChunkSearchEvidence(candidates, rootDir, options.query, topK, semanticWeight, lexicalWeight, queryVector);
  const identifierDiagnostics = await processIdentifierSearchEvidence(candidates, rootDir, options.query, topK, semanticWeight, lexicalWeight, queryVector);

  processStructureEvidence(candidates, options.query, queryTerms, structureState, retrievalMode);

  const normalizedKinds = options.includeKinds?.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const kindFilter = normalizedKinds && normalizedKinds.length > 0 ? new Set(normalizedKinds) : null;

  const hits = Array.from(candidates.values())
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
  return {
    hits,
    diagnostics: {
      retrievalMode,
      chunk: chunkDiagnostics,
      identifier: identifierDiagnostics,
    },
  };
}

export async function rankUnifiedSearch(options: UnifiedRankingOptions): Promise<UnifiedRankedHit[]> {
  return (await buildUnifiedSearchReport(options)).hits;
}
