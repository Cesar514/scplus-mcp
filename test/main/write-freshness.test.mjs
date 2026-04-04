import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getWriteFreshnessRuntimeStats, resetWriteFreshnessRuntimeStats, refreshPreparedIndexAfterWrite } from "../../build/tools/write-freshness.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("write-freshness", () => {
  beforeEach(() => {
    resetWriteFreshnessRuntimeStats();
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
});
