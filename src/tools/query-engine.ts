// summary: Persists the layered explanation artifacts that back the prepared query engine.
// FEATURE: Layered query engine contract and explanation substrate.
// inputs: Ranked query candidates, structure evidence, and explanation generation settings.
// outputs: Agent-ready explanation cards and supporting query engine artifacts.

import { discoverHubs, parseHubFile } from "../core/hub.js";
import { loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import { type PersistedSemanticClusterState, type RelatedFileEdge, type SubsystemSummary } from "./cluster-artifacts.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION } from "./index-contract.js";
import { type PersistedHubSuggestionState } from "./hub-suggestions.js";

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

interface ModuleStructureArtifact {
  modulePath: string;
  filePaths: string[];
  symbolIds: string[];
  exportedSymbolIds: string[];
  localDependencyPaths: string[];
  externalDependencySources: string[];
  ownedFilePaths: string[];
}

interface PersistedStructureIndexState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  files: Record<string, {
    contentHash: string;
    dependencyHash: string;
    artifact: StructureArtifact;
  }>;
  symbols: Record<string, StructureSymbolRecord>;
  fileToSymbolIds: Record<string, string[]>;
  moduleSummaries: Record<string, ModuleStructureArtifact>;
  moduleImportEdges: Array<{
    fromModule: string;
    toModule: string;
    filePath: string;
    dependencyPath: string;
  }>;
}

export interface QueryLayerDescriptor {
  id: "layer-a-exact" | "layer-b-candidate" | "layer-c-explanation";
  label: string;
  role: string;
  tools: string[];
  artifactKeys: string[];
}

export interface QueryEngineContract {
  exact: QueryLayerDescriptor;
  candidate: QueryLayerDescriptor;
  explanation: QueryLayerDescriptor;
}

export interface RelatedContextCard {
  path: string;
  source: "cluster" | "dependency" | "reverse-dependency" | "module-peer";
  score: number;
  reason: string;
}

export interface FileExplanationCard {
  path: string;
  header: string;
  modulePath: string;
  purposeSummary: string;
  publicApiCard: string;
  dependencyNeighborhoodSummary: string;
  hotPathSummary: string;
  ownershipSummary: string;
  changeRiskNote: string;
  relatedContexts: RelatedContextCard[];
}

export interface ModuleExplanationCard {
  modulePath: string;
  filePaths: string[];
  purposeSummary: string;
  publicApiCard: string;
  dependencyNeighborhoodSummary: string;
  hotPathSummary: string;
  ownershipSummary: string;
  changeRiskNote: string;
}

export interface SubsystemExplanationCard {
  id: string;
  label: string;
  overview: string;
  rationale: string;
  pathPattern: string | null;
  filePaths: string[];
  modulePaths: string[];
}

export interface HubExplanationCard {
  id: string;
  kind: "manual" | "suggested";
  label: string;
  path: string;
  overview: string;
  rationale: string;
  linkedPaths: string[];
  modulePaths: string[];
  featureTags: string[];
}

export interface PersistedQueryExplanationState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  queryEngine: QueryEngineContract;
  fileCards: Record<string, FileExplanationCard>;
  moduleCards: Record<string, ModuleExplanationCard>;
  subsystemCards: Record<string, SubsystemExplanationCard>;
  hubCards: Record<string, HubExplanationCard>;
}

export interface QueryExplanationStats {
  fileCardCount: number;
  moduleCardCount: number;
  subsystemCardCount: number;
  hubCardCount: number;
}

