// Incremental invalidation tests for durable full-engine refresh behavior
// FEATURE: Content-hash and dependency-aware refresh verification

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

describe("invalidation", () => {
  it("recomputes file, identifier, chunk, and structure artifacts when content changes without relying on size or mtime drift", async () => {
    const { ensureFileSearchIndex } = await import("../../build/tools/semantic-search.js");
    const { ensureIdentifierSearchIndex } = await import("../../build/tools/semantic-identifiers.js");
    const { refreshChunkIndexState } = await import("../../build/tools/chunk-index.js");
    const { refreshStructureIndexState } = await import("../../build/tools/full-index-artifacts.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-invalidation-"));

    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      const targetPath = join(rootDir, "src", "app.ts");
      const firstVersion = [
        "// Invalidation fixture for content hash verification",
        "// FEATURE: content hash must beat size and mtime heuristics",
        "export function marker(): string {",
        "  return 'alpha';",
        "}",
        "",
      ].join("\n");
      const secondVersion = firstVersion.replace("'alpha'", "'omega'");

      assert.equal(firstVersion.length, secondVersion.length);
      await writeFile(targetPath, firstVersion);

      await ensureFileSearchIndex(rootDir);
      await ensureIdentifierSearchIndex(rootDir);
      const firstChunkRefresh = await refreshChunkIndexState(rootDir);
      const firstStructureRefresh = await refreshStructureIndexState(rootDir);
      const originalStat = await stat(targetPath);

      await writeFile(targetPath, secondVersion);
      await utimes(targetPath, originalStat.atime, originalStat.mtime);

      const secondFileIndex = await ensureFileSearchIndex(rootDir);
      const secondIdentifierIndex = await ensureIdentifierSearchIndex(rootDir);
      const secondChunkRefresh = await refreshChunkIndexState(rootDir);
      const secondStructureRefresh = await refreshStructureIndexState(rootDir);

      assert.equal(secondFileIndex.stats.changedFiles, 1);
      assert.equal(secondIdentifierIndex.stats.changedFiles, 1);
      assert.equal(secondChunkRefresh.stats.changedFiles, 1);
      assert.equal(secondStructureRefresh.stats.changedFiles, 1);

      const firstChunk = firstChunkRefresh.state.files["src/app.ts"].chunks.find((chunk) => chunk.symbolName === "marker");
      const secondChunk = secondChunkRefresh.state.files["src/app.ts"].chunks.find((chunk) => chunk.symbolName === "marker");
      assert.ok(firstChunk);
      assert.ok(secondChunk);
      assert.notEqual(firstChunk.contentHash, secondChunk.contentHash);
      assert.equal(firstStructureRefresh.state.files["src/app.ts"].contentHash === secondStructureRefresh.state.files["src/app.ts"].contentHash, false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("recomputes dependent structure artifacts when an imported local dependency changes", async () => {
    const { refreshStructureIndexState } = await import("../../build/tools/full-index-artifacts.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-dependency-invalidation-"));

    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "helper.ts"),
        [
          "// Dependency invalidation fixture for helper module",
          "// FEATURE: importer artifacts must refresh when this module changes",
          "export function sharedValue(): string {",
          "  return 'alpha';",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "consumer.ts"),
        [
          "// Dependency invalidation fixture for importer module",
          "// FEATURE: structure artifacts track local imports",
          "import { sharedValue } from './helper';",
          "",
          "export function consumeValue(): string {",
          "  return sharedValue();",
          "}",
          "",
        ].join("\n"),
      );

      const firstRefresh = await refreshStructureIndexState(rootDir);
      await writeFile(
        join(rootDir, "src", "helper.ts"),
        [
          "// Dependency invalidation fixture for helper module",
          "// FEATURE: importer artifacts must refresh when this module changes",
          "export function sharedValue(): string {",
          "  return 'omega';",
          "}",
          "",
        ].join("\n"),
      );

      const secondRefresh = await refreshStructureIndexState(rootDir);
      const firstConsumer = firstRefresh.state.files["src/consumer.ts"];
      const secondConsumer = secondRefresh.state.files["src/consumer.ts"];

      assert.equal(firstRefresh.stats.changedFiles, 2);
      assert.equal(secondRefresh.stats.changedFiles, 2);
      assert.deepEqual(firstConsumer.artifact.dependencyPaths, ["src/helper.ts"]);
      assert.deepEqual(secondConsumer.artifact.dependencyPaths, ["src/helper.ts"]);
      assert.notEqual(firstConsumer.dependencyHash, secondConsumer.dependencyHash);
      assert.equal(firstConsumer.contentHash, secondConsumer.contentHash);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
