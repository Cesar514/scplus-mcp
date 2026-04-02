// Persistent CLI bridge coverage for long-lived request and event streaming behavior
// FEATURE: Verify the bridge-serve protocol keeps one backend alive across requests and watcher-driven jobs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}

class BridgeSession {
  constructor(cwd) {
    this.cwd = cwd;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.stderrLines = [];
    this.process = spawn(process.execPath, [join(process.cwd(), "build", "index.js"), "bridge-serve"], {
      cwd,
      env: {
        ...process.env,
        CONTEXTPLUS_EMBED_PROVIDER: "mock",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    this.readline.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.type === "response") {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.result);
          return;
        }
        pending.reject(new Error(frame.error));
        return;
      }
      if (frame.type !== "event") {
        throw new Error(`Unexpected frame type ${String(frame.type)}`);
      }
      this.events.push(frame);
      const remaining = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(frame)) {
          waiter.resolve(frame);
          continue;
        }
        remaining.push(waiter);
      }
      this.waiters = remaining;
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.stderrLines.push(...String(chunk).split("\n").filter(Boolean));
    });
  }

  request(command, args = {}) {
    const id = ++this.nextId;
    const payload = JSON.stringify({
      type: "request",
      id,
      command,
      args,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${payload}\n`);
    });
  }

  waitForEvent(predicate, timeoutMs = 20000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== pending);
        reject(new Error(`Timed out waiting for bridge event.\nstderr:\n${this.stderrLines.join("\n")}`));
      }, timeoutMs);
      const pending = {
        predicate,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
      };
      this.waiters.push(pending);
    });
  }

  async close() {
    try {
      await this.request("shutdown");
    } catch {
      // The process may already be exiting.
    }
    this.process.stdin.end();
    if (this.process.exitCode === null) {
      await new Promise((resolve) => this.process.once("exit", resolve));
    }
    this.readline.close();
  }
}

describe("bridge-serve", () => {
  it("keeps one backend process alive across requests and streams watcher-driven index events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-bridge-serve-"));
    const filePath = join(cwd, "src", "app.ts");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        filePath,
        "// Bridge serve smoke fixture for persistent backend tests\n// FEATURE: Keep one backend alive while requests and watcher events stream\n\nexport function run() {\n  return 1;\n}\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "contextplus@example.com");
      await git(cwd, "config", "user.name", "Context Plus");
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", "init");

      await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "index"],
        {
          cwd,
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = new BridgeSession(cwd);
      try {
        const [doctor, tree] = await Promise.all([
          session.request("doctor", { root: cwd }),
          session.request("tree", { root: cwd }),
        ]);
        assert.equal(doctor.root, cwd);
        assert.equal(doctor.indexValidation.ok, true);
        assert.equal(doctor.observability.scheduler.queueDepth, 0);
        assert.equal(tree.root, cwd);
        assert.equal(tree.text.includes("src/"), true);

        const watchState = await session.request("watch-set", { root: cwd, enabled: true, debounceMs: 100 });
        assert.deepEqual(watchState, { root: cwd, enabled: true });
        await session.waitForEvent((event) => event.kind === "watch-state" && event.enabled === true);

        await writeFile(
          filePath,
          "// Bridge serve smoke fixture for persistent backend tests\n// FEATURE: Keep one backend alive while requests and watcher events stream\n\nexport function rerun() {\n  return 2;\n}\n",
        );

        const batchEvent = await session.waitForEvent((event) =>
          event.kind === "watch-batch" &&
          Array.isArray(event.changedPaths) &&
          event.changedPaths.some((path) => path === "src/app.ts"),
        );
        assert.equal(batchEvent.root, cwd);
        assert.equal(typeof batchEvent.queueDepth, "number");

        const jobCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "index" &&
          event.source === "watch",
        );
        assert.equal(jobCompleted.root, cwd);
        assert.equal(typeof jobCompleted.queueDepth, "number");
        assert.equal(jobCompleted.rebuildReason.includes("watch-triggered full rebuild"), true);

        const doctorAfterWatch = await session.request("doctor", { root: cwd });
        assert.equal(doctorAfterWatch.root, cwd);
        assert.equal(doctorAfterWatch.indexValidation.ok, true);
        assert.equal(doctorAfterWatch.observability.scheduler.batchCount >= 1, true);
        assert.equal(doctorAfterWatch.observability.scheduler.fullRebuildReasons.some((reason) => reason.includes("watch-triggered full rebuild")), true);
      } finally {
        await session.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("serves the expanded bridge parity commands over the persistent session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-bridge-parity-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// Bridge parity fixture for persistent backend command coverage\n// FEATURE: Verify bridge-serve exposes exact-query, search, lint, and restore commands\n\nexport function runApp() {\n  return helperValue();\n}\n\nfunction helperValue() {\n  return 1;\n}\n",
      );
      await writeFile(
        join(cwd, "src", "runner.ts"),
        "// Bridge parity fixture for persistent backend command coverage\n// FEATURE: Verify bridge-serve exposes exact-query, search, lint, and restore commands\n\nimport { runApp } from \"./app\";\n\nexport function startRunner() {\n  return runApp();\n}\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "contextplus@example.com");
      await git(cwd, "config", "user.name", "Context Plus");
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", "init");

      await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "index"],
        {
          cwd,
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = new BridgeSession(cwd);
      try {
        const symbol = await session.request("symbol", { root: cwd, query: "runApp", topK: 5 });
        assert.equal(symbol.hits.length, 1);
        assert.equal(symbol.freshnessHeader.includes("Index freshness"), true);

        const search = await session.request("search", {
          root: cwd,
          intent: "exact",
          searchType: "mixed",
          query: "runApp",
          topK: 5,
        });
        assert.equal(search.intent, "exact");
        assert.equal(search.symbolHits.length, 1);

        const lint = await session.request("lint", { root: cwd });
        assert.equal(lint.report.filesInspected >= 2, true);

        const checkpoint = await session.request("checkpoint", {
          root: cwd,
          filePath: "src/runner.ts",
          newContent: "// Bridge parity fixture for persistent backend command coverage\n// FEATURE: Verify bridge-serve exposes exact-query, search, lint, and restore commands\n\nimport { runApp } from \"./app\";\n\nexport function startRunner() {\n  return runApp() + 1;\n}\n",
        });
        assert.equal(checkpoint.report.filePath, "src/runner.ts");

        const status = await session.request("status", { root: cwd });
        assert.equal(status.modifiedCount, 1);

        const restorePoints = await session.request("restore-points", { root: cwd });
        assert.equal(restorePoints.length, 1);

        const restore = await session.request("restore", { root: cwd, pointId: restorePoints[0].id });
        assert.deepEqual(restore.restoredFiles, ["src/runner.ts"]);

        const cleanStatus = await session.request("status", { root: cwd });
        assert.equal(cleanStatus.modifiedCount, 0);
      } finally {
        await session.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