function formatList(values: string[], maxItems: number = 3): string {
  if (values.length === 0) return "none";
  if (values.length <= maxItems) return values.join(", ");
  return `${values.slice(0, maxItems).join(", ")}, +${values.length - maxItems} more`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function buildQueryEngineContract(): QueryEngineContract {
  return {
    exact: {
      id: "layer-a-exact",
      label: "Layer A: exact deterministic substrate",
      role: "Serve exact symbol, word, outline, dependency, status, and change queries from the cheapest prepared state.",
      tools: ["symbol", "word", "outline", "deps", "status", "changes"],
      artifactKeys: ["file-search-index", "identifier-search-index", "code-structure-index"],
    },
    candidate: {
      id: "layer-b-candidate",
      label: "Layer B: candidate generation substrate",
      role: "Generate ranked file and symbol candidates from lexical, semantic, structural, cluster, and hub priors before explanation rendering.",
      tools: ["search", "research"],
      artifactKeys: ["file-search-index", "hybrid-chunk-index", "hybrid-identifier-index", "code-structure-index", "semantic-cluster-index", "hub-suggestion-index"],
    },
    explanation: {
      id: "layer-c-explanation",
      label: "Layer C: explanation substrate",
      role: "Serve precomputed file, module, subsystem, and hub explanations so broad research does not reconstruct high-level context on demand.",
      tools: ["research"],
      artifactKeys: ["query-explanation-index"],
    },
  };
}

async function loadStructureState(rootDir: string): Promise<PersistedStructureIndexState> {
  return loadIndexArtifact(rootDir, "code-structure-index", () => {
    throw new Error("code-structure-index is required to build query explanations.");
  });
}

async function loadClusterState(rootDir: string): Promise<PersistedSemanticClusterState> {
  return loadIndexArtifact(rootDir, "semantic-cluster-index", () => {
    throw new Error("semantic-cluster-index is required to build query explanations.");
  });
}

async function loadHubSuggestionState(rootDir: string): Promise<PersistedHubSuggestionState> {
  return loadIndexArtifact(rootDir, "hub-suggestion-index", () => {
    throw new Error("hub-suggestion-index is required to build query explanations.");
  });
}

export async function loadQueryExplanationState(rootDir: string): Promise<PersistedQueryExplanationState> {
  return loadIndexArtifact(rootDir, "query-explanation-index", () => {
    throw new Error("query-explanation-index is required for explanation-backed research.");
  });
}

function buildReverseDependencies(structureState: PersistedStructureIndexState): Map<string, string[]> {
  const reverseDependencies = new Map<string, string[]>();
  for (const [filePath, entry] of Object.entries(structureState.files)) {
    for (const dependencyPath of entry.artifact.dependencyPaths) {
      const current = reverseDependencies.get(dependencyPath) ?? [];
      if (!current.includes(filePath)) current.push(filePath);
      reverseDependencies.set(dependencyPath, current);
    }
  }
  for (const values of reverseDependencies.values()) values.sort();
  return reverseDependencies;
}

function buildModulePeers(structureState: PersistedStructureIndexState): Map<string, string[]> {
  const peers = new Map<string, string[]>();
  for (const [filePath, entry] of Object.entries(structureState.files)) {
    const moduleFiles = structureState.moduleSummaries[entry.artifact.modulePath]?.filePaths ?? [];
    peers.set(filePath, moduleFiles.filter((candidate) => candidate !== filePath).sort());
  }
  return peers;
}

function buildPublicApiCard(artifact: StructureArtifact): string {
  if (artifact.exports.length === 0) return "Public API: no exported symbols.";
  const entries = artifact.exports.map((entry) => `${entry.name} (${entry.kind})`);
  return `Public API: ${formatList(entries, 4)}.`;
}

function buildDependencyNeighborhoodSummary(
  artifact: StructureArtifact,
  reverseDependencies: string[],
): string {
  const directDependencies = artifact.dependencyPaths;
  return [
    `Dependency neighborhood: depends on ${formatList(directDependencies)}.`,
    `Imported by ${formatList(reverseDependencies)}.`,
  ].join(" ");
}

function buildHotPathSummary(artifact: StructureArtifact, reverseDependencies: string[]): string {
  if (reverseDependencies.length > 0) {
    return `Hot path: imported by ${reverseDependencies.length} file(s), led by ${formatList(reverseDependencies)}.`;
  }
  if (artifact.calls.length > 0) {
    const callees = Array.from(new Set(artifact.calls.map((call) => call.callee))).sort();
    return `Hot path: calls ${formatList(callees, 4)} from ${artifact.symbols.length} symbol(s).`;
  }
  return `Hot path: isolated to module ${artifact.modulePath} with no downstream imports yet.`;
}

function buildOwnershipSummary(artifact: StructureArtifact): string {
  return `Ownership: module ${artifact.modulePath} owns this file and ${artifact.symbols.length} symbol(s).`;
}

function buildChangeRiskNote(artifact: StructureArtifact, reverseDependencies: string[]): string {
  const exportCount = artifact.exports.length;
  const dependencyCount = artifact.dependencyPaths.length;
  const reverseCount = reverseDependencies.length;
  const risk = reverseCount >= 3 || exportCount >= 3 || dependencyCount >= 5
    ? "high"
    : reverseCount > 0 || exportCount > 0 || dependencyCount >= 3
      ? "medium"
      : "low";
  return `Change risk: ${risk}; exports=${exportCount}, direct dependencies=${dependencyCount}, reverse dependencies=${reverseCount}.`;
}

function dedupeRelatedContexts(cards: RelatedContextCard[]): RelatedContextCard[] {
  const related = new Map<string, RelatedContextCard>();
  for (const card of cards) {
    const current = related.get(card.path);
    if (!current || card.score > current.score) related.set(card.path, card);
  }
  return Array.from(related.values())
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 8);
}

