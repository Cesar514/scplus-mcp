// summary: Persists semantic clusters, related-file graphs, and subsystem summaries in full mode.
// FEATURE: SQLite-backed semantic clusters, labels, related files, and subsystem summaries.
// inputs: Ranked retrieval artifacts, structure evidence, and cluster generation settings.
// outputs: Durable cluster trees, related-file graphs, labels, and subsystem summaries.

import { extname } from "path";
import { fetchEmbedding } from "../core/embeddings.js";
import { clusterVectors, findPathPattern } from "../core/clustering.js";
import { loadIndexArtifact, saveIndexArtifact } from "../core/index-database.js";
import { buildIndexContract, INDEX_ARTIFACT_VERSION } from "./index-contract.js";

interface SymbolEntry {
  name: string;
  kind?: string;
  line: number;
  endLine?: number;
  signature?: string;
}

interface SearchDocument {
  path: string;
  header: string;
  symbols: string[];
  symbolEntries?: SymbolEntry[];
  content: string;
}

interface PersistedFileSearchState {
  generatedAt: string;
  files: Record<string, { contentHash: string; doc: SearchDocument }>;
}

export interface SemanticClusterArtifactNode {
  id: string;
  label: string;
  pathPattern: string | null;
  summary: string;
  filePaths: string[];
  children: SemanticClusterArtifactNode[];
}

export interface RelatedFileEdge {
  path: string;
  score: number;
  reason: string;
}

export interface SubsystemSummary {
  id: string;
  label: string;
  overarchingTheme: string;
  distinguishingFeature: string;
  pathPattern: string | null;
  fileCount: number;
  filePaths: string[];
}

export interface PersistedSemanticClusterState {
  generatedAt: string;
  artifactVersion: number;
  contractVersion: number;
  mode: "full";
  clusterCount: number;
  root: SemanticClusterArtifactNode;
  relatedFiles: Record<string, RelatedFileEdge[]>;
  subsystemSummaries: Record<string, SubsystemSummary>;
}

export interface SemanticClusterStats {
  indexedFiles: number;
  clusterCount: number;
  relatedFileCount: number;
  subsystemCount: number;
}

export interface SemanticClusterRenderOptions {
  maxDepth?: number;
  maxClusters?: number;
}

interface FileInfo {
  relativePath: string;
  header: string;
  content: string;
  symbolPreview: string[];
}

interface ClusterDescriptor {
  label: string;
  overarchingTheme: string;
  distinguishingFeature: string;
}

