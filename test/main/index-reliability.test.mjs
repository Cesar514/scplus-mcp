// Prepared index validation and repair tests over sqlite-backed full-engine state
// FEATURE: Crash-only validation and repair coverage for prepared query artifacts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SCPLUS_EMBED_PROVIDER = "mock";

async function createFixtureRepo(rootDir) {
  await mkdir(join(rootDir, "src", "auth"), { recursive: true });
  await mkdir(join(rootDir, "docs"), { recursive: true });
  await writeFile(
    join(rootDir, "src", "auth", "jwt.ts"),
    [
      "// JWT auth helpers for index reliability fixtures",
      "// FEATURE: reliability validation and repair coverage",
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "src", "auth", "session.ts"),
    [
      "// Session auth helpers for index reliability fixtures",
      "// FEATURE: reliability validation and repair coverage",
      "import { verifyToken } from './jwt';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "docs", "auth.md"),
    [
      "# Auth Hub",
      "",
      "- [[src/auth/jwt.ts|JWT auth code]]",
      "- [[src/auth/session.ts|Session auth code]]",
      "",
    ].join("\n"),
  );
}

describe("index-reliability", () => {
  it("fails loudly on missing required artifacts and repairs them with a targeted stage rerun", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { runResearch } = await import("../../build/tools/research.js");
    const { validatePreparedIndex, repairPreparedIndex } = await import("../../build/tools/index-reliability.js");
    const { deleteIndexArtifact } = await import("../../build/core/index-database.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-index-reliability-"));
    try {
      await createFixtureRepo(rootDir);
      await indexCodebase({ rootDir, mode: "full" });

      const validReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(validReport.ok, true);

      await deleteIndexArtifact(rootDir, "full-index-manifest");

      const invalidReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(invalidReport.ok, false);
      assert.equal(invalidReport.issues.some((issue) => issue.code === "missing-artifact"), true);

      await assert.rejects(
        () => runResearch({ rootDir, query: "auth reliability validation", topK: 3 }),
        /requires a valid prepared full index/i,
      );

      const repairOutput = await repairPreparedIndex(rootDir, "full-artifacts");
      assert.match(repairOutput, /Repaired stage: full-artifacts/);
      assert.match(repairOutput, /Index validation: ok/);

      const repairedReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(repairedReport.ok, true);

      const output = await runResearch({ rootDir, query: "auth reliability validation", topK: 3 });
      assert.match(output, /^Research: "auth reliability validation"/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("detects artifact-version mismatches and repairs them", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { runCanonicalSearch } = await import("../../build/tools/unified-ranking.js");
    const { validatePreparedIndex, repairPreparedIndex } = await import("../../build/tools/index-reliability.js");
    const { loadIndexArtifact, saveIndexArtifact } = await import("../../build/core/index-database.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-index-version-"));
    try {
      await createFixtureRepo(rootDir);
      await indexCodebase({ rootDir, mode: "full" });

      const manifest = await loadIndexArtifact(rootDir, "full-index-manifest", () => {
        throw new Error("full-index-manifest missing");
      });
      await saveIndexArtifact(rootDir, "full-index-manifest", {
        ...manifest,
        artifactVersion: 999,
      });

      const invalidReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(invalidReport.ok, false);
      assert.equal(invalidReport.issues.some((issue) => issue.code === "artifact-version-mismatch"), true);

      await assert.rejects(
        () => runCanonicalSearch({
          rootDir,
          query: "auth token session",
          entityTypes: ["file", "symbol"],
          topK: 3,
        }),
        /requires a valid prepared full index/i,
      );

      const repairOutput = await repairPreparedIndex(rootDir, "full-artifacts");
      assert.match(repairOutput, /Index validation: ok/);

      const repairedReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(repairedReport.ok, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("upgrades stale status and stage metadata during a normal full reindex", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { validatePreparedIndex } = await import("../../build/tools/index-reliability.js");
    const { loadIndexArtifact, saveIndexArtifact } = await import("../../build/core/index-database.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-index-upgrade-"));
    try {
      await createFixtureRepo(rootDir);
      await indexCodebase({ rootDir, mode: "full" });

      const status = await loadIndexArtifact(rootDir, "index-status", () => {
        throw new Error("index-status missing");
      });
      const stageState = await loadIndexArtifact(rootDir, "index-stage-state", () => {
        throw new Error("index-stage-state missing");
      });

      await saveIndexArtifact(rootDir, "index-status", {
        ...status,
        artifactVersion: 5,
        contractVersion: 3,
      });
      await saveIndexArtifact(rootDir, "index-stage-state", {
        ...stageState,
        artifactVersion: 5,
        contractVersion: 3,
      });

      const staleReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(staleReport.ok, false);
      assert.equal(staleReport.issues.some((issue) => issue.code === "artifact-version-mismatch"), true);

      await indexCodebase({ rootDir, mode: "full" });

      const upgradedReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(upgradedReport.ok, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("refreshes the prepared index after checkpoint and restore so exact and related queries see post-write filesystem truth", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { proposeCommit } = await import("../../build/tools/propose-commit.js");
    const { listRestorePoints, restorePoint } = await import("../../build/git/shadow.js");
    const { lookupExactSymbol, lookupWord } = await import("../../build/tools/exact-query.js");
    const { runSearchByIntent } = await import("../../build/tools/query-intent.js");
    const { runResearch } = await import("../../build/tools/research.js");
    const { loadIndexServingState } = await import("../../build/core/index-database.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-write-refresh-"));
    try {
      await createFixtureRepo(rootDir);
      await indexCodebase({ rootDir, mode: "full" });

      const checkpointOutput = await proposeCommit({
        rootDir,
        filePath: "src/auth/jwt.ts",
        newContent: [
          "// JWT auth helpers for index reliability fixtures",
          "// FEATURE: reliability validation and repair coverage",
          "export function normalizeToken(token: string): string {",
          "  return token.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      });
      assert.match(checkpointOutput, /Index refresh completed in full mode\./);

      const afterCheckpoint = await loadIndexServingState(rootDir);
      assert.equal(afterCheckpoint.activeGenerationFreshness, "fresh");
      assert.ok(afterCheckpoint.activeGeneration >= 2);

      const symbolHits = await lookupExactSymbol(rootDir, "normalizeToken");
      assert.equal(symbolHits.length, 1);
      assert.equal(symbolHits[0].path, "src/auth/jwt.ts");

      const wordHits = await lookupWord(rootDir, "normalize", 10);
      assert.equal(wordHits.some((hit) => hit.path === "src/auth/jwt.ts"), true);

      const relatedResult = await runSearchByIntent({
        rootDir,
        intent: "related",
        searchType: "mixed",
        query: "normalize token auth",
        topK: 5,
      });
      assert.match(relatedResult, /normalizeToken|src\/auth\/jwt\.ts/);

      const researchResult = await runResearch({
        rootDir,
        query: "How does normalize token auth work across this repository?",
        topK: 5,
      });
      assert.match(researchResult, /normalizeToken|src\/auth\/jwt\.ts/);

      const [restorePointEntry] = (await listRestorePoints(rootDir)).slice(-1);
      assert.ok(restorePointEntry);
      const restoredFiles = await restorePoint(rootDir, restorePointEntry.id);
      assert.deepEqual(restoredFiles, ["src/auth/jwt.ts"]);

      const afterRestore = await loadIndexServingState(rootDir);
      assert.equal(afterRestore.activeGenerationFreshness, "fresh");
      assert.ok(afterRestore.activeGeneration > afterCheckpoint.activeGeneration);

      const restoredSymbolHits = await lookupExactSymbol(rootDir, "verifyToken");
      assert.equal(restoredSymbolHits.length, 1);
      assert.equal(restoredSymbolHits[0].path, "src/auth/jwt.ts");
      const removedSymbolHits = await lookupExactSymbol(rootDir, "normalizeToken");
      assert.equal(removedSymbolHits.length, 0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects prepared-index queries when the active generation is marked dirty or blocked", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { validatePreparedIndex } = await import("../../build/tools/index-reliability.js");
    const { lookupExactSymbol } = await import("../../build/tools/exact-query.js");
    const { updateIndexServingFreshness } = await import("../../build/core/index-database.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-dirty-serving-"));
    try {
      await createFixtureRepo(rootDir);
      await indexCodebase({ rootDir, mode: "full" });

      await updateIndexServingFreshness(rootDir, "dirty");
      const dirtyReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(dirtyReport.ok, false);
      assert.equal(dirtyReport.issues.some((issue) => issue.code === "serving-generation-not-fresh"), true);
      await assert.rejects(
        () => lookupExactSymbol(rootDir, "verifyToken"),
        /serving generation 1 is dirty/i,
      );

      await updateIndexServingFreshness(rootDir, "blocked", "manual blocked test");
      const blockedReport = await validatePreparedIndex({ rootDir, mode: "full" });
      assert.equal(blockedReport.ok, false);
      assert.equal(blockedReport.issues.some((issue) => issue.code === "serving-generation-not-fresh"), true);
      await assert.rejects(
        () => lookupExactSymbol(rootDir, "verifyToken"),
        /manual blocked test/i,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
