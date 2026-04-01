// Graph-plus-markdown-plus-vector memory system on sqlite-backed durable state
// FEATURE: Memory graph, markdown documents, embeddings, and automatic relation upkeep

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fetchEmbedding } from "./embeddings.js";
import { loadIndexArtifact, saveIndexArtifact } from "./index-database.js";
import { parseWikiLinks } from "./hub.js";
import { ensureContextplusLayout } from "./project-layout.js";

export type NodeType = "concept" | "file" | "symbol" | "note";
export type RelationType = "relates_to" | "depends_on" | "implements" | "references" | "similar_to" | "contains";

export interface MemoryNode {
  id: string;
  type: NodeType;
  label: string;
  content: string;
  summary: string;
  documentPath: string;
  contentHash: string;
  embedding: number[];
  createdAt: number;
  updatedAt: number;
  lastAccessed: number;
  accessCount: number;
  aliases: string[];
  tags: string[];
  metadata: Record<string, string>;
}

export interface MemoryEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  weight: number;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, string>;
}

interface MemoryDocumentRecord {
  nodeId: string;
  documentPath: string;
  contentHash: string;
  updatedAt: number;
}

export interface GraphStore {
  version: 2;
  nodes: Record<string, MemoryNode>;
  edges: Record<string, MemoryEdge>;
  documents: Record<string, MemoryDocumentRecord>;
}

export interface TraversalResult {
  node: MemoryNode;
  depth: number;
  pathRelations: string[];
  relevanceScore: number;
}

export interface GraphSearchResult {
  direct: TraversalResult[];
  neighbors: TraversalResult[];
  totalNodes: number;
  totalEdges: number;
}

const DECAY_LAMBDA = 0.05;
const SIMILARITY_THRESHOLD = 0.72;
const STALE_THRESHOLD = 0.15;
const MEMORY_STORE_VERSION = 2;

const graphCache = new Map<string, GraphStore>();

interface ParsedMemoryDocument {
  id: string;
  type: NodeType;
  label: string;
  createdAt: number;
  updatedAt: number;
  aliases: string[];
  tags: string[];
  metadata: Record<string, string>;
  content: string;
  summary: string;
  documentPath: string;
  contentHash: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function decayWeight(edge: MemoryEdge): number {
  const daysSinceCreation = (Date.now() - edge.createdAt) / 86_400_000;
  return edge.weight * Math.exp(-DECAY_LAMBDA * daysSinceCreation);
}

function summarizeContent(content: string): string {
  const line = content
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  return (line ?? "").slice(0, 140);
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function computeMemoryContentHash(
  label: string,
  content: string,
  metadata: Record<string, string>,
  aliases: string[],
  tags: string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      label,
      content,
      metadata,
      aliases: aliases.slice().sort(),
      tags: tags.slice().sort(),
    }))
    .digest("hex");
}

function buildMemoryDocumentPath(rootDir: string, type: NodeType, label: string, id: string): string {
  return normalizePath(relative(
    rootDir,
    join(resolve(rootDir), ".contextplus", "memories", type, `${slugify(label) || type}-${id}.md`),
  ));
}

function serializeMemoryDocument(node: MemoryNode): string {
  const metadata = JSON.stringify(node.metadata);
  return [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `label: ${node.label}`,
    `createdAt: ${node.createdAt}`,
    `updatedAt: ${node.updatedAt}`,
    `aliases: ${node.aliases.join(", ")}`,
    `tags: ${node.tags.join(", ")}`,
    `metadata: ${metadata}`,
    "---",
    "",
    node.content.trimEnd(),
    "",
  ].join("\n");
}

function parseMemoryDocument(raw: string, documentPath: string): ParsedMemoryDocument {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`Memory document missing frontmatter: ${documentPath}`);
  const frontmatter = match[1].split("\n");
  const body = match[2].trim();
  const values: Record<string, string> = {};
  for (const line of frontmatter) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values[key] = value;
  }
  const id = values.id;
  const type = values.type as NodeType | undefined;
  const label = values.label;
  if (!id || !type || !label) {
    throw new Error(`Memory document frontmatter missing required keys in ${documentPath}`);
  }
  const createdAt = Number(values.createdAt);
  const updatedAt = Number(values.updatedAt);
  const aliases = parseList(values.aliases);
  const tags = parseList(values.tags);
  let metadata: Record<string, string> = {};
  if (values.metadata) {
    metadata = JSON.parse(values.metadata) as Record<string, string>;
  }
  return {
    id,
    type,
    label,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    aliases,
    tags,
    metadata,
    content: body,
    summary: summarizeContent(body),
    documentPath: normalizePath(documentPath),
    contentHash: computeMemoryContentHash(label, body, metadata, aliases, tags),
  };
}

