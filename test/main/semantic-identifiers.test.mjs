import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import {
  invalidateIdentifierSearchCache,
  semanticIdentifierSearch,
} from "../../build/tools/semantic-identifiers.js";

describe("semantic-identifiers", () => {
  it("exports semanticIdentifierSearch as a function", async () => {
    const mod = await import("../../build/tools/semantic-identifiers.js");
    assert.equal(typeof mod.semanticIdentifierSearch, "function");
  });

  it("exports invalidateIdentifierSearchCache as a function", async () => {
    const mod = await import("../../build/tools/semantic-identifiers.js");
    assert.equal(typeof mod.invalidateIdentifierSearchCache, "function");
  });

  it("semanticIdentifierSearch uses single options parameter", async () => {
    const mod = await import("../../build/tools/semantic-identifiers.js");
    assert.equal(mod.semanticIdentifierSearch.length, 1);
  });

  it("persists identifier search state and refreshes only changed files on later searches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-semantic-identifiers-"));
    const originalEmbed = Ollama.prototype.embed;

    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return {
        embeddings: batch.map((value) => {
          const lower = value.toLowerCase();
          return [
            lower.includes("welcome") ? 1 : 0.1,
            lower.includes("greet") ? 1 : 0.1,
            lower.includes("user") ? 1 : 0.1,
          ];
        }),
      };
    };

    try {
      await writeFile(
        join(rootDir, "service.ts"),
        [
          "// Identifier search fixture header line one two three four",
          "// FEATURE: persisted identifier search refresh coverage",
          "export function greetUser(name: string): string {",
          "  return `hello ${name}`;",
          "}",
          "",
        ].join("\n"),
      );

      invalidateIdentifierSearchCache();
      const firstResult = await semanticIdentifierSearch({
        rootDir,
        query: "greet user",
        topK: 3,
      });
      const initialState = JSON.parse(
        await readFile(
          join(rootDir, ".contextplus", "embeddings", "identifier-search-index.json"),
          "utf8",
        ),
      );

      assert.match(firstResult, /function greetUser/);
      assert.equal(initialState.files["service.ts"].docs.some((doc) => doc.name === "greetUser"), true);

      await writeFile(
        join(rootDir, "service.ts"),
        [
          "// Identifier search fixture header line one two three four",
          "// FEATURE: persisted identifier search refresh coverage",
          "export function welcomeUser(name: string): string {",
          "  return `hello ${name}`;",
          "}",
          "",
        ].join("\n"),
      );

      const secondResult = await semanticIdentifierSearch({
        rootDir,
        query: "welcome user",
        topK: 3,
      });
      const refreshedState = JSON.parse(
        await readFile(
          join(rootDir, ".contextplus", "embeddings", "identifier-search-index.json"),
          "utf8",
        ),
      );

      assert.match(secondResult, /Index refresh: 1 changed, 0 removed/);
      assert.match(secondResult, /function welcomeUser/);
      assert.equal(refreshedState.files["service.ts"].docs.some((doc) => doc.name === "welcomeUser"), true);
    } finally {
      Ollama.prototype.embed = originalEmbed;
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
