// Runtime lock takeover coverage for same-repo scplus processes.
// FEATURE: Verified same-repo watcher and mutation lock takeover instead of fatal contention.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runtime locks", () => {
  it("allows watcher lock takeover by terminating a competing scplus-owned process", async () => {
    const { acquireRepoRuntimeLock } = await import("../../build/core/runtime-locks.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-runtime-locks-"));
    const holder = spawn("bash", ["-lc", "exec -a scplus-mcp node -e 'setInterval(() => {}, 1000)'"], {
      stdio: "ignore",
    });
    try {
      await mkdir(join(rootDir, ".scplus", "locks"), { recursive: true });
      const lockPath = join(rootDir, ".scplus", "locks", "watcher.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: "foreign-lock",
          pid: holder.pid,
          startedAt: new Date().toISOString(),
          kind: "watcher",
          rootDir,
          holder: "foreign scplus watcher",
        }, null, 2)}\n`,
      );

      const handle = await acquireRepoRuntimeLock(rootDir, "watcher", {
        holder: "test watcher takeover",
        timeoutMs: 0,
        allowTakeover: true,
      });
      await handle.release();

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(holder.exitCode !== null || holder.signalCode !== null, true);
      await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
    } finally {
      holder.kill("SIGKILL");
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
