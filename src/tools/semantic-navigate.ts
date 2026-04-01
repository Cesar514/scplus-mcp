// Semantic project navigator backed by persisted full-engine cluster artifacts
// FEATURE: Render semantic clusters from sqlite instead of recomputing on demand

import { loadSemanticClusterState, renderSemanticClusterState } from "./cluster-artifacts.js";

export interface SemanticNavigateOptions {
  rootDir: string;
  maxDepth?: number;
  maxClusters?: number;
}

export async function semanticNavigate(options: SemanticNavigateOptions): Promise<string> {
  const state = await loadSemanticClusterState(options.rootDir);
  if (state.clusterCount === 0 && state.root.filePaths.length === 0) {
    throw new Error("Semantic cluster artifacts are missing. Run `index` in full mode before calling `cluster`.");
  }
  return renderSemanticClusterState(state, {
    maxDepth: options.maxDepth,
    maxClusters: options.maxClusters,
  });
}