function buildFileRelatedContexts(
  filePath: string,
  clusterEdges: RelatedFileEdge[],
  dependencyPaths: string[],
  reverseDependencies: string[],
  modulePeers: string[],
): RelatedContextCard[] {
  return dedupeRelatedContexts([
    ...clusterEdges.map((edge) => ({
      path: edge.path,
      source: "cluster" as const,
      score: clamp01(edge.score),
      reason: edge.reason,
    })),
    ...dependencyPaths.map((dependencyPath) => ({
      path: dependencyPath,
      source: "dependency" as const,
      score: 0.72,
      reason: `Imported by ${filePath}`,
    })),
    ...reverseDependencies.map((dependencyPath) => ({
      path: dependencyPath,
      source: "reverse-dependency" as const,
      score: 0.78,
      reason: `${dependencyPath} imports ${filePath}`,
    })),
    ...modulePeers.map((peerPath) => ({
      path: peerPath,
      source: "module-peer" as const,
      score: 0.58,
      reason: `Shares module ${filePath.split("/").slice(0, -1).join("/") || "."}`,
    })),
  ]);
}

function buildModulePurposeSummary(
  modulePath: string,
  moduleSummary: ModuleStructureArtifact,
  structureState: PersistedStructureIndexState,
): string {
  const headers = moduleSummary.filePaths
    .map((filePath) => structureState.files[filePath]?.artifact.header)
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);
  if (headers.length === 0) {
    return `Module ${modulePath} groups ${moduleSummary.filePaths.length} file(s).`;
  }
  return `Module ${modulePath} groups ${moduleSummary.filePaths.length} file(s) around ${headers.join(" / ")}.`;
}

function buildModulePublicApiCard(
  moduleSummary: ModuleStructureArtifact,
  structureState: PersistedStructureIndexState,
): string {
  const exportedSymbols = moduleSummary.exportedSymbolIds
    .map((symbolId) => structureState.symbols[symbolId])
    .filter((value): value is StructureSymbolRecord => Boolean(value))
    .map((symbol) => `${symbol.name} (${symbol.kind})`);
  if (exportedSymbols.length === 0) return "Public API: no exported module symbols.";
  return `Public API: ${formatList(exportedSymbols, 5)}.`;
}

function buildModuleDependencyNeighborhoodSummary(
  modulePath: string,
  moduleSummary: ModuleStructureArtifact,
  structureState: PersistedStructureIndexState,
): string {
  const outgoing = structureState.moduleImportEdges
    .filter((edge) => edge.fromModule === modulePath)
    .map((edge) => edge.toModule)
    .filter((value) => value !== modulePath);
  const incoming = structureState.moduleImportEdges
    .filter((edge) => edge.toModule === modulePath)
    .map((edge) => edge.fromModule)
    .filter((value) => value !== modulePath);
  return [
    `Dependency neighborhood: imports modules ${formatList(Array.from(new Set(outgoing)).sort())}.`,
    `Imported by modules ${formatList(Array.from(new Set(incoming)).sort())}.`,
    `Local file dependencies: ${formatList(moduleSummary.localDependencyPaths, 4)}.`,
  ].join(" ");
}

