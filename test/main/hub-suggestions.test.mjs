import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { indexCodebase } = await import("../../build/tools/index-codebase.js");
const { getFeatureHub } = await import("../../build/tools/feature-hub.js");

function readArtifact(dbPath, artifactKey) {
  const db = new DatabaseSync(dbPath);
  try {
    const generation = getActiveGenerationFromDb(dbPath);
    const storedKey = generation === 0 ? artifactKey : `generation:${generation}:${artifactKey}`;
    const row = db.prepare("SELECT artifact_json FROM index_artifacts WHERE artifact_key = ?").get(storedKey);
    return row ? JSON.parse(row.artifact_json) : null;
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

describe("hub suggestions", () => {
  it("persists suggested hubs and feature groups from full-index artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-hub-suggestions-"));
    const previousProvider = process.env.CONTEXTPLUS_EMBED_PROVIDER;
    process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";
    try {
      await mkdir(join(rootDir, "src", "auth"), { recursive: true });
      await mkdir(join(rootDir, "src", "billing"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "auth", "login.ts"),
        [
          "// Login flow handler",
          "// FEATURE: Authentication",
          "",
          "export function login() {",
          '  return "ok";',
          "}",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "auth", "session.ts"),
        [
          "// Session refresh logic",
          "// FEATURE: Authentication",
          "",
          "export function refreshSession() {",
          '  return "session";',
          "}",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "billing", "invoice.ts"),
        [
          "// Invoice generation service",
          "// FEATURE: Billing",
          "",
          "export function generateInvoice() {",
          '  return "invoice";',
          "}",
        ].join("\n"),
      );

      await indexCodebase({ rootDir, mode: "full" });

      const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
      const state = readArtifact(dbPath, "hub-suggestion-index");
      assert.ok(state);
      assert.equal(state.artifactVersion, 17);
      assert.equal(state.contractVersion, 13);
      assert.equal(Object.keys(state.suggestions).length >= 1, true);
      assert.equal(Object.keys(state.featureGroups).length >= 1, true);

      const authSuggestion = Object.values(state.suggestions).find((suggestion) => suggestion.label === "Authentication");
      assert.ok(authSuggestion);
      assert.equal(authSuggestion.featureTags.includes("Authentication"), true);
      const markdown = await readFile(join(rootDir, authSuggestion.markdownPath), "utf8");
      assert.match(markdown, /Suggested hub generated from persisted full-index artifacts/);
      assert.match(markdown, /\[\[src\/auth\/login\.ts\|/);

      const listOutput = await getFeatureHub({ rootDir });
      assert.match(listOutput, /Suggested Hubs/);
      assert.match(listOutput, /Feature Group Candidates/);
      assert.match(listOutput, /Authentication/);

      const detailOutput = await getFeatureHub({ rootDir, featureName: "Authentication" });
      assert.match(detailOutput, /Hub: Authentication/);
      assert.match(detailOutput, /src\/auth\/login\.ts/);

      const rankedOutput = await getFeatureHub({
        rootDir,
        query: "authentication session login",
        rankingMode: "both",
      });
      assert.match(rankedOutput, /Ranked hubs for: "authentication session login"/);
      assert.match(rankedOutput, /Ranking mode: both/);
      assert.match(rankedOutput, /\.scplus\/hubs\/suggested\/authentication\.md \[suggested\]/);
    } finally {
      if (previousProvider === undefined) delete process.env.CONTEXTPLUS_EMBED_PROVIDER;
      else process.env.CONTEXTPLUS_EMBED_PROVIDER = previousProvider;
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
