// Hybrid retrieval index tests for chunk and identifier search artifacts
// FEATURE: Direct verification of persisted lexical plus dense retrieval behavior

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

describe("hybrid-retrieval", () => {
  it("persists hybrid chunk and identifier indexes in sqlite", async () => {
    const { refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const { ensureIdentifierSearchIndex } = await import("../../build/tools/semantic-identifiers.js");
    const { refreshHybridChunkIndex, refreshHybridIdentifierIndex } = await import("../../build/tools/hybrid-retrieval.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-hybrid-index-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "greeter.ts"),
        [
          "// Hybrid retrieval fixture for persisted index verification",
          "// FEATURE: chunk and identifier hybrid retrieval coverage",
          "export function shoutGreeting(name: string): string {",
          "  return `HELLO ${name.toUpperCase()}`;",
          "}",
          "",
          "export function whisperGreeting(name: string): string {",
          "  return `hello ${name.toLowerCase()}`;",
          "}",
          "",
        ].join("\n"),
      );

      const chunkRefresh = await refreshChunkIndexState(rootDir);
      const chunks = Object.values(chunkRefresh.state.files).flatMap((entry) => entry.chunks);
      await warmChunkEmbeddings(rootDir, chunks);
      await ensureIdentifierSearchIndex(rootDir);
      const hybridChunk = await refreshHybridChunkIndex(rootDir, chunkRefresh.state);
      const hybridIdentifier = await refreshHybridIdentifierIndex(rootDir);
      const dbPath = join(rootDir, ".contextplus", "state", "index.sqlite");
      const dbHybridChunk = readArtifactFromDb(dbPath, "hybrid-chunk-index");
      const dbHybridIdentifier = readArtifactFromDb(dbPath, "hybrid-identifier-index");

      assert.equal(hybridChunk.state.artifactVersion, 8);
      assert.equal(hybridChunk.state.contractVersion, 6);
      assert.equal(hybridChunk.state.source, "chunk");
      assert.equal(hybridChunk.stats.indexedDocuments >= 2, true);
      assert.equal(hybridChunk.stats.uniqueTerms >= 4, true);
      assert.equal(Object.keys(dbHybridChunk.documents).length, hybridChunk.stats.indexedDocuments);

      assert.equal(hybridIdentifier.state.artifactVersion, 8);
      assert.equal(hybridIdentifier.state.contractVersion, 6);
      assert.equal(hybridIdentifier.state.source, "identifier");
      assert.equal(hybridIdentifier.stats.indexedDocuments >= 2, true);
      assert.equal(hybridIdentifier.stats.uniqueTerms >= 4, true);
      assert.equal(Object.keys(dbHybridIdentifier.documents).length, hybridIdentifier.stats.indexedDocuments);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("ranks chunk and identifier matches with combined lexical and semantic evidence", async () => {
    const { refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const { ensureIdentifierSearchIndex } = await import("../../build/tools/semantic-identifiers.js");
    const {
      refreshHybridChunkIndex,
      refreshHybridIdentifierIndex,
      searchHybridChunkIndex,
      searchHybridIdentifierIndex,
    } = await import("../../build/tools/hybrid-retrieval.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-hybrid-search-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "greeter.ts"),
        [
          "// Hybrid retrieval fixture for ranking verification",
          "// FEATURE: lexical and semantic scoring must both affect ranking",
          "export function shoutGreeting(name: string): string {",
          "  return `HELLO ${name.toUpperCase()}`;",
          "}",
          "",
          "export function whisperGreeting(name: string): string {",
          "  return `hello ${name.toLowerCase()}`;",
          "}",
          "",
        ].join("\n"),
      );

      const chunkRefresh = await refreshChunkIndexState(rootDir);
      const chunks = Object.values(chunkRefresh.state.files).flatMap((entry) => entry.chunks);
      await warmChunkEmbeddings(rootDir, chunks);
      await ensureIdentifierSearchIndex(rootDir);
      await refreshHybridChunkIndex(rootDir, chunkRefresh.state);
      await refreshHybridIdentifierIndex(rootDir);

      const chunkMatches = await searchHybridChunkIndex(rootDir, "shout greeting upper case", { topK: 2 });
      const identifierMatches = await searchHybridIdentifierIndex(rootDir, "shout greeting upper case", { topK: 2 });

      assert.equal(chunkMatches.length >= 1, true);
      assert.equal(identifierMatches.length >= 1, true);
      assert.equal(chunkMatches[0].title, "shoutGreeting");
      assert.equal(identifierMatches[0].title, "shoutGreeting");
      assert.equal(chunkMatches[0].lexicalScore > 0, true);
      assert.equal(chunkMatches[0].semanticScore > 0, true);
      assert.equal(identifierMatches[0].lexicalScore > 0, true);
      assert.equal(identifierMatches[0].semanticScore > 0, true);
      assert.equal(chunkMatches[0].score >= chunkMatches[1].score, true);
      assert.equal(identifierMatches[0].score >= identifierMatches[1].score, true);
      assert.equal(chunkMatches[0].matchedTerms.includes("shout"), true);
      assert.equal(identifierMatches[0].matchedTerms.includes("greeting"), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
