// Fast exact-query substrate tests over prepared full-index artifacts and git state
// FEATURE: Direct verification of cached exact symbol, word, outline, dependency, and change/status queries

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

async function git(rootDir, ...args) {
  await execFileAsync("git", args, { cwd: rootDir });
}

async function createFixtureRepo(rootDir) {
  await mkdir(join(rootDir, "src", "auth"), { recursive: true });
  await mkdir(join(rootDir, "scripts"), { recursive: true });
  await writeFile(
    join(rootDir, "src", "auth", "jwt.ts"),
    [
      "// JWT auth helpers for fast exact-query fixtures",
      "// FEATURE: exact query cache coverage",
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "src", "auth", "session.ts"),
    [
      "// Session auth helpers for fast exact-query fixtures",
      "// FEATURE: exact query cache coverage",
      "import { verifyToken } from './jwt.js';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "scripts", "setup-auth.ts"),
    [
      "// Script used to bootstrap auth fixtures",
      "// FEATURE: exact query cache coverage",
      "import { createSession } from '../src/auth/session.js';",
      "",
      "export function setupAuth(): string {",
      "  return createSession('Token');",
      "}",
      "",
    ].join("\n"),
  );
}

describe("exact-query", () => {
  it("builds fast exact-query caches for symbols, words, outlines, dependencies, and git changes", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const {
      getDependencyInfo,
      getOutline,
      getRepoChanges,
      getRepoStatus,
      invalidateFastQueryCache,
      lookupExactSymbol,
      lookupWord,
    } = await import("../../build/tools/exact-query.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-exact-query-"));
    try {
      await createFixtureRepo(rootDir);
      await git(rootDir, "init");
      await git(rootDir, "config", "user.email", "codex@example.com");
      await git(rootDir, "config", "user.name", "Codex");
      await git(rootDir, "add", ".");
      await git(rootDir, "commit", "-m", "initial");

      await indexCodebase({ rootDir, mode: "full" });

      const symbolHits = await lookupExactSymbol(rootDir, "verifyToken");
      assert.equal(symbolHits.length > 0, true);
      assert.equal(symbolHits[0].path, "src/auth/jwt.ts");
      assert.equal(symbolHits[0].line, 3);

      const wordHits = await lookupWord(rootDir, "auth", 8);
      assert.equal(wordHits.some((hit) => hit.path === "scripts/setup-auth.ts"), true);
      assert.equal(wordHits.some((hit) => hit.path === "src/auth/jwt.ts"), true);

      const outline = await getOutline(rootDir, "src/auth/session.ts");
      assert.equal(outline.path, "src/auth/session.ts");
      assert.equal(outline.symbols.some((symbol) => symbol.name === "createSession"), true);
      assert.equal(outline.imports.some((entry) => entry.source === "./jwt.js"), true);

      const deps = await getDependencyInfo(rootDir, "src/auth/jwt.ts");
      assert.deepEqual(deps.directDependencies, []);
      assert.equal(deps.reverseDependencies.includes("src/auth/session.ts"), true);

      const cleanStatus = await getRepoStatus(rootDir);
      assert.equal(cleanStatus.modifiedCount, 0);
      assert.equal(cleanStatus.untrackedCount, 0);

      await writeFile(
        join(rootDir, "src", "auth", "session.ts"),
        [
          "// Session auth helpers for fast exact-query fixtures",
          "// FEATURE: exact query cache coverage",
          "import { verifyToken } from './jwt.js';",
          "",
          "export function createSession(token: string): string {",
          "  return `session:${verifyToken(token)}:changed`;",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "scripts", "auth-status.ts"),
        [
          "// Extra auth status script fixture",
          "// FEATURE: exact query cache coverage",
          "export const authStatus = 'dirty';",
          "",
        ].join("\n"),
      );
      invalidateFastQueryCache(rootDir);

      const dirtyStatus = await getRepoStatus(rootDir);
      assert.equal(dirtyStatus.modifiedCount >= 1, true);
      assert.equal(dirtyStatus.untrackedCount >= 1, true);
      assert.equal(dirtyStatus.files.some((file) => file.path === "src/auth/session.ts"), true);

      const changeSummary = await getRepoChanges(rootDir, { limit: 10 });
      assert.equal(changeSummary.changedFiles >= 2, true);
      assert.equal(changeSummary.files.some((file) => file.path === "src/auth/session.ts"), true);
      assert.equal(changeSummary.files.some((file) => file.path === "scripts/auth-status.ts"), true);

      const fileChanges = await getRepoChanges(rootDir, { path: "src/auth/session.ts" });
      assert.equal(fileChanges.files.length, 1);
      assert.equal(fileChanges.files[0].path, "src/auth/session.ts");
      assert.equal((fileChanges.files[0].ranges?.length ?? 0) > 0, true);
      assert.equal(fileChanges.files[0].patch.includes("createSession"), true);
      assert.equal(fileChanges.files[0].patch.includes(":changed"), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
