import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import {
  FileSearchRefreshError,
  ensureFileSearchIndex,
  invalidateSearchCache,
  semanticCodeSearch,
} from "../../build/tools/semantic-search.js";
import {
  resetTreeSitterRuntimeStateForTests,
  setTreeSitterParserFactoryForTests,
} from "../../build/core/tree-sitter.js";

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

describe("semantic-search", () => {
  describe("invalidateSearchCache", () => {
    it("is a function", () => {
      assert.equal(typeof invalidateSearchCache, "function");
    });

    it("does not throw when called", () => {
      assert.doesNotThrow(() => invalidateSearchCache());
    });

    it("can be called multiple times", () => {
      invalidateSearchCache();
      invalidateSearchCache();
      invalidateSearchCache();
      assert.ok(true);
    });
  });

  describe("semanticCodeSearch (structural)", () => {
    it("is exported as a function", async () => {
      const mod = await import("../../build/tools/semantic-search.js");
      assert.equal(typeof mod.semanticCodeSearch, "function");
    });

    it("has expected parameter signature (rootDir, query, topK)", async () => {
      const mod = await import("../../build/tools/semantic-search.js");
      assert.equal(mod.semanticCodeSearch.length, 1);
    });

    it("skips oversized data files and still indexes source files", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "scplus-semantic-search-"),
      );
      const originalEmbed = Ollama.prototype.embed;
      const previousSizeLimit = process.env.SCPLUS_MAX_EMBED_FILE_SIZE;

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((value) => [
            value.includes("greet") ? 1 : 0.25,
          ]),
        };
      };

      process.env.SCPLUS_MAX_EMBED_FILE_SIZE = "1024";

      try {
        await writeFile(
          join(rootDir, "app.ts"),
          [
            "// Semantic search fixture header line one two three four",
            "// FEATURE: semantic search fixture coverage for mixed data projects",
            "export function greet(name: string): string {",
            "  return `hello ${name}`;",
            "}",
            "",
          ].join("\n"),
        );
        await writeFile(
          join(rootDir, "data.json"),
          JSON.stringify({
            rows: Array.from({ length: 50000 }, (_, idx) => ({
              id: idx,
              value: `payload_${idx}`,
            })),
          }),
        );

        invalidateSearchCache();
        const result = await semanticCodeSearch({
          rootDir,
          query: "greet",
          topK: 3,
        });
        assert.match(result, /app\.ts/);
        assert.doesNotMatch(result, /data\.json/);
      } finally {
        if (previousSizeLimit === undefined)
          delete process.env.SCPLUS_MAX_EMBED_FILE_SIZE;
        else process.env.SCPLUS_MAX_EMBED_FILE_SIZE = previousSizeLimit;
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("persists file search state and refreshes only changed files on later searches", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "scplus-semantic-search-"),
      );
      const originalEmbed = Ollama.prototype.embed;

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((value) => {
            const lower = value.toLowerCase();
            return [
              lower.includes("salute") ? 1 : 0.1,
              lower.includes("greet") ? 1 : 0.1,
              lower.includes("alpha") ? 1 : 0.1,
            ];
          }),
        };
      };

      try {
        await writeFile(
          join(rootDir, "alpha.ts"),
          [
            "// File search fixture header line one two three four",
            "// FEATURE: persisted file search refresh coverage",
            "export function greetAlpha(name: string): string {",
            "  return `hello ${name}`;",
            "}",
            "",
          ].join("\n"),
        );

        invalidateSearchCache();
        const firstResult = await semanticCodeSearch({
          rootDir,
          query: "greet alpha",
          topK: 3,
        });
        const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
        const initialState = readArtifactFromDb(dbPath, "file-search-index");

        assert.match(firstResult, /alpha\.ts/);
        assert.equal(Boolean(initialState.files["alpha.ts"]), true);
        assert.equal(typeof initialState.files["alpha.ts"].mtimeMs, "number");
        assert.equal(typeof initialState.files["alpha.ts"].ctimeMs, "number");
        assert.equal(typeof initialState.files["alpha.ts"].size, "number");

        await writeFile(
          join(rootDir, "alpha.ts"),
          [
            "// File search fixture header line one two three four",
            "// FEATURE: persisted file search refresh coverage",
            "export function saluteAlpha(name: string): string {",
            "  return `hi ${name}`;",
            "}",
            "",
          ].join("\n"),
        );

        const secondResult = await semanticCodeSearch({
          rootDir,
          query: "salute alpha",
          topK: 3,
        });
        const refreshedState = readArtifactFromDb(dbPath, "file-search-index");
        const dbState = readArtifactFromDb(dbPath, "file-search-index");

        assert.match(secondResult, /Index refresh: 1 changed, 0 removed/);
        assert.match(secondResult, /alpha\.ts/);
        assert.match(refreshedState.files["alpha.ts"].doc.content, /saluteAlpha/);
        assert.match(dbState.files["alpha.ts"].doc.content, /saluteAlpha/);
        await assert.rejects(access(join(rootDir, ".scplus", "embeddings", "file-search-index.json")));
      } finally {
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("skips content hashing on unchanged refreshes and hashes only when file metadata changes", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "scplus-semantic-search-"),
      );
      const originalEmbed = Ollama.prototype.embed;
      const alphaContent = [
        "// File search fixture header line one two three four",
        "// FEATURE: metadata-gated refresh coverage",
        "export function greetAlpha(name: string): string {",
        "  return `hello ${name}`;",
        "}",
        "",
      ].join("\n");

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((value) => {
            const lower = value.toLowerCase();
            return [
              lower.includes("greet") ? 1 : 0.1,
              lower.includes("alpha") ? 1 : 0.1,
            ];
          }),
        };
      };

      try {
        await writeFile(join(rootDir, "alpha.ts"), alphaContent);

        invalidateSearchCache();
        const firstRefresh = await ensureFileSearchIndex(rootDir);
        assert.equal(firstRefresh.stats.hashedFiles, 1);
        assert.equal(firstRefresh.stats.changedFiles, 1);

        const secondRefresh = await ensureFileSearchIndex(rootDir);
        assert.equal(secondRefresh.stats.hashedFiles, 0);
        assert.equal(secondRefresh.stats.changedFiles, 0);
        assert.equal(secondRefresh.stats.reusedDocuments, 1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(join(rootDir, "alpha.ts"), alphaContent);

        const touchedRefresh = await ensureFileSearchIndex(rootDir);
        assert.equal(touchedRefresh.stats.hashedFiles, 1);
        assert.equal(touchedRefresh.stats.changedFiles, 0);
        assert.equal(touchedRefresh.stats.reusedDocuments, 1);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("blocks refresh loudly when a previously indexed file would disappear because it now exceeds the size limit", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "scplus-semantic-search-"),
      );
      const originalEmbed = Ollama.prototype.embed;
      const previousSizeLimit = process.env.SCPLUS_MAX_EMBED_FILE_SIZE;
      const initialContent = [
        "# Phase 15 fixture",
        "",
        "small content",
        "",
      ].join("\n");

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map(() => [1, 0.2]),
        };
      };

      process.env.SCPLUS_MAX_EMBED_FILE_SIZE = "1024";

      try {
        await writeFile(join(rootDir, "notes.md"), initialContent);

        invalidateSearchCache();
        await ensureFileSearchIndex(rootDir);
        const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
        const beforeState = readArtifactFromDb(dbPath, "file-search-index");
        assert.equal(Boolean(beforeState.files["notes.md"]), true);

        await writeFile(join(rootDir, "notes.md"), "x".repeat(2048));

        await assert.rejects(
          () => ensureFileSearchIndex(rootDir),
          (error) => {
            assert.ok(error instanceof FileSearchRefreshError);
            assert.match(error.message, /notes\.md/);
            assert.match(error.message, /refresh would remove an indexed file without replacement/);
            assert.equal(error.failures[0].path, "notes.md");
            return true;
          },
        );

        const afterState = readArtifactFromDb(dbPath, "file-search-index");
        assert.equal(afterState.files["notes.md"].doc.content, beforeState.files["notes.md"].doc.content);
      } finally {
        if (previousSizeLimit === undefined)
          delete process.env.SCPLUS_MAX_EMBED_FILE_SIZE;
        else process.env.SCPLUS_MAX_EMBED_FILE_SIZE = previousSizeLimit;
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("surfaces supported-source document construction failures instead of silently dropping the file", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "scplus-semantic-search-"),
      );
      const originalEmbed = Ollama.prototype.embed;
      const sourceContent = [
        "// File search fixture header line one two three four",
        "// FEATURE: refresh failure coverage",
        "export function greetAlpha(name: string): string {",
        "  return `hello ${name}`;",
        "}",
        "",
      ].join("\n");

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map(() => [1, 0.3]),
        };
      };

      try {
        await writeFile(join(rootDir, "alpha.ts"), sourceContent);

        invalidateSearchCache();
        await ensureFileSearchIndex(rootDir);
        const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
        const beforeState = readArtifactFromDb(dbPath, "file-search-index");
        assert.equal(Boolean(beforeState.files["alpha.ts"]), true);

        await writeFile(
          join(rootDir, "alpha.ts"),
          sourceContent.replace("greetAlpha", "saluteAlpha"),
        );
        setTreeSitterParserFactoryForTests(() => ({
          setLanguage() {},
          parse() {
            throw new Error("synthetic parse failure for phase 15");
          },
          delete() {},
        }));

        await assert.rejects(
          () => ensureFileSearchIndex(rootDir),
          (error) => {
            assert.ok(error instanceof FileSearchRefreshError);
            assert.match(error.message, /alpha\.ts/);
            assert.match(error.message, /synthetic parse failure for phase 15/);
            assert.equal(error.failures[0].path, "alpha.ts");
            return true;
          },
        );

        const afterState = readArtifactFromDb(dbPath, "file-search-index");
        assert.match(afterState.files["alpha.ts"].doc.content, /greetAlpha/);
        assert.doesNotMatch(afterState.files["alpha.ts"].doc.content, /saluteAlpha/);
      } finally {
        resetTreeSitterRuntimeStateForTests();
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });
});
