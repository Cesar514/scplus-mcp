// summary: Clusters retrieval vectors deterministically without spectral decomposition.
// FEATURE: Farthest-seed cosine k-means for large-repo semantic clustering.
// inputs: Embedding vectors, repository metadata, and clustering configuration limits.
// outputs: Deterministic cluster assignments, centroids, and path-pattern summaries.

export interface ClusterResult {
  indices: number[];
}

const MAX_KMEANS_ITERATIONS = 20;
const STABLE_CLUSTER_SIZE_HINT = 24;

// Purpose: Compute the squared Euclidean norm used by vector normalization and comparisons.
// Inputs: A numeric embedding vector.
// Returns/Effects: Returns the sum of squared component values for the provided vector.
function squaredNorm(vector: number[]): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return total;
}

// Purpose: Normalize a vector onto the unit sphere for cosine-similarity clustering.
// Inputs: A numeric embedding vector.
// Returns/Effects: Returns a normalized vector, or a zero vector when the norm is effectively zero.
function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(squaredNorm(vector));
  if (norm <= 1e-10) return new Array(vector.length).fill(0);
  return vector.map((value) => value / norm);
}

// Purpose: Compute cosine-style dot-product similarity between two normalized vectors.
// Inputs: Two numeric embedding vectors that may differ in length.
// Returns/Effects: Returns the summed pairwise product across the shared dimensions.
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index++) dot += a[index] * b[index];
  return dot;
}

// Purpose: Choose a stable cluster count for deterministic k-means based on corpus size.
// Inputs: The number of vectors being clustered and the maximum allowed cluster count.
// Returns/Effects: Returns the derived cluster count constrained by the configured limits.
function chooseClusterCount(vectorCount: number, maxClusters: number): number {
  if (vectorCount <= 1) return vectorCount;
  if (vectorCount <= maxClusters) return vectorCount;
  const derived = Math.ceil(vectorCount / STABLE_CLUSTER_SIZE_HINT);
  return Math.min(maxClusters, Math.max(2, derived));
}

// Purpose: Seed deterministic centroid candidates using farthest-point initialization.
// Inputs: The normalized vector set and the desired number of clusters.
// Returns/Effects: Returns an ordered centroid list chosen from the input vectors.
function chooseInitialCentroids(vectors: number[][], clusterCount: number): number[][] {
  const centroids: number[][] = [[...vectors[0]]];
  const minDistances = new Array(vectors.length).fill(Infinity);
  const chosen = new Set<number>([0]);

  while (centroids.length < clusterCount) {
    const newest = centroids[centroids.length - 1];
    for (let index = 0; index < vectors.length; index++) {
      const distance = 1 - cosine(vectors[index], newest);
      if (distance < minDistances[index]) minDistances[index] = distance;
    }

    let bestIndex = -1;
    let bestDistance = -1;
    for (let index = 0; index < vectors.length; index++) {
      if (chosen.has(index)) continue;
      if (minDistances[index] > bestDistance) {
        bestDistance = minDistances[index];
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestDistance <= 1e-10) break;
    centroids.push([...vectors[bestIndex]]);
    chosen.add(bestIndex);
  }

  return centroids;
}

// Purpose: Assign each vector to the centroid with the highest cosine similarity score.
// Inputs: The normalized vector set and the current centroid list.
// Returns/Effects: Returns the cluster index assignment for every input vector.
function assignVectors(vectors: number[][], centroids: number[][]): number[] {
  const assignments = new Array(vectors.length).fill(0);
  for (let index = 0; index < vectors.length; index++) {
    let bestCluster = 0;
    let bestScore = -Infinity;
    for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
      const score = cosine(vectors[index], centroids[centroidIndex]);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = centroidIndex;
      }
    }
    assignments[index] = bestCluster;
  }
  return assignments;
}

// Purpose: Rebuild normalized centroids from the current cluster assignments.
// Inputs: The normalized vectors, their cluster assignments, and the expected cluster count.
// Returns/Effects: Returns a normalized centroid vector for each non-empty cluster.
function buildCentroids(vectors: number[][], assignments: number[], clusterCount: number): number[][] {
  const sums = Array.from({ length: clusterCount }, () => new Array(vectors[0].length).fill(0));
  const counts = new Array(clusterCount).fill(0);

  for (let index = 0; index < vectors.length; index++) {
    const cluster = assignments[index];
    counts[cluster] += 1;
    for (let dimension = 0; dimension < vectors[index].length; dimension++) {
      sums[cluster][dimension] += vectors[index][dimension];
    }
  }

  const centroids: number[][] = [];
  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
    if (counts[clusterIndex] === 0) continue;
    const centroid = sums[clusterIndex].map((value) => value / counts[clusterIndex]);
    centroids.push(normalizeVector(centroid));
  }
  return centroids;
}

