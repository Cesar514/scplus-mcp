// Embedding tracker controller tests cover backend-batch refresh and native watcher removal.
// FEATURE: Verifies embedding tracking no longer starts recursive filesystem watches.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmbeddingTrackerController,
  parseEmbeddingTrackerMode,
  refreshEmbeddingsForChangedPaths,
  startEmbeddingTracker,
} from "../../build/core/embedding-tracker.js";

describe("embedding-tracker controller", () => {
  it("exports startEmbeddingTracker", async () => {
    const mod = await import("../../build/core/embedding-tracker.js");
    assert.equal(typeof mod.startEmbeddingTracker, "function");
  });

  it("startEmbeddingTracker takes one options argument", async () => {
    const mod = await import("../../build/core/embedding-tracker.js");
    assert.equal(mod.startEmbeddingTracker.length, 1);
  });

  it("parses tracker modes with off as the no-native-watch default", () => {
    assert.equal(parseEmbeddingTrackerMode(undefined), "off");
    assert.equal(parseEmbeddingTrackerMode("true"), "lazy");
    assert.equal(parseEmbeddingTrackerMode("lazy"), "lazy");
    assert.equal(parseEmbeddingTrackerMode("eager"), "eager");
    assert.equal(parseEmbeddingTrackerMode("off"), "off");
  });

  it("rejects native tracker startup and keeps built output free of fs.watch", async () => {
    assert.throws(
      () => startEmbeddingTracker({ rootDir: "." }),
      /Native embedding tracker startup is disabled/,
    );
    const source = await readFile(join(process.cwd(), "build", "core", "embedding-tracker.js"), "utf8");
    assert.doesNotMatch(source, /watch\(/);
    assert.doesNotMatch(source, /import \{ watch/);
    assert.doesNotMatch(source, /fsnotify/);
  });

  it("defers tracker startup in lazy mode", () => {
    let starts = 0;
    let stops = 0;
    const controller = createEmbeddingTrackerController({
      rootDir: ".",
      mode: "true",
      starter: () => {
        starts += 1;
        return () => {
          stops += 1;
        };
      },
    });

    assert.equal(starts, 0);
    assert.equal(controller.isRunning(), false);
    controller.ensureStarted();
    controller.ensureStarted();
    assert.equal(starts, 1);
    assert.equal(controller.isRunning(), true);
    controller.stop();
    assert.equal(stops, 1);
    assert.equal(controller.isRunning(), false);
  });

  it("starts immediately in eager mode and never starts when disabled", () => {
    let eagerStarts = 0;
    const eager = createEmbeddingTrackerController({
      rootDir: ".",
      mode: "eager",
      starter: () => {
        eagerStarts += 1;
        return () => {};
      },
    });

    assert.equal(eagerStarts, 1);
    assert.equal(eager.isRunning(), true);

    let disabledStarts = 0;
    const disabled = createEmbeddingTrackerController({
      rootDir: ".",
      mode: "false",
      starter: () => {
        disabledStarts += 1;
        return () => {};
      },
    });

    disabled.ensureStarted();
    assert.equal(disabledStarts, 0);
    assert.equal(disabled.isRunning(), false);
  });

  it("refreshes backend batches as a no-op when changed files no longer exist", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-embedding-batch-"));
    try {
      const result = await refreshEmbeddingsForChangedPaths({
        rootDir,
        relativePaths: ["missing.ts", "node_modules/ignored.ts"],
      });
      assert.deepEqual(result, {
        fileEmbeddings: 0,
        identifierEmbeddings: 0,
        refreshedPaths: [],
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
