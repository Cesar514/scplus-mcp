// Chunk index contract tests for full-engine retrieval artifacts
// FEATURE: Direct verification of symbol chunks, fallback chunks, and chunk embedding reuse

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

describe("chunk-index", () => {
  it("builds first-class symbol and fallback chunk artifacts", async () => {
    const { buildChunkArtifactsForFile } = await import("../../build/tools/chunk-index.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-chunk-index-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "app.ts"),
        [
          "// Chunk index fixture for symbol chunk verification",
          "// FEATURE: first-class symbol chunk contract coverage",
          "export function run(name: string): string {",
          "  return name.toUpperCase();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "plain.js"),
        [
          "// Chunk index fixture for fallback chunk verification",
          "// FEATURE: file fallback chunk contract coverage",
          "const value = 1;",
          "console.log(value);",
          "",
        ].join("\n"),
      );

      const symbolChunks = await buildChunkArtifactsForFile(rootDir, "src/app.ts");
      const fallbackChunks = await buildChunkArtifactsForFile(rootDir, "src/plain.js");

      assert.equal(Array.isArray(symbolChunks), true);
      assert.equal(symbolChunks.length >= 1, true);
      const runChunk = symbolChunks.find((chunk) => chunk.symbolName === "run");
      assert.ok(runChunk);
      assert.equal(runChunk.chunkType, "symbol");
      assert.equal(runChunk.symbolKind, "function");
      assert.deepEqual(runChunk.symbolPath, ["run"]);
      assert.equal(runChunk.lineCount >= 1, true);
      assert.match(runChunk.content, /export function run/);
      assert.match(runChunk.contentHash, /^[a-f0-9]{64}$/);

      assert.equal(Array.isArray(fallbackChunks), true);
      assert.equal(fallbackChunks.length, 1);
      assert.equal(fallbackChunks[0].chunkType, "file-fallback");
      assert.equal(fallbackChunks[0].symbolKind, "file");
      assert.equal(fallbackChunks[0].symbolName, "file");
      assert.deepEqual(fallbackChunks[0].symbolPath, []);
      assert.match(fallbackChunks[0].content, /console\.log/);
      assert.match(fallbackChunks[0].contentHash, /^[a-f0-9]{64}$/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists versioned chunk state and reuses chunk embeddings on repeated warmups", async () => {
    const { buildChunkArtifactsForFile, refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-chunk-index-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "app.ts"),
        [
          "// Chunk index fixture for sqlite state verification",
          "// FEATURE: chunk state contract and embedding cache coverage",
          "export function run(name: string): string {",
          "  return name.toUpperCase();",
          "}",
          "",
        ].join("\n"),
      );

      const firstRefresh = await refreshChunkIndexState(rootDir);
      const secondRefresh = await refreshChunkIndexState(rootDir);
      const chunks = await buildChunkArtifactsForFile(rootDir, "src/app.ts");
      const firstWarm = await warmChunkEmbeddings(rootDir, chunks);
      const secondWarm = await warmChunkEmbeddings(rootDir, chunks);
      const dbPath = join(rootDir, ".contextplus", "state", "index.sqlite");
      const chunkState = readArtifactFromDb(dbPath, "chunk-search-index");
      const chunkCache = readArtifactFromDb(dbPath, "embedding-cache:chunk-embeddings-cache.json");

      assert.equal(firstRefresh.state.artifactVersion, 8);
      assert.equal(firstRefresh.state.contractVersion, 6);
      assert.equal(firstRefresh.state.mode, "full");
      assert.equal(firstRefresh.stats.totalFiles, 1);
      assert.equal(firstRefresh.stats.changedFiles, 1);
      assert.equal(firstRefresh.stats.indexedChunks >= 1, true);
      assert.equal(secondRefresh.stats.changedFiles, 0);
      assert.equal(secondRefresh.stats.removedFiles, 0);
      assert.equal(Array.isArray(chunks), true);
      assert.equal(chunks.length >= 1, true);
      assert.equal(firstWarm.embeddedChunks, chunks.length);
      assert.equal(firstWarm.reusedChunks, 0);
      assert.equal(secondWarm.embeddedChunks, 0);
      assert.equal(secondWarm.reusedChunks, chunks.length);
      assert.equal(chunkState.files["src/app.ts"].chunks.some((chunk) => chunk.symbolName === "run"), true);
      assert.equal(Object.keys(chunkCache).length, chunks.length);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