// Purpose: Remap sparse cluster ids into a compact consecutive cluster index space.
// Inputs: The raw assignment array produced by the current clustering pass.
// Returns/Effects: Returns compacted assignments plus the resulting compact cluster count.
function compactAssignments(assignments: number[]): { compacted: number[]; clusterCount: number } {
  const remap = new Map<number, number>();
  const compacted = new Array(assignments.length);
  let nextCluster = 0;
  for (let index = 0; index < assignments.length; index++) {
    const current = assignments[index];
    if (!remap.has(current)) {
      remap.set(current, nextCluster);
      nextCluster += 1;
    }
    compacted[index] = remap.get(current)!;
  }
  return { compacted, clusterCount: nextCluster };
}

// Purpose: Run deterministic k-means until assignments stabilize or iteration limits are reached.
// Inputs: The normalized vector set and the requested cluster count.
// Returns/Effects: Returns the final assignment array for all input vectors.
function runDeterministicKMeans(vectors: number[][], clusterCount: number): number[] {
  let centroids = chooseInitialCentroids(vectors, clusterCount);
  if (centroids.length === 0) return new Array(vectors.length).fill(0);

  let assignments = assignVectors(vectors, centroids);

  for (let iteration = 0; iteration < MAX_KMEANS_ITERATIONS; iteration++) {
    const nextCentroids = buildCentroids(vectors, assignments, centroids.length);
    if (nextCentroids.length === 0) return new Array(vectors.length).fill(0);

    const nextAssignments = assignVectors(vectors, nextCentroids);
    const compacted = compactAssignments(nextAssignments);
    const stable = compacted.compacted.every((cluster, index) => cluster === assignments[index]);
    assignments = compacted.compacted;
    centroids = buildCentroids(vectors, assignments, compacted.clusterCount);
    if (stable) break;
  }

  return assignments;
}

// Purpose: Cluster embedding vectors into deterministic groups suitable for semantic navigation.
// Inputs: The embedding vectors plus an optional maximum cluster count.
// Returns/Effects: Returns cluster membership lists that group related vector indices together.
export function clusterVectors(vectors: number[][], maxClusters: number = 20): ClusterResult[] {
  const vectorCount = vectors.length;
  if (vectorCount <= 1) return [{ indices: Array.from({ length: vectorCount }, (_, index) => index) }];
  if (vectorCount <= maxClusters) return vectors.map((_, index) => ({ indices: [index] }));

  const normalized = vectors.map((vector) => normalizeVector(vector));
  const clusterCount = chooseClusterCount(vectorCount, maxClusters);
  const assignments = runDeterministicKMeans(normalized, clusterCount);

  const clusters = new Map<number, number[]>();
  for (let index = 0; index < assignments.length; index++) {
    const cluster = assignments[index];
    if (!clusters.has(cluster)) clusters.set(cluster, []);
    clusters.get(cluster)!.push(index);
  }

  return Array.from(clusters.values())
    .filter((indices) => indices.length > 0)
    .map((indices) => ({ indices }));
}

// Purpose: Derive a readable shared path pattern for a group of repository-relative file paths.
// Inputs: The path list that should be summarized into one common pattern.
// Returns/Effects: Returns a shared prefix or suffix pattern, or null when no useful pattern exists.
export function findPathPattern(paths: string[]): string | null {
  if (paths.length <= 1) return null;

  const parts = paths.map((path) => path.split("/"));
  let commonPrefix = "";
  const minLength = Math.min(...parts.map((pathParts) => pathParts.length));
  for (let index = 0; index < minLength - 1; index++) {
    if (parts.every((pathParts) => pathParts[index] === parts[0][index])) {
      commonPrefix += `${parts[0][index]}/`;
    } else {
      break;
    }
  }

  const suffixes = paths.map((path) => path.split("/").pop()!);
  const allSameSuffix = suffixes.every((suffix) => suffix === suffixes[0]);

  if (commonPrefix && allSameSuffix) return `${commonPrefix}${suffixes[0]}`;
  if (commonPrefix) return `${commonPrefix}*`;
  if (allSameSuffix) return `*/${suffixes[0]}`;
  return null;
}
