// summary: Renders semantic project navigation views from persisted full-engine cluster artifacts.
// FEATURE: Render semantic clusters from sqlite instead of recomputing on demand.
// inputs: Cluster artifacts, subsystem summaries, and semantic navigation requests.
// outputs: Structured semantic cluster views and related-file neighborhoods.

import { loadSemanticClusterState, renderSemanticClusterState } from "./cluster-artifacts.js";
import { assertValidPreparedIndex } from "./index-reliability.js";

export interface SemanticNavigateOptions {
  rootDir: string;
  maxDepth?: number;
  maxClusters?: number;
}

// Purpose: Render the persisted semantic cluster view for a repository with prepared full-index artifacts.
// Inputs: Semantic navigation options including the root directory and optional render limits.
// Returns/Effects: Validates the prepared index, loads cluster state, and returns the rendered cluster view text.
export async function semanticNavigate(options: SemanticNavigateOptions): Promise<string> {
  await assertValidPreparedIndex({
    rootDir: options.rootDir,
    mode: "full",
    consumer: "cluster",
  });
  const state = await loadSemanticClusterState(options.rootDir);
  if (state.clusterCount === 0 && state.root.filePaths.length === 0) {
    throw new Error("Semantic cluster artifacts are missing. Run `index` in full mode before calling `cluster`.");
  }
  return renderSemanticClusterState(state, {
    maxDepth: options.maxDepth,
    maxClusters: options.maxClusters,
  });
}