function buildModuleHotPathSummary(modulePath: string, structureState: PersistedStructureIndexState): string {
  const incoming = structureState.moduleImportEdges.filter((edge) => edge.toModule === modulePath).length;
  const outgoing = structureState.moduleImportEdges.filter((edge) => edge.fromModule === modulePath).length;
  if (incoming > 0) {
    return `Hot path: ${modulePath} is a shared dependency for ${incoming} cross-module import edge(s).`;
  }
  if (outgoing > 0) {
    return `Hot path: ${modulePath} fans out across ${outgoing} cross-module import edge(s).`;
  }
  return `Hot path: ${modulePath} is currently self-contained.`;
}

function buildModuleOwnershipSummary(moduleSummary: ModuleStructureArtifact): string {
  return `Ownership: owns ${moduleSummary.filePaths.length} file(s) and ${moduleSummary.symbolIds.length} symbol(s).`;
}

function buildModuleChangeRiskNote(moduleSummary: ModuleStructureArtifact, structureState: PersistedStructureIndexState): string {
  const incoming = structureState.moduleImportEdges.filter((edge) => edge.toModule === moduleSummary.modulePath).length;
  const risk = incoming >= 3 || moduleSummary.exportedSymbolIds.length >= 4 || moduleSummary.filePaths.length >= 5
    ? "high"
    : incoming > 0 || moduleSummary.exportedSymbolIds.length > 0 || moduleSummary.filePaths.length >= 3
      ? "medium"
      : "low";
  return `Change risk: ${risk}; files=${moduleSummary.filePaths.length}, exported symbols=${moduleSummary.exportedSymbolIds.length}, incoming module imports=${incoming}.`;
}

function buildSubsystemCard(
  subsystem: SubsystemSummary,
  structureState: PersistedStructureIndexState,
): SubsystemExplanationCard {
  const modulePaths = Array.from(new Set(
    subsystem.filePaths
      .map((filePath) => structureState.files[filePath]?.artifact.modulePath)
      .filter((value): value is string => Boolean(value)),
  )).sort();
  return {
    id: subsystem.id,
    label: subsystem.label,
    overview: subsystem.overarchingTheme,
    rationale: subsystem.distinguishingFeature,
    pathPattern: subsystem.pathPattern,
    filePaths: subsystem.filePaths.slice(),
    modulePaths,
  };
}

async function buildManualHubCards(rootDir: string, structureState: PersistedStructureIndexState): Promise<Record<string, HubExplanationCard>> {
  const cards: Record<string, HubExplanationCard> = {};
  const hubs = await discoverHubs(rootDir);
  for (const hubPath of hubs) {
    if (hubPath.startsWith(".contextplus/hubs/suggested/")) continue;
    const hub = await parseHubFile(`${rootDir}/${hubPath}`);
    const linkedPaths = hub.links.map((link) => link.target);
    const modulePaths = Array.from(new Set(
      linkedPaths
        .map((filePath) => structureState.files[filePath]?.artifact.modulePath)
        .filter((value): value is string => Boolean(value)),
    )).sort();
    cards[`manual:${hubPath}`] = {
      id: `manual:${hubPath}`,
      kind: "manual",
      label: hub.title,
      path: hubPath,
      overview: `Manual hub ${hub.title} links ${linkedPaths.length} file(s).`,
      rationale: modulePaths.length > 0
        ? `Covers modules ${formatList(modulePaths)} through linked files.`
        : "Covers linked files without matching prepared modules.",
      linkedPaths: linkedPaths.slice(0, 8),
      modulePaths,
      featureTags: [],
    };
  }
  return cards;
}

