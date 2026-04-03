// Unified research surface tests over persisted full-engine artifacts
// FEATURE: Aggregated code, cluster, and hub research coverage

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SCPLUS_EMBED_PROVIDER = "mock";

describe("research", () => {
  it("aggregates ranked code hits with related files, subsystem context, and hubs", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { runResearch, buildResearchReport } = await import("../../build/tools/research.js");
    const { loadQueryExplanationState } = await import("../../build/tools/query-engine.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-research-"));
    try {
      await mkdir(join(rootDir, "src", "auth"), { recursive: true });
      await mkdir(join(rootDir, "docs"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "auth", "jwt.ts"),
        [
          "// JWT auth helpers for token validation and signing",
          "// FEATURE: auth research coverage for the unified report",
          "export function verifyToken(token: string): string {",
          "  return token.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "auth", "session.ts"),
        [
          "// Session auth helpers for session lifecycle management",
          "// FEATURE: auth research coverage for the unified report",
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

      await indexCodebase({ rootDir, mode: "full" });
      const explanationState = await loadQueryExplanationState(rootDir);
      assert.equal(typeof explanationState.fileCards["src/auth/jwt.ts"].purposeSummary, "string");
      assert.equal(explanationState.fileCards["src/auth/jwt.ts"].publicApiCard.includes("verifyToken"), true);
      assert.equal(explanationState.moduleCards["src/auth"].purposeSummary.includes("src/auth"), true);

      const report = await buildResearchReport({
        rootDir,
        query: "auth token session verification",
        topK: 4,
      });
      const output = await runResearch({
        rootDir,
        query: "auth token session verification",
        topK: 4,
      });

      assert.equal(report.fileCards.length >= 1, true);
      assert.equal(report.moduleCards.length >= 1, true);
      assert.equal(report.layers.explanation.artifactKeys.includes("query-explanation-index"), true);
      assert.match(report.semanticSummary.answer, /src\/auth\/jwt\.ts|src\/auth\/session\.ts/);
      assert.match(output, /^Research: "auth token session verification"/);
      assert.match(output, /Semantic answer:/);
      assert.match(output, /Key findings:/);
      assert.match(output, /Recommended files:/);
      assert.match(output, /Code hits:/);
      assert.match(output, /Explanation context:/);
      assert.match(output, /Module context:/);
      assert.match(output, /Purpose:/);
      assert.match(output, /Public API:/);
      assert.match(output, /Change risk:/);
      assert.match(output, /src\/auth\/jwt\.ts/);
      assert.match(output, /src\/auth\/session\.ts/);
      assert.match(output, /Related context:/);
      assert.match(output, /Subsystem context:/);
      assert.match(output, /Hub context:/);
      assert.match(output, /\[manual\] docs\/auth\.md \| Auth Hub/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