function migrateLegacyNode(nodeId: string, node: Partial<MemoryNode>): MemoryNode {
  const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
  const label = node.label ?? nodeId;
  const content = node.content ?? "";
  const aliases = Array.isArray(node.aliases) ? node.aliases : [];
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const createdAt = typeof node.createdAt === "number" ? node.createdAt : Date.now();
  const updatedAt = typeof node.updatedAt === "number" ? node.updatedAt : createdAt;
  return {
    id: node.id ?? nodeId,
    type: (node.type as NodeType | undefined) ?? "note",
    label,
    content,
    summary: node.summary ?? summarizeContent(content),
    documentPath: node.documentPath ?? "",
    contentHash: node.contentHash ?? computeMemoryContentHash(label, content, metadata, aliases, tags),
    embedding: Array.isArray(node.embedding) ? node.embedding : [],
    createdAt,
    updatedAt,
    lastAccessed: typeof node.lastAccessed === "number" ? node.lastAccessed : updatedAt,
    accessCount: typeof node.accessCount === "number" ? node.accessCount : 0,
    aliases,
    tags,
    metadata,
  };
}

function migrateLegacyEdge(edgeId: string, edge: Partial<MemoryEdge>): MemoryEdge {
  const createdAt = typeof edge.createdAt === "number" ? edge.createdAt : Date.now();
  const updatedAt = typeof edge.updatedAt === "number" ? edge.updatedAt : createdAt;
  return {
    id: edge.id ?? edgeId,
    source: edge.source ?? "",
    target: edge.target ?? "",
    relation: (edge.relation as RelationType | undefined) ?? "relates_to",
    weight: typeof edge.weight === "number" ? edge.weight : 1,
    createdAt,
    updatedAt,
    metadata: edge.metadata && typeof edge.metadata === "object" ? edge.metadata : {},
  };
}

export function createEmptyMemoryStore(): GraphStore {
  return {
    version: MEMORY_STORE_VERSION,
    nodes: {},
    edges: {},
    documents: {},
  };
}

export function migrateGraphStore(raw: unknown): GraphStore {
  const store = raw && typeof raw === "object" ? raw as Partial<GraphStore> : {};
  const nodesSource = store.nodes && typeof store.nodes === "object" ? store.nodes : {};
  const edgesSource = store.edges && typeof store.edges === "object" ? store.edges : {};
  const documentsSource = store.documents && typeof store.documents === "object" ? store.documents : {};
  const nodes: Record<string, MemoryNode> = {};
  const edges: Record<string, MemoryEdge> = {};
  const documents: Record<string, MemoryDocumentRecord> = {};

  for (const [nodeId, value] of Object.entries(nodesSource)) {
    nodes[nodeId] = migrateLegacyNode(nodeId, value as Partial<MemoryNode>);
  }
  for (const [edgeId, value] of Object.entries(edgesSource)) {
    edges[edgeId] = migrateLegacyEdge(edgeId, value as Partial<MemoryEdge>);
  }
  for (const [docPath, value] of Object.entries(documentsSource)) {
    if (!value || typeof value !== "object") continue;
    const document = value as Partial<MemoryDocumentRecord>;
    if (!document.nodeId || !document.contentHash) continue;
    documents[normalizePath(docPath)] = {
      nodeId: document.nodeId,
      documentPath: normalizePath(document.documentPath ?? docPath),
      contentHash: document.contentHash,
      updatedAt: typeof document.updatedAt === "number" ? document.updatedAt : Date.now(),
    };
  }
  return { version: MEMORY_STORE_VERSION, nodes, edges, documents };
}

