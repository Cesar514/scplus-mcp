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
    const { runResearch, buildResearchReport, formatResearchReport } = await import("../../build/tools/research.js");
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

  it("formats full research report correctly", async () => {
    const { formatResearchReport } = await import("../../build/tools/research.js");

    const mockReport = {
      query: "test query",
      semanticSummary: {
        answer: "This is a test answer.",
        keyFindings: ["Finding 1", "Finding 2"],
        recommendedFiles: ["src/a.ts", "src/b.ts"]
      },
      searchDiagnostics: {
        retrievalMode: "keyword",
        chunk: {
          totalDocuments: 10, lexicalCandidateCount: 5, rerankCandidateCount: 2, finalResultCount: 1, retrievalMode: "keyword",
          vectorCoverage: { state: "explicit-lexical-only", requestedVectorCount: 0, loadedVectorCount: 0, missingVectorCount: 0, coverageRatio: 0, missingVectorIds: [] }
        },
        identifier: {
          totalDocuments: 10, lexicalCandidateCount: 5, rerankCandidateCount: 2, finalResultCount: 1, retrievalMode: "keyword",
          vectorCoverage: { state: "explicit-lexical-only", requestedVectorCount: 0, loadedVectorCount: 0, missingVectorCount: 0, coverageRatio: 0, missingVectorIds: [] }
        }
      },
      codeHits: [
        {
          id: "hit1", path: "src/a.ts", title: "Test A", kind: "file",
          line: 1, endLine: 10, modulePath: "src", score: 0.9,
          evidence: {
            file: 0.9, chunk: 0.8, identifier: 0.7, structure: 0.6,
            semantic: 0.5, lexical: 0.4, matchedTerms: ["test"],
            supportingChunkIds: ["chunk1"], supportingIdentifierIds: ["id1"]
          }
        }
      ],
      fileCards: [
        {
          path: "src/a.ts", score: 0.8,
          card: {
            purposeSummary: "Purpose A",
            publicApiCard: "API A",
            dependencyNeighborhoodSummary: "Deps A",
            hotPathSummary: "Hot A",
            ownershipSummary: "Own A",
            changeRiskNote: "Risk A",
            relatedContexts: []
          }
        }
      ],
      moduleCards: [
        {
          modulePath: "src", score: 0.85,
          card: {
            purposeSummary: "Mod Purpose",
            publicApiCard: "Mod API",
            dependencyNeighborhoodSummary: "Mod Deps",
            hotPathSummary: "Mod Hot",
            ownershipSummary: "Mod Own",
            changeRiskNote: "Mod Risk"
          }
        }
      ],
      relatedHits: [
        {
          path: "src/b.ts", score: 0.7, source: "cluster", reason: "related to a"
        }
      ],
      subsystemHits: [
        {
          score: 0.75,
          card: {
            label: "Subsystem A",
            overview: "Overview A",
            rationale: "Rationale A",
            filePaths: ["src/a.ts"],
            modulePaths: ["src"]
          }
        }
      ],
      hubHits: [
        {
          score: 0.6,
          card: {
            kind: "manual",
            path: "docs/a.md",
            label: "Hub A",
            overview: "Hub Overview A",
            rationale: "Hub Rationale",
            linkedPaths: ["src/a.ts"],
            modulePaths: ["src"],
            featureTags: ["test"]
          }
        }
      ],
      layers: {
        structure: { artifactKeys: [] },
        identifier: { artifactKeys: [] },
        explanation: { artifactKeys: [] }
      }
    };

    const output = formatResearchReport(mockReport);

    assert.match(output, /Research: "test query"/);
    assert.match(output, /Semantic answer:/);
    assert.match(output, /This is a test answer\./);
    assert.match(output, /Key findings:/);
    assert.match(output, /Finding 1/);
    assert.match(output, /Recommended files: src\/a\.ts, src\/b\.ts/);

    assert.match(output, /Code hits:/);
    assert.match(output, /src\/a\.ts/);

    assert.match(output, /Explanation context:/);
    assert.match(output, /Purpose A/);
    assert.match(output, /Risk A/);

    assert.match(output, /Module context:/);
    assert.match(output, /Mod Purpose/);
    assert.match(output, /Mod Risk/);

    assert.match(output, /Related context:/);
    assert.match(output, /src\/b\.ts \| cluster \| score=0.70 \| related to a/);

    assert.match(output, /Subsystem context:/);
    assert.match(output, /\[Subsystem A\] score=0.75 \| Overview A/);
    assert.match(output, /Rationale A/);
    assert.match(output, /files: src\/a\.ts/);
    assert.match(output, /modules: src/);

    assert.match(output, /Hub context:/);
    assert.match(output, /\[manual\] docs\/a\.md \| Hub A \| score=0.60/);
    assert.match(output, /Hub Overview A/);
    assert.match(output, /rationale: Hub Rationale/);
    assert.match(output, /linked files: src\/a\.ts/);
    assert.match(output, /modules: src/);
  });

  it("formats empty research report correctly", async () => {
    const { formatResearchReport } = await import("../../build/tools/research.js");

    const mockReport = {
      query: "empty query",
      semanticSummary: {
        answer: "Nothing found.",
        keyFindings: [],
        recommendedFiles: []
      },
      searchDiagnostics: {
        retrievalMode: "keyword",
        chunk: {
          totalDocuments: 10, lexicalCandidateCount: 0, rerankCandidateCount: 0, finalResultCount: 0, retrievalMode: "keyword",
          vectorCoverage: { state: "explicit-lexical-only", requestedVectorCount: 0, loadedVectorCount: 0, missingVectorCount: 0, coverageRatio: 0, missingVectorIds: [] }
        },
        identifier: {
          totalDocuments: 10, lexicalCandidateCount: 0, rerankCandidateCount: 0, finalResultCount: 0, retrievalMode: "keyword",
          vectorCoverage: { state: "explicit-lexical-only", requestedVectorCount: 0, loadedVectorCount: 0, missingVectorCount: 0, coverageRatio: 0, missingVectorIds: [] }
        }
      },
      codeHits: [],
      fileCards: [],
      moduleCards: [],
      relatedHits: [],
      subsystemHits: [],
      hubHits: [],
      layers: {
        structure: { artifactKeys: [] },
        identifier: { artifactKeys: [] },
        explanation: { artifactKeys: [] }
      }
    };

    const output = formatResearchReport(mockReport);

    assert.match(output, /Research: "empty query"/);
    assert.match(output, /Semantic answer:/);
    assert.match(output, /Nothing found\./);

    // Arrays are empty, these sections shouldn't be present or should have fallback text
    assert.doesNotMatch(output, /Key findings:/);
    assert.doesNotMatch(output, /Recommended files:/);

    assert.match(output, /Code hits:/);
    assert.match(output, /No ranked code hits found in the prepared full-engine artifacts\./);

    assert.match(output, /Explanation context:/);
    assert.match(output, /No explanation cards matched the ranked file set\./);

    assert.match(output, /Module context:/);
    assert.match(output, /No module explanation cards matched the ranked file set\./);

    assert.match(output, /Related context:/);
    assert.match(output, /No additional related files found\./);

    assert.match(output, /Subsystem context:/);
    assert.match(output, /No matching subsystem summaries found\./);

    assert.match(output, /Hub context:/);
    assert.match(output, /No relevant manual or suggested hubs found\./);
  });
});
