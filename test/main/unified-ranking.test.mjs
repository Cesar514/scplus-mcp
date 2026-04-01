// Unified ranking engine tests over persisted full-index and memory evidence
// FEATURE: Combined file, chunk, identifier, structure, and memory ranking

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

describe("unified-ranking", () => {
  it("combines file, chunk, identifier, structure, and memory evidence for symbol ranking", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { upsertNode } = await import("../../build/core/memory-graph.js");
    const { rankUnifiedSearch } = await import("../../build/tools/unified-ranking.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-unified-ranking-"));
    try {
      await mkdir(join(rootDir, "src", "lib"), { recursive: true });
      await mkdir(join(rootDir, "src", "services"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "lib", "normalize.ts"),
        [
          "// Normalization helper for unified ranking fixtures",
          "// FEATURE: structure and import evidence for ranking tests",
          "export function normalizeUserQuery(input: string): string {",
          "  return input.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "services", "ranking.ts"),
        [
          "// Ranking service for unified search fixture",
          "// FEATURE: file, symbol, structure, and memory evidence should converge",
          "import { normalizeUserQuery } from '../lib/normalize';",
          "",
          "export function rankUnifiedResults(query: string): string {",
          "  const normalized = normalizeUserQuery(query);",
          "  return `ranked:${normalized}`;",
          "}",
          "",
        ].join("\n"),
      );

      await indexCodebase({ rootDir, mode: "full" });
      await upsertNode(
        rootDir,
        "note",
        "ranking evidence memory",
        "rank unified results should favor the ranking service symbol",
        {
          path: "src/services/ranking.ts",
          symbolName: "rankUnifiedResults",
          line: "5",
        },
      );

      const fileHits = await rankUnifiedSearch({
        rootDir,
        query: "ranking unified results normalize query",
        entityTypes: ["file"],
        topK: 3,
      });
      const symbolHits = await rankUnifiedSearch({
        rootDir,
        query: "ranking unified results normalize query",
        entityTypes: ["symbol"],
        topK: 3,
      });

      assert.equal(fileHits.length >= 1, true);
      assert.equal(symbolHits.length >= 1, true);
      assert.equal(fileHits[0].path, "src/services/ranking.ts");
      assert.equal(symbolHits[0].path, "src/services/ranking.ts");
      assert.equal(symbolHits[0].title, "rankUnifiedResults");
      assert.equal(fileHits[0].evidence.file > 0, true);
      assert.equal(fileHits[0].evidence.chunk > 0, true);
      assert.equal(fileHits[0].evidence.structure > 0, true);
      assert.equal(symbolHits[0].evidence.file > 0, true);
      assert.equal(symbolHits[0].evidence.chunk > 0, true);
      assert.equal(symbolHits[0].evidence.identifier > 0, true);
      assert.equal(symbolHits[0].evidence.structure > 0, true);
      assert.equal(symbolHits[0].evidence.memory > 0, true);
      assert.equal(symbolHits[0].evidence.semantic > 0, true);
      assert.equal(symbolHits[0].evidence.lexical > 0, true);
      assert.equal(symbolHits[0].evidence.supportingChunkIds.length >= 1, true);
      assert.equal(symbolHits[0].evidence.supportingIdentifierIds.length >= 1, true);
      assert.equal(symbolHits[0].evidence.supportingMemoryNodeIds.length >= 1, true);
      if (symbolHits[1]) {
        assert.equal(symbolHits[0].score >= symbolHits[1].score, true);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