async function listMemoryDocumentPaths(rootDir: string): Promise<string[]> {
  const layout = await ensureContextplusLayout(resolve(rootDir));
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        result.push(normalizePath(relative(rootDir, fullPath)));
      }
    }
  }

  await walk(layout.memories);
  return result.sort();
}

async function persistGraph(rootDir: string, graph: GraphStore): Promise<void> {
  await saveIndexArtifact(rootDir, "memory-graph", graph);
}

function upsertEdge(
  graph: GraphStore,
  sourceId: string,
  targetId: string,
  relation: RelationType,
  weight: number,
  metadata?: Record<string, string>,
): MemoryEdge {
  const duplicate = Object.values(graph.edges).find((edge) =>
    edge.source === sourceId && edge.target === targetId && edge.relation === relation,
  );
  if (duplicate) {
    duplicate.weight = weight;
    duplicate.updatedAt = Date.now();
    duplicate.metadata = { ...duplicate.metadata, ...(metadata ?? {}) };
    return duplicate;
  }
  const edge: MemoryEdge = {
    id: generateId("me"),
    source: sourceId,
    target: targetId,
    relation,
    weight,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: metadata ?? {},
  };
  graph.edges[edge.id] = edge;
  return edge;
}

function removeAutoEdgesForNode(graph: GraphStore, nodeId: string): void {
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    if (!edge.metadata.origin?.startsWith("auto:")) continue;
    delete graph.edges[edgeId];
  }
}

function findNodeByWikiTarget(graph: GraphStore, target: string): MemoryNode | null {
  const normalized = target.trim().toLowerCase();
  return Object.values(graph.nodes).find((node) => {
    const documentSlug = basename(node.documentPath, extname(node.documentPath)).toLowerCase();
    return node.label.toLowerCase() === normalized
      || documentSlug === slugify(normalized)
      || node.aliases.some((alias) => alias.toLowerCase() === normalized);
  }) ?? null;
}

async function writeNodeDocument(rootDir: string, node: MemoryNode): Promise<void> {
  const fullPath = resolve(rootDir, node.documentPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, serializeMemoryDocument(node), "utf8");
}

async function rebuildAutomaticRelations(rootDir: string, graph: GraphStore, node: MemoryNode): Promise<void> {
  removeAutoEdgesForNode(graph, node.id);

  const wikilinks = parseWikiLinks(node.content);
  for (const link of wikilinks) {
    const targetNode = findNodeByWikiTarget(graph, link.target);
    if (!targetNode || targetNode.id === node.id) continue;
    upsertEdge(graph, node.id, targetNode.id, "references", 1, { origin: "auto:wikilink" });
  }

  for (const candidate of Object.values(graph.nodes)) {
    if (candidate.id === node.id) continue;
    const similarity = cosine(node.embedding, candidate.embedding);
    if (similarity >= SIMILARITY_THRESHOLD) {
      upsertEdge(graph, node.id, candidate.id, "similar_to", similarity, { origin: "auto:similarity" });
    }
  }

  await persistGraph(rootDir, graph);
}

async function syncMarkdownDocuments(rootDir: string, graph: GraphStore): Promise<void> {
  const documentPaths = await listMemoryDocumentPaths(rootDir);
  const seenPaths = new Set<string>();
  let mutated = false;

  for (const documentPath of documentPaths) {
    const raw = await readFile(resolve(rootDir, documentPath), "utf8");
    const parsed = parseMemoryDocument(raw, documentPath);
    seenPaths.add(parsed.documentPath);
    const existing = graph.nodes[parsed.id];
    const documentRecord = graph.documents[parsed.documentPath];
    const contentChanged = !existing || existing.contentHash !== parsed.contentHash;
    if (!existing || contentChanged || existing.documentPath !== parsed.documentPath) {
      const embedding = contentChanged || !existing?.embedding.length
        ? (await fetchEmbedding(`${parsed.label} ${parsed.content} ${parsed.tags.join(" ")}`))[0]
        : existing.embedding;
      graph.nodes[parsed.id] = {
        id: parsed.id,
        type: parsed.type,
        label: parsed.label,
        content: parsed.content,
        summary: parsed.summary,
        documentPath: parsed.documentPath,
        contentHash: parsed.contentHash,
        embedding,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        lastAccessed: existing?.lastAccessed ?? parsed.updatedAt,
        accessCount: existing?.accessCount ?? 0,
        aliases: parsed.aliases,
        tags: parsed.tags,
        metadata: parsed.metadata,
      };
      mutated = true;
    }
    if (!documentRecord || documentRecord.contentHash !== parsed.contentHash) {
      graph.documents[parsed.documentPath] = {
        nodeId: parsed.id,
        documentPath: parsed.documentPath,
        contentHash: parsed.contentHash,
        updatedAt: parsed.updatedAt,
      };
      mutated = true;
    }
  }

  for (const [documentPath, record] of Object.entries(graph.documents)) {
    if (seenPaths.has(documentPath)) continue;
    delete graph.documents[documentPath];
    const node = graph.nodes[record.nodeId];
    if (node) {
      delete graph.nodes[record.nodeId];
      removeAutoEdgesForNode(graph, record.nodeId);
      for (const [edgeId, edge] of Object.entries(graph.edges)) {
        if (edge.source === record.nodeId || edge.target === record.nodeId) delete graph.edges[edgeId];
      }
    }
    mutated = true;
  }

  if (!mutated) return;
  for (const node of Object.values(graph.nodes)) {
    await rebuildAutomaticRelations(rootDir, graph, node);
  }
  await persistGraph(rootDir, graph);
}

