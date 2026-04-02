// Index persistence throttling tests for the codebase index entrypoint
// FEATURE: Debounced status persistence for bursty indexing progress updates

import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
});
