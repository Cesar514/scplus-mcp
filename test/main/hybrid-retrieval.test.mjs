// Hybrid retrieval index tests for chunk and identifier search artifacts
// FEATURE: Direct verification of persisted lexical plus dense retrieval behavior

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";
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
      const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
      const dbHybridChunk = readArtifactFromDb(dbPath, "hybrid-chunk-index");
      const dbHybridIdentifier = readArtifactFromDb(dbPath, "hybrid-identifier-index");

      assert.equal(hybridChunk.state.artifactVersion, 17);
      assert.equal(hybridChunk.state.contractVersion, 13);
      assert.equal(hybridChunk.state.source, "chunk");
      assert.equal(hybridChunk.stats.indexedDocuments >= 2, true);
      assert.equal(hybridChunk.stats.uniqueTerms >= 4, true);
      assert.equal(Object.keys(dbHybridChunk.documents).length, hybridChunk.stats.indexedDocuments);
      assert.equal(Array.isArray(dbHybridChunk.lexicalIndex.terms.greeting), true);
      assert.equal(dbHybridChunk.lexicalIndex.documentCount, hybridChunk.stats.indexedDocuments);
      assert.equal(Object.values(dbHybridChunk.documents).every((document) => document.entityType === "file" || document.entityType === "symbol"), true);

      assert.equal(hybridIdentifier.state.artifactVersion, 17);
      assert.equal(hybridIdentifier.state.contractVersion, 13);
      assert.equal(hybridIdentifier.state.source, "identifier");
      assert.equal(hybridIdentifier.stats.indexedDocuments >= 2, true);
      assert.equal(hybridIdentifier.stats.uniqueTerms >= 4, true);
      assert.equal(Object.keys(dbHybridIdentifier.documents).length, hybridIdentifier.stats.indexedDocuments);
      assert.equal(Array.isArray(dbHybridIdentifier.lexicalIndex.terms.shout), true);
      assert.equal(dbHybridIdentifier.lexicalIndex.documentCount, hybridIdentifier.stats.indexedDocuments);
      assert.equal(Object.values(dbHybridIdentifier.documents).every((document) => document.entityType === "symbol"), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("ranks chunk and identifier matches with combined lexical and semantic evidence", async () => {
    const { refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const { ensureIdentifierSearchIndex } = await import("../../build/tools/semantic-identifiers.js");
    const {
      getHybridSearchRuntimeStats,
      refreshHybridChunkIndex,
      refreshHybridIdentifierIndex,
      resetHybridSearchRuntimeStats,
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
      resetHybridSearchRuntimeStats();

      const chunkSearch = await searchHybridChunkIndex(rootDir, "shout greeting upper case", { topK: 2 });
      const identifierSearch = await searchHybridIdentifierIndex(rootDir, "shout greeting upper case", { topK: 2 });
      const runtimeStats = getHybridSearchRuntimeStats();
      const chunkMatches = chunkSearch.matches;
      const identifierMatches = identifierSearch.matches;

      assert.equal(chunkMatches.length >= 1, true);
      assert.equal(identifierMatches.length >= 1, true);
      assert.equal(chunkMatches[0].title, "shoutGreeting");
      assert.equal(identifierMatches[0].title, "shoutGreeting");
      assert.equal(chunkMatches[0].entityType, "symbol");
      assert.equal(identifierMatches[0].entityType, "symbol");
      assert.equal(chunkMatches[0].lexicalScore > 0, true);
      assert.equal(chunkMatches[0].semanticScore > 0, true);
      assert.equal(identifierMatches[0].lexicalScore > 0, true);
      assert.equal(identifierMatches[0].semanticScore > 0, true);
      assert.equal(chunkMatches[0].score >= chunkMatches[1].score, true);
      assert.equal(identifierMatches[0].score >= identifierMatches[1].score, true);
      assert.equal(chunkMatches[0].matchedTerms.includes("shout"), true);
      assert.equal(identifierMatches[0].matchedTerms.includes("greeting"), true);
      assert.equal(chunkSearch.diagnostics.lexicalCandidateCount >= chunkSearch.diagnostics.finalResultCount, true);
      assert.equal(identifierSearch.diagnostics.lexicalCandidateCount >= identifierSearch.diagnostics.finalResultCount, true);
      assert.equal(chunkSearch.diagnostics.rerankCandidateCount >= chunkSearch.diagnostics.finalResultCount, true);
      assert.equal(identifierSearch.diagnostics.rerankCandidateCount >= identifierSearch.diagnostics.finalResultCount, true);
      assert.equal(chunkSearch.diagnostics.totalDocuments, 2);
      assert.equal(identifierSearch.diagnostics.totalDocuments, 2);
      assert.equal(runtimeStats.chunk.searchCalls, 1);
      assert.equal(runtimeStats.identifier.searchCalls, 1);
      assert.equal(runtimeStats.chunk.lexicalCandidateCount >= chunkSearch.diagnostics.lexicalCandidateCount, true);
      assert.equal(runtimeStats.identifier.lexicalCandidateCount >= identifierSearch.diagnostics.lexicalCandidateCount, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit symbol entity typing for a real symbol named file", async () => {
    const { refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const { refreshHybridChunkIndex, searchHybridChunkIndex } = await import("../../build/tools/hybrid-retrieval.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-hybrid-symbol-file-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "naming.ts"),
        [
          "// Hybrid retrieval fixture for symbols literally named file",
          "// FEATURE: explicit entity typing must beat title heuristics",
          "export function file(input: string): string {",
          "  return input.trim();",
          "}",
          "",
        ].join("\n"),
      );

      const chunkRefresh = await refreshChunkIndexState(rootDir);
      const chunks = Object.values(chunkRefresh.state.files).flatMap((entry) => entry.chunks);
      await warmChunkEmbeddings(rootDir, chunks);
      await refreshHybridChunkIndex(rootDir, chunkRefresh.state);

      const chunkSearch = await searchHybridChunkIndex(rootDir, "function named file trim", { topK: 3 });
      const symbolMatch = chunkSearch.matches.find((match) => match.title === "file");
      assert.ok(symbolMatch);
      assert.equal(symbolMatch.entityType, "symbol");
      assert.equal(symbolMatch.kind, "function");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports keyword retrieval as explicit lexical-only mode instead of silently treating vectors as optional", async () => {
    const { refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const { refreshHybridChunkIndex, searchHybridChunkIndex } = await import("../../build/tools/hybrid-retrieval.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-hybrid-keyword-mode-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "greeter.ts"),
        [
          "// Hybrid retrieval fixture for explicit lexical-only reporting",
          "// FEATURE: keyword-only retrieval must be reported explicitly",
          "export function shoutGreeting(name: string): string {",
          "  return `HELLO ${name.toUpperCase()}`;",
          "}",
          "",
        ].join("\n"),
      );
      const chunkRefresh = await refreshChunkIndexState(rootDir);
      const chunks = Object.values(chunkRefresh.state.files).flatMap((entry) => entry.chunks);
      await warmChunkEmbeddings(rootDir, chunks);
      await refreshHybridChunkIndex(rootDir, chunkRefresh.state);

      const result = await searchHybridChunkIndex(rootDir, "shout greeting", {
        topK: 2,
        semanticWeight: 0,
        lexicalWeight: 1,
      });
      assert.equal(result.diagnostics.retrievalMode, "keyword");
      assert.equal(result.diagnostics.vectorCoverage.state, "explicit-lexical-only");
      assert.equal(result.diagnostics.vectorCoverage.requestedVectorCount, 0);
      assert.equal(result.matches[0].lexicalScore > 0, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when a rerank candidate vector is missing", async () => {
    const { deleteVectorEntries } = await import("../../build/core/index-database.js");
    const { refreshChunkIndexState, warmChunkEmbeddings } = await import("../../build/tools/chunk-index.js");
    const { refreshHybridChunkIndex } = await import("../../build/tools/hybrid-retrieval.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-hybrid-missing-vector-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "greeter.ts"),
        [
          "// Hybrid retrieval fixture for missing vector integrity errors",
          "// FEATURE: missing vectors must fail loudly during rerank",
          "export function shoutGreeting(name: string): string {",
          "  return `HELLO ${name.toUpperCase()}`;",
          "}",
          "",
        ].join("\n"),
      );
      const chunkRefresh = await refreshChunkIndexState(rootDir);
      const chunks = Object.values(chunkRefresh.state.files).flatMap((entry) => entry.chunks);
      await warmChunkEmbeddings(rootDir, chunks);
      await refreshHybridChunkIndex(rootDir, chunkRefresh.state);
      const symbolChunk = chunks.find((chunk) => chunk.symbolName === "shoutGreeting");
      assert.ok(symbolChunk);
      await deleteVectorEntries(rootDir, "chunk-search", [symbolChunk.id]);

      const script = `
        process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";
        const { searchHybridChunkIndex } = await import(${JSON.stringify(join(process.cwd(), "build", "tools", "hybrid-retrieval.js"))});
        try {
          await searchHybridChunkIndex(process.env.TEST_ROOT, "shout greeting upper case", { topK: 2 });
          console.log(JSON.stringify({ ok: true }));
        } catch (error) {
          console.log(JSON.stringify({
            ok: false,
            name: error?.name,
            source: error?.source,
            state: error?.diagnostics?.state,
            missingVectorCount: error?.diagnostics?.missingVectorCount,
            missingVectorIds: error?.diagnostics?.missingVectorIds ?? [],
          }));
        }
      `;
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        env: {
          ...process.env,
          TEST_ROOT: rootDir,
        },
      });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.ok, false);
      assert.equal(result.name, "HybridVectorIntegrityError");
      assert.equal(result.source, "chunk");
      assert.equal(result.state, "missing-vectors");
      assert.equal(result.missingVectorCount, 1);
      assert.equal(result.missingVectorIds.includes(symbolChunk.id), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