async function loadGraph(rootDir: string): Promise<GraphStore> {
  const normalizedRootDir = resolve(rootDir);
  const cached = graphCache.get(normalizedRootDir);
  if (cached) {
    await syncMarkdownDocuments(normalizedRootDir, cached);
    return cached;
  }
  const raw = await loadIndexArtifact(normalizedRootDir, "memory-graph", () => ({
    ...createEmptyMemoryStore(),
  }));
  const store = migrateGraphStore(raw);
  graphCache.set(normalizedRootDir, store);
  await syncMarkdownDocuments(normalizedRootDir, store);
  return store;
}

function getEdgesForNode(graph: GraphStore, nodeId: string): MemoryEdge[] {
  return Object.values(graph.edges).filter((edge) => edge.source === nodeId || edge.target === nodeId);
}

function getNeighborId(edge: MemoryEdge, fromId: string): string {
  return edge.source === fromId ? edge.target : edge.source;
}

async function upsertNodeInternal(
  rootDir: string,
  type: NodeType,
  label: string,
  content: string,
  metadata?: Record<string, string>,
  options?: { suppressAutoRelations?: boolean },
): Promise<MemoryNode> {
  const graph = await loadGraph(rootDir);
  const existing = Object.values(graph.nodes).find((node) => node.label === label && node.type === type);
  const now = Date.now();
  const normalizedMetadata = { ...(existing?.metadata ?? {}), ...(metadata ?? {}) };
  const aliases = parseList(normalizedMetadata.aliases);
  const tags = parseList(normalizedMetadata.tags);
  const summary = summarizeContent(content);
  const contentHash = computeMemoryContentHash(label, content, normalizedMetadata, aliases, tags);
  const nodeId = existing?.id ?? generateId("mn");
  const documentPath = existing?.documentPath || buildMemoryDocumentPath(rootDir, type, label, nodeId);
  const embedding = existing?.contentHash === contentHash && existing.embedding.length > 0
    ? existing.embedding
    : (await fetchEmbedding(`${label} ${content} ${tags.join(" ")}`))[0];
  const node: MemoryNode = {
    id: nodeId,
    type,
    label,
    content,
    summary,
    documentPath,
    contentHash,
    embedding,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastAccessed: now,
    accessCount: (existing?.accessCount ?? 0) + 1,
    aliases,
    tags,
    metadata: normalizedMetadata,
  };

  graph.nodes[node.id] = node;
  graph.documents[node.documentPath] = {
    nodeId: node.id,
    documentPath: node.documentPath,
    contentHash: node.contentHash,
    updatedAt: node.updatedAt,
  };
  await writeNodeDocument(rootDir, node);
  await persistGraph(rootDir, graph);
  if (!options?.suppressAutoRelations) await rebuildAutomaticRelations(rootDir, graph, node);
  return node;
}

export async function upsertNode(rootDir: string, type: NodeType, label: string, content: string, metadata?: Record<string, string>): Promise<MemoryNode> {
  return upsertNodeInternal(rootDir, type, label, content, metadata);
}