function buildSuggestedHubCards(
  structureState: PersistedStructureIndexState,
  hubSuggestionState: PersistedHubSuggestionState,
): Record<string, HubExplanationCard> {
  const cards: Record<string, HubExplanationCard> = {};
  for (const suggestion of Object.values(hubSuggestionState.suggestions)) {
    cards[`suggested:${suggestion.id}`] = {
      id: `suggested:${suggestion.id}`,
      kind: "suggested",
      label: suggestion.label,
      path: suggestion.markdownPath,
      overview: suggestion.summary,
      rationale: suggestion.rationale,
      linkedPaths: suggestion.filePaths.slice(0, 8),
      modulePaths: suggestion.modulePaths.length > 0
        ? suggestion.modulePaths.slice()
        : Array.from(new Set(
          suggestion.filePaths
            .map((filePath) => structureState.files[filePath]?.artifact.modulePath)
            .filter((value): value is string => Boolean(value)),
        )).sort(),
      featureTags: suggestion.featureTags.slice(),
    };
  }
  return cards;
}

export async function refreshQueryExplanationState(
  rootDir: string,
): Promise<{ state: PersistedQueryExplanationState; stats: QueryExplanationStats }> {
  const [structureState, clusterState, hubSuggestionState] = await Promise.all([
    loadStructureState(rootDir),
    loadClusterState(rootDir),
    loadHubSuggestionState(rootDir),
  ]);
  const reverseDependencies = buildReverseDependencies(structureState);
  const modulePeers = buildModulePeers(structureState);
  const fileCards: Record<string, FileExplanationCard> = {};

  for (const [filePath, entry] of Object.entries(structureState.files)) {
    const artifact = entry.artifact;
    const reverse = reverseDependencies.get(filePath) ?? [];
    fileCards[filePath] = {
      path: filePath,
      header: artifact.header,
      modulePath: artifact.modulePath,
      purposeSummary: `Purpose: ${artifact.header} Lives in module ${artifact.modulePath}.`,
      publicApiCard: buildPublicApiCard(artifact),
      dependencyNeighborhoodSummary: buildDependencyNeighborhoodSummary(artifact, reverse),
      hotPathSummary: buildHotPathSummary(artifact, reverse),
      ownershipSummary: buildOwnershipSummary(artifact),
      changeRiskNote: buildChangeRiskNote(artifact, reverse),
      relatedContexts: buildFileRelatedContexts(
        filePath,
        clusterState.relatedFiles[filePath] ?? [],
        artifact.dependencyPaths,
        reverse,
        modulePeers.get(filePath) ?? [],
      ),
    };
  }

  const moduleCards: Record<string, ModuleExplanationCard> = {};
  for (const [modulePath, moduleSummary] of Object.entries(structureState.moduleSummaries)) {
    moduleCards[modulePath] = {
      modulePath,
      filePaths: moduleSummary.filePaths.slice(),
      purposeSummary: buildModulePurposeSummary(modulePath, moduleSummary, structureState),
      publicApiCard: buildModulePublicApiCard(moduleSummary, structureState),
      dependencyNeighborhoodSummary: buildModuleDependencyNeighborhoodSummary(modulePath, moduleSummary, structureState),
      hotPathSummary: buildModuleHotPathSummary(modulePath, structureState),
      ownershipSummary: buildModuleOwnershipSummary(moduleSummary),
      changeRiskNote: buildModuleChangeRiskNote(moduleSummary, structureState),
    };
  }

  const subsystemCards = Object.fromEntries(
    Object.values(clusterState.subsystemSummaries).map((summary) => [summary.id, buildSubsystemCard(summary, structureState)]),
  );
  const manualHubCards = await buildManualHubCards(rootDir, structureState);
  const suggestedHubCards = buildSuggestedHubCards(structureState, hubSuggestionState);
  const hubCards = {
    ...manualHubCards,
    ...suggestedHubCards,
  };

  const state: PersistedQueryExplanationState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    queryEngine: buildQueryEngineContract(),
    fileCards,
    moduleCards,
    subsystemCards,
    hubCards,
  };
  await saveIndexArtifact(rootDir, "query-explanation-index", state);
  return {
    state,
    stats: {
      fileCardCount: Object.keys(fileCards).length,
      moduleCardCount: Object.keys(moduleCards).length,
      subsystemCardCount: Object.keys(subsystemCards).length,
      hubCardCount: Object.keys(hubCards).length,
    },
  };
}
