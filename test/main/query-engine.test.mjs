// Query explanation artifact tests over prepared full-engine indexing state.
// FEATURE: Persisted Layer C explanation substrate for broad research.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

describe("query-engine", () => {
  it("persists explanation cards for files, modules, subsystems, and hubs", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { loadQueryExplanationState } = await import("../../build/tools/query-engine.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-query-engine-"));
    try {
      await mkdir(join(rootDir, "src", "auth"), { recursive: true });
      await mkdir(join(rootDir, "docs"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "auth", "jwt.ts"),
        [
          "// JWT auth helpers for query engine explanation coverage",
          "// FEATURE: query engine explanation coverage",
          "export function verifyToken(token: string): string {",
          "  return token.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "auth", "session.ts"),
        [
          "// Session auth helpers for query engine explanation coverage",
          "// FEATURE: query engine explanation coverage",
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
      const state = await loadQueryExplanationState(rootDir);

      assert.equal(state.mode, "full");
      assert.equal(state.queryEngine.exact.tools.includes("symbol"), true);
      assert.equal(state.queryEngine.candidate.artifactKeys.includes("semantic-cluster-index"), true);
      assert.equal(state.queryEngine.explanation.artifactKeys.includes("query-explanation-index"), true);
      assert.equal(state.fileCards["src/auth/jwt.ts"].publicApiCard.includes("verifyToken"), true);
      assert.equal(state.fileCards["src/auth/jwt.ts"].changeRiskNote.includes("Change risk:"), true);
      assert.equal(state.moduleCards["src/auth"].publicApiCard.includes("verifyToken"), true);
      assert.equal(Object.keys(state.subsystemCards).length >= 1, true);
      assert.equal(Object.values(state.hubCards).some((card) => card.path === "docs/auth.md"), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