export async function createRelation(rootDir: string, sourceId: string, targetId: string, relation: RelationType, weight?: number, metadata?: Record<string, string>): Promise<MemoryEdge | null> {
  const graph = await loadGraph(rootDir);
  if (!graph.nodes[sourceId] || !graph.nodes[targetId]) return null;
  const edge = upsertEdge(graph, sourceId, targetId, relation, weight ?? 1, metadata);
  await persistGraph(rootDir, graph);
  return edge;
}

export async function searchGraph(rootDir: string, query: string, maxDepth: number = 1, topK: number = 5, edgeFilter?: RelationType[]): Promise<GraphSearchResult> {
  const graph = await loadGraph(rootDir);
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return { direct: [], neighbors: [], totalNodes: 0, totalEdges: 0 };

  const [queryVec] = await fetchEmbedding(query);
  const scored = nodes
    .map((node) => ({ node, score: cosine(queryVec, node.embedding) }))
    .sort((left, right) => right.score - left.score);

  const directHits = scored.slice(0, topK).map(({ node, score }) => {
    node.lastAccessed = Date.now();
    return {
      node,
      depth: 0,
      pathRelations: [],
      relevanceScore: Math.round(score * 1000) / 10,
    };
  });

  const neighborResults: TraversalResult[] = [];
  const visited = new Set(directHits.map((hit) => hit.node.id));
  for (const hit of directHits) {
    traverseNeighbors(graph, hit.node.id, queryVec, 1, maxDepth, [hit.node.label], visited, neighborResults, edgeFilter);
  }

  neighborResults.sort((left, right) => right.relevanceScore - left.relevanceScore);
  await persistGraph(rootDir, graph);
  return {
    direct: directHits,
    neighbors: neighborResults.slice(0, topK * 2),
    totalNodes: nodes.length,
    totalEdges: Object.keys(graph.edges).length,
  };
}

function traverseNeighbors(
  graph: GraphStore,
  nodeId: string,
  queryVec: number[],
  depth: number,
  maxDepth: number,
  pathLabels: string[],
  visited: Set<string>,
  results: TraversalResult[],
  edgeFilter?: RelationType[],
): void {
  if (depth > maxDepth) return;
  for (const edge of getEdgesForNode(graph, nodeId)) {
    if (edgeFilter && !edgeFilter.includes(edge.relation)) continue;
    const neighborId = getNeighborId(edge, nodeId);
    if (visited.has(neighborId)) continue;
    const neighbor = graph.nodes[neighborId];
    if (!neighbor) continue;
    visited.add(neighborId);
    const similarity = cosine(queryVec, neighbor.embedding);
    const edgeDecay = decayWeight(edge);
    const relevance = similarity * 0.6 + (edgeDecay / Math.max(edge.weight, 0.01)) * 0.4;
    results.push({
      node: neighbor,
      depth,
      pathRelations: [...pathLabels, `--[${edge.relation}]-->`, neighbor.label],
      relevanceScore: Math.round(relevance * 1000) / 10,
    });
    neighbor.lastAccessed = Date.now();
    traverseNeighbors(graph, neighborId, queryVec, depth + 1, maxDepth, [...pathLabels, `--[${edge.relation}]-->`, neighbor.label], visited, results, edgeFilter);
  }
}

export async function pruneStaleLinks(rootDir: string, threshold?: number): Promise<{ removed: number; remaining: number }> {
  const graph = await loadGraph(rootDir);
  const cutoff = threshold ?? STALE_THRESHOLD;
  const toRemove: string[] = [];
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (decayWeight(edge) < cutoff) toRemove.push(edgeId);
  }
  for (const edgeId of toRemove) delete graph.edges[edgeId];

  const orphanNodeIds = Object.keys(graph.nodes).filter((nodeId) =>
    getEdgesForNode(graph, nodeId).length === 0
      && graph.nodes[nodeId].accessCount <= 1
      && (Date.now() - graph.nodes[nodeId].lastAccessed) > 7 * 86_400_000,
  );
  for (const nodeId of orphanNodeIds) {
    const node = graph.nodes[nodeId];
    if (node?.documentPath) {
      await rm(resolve(rootDir, node.documentPath), { force: true });
      delete graph.documents[node.documentPath];
    }
    delete graph.nodes[nodeId];
  }
  await persistGraph(rootDir, graph);
  return { removed: toRemove.length + orphanNodeIds.length, remaining: Object.keys(graph.edges).length };
}

