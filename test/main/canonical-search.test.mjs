// Canonical search surface tests over the unified ranking engine
// FEATURE: Public search formatting now routes through the full-engine ranker

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

describe("canonical-search", () => {
  it("formats mixed and symbol search output from the unified ranker", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { runCanonicalSearch } = await import("../../build/tools/unified-ranking.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-canonical-search-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "search.ts"),
        [
          "// Canonical search fixture header line one",
          "// FEATURE: public search output should use unified ranking",
          "export function searchKnowledgeBase(query: string): string {",
          "  return query.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      );

      await indexCodebase({ rootDir, mode: "full" });

      const mixed = await runCanonicalSearch({
        rootDir,
        query: "canonical search knowledge base",
        entityTypes: ["file", "symbol"],
        topK: 4,
      });
      const symbolOnly = await runCanonicalSearch({
        rootDir,
        query: "canonical search knowledge base",
        entityTypes: ["symbol"],
        topK: 2,
        includeKinds: ["function"],
      });

      assert.match(mixed, /Requested result types: file, symbol/);
      assert.match(mixed, /src\/search\.ts:L3-L5 \[symbol\] searchKnowledgeBase \(function\)/);
      assert.match(mixed, /evidence file=/);
      assert.match(mixed, /supporting chunks:/);
      assert.match(mixed, /supporting identifiers:/);
      assert.match(symbolOnly, /Requested result types: symbol/);
      assert.match(symbolOnly, /\[symbol\] searchKnowledgeBase \(function\)/);
      assert.doesNotMatch(symbolOnly, /\[symbol\].+\(interface\)/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
