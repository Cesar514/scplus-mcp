// summary: Generates automatic hub suggestions and feature-group candidates from full-index evidence.
// FEATURE: Suggested feature hubs and higher-level maps generated from clusters and structure.
// inputs: Cluster artifacts, structure graphs, feature tags, and repository paths.
// outputs: Suggested hub markdown, feature-group candidates, and hub ranking metadata.

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { extractFeatureTag, formatHubLink } from "../core/hub.js";
import { loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import { ensureScplusLayout } from "../core/project-layout.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION } from "./index-contract.js";

interface PersistedStructureIndexState {
  files: Record<string, {
    artifact: {
      path: string;
      header: string;
      modulePath: string;
      dependencyPaths: string[];
    };
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

interface PersistedSemanticClusterState {
  root: SemanticClusterArtifactNode;
  relatedFiles: Record<string, RelatedFileEdge[]>;
  subsystemSummaries: Record<string, SubsystemSummary>;
}

interface SemanticClusterArtifactNode {
  id: string;
  label: string;
  pathPattern: string | null;
  summary: string;
  filePaths: string[];
  children: SemanticClusterArtifactNode[];
}

interface RelatedFileEdge {
  path: string;
  score: number;
  reason: string;
}

interface SubsystemSummary {
  id: string;
  label: string;
  overarchingTheme: string;
  distinguishingFeature: string;
  pathPattern: string | null;
  fileCount: number;
  filePaths: string[];
}

export interface HubSuggestion {
  id: string;
  label: string;
  slug: string;
  summary: string;
  rationale: string;
  pathPattern: string | null;
  filePaths: string[];
  modulePaths: string[];
  featureTags: string[];
  linkedSuggestionIds: string[];
  backingSubsystemId: string | null;
  markdownPath: string;
}

export interface FeatureGroupCandidate {
  id: string;
  label: string;
  featureTag: string;
  filePaths: string[];
  modulePaths: string[];
  suggestionIds: string[];
}

export interface PersistedHubSuggestionState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  suggestions: Record<string, HubSuggestion>;
  featureGroups: Record<string, FeatureGroupCandidate>;
}

export interface HubSuggestionStats {
  suggestionCount: number;
  featureGroupCount: number;
  generatedMarkdownCount: number;
}

// Purpose: Convert a label or feature tag into a stable markdown-safe slug.
// Inputs: Arbitrary display text such as a feature label or subsystem name.
// Returns/Effects: Returns a lowercase dash-separated slug limited to 64 characters.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

// Purpose: Count and rank repeated feature tags collected from subsystem files.
// Inputs: The raw feature tags extracted from files within one subsystem.
// Returns/Effects: Returns tags sorted by descending count and then alphabetically.
function rankFeatureTags(tags: string[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tag of tags) {
    if (!tag || tag.toLowerCase() === "none") continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

// Purpose: Choose the display label for a suggested hub from subsystem and tag evidence.
// Inputs: The subsystem summary and ranked feature-tag counts for its files.
// Returns/Effects: Returns either the preferred tag label or the subsystem label.
function chooseLabel(subsystem: SubsystemSummary, rankedTags: Array<{ tag: string; count: number }>): string {
  const preferred = rankedTags[0];
  if (!preferred) return subsystem.label;
  if (preferred.count >= 2 || preferred.count === subsystem.filePaths.length) return preferred.tag;
  return subsystem.label;
}

// Purpose: Collect semantic cluster ids that overlap with a target file set.
// Inputs: The current cluster node, target file paths, and the mutable result set.
// Returns/Effects: Adds matching cluster ids into the provided `found` set.
function collectClusterIds(node: SemanticClusterArtifactNode, targetPaths: Set<string>, found: Set<string>): void {
  const overlap = node.filePaths.some((filePath) => targetPaths.has(filePath));
  if (!overlap) return;
  if (node.id) found.add(node.id);
  for (const child of node.children) collectClusterIds(child, targetPaths, found);
}

// Purpose: Read and extract the feature tag from a source file if one exists.
// Inputs: The repo root and relative file path whose content may contain a feature tag.
// Returns/Effects: Returns the extracted feature tag or null when unavailable.
async function readFeatureTag(rootDir: string, relativePath: string): Promise<string | null> {
  try {
    const content = await readFile(resolve(rootDir, relativePath), "utf8");
    return extractFeatureTag(content);
  } catch {
    return null;
  }
}

// Purpose: Load the persisted structure artifact state required for hub suggestion generation.
// Inputs: The repo root whose `code-structure-index` artifact should be read.
// Returns/Effects: Returns the persisted structure index state or an empty baseline.
async function loadStructureState(rootDir: string): Promise<PersistedStructureIndexState> {
  return loadIndexArtifact(rootDir, "code-structure-index", () => ({
    files: {},
    moduleSummaries: {},
    moduleImportEdges: [],
  }));
}

// Purpose: Load the persisted semantic cluster state required for hub suggestion generation.
// Inputs: The repo root whose `semantic-cluster-index` artifact should be read.
// Returns/Effects: Returns the persisted cluster state or an empty baseline.
async function loadClusterState(rootDir: string): Promise<PersistedSemanticClusterState> {
  return loadIndexArtifact(rootDir, "semantic-cluster-index", () => ({
    root: { id: "cluster-empty", label: "Empty", pathPattern: null, summary: "", filePaths: [], children: [] },
    relatedFiles: {},
    subsystemSummaries: {},
  }));
}

// Purpose: Load the persisted hub suggestion state from the full artifact store.
// Inputs: The repo root whose `hub-suggestion-index` artifact should be read.
// Returns/Effects: Returns the current persisted hub suggestions or an empty baseline.
export async function loadHubSuggestionState(rootDir: string): Promise<PersistedHubSuggestionState> {
  return loadIndexArtifact(rootDir, "hub-suggestion-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    suggestions: {},
    featureGroups: {},
  }));
}

// Purpose: Write one suggested hub markdown file with linked suggestions and file links.
// Inputs: The repo root, the suggestion to render, and related suggestions to cross-link.
// Returns/Effects: Creates or overwrites the suggestion markdown file on disk.
async function writeSuggestionMarkdown(rootDir: string, suggestion: HubSuggestion, linkedSuggestions: HubSuggestion[]): Promise<void> {
  const fullPath = resolve(rootDir, suggestion.markdownPath);
  await mkdir(dirname(fullPath), { recursive: true });
  const lines = [
    `# ${suggestion.label}`,
    "",
    suggestion.summary,
    "",
    `Suggested hub generated from persisted full-index artifacts.`,
    "",
    `- Rationale: ${suggestion.rationale}`,
    `- Modules: ${suggestion.modulePaths.join(", ") || "(none)"}`,
    `- Feature tags: ${suggestion.featureTags.join(", ") || "(none)"}`,
    "",
  ];
  for (const linked of linkedSuggestions) {
    lines.push(`@linked-to [[${linked.label}]]`);
  }
  if (linkedSuggestions.length > 0) lines.push("");
  for (const filePath of suggestion.filePaths) {
    lines.push(formatHubLink(filePath, `Suggested because it anchors ${suggestion.label}`));
  }
  lines.push("");
  await writeFile(fullPath, lines.join("\n"), "utf8");
}

// Purpose: Group hub suggestions by their target markdown file path before writing.
// Inputs: The ordered list of generated hub suggestions.
// Returns/Effects: Returns suggestion buckets keyed by shared markdown output path.
function groupSuggestionsByMarkdownPath(suggestionOrder: HubSuggestion[]): HubSuggestion[][] {
  const buckets = new Map<string, HubSuggestion[]>();
  for (const suggestion of suggestionOrder) {
    const existing = buckets.get(suggestion.markdownPath);
    if (existing) {
      existing.push(suggestion);
      continue;
    }
    buckets.set(suggestion.markdownPath, [suggestion]);
  }
  return Array.from(buckets.values());
}

// Purpose: Count related-file edges that connect one suggestion to another.
// Inputs: Related-file edges, the current suggestion file paths, and the candidate file set.
// Returns/Effects: Returns the number of cross-suggestion related-file matches.
function countSuggestionLinks(
  relatedFiles: Record<string, RelatedFileEdge[]>,
  leftPaths: string[],
  rightPathSet: Set<string>,
): number {
  let matches = 0;
  for (const filePath of leftPaths) {
    for (const edge of relatedFiles[filePath] ?? []) {
      if (rightPathSet.has(edge.path)) matches++;
    }
  }
  return matches;
}

// Purpose: Regenerate suggested hubs and feature groups from persisted structure and cluster evidence.
// Inputs: The repo root whose full-mode artifacts should drive suggestion generation.
// Returns/Effects: Rewrites suggestion markdown, persists suggestion state, and returns summary stats.
export async function refreshHubSuggestionState(rootDir: string): Promise<{ state: PersistedHubSuggestionState; stats: HubSuggestionStats }> {
  const layout = await ensureScplusLayout(rootDir);
  const structureState = await loadStructureState(rootDir);
  const clusterState = await loadClusterState(rootDir);
  const suggestionsDir = join(layout.hubs, "suggested");
  await rm(suggestionsDir, { recursive: true, force: true });

  const suggestions: Record<string, HubSuggestion> = {};
  const suggestionOrder: HubSuggestion[] = [];
  const featureGroupMap = new Map<string, FeatureGroupCandidate>();

  const subsystems = Object.values(clusterState.subsystemSummaries).sort((left, right) => right.fileCount - left.fileCount);
  for (const subsystem of subsystems) {
    const codeFilePaths = subsystem.filePaths
      .filter((filePath) => Boolean(structureState.files[filePath]?.artifact))
      .sort();
    if (codeFilePaths.length === 0) continue;
    const rawFeatureTags = (await Promise.all(
      codeFilePaths.map((filePath) => readFeatureTag(rootDir, filePath)),
    )).filter((value): value is string => Boolean(value));
    const rankedFeatureTags = rankFeatureTags(rawFeatureTags);
    const featureTags = rankedFeatureTags.slice(0, 3).map((entry) => entry.tag);
    const codeScopedSubsystem: SubsystemSummary = { ...subsystem, filePaths: codeFilePaths };
    const label = chooseLabel(codeScopedSubsystem, rankedFeatureTags);
    const slug = slugify(label || subsystem.id);
    const modulePaths = Array.from(new Set(codeFilePaths.map((filePath) => structureState.files[filePath]?.artifact?.modulePath).filter((value): value is string => Boolean(value)))).sort();
    const rationaleParts = [
      subsystem.overarchingTheme,
      subsystem.distinguishingFeature,
      modulePaths.length > 0 ? `Touches modules ${modulePaths.join(", ")}.` : "",
      featureTags.length > 0 ? `Tagged with ${featureTags.join(", ")}.` : "",
    ].filter(Boolean);
    const suggestion: HubSuggestion = {
      id: subsystem.id,
      label,
      slug,
      summary: `${subsystem.overarchingTheme} ${subsystem.distinguishingFeature}`.trim(),
      rationale: rationaleParts.join(" "),
      pathPattern: subsystem.pathPattern,
      filePaths: codeFilePaths,
      modulePaths,
      featureTags,
      linkedSuggestionIds: [],
      backingSubsystemId: subsystem.id,
      markdownPath: normalizePath(join(".scplus", "hubs", "suggested", `${slug}.md`)),
    };
    suggestions[suggestion.id] = suggestion;
    suggestionOrder.push(suggestion);

    for (const featureTag of featureTags) {
      const groupId = slugify(featureTag);
      const featureCount = rankedFeatureTags.find((entry) => entry.tag === featureTag)?.count ?? 0;
      if (featureCount < 2 && featureTag !== label) continue;
      const existing = featureGroupMap.get(groupId) ?? {
        id: groupId,
        label: `${featureTag} Group`,
        featureTag,
        filePaths: [],
        modulePaths: [],
        suggestionIds: [],
      };
      existing.filePaths.push(...suggestion.filePaths);
      existing.modulePaths.push(...suggestion.modulePaths);
      existing.suggestionIds.push(suggestion.id);
      featureGroupMap.set(groupId, existing);
    }
  }

  for (let index = 0; index < suggestionOrder.length; index++) {
    const current = suggestionOrder[index];
    const currentPaths = new Set(current.filePaths);
    const links: string[] = [];
    for (let compareIndex = 0; compareIndex < suggestionOrder.length; compareIndex++) {
      if (index === compareIndex) continue;
      const candidate = suggestionOrder[compareIndex];
      const overlap = countSuggestionLinks(clusterState.relatedFiles, current.filePaths, new Set(candidate.filePaths));
      if (overlap > 0) links.push(candidate.id);
    }
    current.linkedSuggestionIds = Array.from(new Set(links)).slice(0, 4);

    const clusterIds = new Set<string>();
    collectClusterIds(clusterState.root, currentPaths, clusterIds);
    if (clusterIds.size > 0 && !current.rationale.includes("semantic clusters")) {
      current.rationale = `${current.rationale} Backed by semantic clusters ${Array.from(clusterIds).slice(0, 3).join(", ")}.`.trim();
    }
  }

  const featureGroups: Record<string, FeatureGroupCandidate> = {};
  for (const [groupId, group] of featureGroupMap) {
    featureGroups[groupId] = {
      ...group,
      filePaths: Array.from(new Set(group.filePaths)).sort(),
      modulePaths: Array.from(new Set(group.modulePaths)).sort(),
      suggestionIds: Array.from(new Set(group.suggestionIds)).sort(),
    };
  }

  if (suggestionOrder.length > 0) {
    await mkdir(suggestionsDir, { recursive: true });
    await Promise.all(
      groupSuggestionsByMarkdownPath(suggestionOrder).map(async (bucket) => {
        for (const suggestion of bucket) {
          const linkedSuggestions = suggestion.linkedSuggestionIds
            .map((suggestionId) => suggestions[suggestionId])
            .filter((value): value is HubSuggestion => Boolean(value));
          await writeSuggestionMarkdown(rootDir, suggestion, linkedSuggestions);
        }
      }),
    );
  }

  const state: PersistedHubSuggestionState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    suggestions,
    featureGroups,
  };
  await saveIndexArtifact(rootDir, "hub-suggestion-index", state);

  return {
    state,
    stats: {
      suggestionCount: Object.keys(suggestions).length,
      featureGroupCount: Object.keys(featureGroups).length,
      generatedMarkdownCount: suggestionOrder.length,
    },
  };
}