const MAX_FILES_PER_LEAF = 20;
const MAX_RELATED_FILES = 3;
const MIN_RELATED_SCORE = 0.35;
const NON_CODE_NAVIGATE_EXTENSIONS = new Set([
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

function isNavigableSourcePath(filePath: string): boolean {
  return !NON_CODE_NAVIGATE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function summarizeFiles(files: FileInfo[]): string {
  const pathPattern = findPathPattern(files.map((file) => file.relativePath));
  const filesLabel = pathPattern ?? files[0]?.relativePath ?? "files";
  return `${files.length} files around ${filesLabel}`;
}

function deriveClusterDescriptor(files: FileInfo[], pathPattern: string | null, index: number): ClusterDescriptor {
  const samplePath = pathPattern ?? files[0]?.relativePath ?? `cluster-${index + 1}`;
  const dominantSegment = samplePath.split("/").find(Boolean) ?? `cluster-${index + 1}`;
  const label = dominantSegment
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .slice(0, 2)
    .join(" ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
  return {
    label: label || `Cluster ${index + 1}`,
    overarchingTheme: `Files centered on ${samplePath}.`,
    distinguishingFeature: files[0]?.header || summarizeFiles(files),
  };
}

async function describeClusters(clusters: { files: FileInfo[]; pathPattern: string | null }[]): Promise<ClusterDescriptor[]> {
  if (clusters.length === 0) return [];
  return clusters.map((cluster, index) => deriveClusterDescriptor(cluster.files, cluster.pathPattern, index));
}

function buildFileInfoList(state: PersistedFileSearchState): FileInfo[] {
  return Object.values(state.files)
    .map((entry) => entry.doc)
    .filter((doc) => isNavigableSourcePath(doc.path))
    .map((doc) => ({
      relativePath: doc.path,
      header: doc.header,
      content: doc.content.slice(0, 500),
      symbolPreview: (doc.symbolEntries ?? []).slice(0, 3).map((symbol) => `${symbol.name}@L${symbol.line}`),
    }));
}

function groupFilesByModule(files: FileInfo[]): FileInfo[][] {
  const groups = new Map<string, FileInfo[]>();
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const groupKey = segments.length > 1 ? `${segments[0]}/${segments[1]}` : segments[0];
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)?.push(file);
  }
  return Array.from(groups.values()).filter((group) => group.length > 0);
}

async function buildHierarchy(files: FileInfo[], vectors: number[][], maxClusters: number, depth: number, maxDepth: number): Promise<SemanticClusterArtifactNode> {
  if (files.length === 0) {
    return {
      id: `cluster-${depth}-empty`,
      label: "Empty Cluster",
      pathPattern: null,
      summary: "No files assigned.",
      filePaths: [],
      children: [],
    };
  }

  if (depth >= maxDepth || files.length <= MAX_FILES_PER_LEAF) {
    const grouped = depth === 0 ? groupFilesByModule(files).filter((group) => group.length < files.length) : [];
    if (grouped.length > 1) {
      const children = await Promise.all(grouped.map(async (group, index) => {
        const pathPattern = findPathPattern(group.map((file) => file.relativePath));
        const descriptor = deriveClusterDescriptor(group, pathPattern, index);
        return {
          id: `cluster-${depth + 1}-${index}`,
          label: descriptor.label,
          pathPattern,
          summary: descriptor.overarchingTheme,
          filePaths: group.map((file) => file.relativePath),
          children: [],
        } satisfies SemanticClusterArtifactNode;
      }));
      return {
        id: `cluster-${depth}-root`,
        label: depth === 0 ? "Project" : "Cluster",
        pathPattern: findPathPattern(files.map((file) => file.relativePath)),
        summary: summarizeFiles(files),
        filePaths: files.map((file) => file.relativePath),
        children,
      };
    }

    return {
      id: `cluster-${depth}-leaf`,
      label: depth === 0 ? "Project" : "Cluster",
      pathPattern: findPathPattern(files.map((file) => file.relativePath)),
      summary: summarizeFiles(files),
      filePaths: files.map((file) => file.relativePath),
      children: [],
    };
  }

  const clusterResults = clusterVectors(vectors, maxClusters);
  if (clusterResults.length <= 1) {
    return {
      id: `cluster-${depth}-leaf`,
      label: depth === 0 ? "Project" : "Cluster",
      pathPattern: findPathPattern(files.map((file) => file.relativePath)),
      summary: summarizeFiles(files),
      filePaths: files.map((file) => file.relativePath),
      children: [],
    };
  }

  const childMetas = clusterResults.map((cluster) => ({
    files: cluster.indices.map((index) => files[index]),
    vectors: cluster.indices.map((index) => vectors[index]),
    pathPattern: findPathPattern(cluster.indices.map((index) => files[index].relativePath)),
  }));
  const descriptors = await describeClusters(childMetas.map((meta) => ({ files: meta.files, pathPattern: meta.pathPattern })));
  const children: SemanticClusterArtifactNode[] = [];
  for (let index = 0; index < childMetas.length; index++) {
    const child = await buildHierarchy(childMetas[index].files, childMetas[index].vectors, maxClusters, depth + 1, maxDepth);
    child.id = `cluster-${depth + 1}-${index}`;
    child.label = descriptors[index]?.label || child.label;
    child.summary = `${descriptors[index]?.overarchingTheme || child.summary} ${descriptors[index]?.distinguishingFeature || ""}`.trim();
    child.pathPattern = childMetas[index].pathPattern;
    children.push(child);
  }

  return {
    id: depth === 0 ? "cluster-root" : `cluster-${depth}`,
    label: depth === 0 ? "Project" : "Cluster",
    pathPattern: findPathPattern(files.map((file) => file.relativePath)),
    summary: summarizeFiles(files),
    filePaths: files.map((file) => file.relativePath),
    children,
  };
}

function flattenClusters(node: SemanticClusterArtifactNode, acc: SemanticClusterArtifactNode[] = []): SemanticClusterArtifactNode[] {
  acc.push(node);
  for (const child of node.children) flattenClusters(child, acc);
  return acc;
}

function buildSubsystemSummaries(node: SemanticClusterArtifactNode): Record<string, SubsystemSummary> {
  const summaries: Record<string, SubsystemSummary> = {};
  for (const cluster of flattenClusters(node)) {
    if (cluster.id === "cluster-root") continue;
    summaries[cluster.id] = {
      id: cluster.id,
      label: cluster.label,
      overarchingTheme: cluster.summary,
      distinguishingFeature: cluster.pathPattern ?? summarizeFiles(cluster.filePaths.map((path) => ({
        relativePath: path,
        header: "",
        content: "",
        symbolPreview: [],
      }))),
      pathPattern: cluster.pathPattern,
      fileCount: cluster.filePaths.length,
      filePaths: cluster.filePaths,
    };
  }
  return summaries;
}

function buildRelatedFileGraph(files: FileInfo[], vectors: number[][]): Record<string, RelatedFileEdge[]> {
  const result: Record<string, RelatedFileEdge[]> = {};
  for (let i = 0; i < files.length; i++) {
    const edges = files
      .map((file, otherIndex) => ({
        path: file.relativePath,
        score: otherIndex === i ? 0 : cosine(vectors[i], vectors[otherIndex]),
      }))
      .filter((entry) => entry.path !== files[i].relativePath && entry.score >= MIN_RELATED_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RELATED_FILES)
      .map((entry) => ({
        path: entry.path,
        score: Number(entry.score.toFixed(4)),
        reason: "semantic-neighbor",
      }));
    result[files[i].relativePath] = edges;
  }
  return result;
}

export async function loadSemanticClusterState(rootDir: string): Promise<PersistedSemanticClusterState> {
  return loadIndexArtifact(rootDir, "semantic-cluster-index", () => ({
    generatedAt: "",
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    clusterCount: 0,
    root: {
      id: "cluster-root",
      label: "Project",
      pathPattern: null,
      summary: "No persisted cluster artifact available.",
      filePaths: [],
      children: [],
    },
    relatedFiles: {},
    subsystemSummaries: {},
  }));
}

export async function refreshSemanticClusterState(rootDir: string, options?: SemanticClusterRenderOptions): Promise<{ state: PersistedSemanticClusterState; stats: SemanticClusterStats }> {
  const fileState = await loadIndexArtifact<PersistedFileSearchState>(rootDir, "file-search-index", () => {
    throw new Error("File search index is required before building semantic cluster artifacts.");
  });
  const files = buildFileInfoList(fileState);
  if (files.length === 0) {
    const emptyState = await loadSemanticClusterState(rootDir);
    await saveIndexArtifact(rootDir, "semantic-cluster-index", emptyState);
    return {
      state: emptyState,
      stats: {
        indexedFiles: 0,
        clusterCount: 0,
        relatedFileCount: 0,
        subsystemCount: 0,
      },
    };
  }

  const vectors = await fetchEmbedding(files.map((file) => `${file.header} ${file.relativePath} ${file.content}`));
  const maxDepth = options?.maxDepth ?? 3;
  const maxClusters = options?.maxClusters ?? 20;
  const root = await buildHierarchy(files, vectors, maxClusters, 0, maxDepth);
  const relatedFiles = buildRelatedFileGraph(files, vectors);
  const subsystemSummaries = buildSubsystemSummaries(root);
  const clusterCount = flattenClusters(root, []).length - 1;
  const state: PersistedSemanticClusterState = {
    generatedAt: new Date().toISOString(),
    artifactVersion: INDEX_ARTIFACT_VERSION,
    contractVersion: buildIndexContract().contractVersion,
    mode: "full",
    clusterCount,
    root,
    relatedFiles,
    subsystemSummaries,
  };
  await saveIndexArtifact(rootDir, "semantic-cluster-index", state);
  return {
    state,
    stats: {
      indexedFiles: files.length,
      clusterCount,
      relatedFileCount: Object.values(relatedFiles).reduce((sum, edges) => sum + edges.length, 0),
      subsystemCount: Object.keys(subsystemSummaries).length,
    },
  };
}

function renderNode(node: SemanticClusterArtifactNode, depth: number, maxDepth: number, maxClusters: number): string[] {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  const prefix = depth === 0 ? "" : `${pad}[${node.label}]`;
  if (prefix) {
    lines.push(prefix);
    if (node.summary) lines.push(`${pad}  ${node.summary}`);
  }

  if (depth >= maxDepth || node.children.length === 0) {
    const filePad = depth === 0 ? "" : `${pad}  `;
    for (const filePath of node.filePaths.slice(0, Math.max(maxClusters, 5))) {
      lines.push(`${filePad}${filePath}`);
    }
    if (node.filePaths.length > Math.max(maxClusters, 5)) {
      lines.push(`${filePad}... ${node.filePaths.length - Math.max(maxClusters, 5)} more files`);
    }
    return lines;
  }

  for (const child of node.children.slice(0, Math.max(1, maxClusters))) {
    lines.push(...renderNode(child, depth + 1, maxDepth, maxClusters));
  }
  if (node.children.length > Math.max(1, maxClusters)) {
    lines.push(`${pad}  ... ${node.children.length - Math.max(1, maxClusters)} more clusters`);
  }
  return lines;
}

export function renderSemanticClusterState(state: PersistedSemanticClusterState, options?: SemanticClusterRenderOptions): string {
  if (state.clusterCount === 0 && state.root.filePaths.length === 0) {
    return "No persisted semantic cluster artifacts are available. Run `index` in full mode first.";
  }
  const maxDepth = options?.maxDepth ?? 3;
  const maxClusters = options?.maxClusters ?? 20;
  const lines = [
    `Semantic Navigator: ${state.root.filePaths.length} files organized by meaning`,
    `Persisted clusters: ${state.clusterCount}`,
    `Subsystem summaries: ${Object.keys(state.subsystemSummaries).length}`,
    "",
    ...renderNode(state.root, 0, maxDepth, maxClusters),
  ];
  return lines.join("\n").trimEnd();
}