export async function addInterlinkedContext(
  rootDir: string,
  items: Array<{ type: NodeType; label: string; content: string; metadata?: Record<string, string> }>,
  autoLink: boolean = true,
): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> {
  const graph = await loadGraph(rootDir);
  const createdNodes: MemoryNode[] = [];
  for (const item of items) {
    createdNodes.push(await upsertNodeInternal(rootDir, item.type, item.label, item.content, item.metadata, { suppressAutoRelations: true }));
  }

  const createdEdges: MemoryEdge[] = [];
  if (autoLink) {
    for (let leftIndex = 0; leftIndex < createdNodes.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < createdNodes.length; rightIndex++) {
        const similarity = cosine(createdNodes[leftIndex].embedding, createdNodes[rightIndex].embedding);
        if (similarity >= SIMILARITY_THRESHOLD) {
          createdEdges.push(upsertEdge(graph, createdNodes[leftIndex].id, createdNodes[rightIndex].id, "similar_to", similarity, { origin: "auto:similarity" }));
        }
      }
    }
    for (const node of createdNodes) {
      await rebuildAutomaticRelations(rootDir, graph, node);
    }
  } else {
    await persistGraph(rootDir, graph);
  }

  return { nodes: createdNodes, edges: createdEdges };
}

export async function retrieveWithTraversal(rootDir: string, startNodeId: string, maxDepth: number = 2, edgeFilter?: RelationType[]): Promise<TraversalResult[]> {
  const graph = await loadGraph(rootDir);
  const startNode = graph.nodes[startNodeId];
  if (!startNode) return [];
  startNode.lastAccessed = Date.now();
  startNode.accessCount++;

  const results: TraversalResult[] = [{
    node: startNode,
    depth: 0,
    pathRelations: [startNode.label],
    relevanceScore: 100,
  }];

  const visited = new Set([startNodeId]);
  collectTraversal(graph, startNodeId, 1, maxDepth, [startNode.label], visited, results, edgeFilter);
  await persistGraph(rootDir, graph);
  return results;
}

function collectTraversal(
  graph: GraphStore,
  nodeId: string,
  depth: number,
  maxDepth: number,
  pathLabels: string[],
  visited: Set<string>,
  results: TraversalResult[],
  edgeFilter?: RelationType[],
): void {
  if (depth > maxDepth) return;
  for (const edge of getEdgesForNode(graph, nodeId)) {
    if (edgeFilter && !edgeFilter.includes(edge.relation)) continue;
    const neighborId = getNeighborId(edge, nodeId);
    if (visited.has(neighborId)) continue;
    const neighbor = graph.nodes[neighborId];
    if (!neighbor) continue;
    visited.add(neighborId);
    neighbor.lastAccessed = Date.now();
    const decayed = decayWeight(edge);
    const depthPenalty = 1 / (1 + depth * 0.3);
    const score = decayed * depthPenalty * 100;
    results.push({
      node: neighbor,
      depth,
      pathRelations: [...pathLabels, `--[${edge.relation}]-->`, neighbor.label],
      relevanceScore: Math.round(score * 10) / 10,
    });
    collectTraversal(graph, neighborId, depth + 1, maxDepth, [...pathLabels, `--[${edge.relation}]-->`, neighbor.label], visited, results, edgeFilter);
  }
}

export async function getGraphStats(rootDir: string): Promise<{ nodes: number; edges: number; types: Record<string, number>; relations: Record<string, number> }> {
  const graph = await loadGraph(rootDir);
  const types: Record<string, number> = {};
  const relations: Record<string, number> = {};
  for (const node of Object.values(graph.nodes)) types[node.type] = (types[node.type] ?? 0) + 1;
  for (const edge of Object.values(graph.edges)) relations[edge.relation] = (relations[edge.relation] ?? 0) + 1;
  return {
    nodes: Object.keys(graph.nodes).length,
    edges: Object.keys(graph.edges).length,
    types,
    relations,
  };
}
