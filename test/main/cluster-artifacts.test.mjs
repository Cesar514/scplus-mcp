// Persisted semantic cluster artifact tests
// FEATURE: Full indexing stores cluster tree, related files, and subsystem summaries

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

function readArtifactFromDb(dbPath, artifactKey) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT artifact_json FROM index_artifacts WHERE artifact_key = ?").get(artifactKey);
    if (!row) return null;
    return JSON.parse(row.artifact_json);
  } finally {
    db.close();
  }
}

describe("cluster-artifacts", () => {
  it("persists semantic clusters, related files, and subsystem summaries in sqlite", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { semanticNavigate } = await import("../../build/tools/semantic-navigate.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-cluster-artifacts-"));
    try {
      await mkdir(join(rootDir, "src", "api"), { recursive: true });
      await mkdir(join(rootDir, "src", "ui"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "api", "search.ts"),
        [
          "// API search fixture for persisted cluster artifacts",
          "// FEATURE: semantic cluster persistence verification",
          "export function searchCatalog(query: string): string {",
          "  return query.trim();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "api", "results.ts"),
        [
          "// API results fixture for persisted cluster artifacts",
          "// FEATURE: semantic cluster persistence verification",
          "export function formatSearchResults(): string {",
          "  return 'results';",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "ui", "button.ts"),
        [
          "// UI button fixture for persisted cluster artifacts",
          "// FEATURE: semantic cluster persistence verification",
          "export function renderPrimaryButton(): string {",
          "  return 'button';",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "ui", "card.ts"),
        [
          "// UI card fixture for persisted cluster artifacts",
          "// FEATURE: semantic cluster persistence verification",
          "export function renderSummaryCard(): string {",
          "  return 'card';",
          "}",
          "",
        ].join("\n"),
      );

      await indexCodebase({ rootDir, mode: "full" });
      const dbPath = join(rootDir, ".contextplus", "state", "index.sqlite");
      const clusterState = readArtifactFromDb(dbPath, "semantic-cluster-index");
      const manifest = readArtifactFromDb(dbPath, "full-index-manifest");
      const rendered = await semanticNavigate({ rootDir, maxDepth: 3, maxClusters: 10 });

      assert.equal(clusterState.artifactVersion, 9);
      assert.equal(clusterState.contractVersion, 7);
      assert.equal(clusterState.mode, "full");
      assert.equal(clusterState.clusterCount >= 1, true);
      assert.equal(Object.keys(clusterState.relatedFiles).length >= 4, true);
      assert.equal(Object.keys(clusterState.subsystemSummaries).length >= 1, true);
      assert.equal(Array.isArray(clusterState.root.children), true);
      assert.equal(clusterState.root.filePaths.length >= 4, true);
      assert.equal(manifest.semanticClusterIndexPath, "sqlite:index_artifacts/semantic-cluster-index");
      assert.equal(manifest.semanticClusterCount, clusterState.clusterCount);
      assert.equal(manifest.stats.semanticClusterIndex.clusterCount, clusterState.clusterCount);
      assert.match(rendered, /Semantic Navigator:/);
      assert.match(rendered, /src\/api\/search\.ts/);
      assert.match(rendered, /src\/ui\/button\.ts/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
