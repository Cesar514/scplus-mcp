import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshPreparedIndexAfterWrite,
  getWriteFreshnessRuntimeStats,
  resetWriteFreshnessRuntimeStats,
} from "../../build/tools/write-freshness.js";
import { ensureScplusLayout, SCPLUS_INDEX_DB_FILE } from "../../build/core/project-layout.js";

describe("write-freshness", () => {
  beforeEach(() => {
    resetWriteFreshnessRuntimeStats();
  });

  describe("refreshPreparedIndexAfterWrite", () => {
    it("catches errors and updates runtime stats on failure", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "scplus-write-freshness-"));
      try {
        await ensureScplusLayout(rootDir);

        // We'll intentionally cause an error by passing a directory where resolveRefreshMode
        // throws an error because the index-serving generation is 1 (or anything > 0)
        // but project-config is missing.
        // Wait, `markPreparedIndexDirtyAfterWrite` needs the directory to not be fully broken.
        // `updateIndexServingFreshness` creates the layout and DB if it doesn't exist, and the active generation is 0.
        // Oh wait, if activeGeneration is 0, resolveRefreshMode returns DEFAULT_INDEX_MODE ("full").
        // Then `indexCodebase` would run, which might succeed or fail.
        // Alternatively, we can manually set activeGeneration to 1 and NOT write `project-config`,
        // which exactly matches the error condition in `resolveRefreshMode`:
        // "Prepared index is missing project-config for the active serving generation."

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
  });
});
