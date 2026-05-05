// Backend scanner tests for bounded repository coverage without native watches.
// FEATURE: Verifies the backend scanner honors budgets and reports zero native watch registrations.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackendBoundedScanner,
  loadBackendScannerBudgets,
} from "../../build/cli/backend-scan-state.js";

// Purpose: Temporarily set one environment variable while an assertion runs.
// Inputs: The environment key, value, and callback to execute.
// Returns/Effects: Restores the original environment value after callback completion.
async function withEnv(key, value, callback) {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

// Purpose: Run scanner ticks until one complete coverage pass is reported.
// Inputs: The scanner instance plus a maximum number of ticks.
// Returns/Effects: Returns the completing tick or throws if coverage does not finish.
async function waitForCoverage(scanner, maxTicks = 40) {
  for (let index = 0; index < maxTicks; index++) {
    const tick = await scanner.scanTick();
    if (tick.completedCoverage) return tick;
  }
  throw new Error("scanner did not complete coverage within the expected tick budget");
}

describe("backend bounded scanner", () => {
  it("rejects invalid configured scanner budgets loudly", async () => {
    await withEnv("SCPLUS_SCAN_MAX_DIRS_PER_TICK", "0", async () => {
      assert.throws(() => loadBackendScannerBudgets(), /SCPLUS_SCAN_MAX_DIRS_PER_TICK must be a positive integer/);
    });
  });

  it("covers large directory trees in bounded ticks with zero native watches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-bounded-scanner-"));
    try {
      for (let dirIndex = 0; dirIndex < 6; dirIndex++) {
        const dirPath = join(rootDir, "src", `area-${dirIndex}`);
        await mkdir(dirPath, { recursive: true });
        for (let fileIndex = 0; fileIndex < 4; fileIndex++) {
          await writeFile(join(dirPath, `file-${fileIndex}.ts`), `export const value${dirIndex}_${fileIndex} = ${fileIndex};\n`);
        }
      }
      await mkdir(join(rootDir, "node_modules", "ignored"), { recursive: true });
      await writeFile(join(rootDir, "node_modules", "ignored", "skip.ts"), "export const ignored = true;\n");

      await withEnv("SCPLUS_SCAN_MAX_DIRS_PER_TICK", "2", async () =>
        withEnv("SCPLUS_SCAN_MAX_FILES_PER_TICK", "3", async () =>
          withEnv("SCPLUS_SCAN_MAX_MS_PER_TICK", "1000", async () => {
            const scanner = await createBackendBoundedScanner(rootDir);
            const firstTick = await scanner.scanTick();
            assert.equal(firstTick.nativeWatchCount, 0);
            assert.equal(firstTick.directoryQueueSize > 0, true);
            assert.equal(firstTick.changedPaths.length <= 3, true);

            const covered = await waitForCoverage(scanner);
            assert.equal(covered.nativeWatchCount, 0);
            assert.equal(covered.knownFileCount, 24);
            assert.equal(covered.knownDirectoryCount >= 7, true);
            assert.equal(typeof covered.lastFullCoverageAt, "string");

            await writeFile(join(rootDir, "src", "area-3", "file-2.ts"), "export const changed = 42;\n");
            const changed = new Set();
            for (let index = 0; index < 30; index++) {
              const tick = await scanner.scanTick();
              for (const path of tick.changedPaths) changed.add(path);
              if (changed.has("src/area-3/file-2.ts")) break;
            }
            assert.equal(changed.has("src/area-3/file-2.ts"), true);
          }),
        ),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
