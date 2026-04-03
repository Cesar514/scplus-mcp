// Index persistence throttling tests for the codebase index entrypoint
// FEATURE: Debounced status persistence for bursty indexing progress updates

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("index-codebase", () => {
  it("debounces repeated progress persistence within the same phase but persists phase changes immediately", async () => {
    const { createIndexProgressPersistenceController } = await import("../../build/tools/index-codebase.js");

    let nowMs = 0;
    let persistCount = 0;
    const controller = createIndexProgressPersistenceController({
      now: () => nowMs,
      minIntervalMs: 1000,
      persist: async () => {
        persistCount++;
      },
    });

    assert.equal(await controller.persist("file-scan"), true);
    assert.equal(persistCount, 1);

    nowMs = 250;
    assert.equal(await controller.persist("file-scan"), false);
    assert.equal(persistCount, 1);

    nowMs = 500;
    assert.equal(await controller.persist("identifier-scan"), true);
    assert.equal(persistCount, 2);

    nowMs = 1100;
    assert.equal(await controller.persist("identifier-scan"), false);
    assert.equal(persistCount, 2);

    nowMs = 1600;
    assert.equal(await controller.persist("identifier-scan"), true);
    assert.equal(persistCount, 3);
  });

  it("persists stage timing and throughput observability in index status", async () => {
    process.env.SCPLUS_EMBED_PROVIDER = "mock";
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const { createIndexRuntime, loadIndexStatus } = await import("../../build/tools/index-stages.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-index-observability-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "app.ts"),
        "// Index observability fixture for persisted stage timing verification\n// FEATURE: Stage timing and throughput metrics in index status\n\nexport function runApp() {\n  return helperValue();\n}\n\nfunction helperValue() {\n  return 1;\n}\n",
      );

      await indexCodebase({ rootDir, mode: "full" });
      const runtime = await createIndexRuntime({ rootDir, mode: "full" });
      const status = await loadIndexStatus(runtime, new Date().toISOString());

      assert.equal(status.state, "completed");
      assert.equal(status.observability.stages["bootstrap"].durationMs > 0, true);
      assert.equal(status.observability.stages["file-search"].durationMs > 0, true);
      assert.equal(status.observability.stages["identifier-search"].durationMs > 0, true);
      assert.equal(status.observability.stages["full-artifacts"].durationMs > 0, true);
      assert.equal(typeof status.observability.stages["file-search"].filesPerSecond, "number");
      assert.equal(typeof status.observability.stages["identifier-search"].embedsPerSecond, "number");
      assert.equal(typeof status.observability.stages["full-artifacts"].chunksPerSecond, "number");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
