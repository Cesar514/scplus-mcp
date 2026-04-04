import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  refreshPreparedIndexAfterWrite,
  getWriteFreshnessRuntimeStats,
  resetWriteFreshnessRuntimeStats,
} from "../../build/tools/write-freshness.js";
import { ensureScplusLayout } from "../../build/core/project-layout.js";
import { indexCodebase } from "../../build/tools/index-codebase.js";

const execFileAsync = promisify(execFile);

async function git(rootDir, ...args) {
  await execFileAsync("git", args, { cwd: rootDir });
}

describe("write-freshness", () => {
  beforeEach(() => {
    resetWriteFreshnessRuntimeStats();
  });

  it("returns default stats initially", () => {
    const stats = getWriteFreshnessRuntimeStats();
    assert.deepEqual(stats, {
      refreshFailures: 0,
      lastRefreshFailure: undefined,
    });
    assert.equal(stats.lastRefreshFailure, undefined);
  });

  it("resetWriteFreshnessRuntimeStats clears the runtime statistics properly", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-test-"));
    try {
      const { reservePendingIndexGeneration } = await import("../../build/core/index-database.js");
      await reservePendingIndexGeneration(rootDir);
      const { DatabaseSync } = await import("node:sqlite");
      const { getIndexDatabasePath } = await import("../../build/core/index-database.js");
      const dbPath = await getIndexDatabasePath(rootDir);
      const db = new DatabaseSync(dbPath);
      db.exec(`
        UPDATE index_db_meta SET meta_value = '1' WHERE meta_key = 'activeGeneration';
      `);
      db.close();

      await assert.rejects(
        refreshPreparedIndexAfterWrite({
          rootDir,
          relativePaths: ["a.txt"],
          cause: "checkpoint",
        })
      );

      const statsAfterFailure = getWriteFreshnessRuntimeStats();
      assert.equal(statsAfterFailure.refreshFailures, 1, "Should have incremented refresh failures");
      assert.ok(statsAfterFailure.lastRefreshFailure, "Should have populated lastRefreshFailure");

      resetWriteFreshnessRuntimeStats();

      const statsAfterReset = getWriteFreshnessRuntimeStats();
      assert.equal(statsAfterReset.refreshFailures, 0, "refreshFailures should be reset to 0");
      assert.equal(statsAfterReset.lastRefreshFailure, undefined, "lastRefreshFailure should be undefined");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  describe("refreshPreparedIndexAfterWrite", () => {
    it("catches errors and updates runtime stats on failure", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "scplus-write-freshness-"));
      try {
        await ensureScplusLayout(rootDir);

        const { DatabaseSync } = await import("node:sqlite");
        const layout = await ensureScplusLayout(rootDir);
        const dbPath = join(layout.state, "index.sqlite");
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE TABLE IF NOT EXISTS index_db_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)");
        db.prepare("INSERT INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)").run("activeGeneration", "1");
        db.close();

        const initialStats = getWriteFreshnessRuntimeStats();
        assert.equal(initialStats.refreshFailures, 0);
        assert.equal(initialStats.lastRefreshFailure, undefined);

        await assert.rejects(
          refreshPreparedIndexAfterWrite({
            rootDir,
            relativePaths: ["src/missing.ts"],
            cause: "restore",
          }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(
              error.message,
              /Automatic restore refresh failed for src\/missing.ts: Prepared index is missing project-config for the active serving generation./
            );
            assert.match(
              error.message,
              /Run repair_index with target="full" after fixing the underlying indexing error./
            );
            return true;
          }
        );

        const stats = getWriteFreshnessRuntimeStats();
        assert.equal(stats.refreshFailures, 1);
        assert.ok(stats.lastRefreshFailure);
        assert.equal(stats.lastRefreshFailure.cause, "restore");
        assert.deepEqual(stats.lastRefreshFailure.paths, ["src/missing.ts"]);
        assert.match(
          stats.lastRefreshFailure.reason,
          /Automatic restore refresh failed for src\/missing.ts: Prepared index is missing project-config/
        );
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("safely clones stats on retrieval to prevent mutation", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "scplus-write-freshness-clone-"));
      try {
        await git(rootDir, "init");
        await git(rootDir, "config", "user.name", "Test User");
        await git(rootDir, "config", "user.email", "test@example.com");

        await mkdir(join(rootDir, "src"));
        await writeFile(join(rootDir, "src", "foo.ts"), "export const foo = 1;\n");
        await git(rootDir, "add", ".");
        await git(rootDir, "commit", "-m", "init");

        await indexCodebase({ rootDir, mode: "full" });

        const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath);
        db.exec("UPDATE index_artifacts SET artifact_json = '{\"invalid' WHERE artifact_key LIKE '%project-config'");
        db.close();

        await assert.rejects(
          refreshPreparedIndexAfterWrite({
            rootDir,
            relativePaths: ["src/foo.ts"],
            cause: "checkpoint",
          }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Run repair_index with target="full"/);
            return true;
          }
        );

        const stats1 = getWriteFreshnessRuntimeStats();
        assert.equal(stats1.refreshFailures, 1);
        assert.equal(stats1.lastRefreshFailure?.rootDir, rootDir);

        stats1.lastRefreshFailure?.paths.push("b.ts");

        const stats2 = getWriteFreshnessRuntimeStats();
        assert.deepEqual(stats2.lastRefreshFailure?.paths, ["src/foo.ts"]);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });
});
