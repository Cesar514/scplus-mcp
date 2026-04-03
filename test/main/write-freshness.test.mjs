import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
process.env.SCPLUS_EMBED_PROVIDER = "mock";

async function git(rootDir, ...args) {
  await execFileAsync("git", args, { cwd: rootDir });
}

describe("write-freshness runtime stats", () => {
  let rootDir;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "scplus-test-freshness-"));
    await git(rootDir, "init");
    await git(rootDir, "config", "user.name", "Test User");
    await git(rootDir, "config", "user.email", "test@example.com");

    const { resetWriteFreshnessRuntimeStats } = await import("../../build/tools/write-freshness.js");
    resetWriteFreshnessRuntimeStats();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns default stats initially", async () => {
    const { getWriteFreshnessRuntimeStats } = await import("../../build/tools/write-freshness.js");
    const stats = getWriteFreshnessRuntimeStats();
    assert.deepEqual(stats, { refreshFailures: 0 });
    assert.equal(stats.lastRefreshFailure, undefined);
  });

  it("safely clones stats on retrieval to prevent mutation", async () => {
    const { getWriteFreshnessRuntimeStats, refreshPreparedIndexAfterWrite } = await import("../../build/tools/write-freshness.js");
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");

    await mkdir(join(rootDir, "src"));
    await writeFile(join(rootDir, "src", "foo.ts"), "export const foo = 1;");
    await git(rootDir, "add", ".");
    await git(rootDir, "commit", "-m", "init");

    // Let the indexer build properly
    await indexCodebase({ rootDir, mode: "full" });

    // Intentionally corrupt the index artifacts JSON to force `resolveRefreshMode` to fail.
    // This correctly simulates a failure INSIDE the target try-catch block!
    const dbPath = join(rootDir, ".scplus", "state", "index.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);

    // Overwrite the project config json to be invalid JSON
    db.exec(`UPDATE index_artifacts SET artifact_json = '{"invalid' WHERE artifact_key LIKE '%project-config'`);
    db.close();

    let threw = false;
    try {
      await refreshPreparedIndexAfterWrite({
        rootDir,
        relativePaths: ["src/foo.ts"],
        cause: "checkpoint"
      });
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes("Run repair_index"), `Unexpected error message: ${e.message}`);
    }
    assert.ok(threw, "Should have caught the JSON error wrapped in repair_index instruction");

    const stats1 = getWriteFreshnessRuntimeStats();
    assert.equal(stats1.refreshFailures, 1);
    assert.equal(stats1.lastRefreshFailure.rootDir, join(rootDir));

    // Mutate the returned object
    stats1.lastRefreshFailure.paths.push("b.ts");

    // Retrieve again and verify it matches the unmutated state
    const stats2 = getWriteFreshnessRuntimeStats();
    assert.deepEqual(stats2.lastRefreshFailure.paths, ["src/foo.ts"]);
  });
});
