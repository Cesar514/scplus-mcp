// Unified ranking engine tests over persisted full-index ranking evidence
// FEATURE: Combined file, chunk, identifier, and structure ranking coverage

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";
const execFileAsync = promisify(execFile);

describe("unified-ranking", () => {
  it("combines file, chunk, identifier, and structure evidence for symbol ranking", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
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
          "// FEATURE: file, symbol, chunk, and structure evidence should converge",
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
      assert.equal(symbolHits[0].evidence.semantic > 0, true);
      assert.equal(symbolHits[0].evidence.lexical > 0, true);
      assert.equal(Number.isFinite(fileHits[0].score), true);
      assert.equal(Number.isFinite(symbolHits[0].score), true);
      assert.equal(Number.isFinite(fileHits[0].evidence.chunk), true);
      assert.equal(Number.isFinite(symbolHits[0].evidence.chunk), true);
      assert.equal(Number.isFinite(symbolHits[0].evidence.identifier), true);
      assert.equal(Number.isFinite(symbolHits[0].evidence.semantic), true);
      assert.equal(Number.isFinite(symbolHits[0].evidence.lexical), true);
      assert.equal(symbolHits[0].evidence.supportingChunkIds.length >= 1, true);
      assert.equal(symbolHits[0].evidence.supportingIdentifierIds.length >= 1, true);
      if (symbolHits[1]) {
        assert.equal(symbolHits[0].score >= symbolHits[1].score, true);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("issues exactly one embedding request per unified top-level query", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-unified-ranking-"));
    try {
      await mkdir(join(rootDir, "src", "lib"), { recursive: true });
      await mkdir(join(rootDir, "src", "services"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "lib", "normalize.ts"),
        [
          "// Normalization helper for unified ranking fixtures",
          "// FEATURE: query embedding reuse verification for unified search",
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
          "// FEATURE: query embedding reuse verification for unified search",
          "import { normalizeUserQuery } from '../lib/normalize';",
          "",
          "export function rankUnifiedResults(query: string): string {",
          "  const normalized = normalizeUserQuery(query);",
          "  return `ranked:${normalized}`;",
          "}",
          "",
        ].join("\n"),
      );

      const script = `
        const { Ollama } = await import("ollama");
        let embedCalls = 0;
        Ollama.prototype.embed = async function ({ input }) {
          embedCalls += 1;
          const batch = Array.isArray(input) ? input : [input];
          return {
            embeddings: batch.map((value) => {
              const vector = new Array(64).fill(0);
              for (let i = 0; i < Math.min(value.length, vector.length); i++) {
                vector[i] = ((value.charCodeAt(i) % 101) + 1) / 101;
              }
              const norm = Math.sqrt(vector.reduce((sum, current) => sum + current * current, 0));
              return norm > 0 ? vector.map((entry) => entry / norm) : vector;
            }),
          };
        };
        const { indexCodebase } = await import(${JSON.stringify(join(process.cwd(), "build", "tools", "index-codebase.js"))});
        const { rankUnifiedSearch } = await import(${JSON.stringify(join(process.cwd(), "build", "tools", "unified-ranking.js"))});
        await indexCodebase({ rootDir: process.env.TEST_ROOT, mode: "full" });
        embedCalls = 0;
        await rankUnifiedSearch({
          rootDir: process.env.TEST_ROOT,
          query: "ranking unified results normalize query",
          entityTypes: ["file", "symbol"],
          topK: 5,
        });
        console.log(JSON.stringify({ embedCalls }));
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "ollama",
            TEST_ROOT: rootDir,
          },
        },
      );
      const result = JSON.parse(stdout.trim());
      assert.equal(result.embedCalls, 1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not classify a real symbol named file as a file hit", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { rankUnifiedSearch } = await import("../../build/tools/unified-ranking.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-unified-symbol-file-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "naming.ts"),
        [
          "// Unified ranking fixture for a symbol literally named file",
          "// FEATURE: explicit entity typing must beat title heuristics",
          "export function file(input: string): string {",
          "  return input.trim();",
          "}",
          "",
        ].join("\n"),
      );

      await indexCodebase({ rootDir, mode: "full" });

      const symbolHits = await rankUnifiedSearch({
        rootDir,
        query: "function named file trim",
        entityTypes: ["symbol"],
        includeKinds: ["function"],
        topK: 3,
      });
      const fileHits = await rankUnifiedSearch({
        rootDir,
        query: "function named file trim",
        entityTypes: ["file"],
        topK: 3,
      });

      assert.equal(symbolHits.length >= 1, true);
      assert.equal(symbolHits[0].title, "file");
      assert.equal(symbolHits[0].entityType, "symbol");
      assert.equal(symbolHits[0].kind, "function");
      assert.equal(fileHits.some((hit) => hit.title === "file"), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
