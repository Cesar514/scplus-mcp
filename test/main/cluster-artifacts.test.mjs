// Persisted semantic cluster artifact tests
// FEATURE: Full indexing stores cluster tree, related files, and subsystem summaries

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.env.SCPLUS_EMBED_PROVIDER = "mock";
const execFileAsync = promisify(execFile);

function readArtifactFromDb(dbPath, artifactKey) {
  const db = new DatabaseSync(dbPath);
  try {
    const generation = getActiveGenerationFromDb(dbPath);
    const storedKey = generation === 0 ? artifactKey : `generation:${generation}:${artifactKey}`;
    const row = db.prepare("SELECT artifact_json FROM index_artifacts WHERE artifact_key = ?").get(storedKey);
    if (!row) return null;
    return JSON.parse(row.artifact_json);
  } finally {
    db.close();
  }
}

function getActiveGenerationFromDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT meta_value FROM index_db_meta WHERE meta_key = 'activeGeneration'").get();
    return row?.meta_value ? Number.parseInt(row.meta_value, 10) : 0;
  } finally {
    db.close();
  }
}

describe("cluster-artifacts", () => {
  it("persists semantic clusters, related files, and subsystem summaries in sqlite", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { semanticNavigate } = await import("../../build/tools/semantic-navigate.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-cluster-artifacts-"));
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
      const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
      const clusterState = readArtifactFromDb(dbPath, "semantic-cluster-index");
      const manifest = readArtifactFromDb(dbPath, "full-index-manifest");
      const rendered = await semanticNavigate({ rootDir, maxDepth: 3, maxClusters: 10 });

      assert.equal(clusterState.artifactVersion, 17);
      assert.equal(clusterState.contractVersion, 13);
      assert.equal(clusterState.mode, "full");
      assert.equal(clusterState.clusterCount >= 1, true);
      assert.equal(Object.keys(clusterState.relatedFiles).length >= 4, true);
      assert.equal(Object.keys(clusterState.subsystemSummaries).length >= 1, true);
      assert.equal(Array.isArray(clusterState.root.children), true);
      assert.equal(clusterState.root.filePaths.length >= 4, true);
      assert.match(clusterState.root.children[0].label, /^Semantic /);
      assert.equal(
        Object.values(clusterState.subsystemSummaries).some((summary) => summary.overarchingTheme.startsWith("Semantic theme:")),
        true,
      );
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

  it("keeps view-clusters read-only while cluster rebuilds missing semantic artifacts", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-cluster-refresh-"));
    try {
      await mkdir(join(rootDir, "src", "domain"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "domain", "account.ts"),
        [
          "// Account fixture for cluster command split",
          "// FEATURE: cluster rebuild versus read-only view verification",
          "export function loadAccountRecord(): string {",
          "  return 'account';",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "domain", "billing.ts"),
        [
          "// Billing fixture for cluster command split",
          "// FEATURE: cluster rebuild versus read-only view verification",
          "export function loadBillingRecord(): string {",
          "  return 'billing';",
          "}",
          "",
        ].join("\n"),
      );

      await indexCodebase({ rootDir, mode: "full" });
      const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
      const generation = getActiveGenerationFromDb(dbPath);
      const artifactKey = generation === 0 ? "semantic-cluster-index" : `generation:${generation}:semantic-cluster-index`;
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("DELETE FROM index_artifacts WHERE artifact_key = ?").run(artifactKey);
      } finally {
        db.close();
      }

      await assert.rejects(
        execFileAsync(
          process.execPath,
          [join(process.cwd(), "build", "index.js"), "view-clusters", "--root", rootDir],
          {
            env: { ...process.env, SCPLUS_EMBED_PROVIDER: "mock" },
          },
        ),
        /Missing required artifact "semantic-cluster-index" for full mode/,
      );

      const rebuilt = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "cluster", "--root", rootDir],
        {
          env: { ...process.env, SCPLUS_EMBED_PROVIDER: "mock" },
        },
      );
      assert.match(rebuilt.stdout, /Semantic Navigator:/);
      assert.equal(readArtifactFromDb(dbPath, "semantic-cluster-index") !== null, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
