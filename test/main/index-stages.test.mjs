import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndexRuntime, loadIndexStatus, loadIndexStageState, executeIndexStage } from "../../build/tools/index-stages.js";

describe("index-stages", () => {
  it("persists stage failure on error during executeIndexStage", async () => {
    const originalProvider = process.env.SCPLUS_EMBED_PROVIDER;
    process.env.SCPLUS_EMBED_PROVIDER = "mock";
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-index-stages-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "app.ts"),
        "export function run() { return 1; }\n",
      );

      const runtime = await createIndexRuntime({ rootDir, mode: "full" });
      const stageState = await loadIndexStageState(runtime);
      const status = await loadIndexStatus(runtime, new Date().toISOString());

      // Mark dependencies as completed to allow the stage to run
      stageState.stages["bootstrap"].state = "completed";
      stageState.stages["file-search"].state = "completed";
      stageState.stages["identifier-search"].state = "completed";

      let persistCalled = false;

      await assert.rejects(
        executeIndexStage({
          runtime,
          status,
          stageState,
          stage: "full-artifacts",
          onFullProgress: () => {
            throw new Error("Simulated failure in full index artifacts");
          },
          persist: () => {
            persistCalled = true;
          }
        }),
        /Simulated failure in full index artifacts/
      );

      assert.equal(persistCalled, true);
      assert.equal(stageState.stages["full-artifacts"].state, "failed");
      assert.equal(stageState.stages["full-artifacts"].lastError, "Simulated failure in full index artifacts");
      assert.equal(status.stages["full-artifacts"].state, "failed");
    } finally {
      if (originalProvider === undefined) delete process.env.SCPLUS_EMBED_PROVIDER;
      else process.env.SCPLUS_EMBED_PROVIDER = originalProvider;
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
