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

// Purpose: Run one git command inside the temporary bridge-serve fixture repository.
// Inputs: The repository working directory plus the git CLI arguments to execute.
// Returns/Effects: Executes the git command and resolves when it completes successfully.
async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}

class BridgeSession {
}

// Purpose: Send one bridge protocol request to the persistent subprocess and await its matching response.
// Inputs: The bridge session state plus the bridge command name and optional argument object.
// Returns/Effects: Writes one JSON request frame to stdin and resolves or rejects when the response arrives.
function requestBridgeSession(session, command, args = {}) {
  const id = ++session.nextId;
  const payload = JSON.stringify({
    type: "request",
    id,
    command,
    args,
  });
  return new Promise((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    session.process.stdin.write(`${payload}\n`);
  });
}

// Purpose: Wait for a previously emitted or future bridge event that satisfies the given predicate.
// Inputs: The bridge session state, an event-matching predicate, and an optional timeout in milliseconds.
// Returns/Effects: Resolves with the matching event or rejects after the timeout expires.
function waitForBridgeSessionEvent(session, predicate, timeoutMs = 20000) {
  const existing = session.events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.waiters = session.waiters.filter((waiter) => waiter !== pending);
      reject(new Error(`Timed out waiting for bridge event.\nstderr:\n${session.stderrLines.join("\n")}`));
    }, timeoutMs);
    const pending = {
      predicate,
      resolve: (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
    };
    session.waiters.push(pending);
  });
}

// Purpose: Shut down the persistent bridge subprocess and clean up its readline wrapper.
// Inputs: The bridge session state for the active subprocess.
// Returns/Effects: Requests shutdown, closes stdin, waits for process exit, and closes readline.
async function closeBridgeSession(session) {
  try {
    await requestBridgeSession(session, "shutdown");
  } catch {
    // The process may already be exiting.
  }
  session.process.stdin.end();
  if (session.process.exitCode === null) {
    await new Promise((resolve) => session.process.once("exit", resolve));
  }
  session.readline.close();
}

// Purpose: Initialize a BridgeSession instance around one persistent bridge-serve subprocess.
// Inputs: The BridgeSession instance to populate plus the repository working directory for the subprocess.
// Returns/Effects: Spawns the subprocess, wires stdout and stderr listeners, and seeds session state.
function initializeBridgeSession(session, cwd, env = {}) {
  session.cwd = cwd;
  session.nextId = 0;
  session.pending = new Map();
  session.events = [];
  session.waiters = [];
  session.stderrLines = [];
  session.request = requestBridgeSession.bind(null, session);
  session.waitForEvent = waitForBridgeSessionEvent.bind(null, session);
  session.close = closeBridgeSession.bind(null, session);
  session.process = spawn(process.execPath, [join(process.cwd(), "build", "index.js"), "bridge-serve"], {
    cwd,
    env: {
      ...process.env,
      SCPLUS_EMBED_PROVIDER: "mock",
      NODE_NO_WARNINGS: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  session.readline = createInterface({
    input: session.process.stdout,
    crlfDelay: Infinity,
  });
  session.readline.on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "response") {
      const pending = session.pending.get(frame.id);
      if (!pending) return;
      session.pending.delete(frame.id);
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
    session.events.push(frame);
    const remaining = [];
    for (const waiter of session.waiters) {
      if (waiter.predicate(frame)) {
        waiter.resolve(frame);
        continue;
      }
      remaining.push(waiter);
    }
    session.waiters = remaining;
  });
  session.process.stderr.setEncoding("utf8");
  session.process.stderr.on("data", (chunk) => {
    session.stderrLines.push(...String(chunk).split("\n").filter(Boolean));
  });
}

// Purpose: Create and initialize a persistent bridge-serve test session for one fixture repository.
// Inputs: The repository working directory that the bridge-serve subprocess should run against.
// Returns/Effects: Returns an initialized BridgeSession instance with a live bridge subprocess.
function createBridgeSession(cwd, env) {
  const session = new BridgeSession();
  initializeBridgeSession(session, cwd, env);
  return session;
}

// Purpose: Retry a bridge request when transient expected errors occur during startup or queue transitions.
// Inputs: The bridge session, command, args, retry predicate, and optional retry controls.
// Returns/Effects: Reissues the request until it succeeds or a non-retriable error occurs.
async function requestWithRetry(session, command, args, predicate, attempts = 6, delayMs = 250) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await session.request(command, args);
    } catch (error) {
      lastError = error;
      if (!predicate(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

describe("bridge-serve", () => {
  it("keeps one backend process alive across requests and streams watcher-driven index events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-bridge-serve-"));
    const filePath = join(cwd, "src", "app.ts");
    const packageJsonPath = join(cwd, "package.json");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        filePath,
        "// Bridge serve smoke fixture for persistent backend tests\n// FEATURE: Keep one backend alive while requests and watcher events stream\n\nexport function run() {\n  return 1;\n}\n",
      );
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          name: "scplus-bridge-serve-fixture",
          version: "1.0.0",
          type: "module",
        }, null, 2) + "\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "scplus@example.com");
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
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = createBridgeSession(cwd);
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

        const jobProgress = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "progress" &&
          event.job === "refresh" &&
          event.source === "watch" &&
          typeof event.currentFile === "string" &&
          event.currentFile.length > 0 &&
          typeof event.percentComplete === "number",
        );
        assert.equal(jobProgress.root, cwd);
        assert.equal(jobProgress.percentComplete >= 0, true);
        assert.equal(typeof jobProgress.processedItems, "number");
        assert.equal(typeof jobProgress.totalItems, "number");

        const jobCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "refresh" &&
          event.source === "watch",
        );
        assert.equal(jobCompleted.root, cwd);
        assert.equal(typeof jobCompleted.queueDepth, "number");
        assert.equal(jobCompleted.rebuildReason.includes("background incremental refresh"), true);

        const indexingLog = await session.waitForEvent((event) =>
          event.kind === "log" &&
          typeof event.message === "string" &&
          event.message.startsWith("observability indexing:"),
        );
        assert.equal(indexingLog.root, cwd);

        const integrityLog = await session.waitForEvent((event) =>
          event.kind === "log" &&
          typeof event.message === "string" &&
          event.message.startsWith("observability integrity:"),
        );
        assert.equal(integrityLog.root, cwd);

        const schedulerLog = await session.waitForEvent((event) =>
          event.kind === "log" &&
          typeof event.message === "string" &&
          event.message.startsWith("observability scheduler:"),
        );
        assert.equal(schedulerLog.root, cwd);
        assert.equal(schedulerLog.message.includes("queueDepth="), true);

        const doctorAfterWatch = await session.request("doctor", { root: cwd });
        assert.equal(doctorAfterWatch.root, cwd);
        assert.equal(doctorAfterWatch.indexValidation.ok, true);
        assert.equal(doctorAfterWatch.observability.scheduler.batchCount >= 1, true);
        assert.equal(typeof doctorAfterWatch.observability.scheduler.canceledJobs, "number");
        assert.equal(doctorAfterWatch.observability.scheduler.pendingChangeCount, 0);
        assert.deepEqual(doctorAfterWatch.observability.scheduler.pendingPaths, []);
        assert.equal(doctorAfterWatch.observability.scheduler.pendingJobKind ?? "", "");
        assert.equal(doctorAfterWatch.observability.scheduler.fullRebuildReasons.length, 0);

        await writeFile(
          packageJsonPath,
          JSON.stringify({
            name: "scplus-bridge-serve-fixture",
            version: "1.0.1",
            type: "module",
          }, null, 2) + "\n",
        );

        await session.waitForEvent((event) =>
          event.kind === "watch-batch" &&
          Array.isArray(event.changedPaths) &&
          event.changedPaths.some((path) => path === "package.json"),
        );
        const rebuildCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "index" &&
          event.source === "watch" &&
          typeof event.rebuildReason === "string" &&
          event.rebuildReason.includes("full rebuild required after watch changes"),
        );
        assert.equal(rebuildCompleted.root, cwd);

        const doctorAfterConfigChange = await session.request("doctor", { root: cwd });
        assert.equal(
          doctorAfterConfigChange.observability.scheduler.fullRebuildReasons.some((reason) => reason.includes("package.json changed dependency or workspace configuration")),
          true,
        );
      } finally {
        await session.close();
      }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
  });

  it("bootstraps with a full manual index when no prepared index exists yet", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-bridge-bootstrap-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// Bridge bootstrap fixture\n// FEATURE: Verify manual index bootstraps a full prepared index when none exists\n\nexport function runApp() {\n  return 1;\n}\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "scplus@example.com");
      await git(cwd, "config", "user.name", "Context Plus");
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", "init");

      const session = createBridgeSession(cwd);
      try {
        const manualIndexPromise = session.request("index", { root: cwd });
        const manualRunning = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "running" &&
          event.job === "index" &&
          event.source === "manual",
        );
        assert.equal(manualRunning.root, cwd);

        const output = await manualIndexPromise;
        assert.equal(typeof output.output, "string");
        assert.equal(output.output.trim().length > 0, true);

        const manualCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "index" &&
          event.source === "manual",
        );
        assert.equal(manualCompleted.root, cwd);

        const doctor = await session.request("doctor", { root: cwd });
        assert.equal(doctor.indexValidation.ok, true);
      } finally {
        await session.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses manual incremental refresh when a valid prepared index already exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-bridge-manual-refresh-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// Bridge manual refresh fixture\n// FEATURE: Verify manual index refreshes only changed files after bootstrap\n\nexport function runApp() {\n  return 1;\n}\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "scplus@example.com");
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
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = createBridgeSession(cwd);
      try {
        const manualIndexPromise = session.request("index", { root: cwd });
        const manualRunning = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "running" &&
          event.job === "refresh" &&
          event.source === "manual",
        );
        assert.equal(manualRunning.root, cwd);

        await manualIndexPromise;
        const manualCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "refresh" &&
          event.source === "manual",
        );
        assert.equal(manualCompleted.root, cwd);
      } finally {
        await session.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("exposes pending-job cancel, supersede, and retry controls over the persistent session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-bridge-controls-"));
    const filePath = join(cwd, "src", "app.ts");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      const manyFiles = Array.from({ length: 240 }, (_, index) => ({
        path: join(cwd, "src", `fixture-${index}.ts`),
        content: `// Bridge control fixture for pending job commands\n// FEATURE: Verify cancel, supersede, and retry controls on the persistent backend\n\nexport function fixture${index}() {\n  return ${index};\n}\n`,
      }));
      await Promise.all([
        writeFile(
          filePath,
          "// Bridge control fixture for pending job commands\n// FEATURE: Verify cancel, supersede, and retry controls on the persistent backend\n\nexport function run() {\n  return 1;\n}\n",
        ),
        ...manyFiles.map((file) => writeFile(file.path, file.content)),
      ]);
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "scplus@example.com");
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
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = createBridgeSession(cwd);
      try {
        await session.request("watch-set", { root: cwd, enabled: true, debounceMs: 100 });
        await session.waitForEvent((event) => event.kind === "watch-state" && event.enabled === true);

        const manualIndexPromise = session.request("index", { root: cwd, mode: "full" });
        await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "running" &&
          event.job === "index" &&
          event.source === "manual",
        );

        await writeFile(
          filePath,
          "// Bridge control fixture for pending job commands\n// FEATURE: Verify cancel, supersede, and retry controls on the persistent backend\n\nexport function rerun() {\n  return 2;\n}\n",
        );
        await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "queued" &&
          event.job === "refresh" &&
          event.source === "watch",
        );
        const cancelResult = await session.request("job-control", { root: cwd, action: "cancel-pending" });
        assert.equal(cancelResult.action, "cancel-pending");
        assert.equal(cancelResult.queueDepth, 0);
        assert.equal(cancelResult.message.includes("canceled"), true);
        assert.equal(cancelResult.pendingPaths.length >= 1, true);

        const doctorAfterCancel = await session.request("doctor", { root: cwd });
        assert.equal(doctorAfterCancel.observability.scheduler.queueDepth, 0);
        assert.equal(doctorAfterCancel.observability.scheduler.pendingChangeCount, 0);

        await writeFile(
          filePath,
          "// Bridge control fixture for pending job commands\n// FEATURE: Verify cancel, supersede, and retry controls on the persistent backend\n\nexport function rerunAgain() {\n  return 3;\n}\n",
        );
        await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "queued" &&
          event.job === "refresh" &&
          event.source === "watch",
        );
        const supersedeResult = await session.request("job-control", { root: cwd, action: "supersede-pending" });
        assert.equal(supersedeResult.action, "supersede-pending");
        assert.equal(supersedeResult.message.includes("superseded"), true);
        assert.equal(supersedeResult.pendingJobKind, "refresh");

        await manualIndexPromise;
        const watchCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "refresh" &&
          event.source === "watch",
        );
        assert.equal(watchCompleted.root, cwd);
        await session.request("watch-set", { root: cwd, enabled: false });
        await session.waitForEvent((event) => event.kind === "watch-state" && event.enabled === false);
        await new Promise((resolve) => setTimeout(resolve, 250));

        const retryResult = await requestWithRetry(
          session,
          "job-control",
          { root: cwd, action: "retry-last" },
          (error) => error instanceof Error && error.message.includes("while another run is active"),
        );
        assert.equal(retryResult.action, "retry-last");
        assert.equal(retryResult.lastMode, "full");

        const manualCompleted = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.state === "completed" &&
          event.job === "index" &&
          event.source === "manual",
        );
        assert.equal(manualCompleted.root, cwd);
      } finally {
        await session.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("escalates watch batches to full rebuild when pending path cap overflows", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-bridge-overflow-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "one.ts"), "export const one = 1;\n");
      await writeFile(join(cwd, "src", "two.ts"), "export const two = 2;\n");
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "scplus@example.com");
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
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = createBridgeSession(cwd, {
        SCPLUS_WATCH_MAX_PENDING_PATHS: "1",
        SCPLUS_SCAN_MAX_DIRS_PER_TICK: "20",
        SCPLUS_SCAN_MAX_FILES_PER_TICK: "20",
      });
      try {
        await session.request("watch-set", { root: cwd, enabled: true, debounceMs: 100 });
        await session.waitForEvent((event) => event.kind === "watch-state" && event.enabled === true);

        await writeFile(join(cwd, "src", "one.ts"), "export const one = 10;\n");
        await writeFile(join(cwd, "src", "two.ts"), "export const two = 20;\n");

        const overflowBatch = await session.waitForEvent((event) =>
          event.kind === "watch-batch" &&
          typeof event.rebuildReason === "string" &&
          event.rebuildReason.includes("watch pending path overflow"),
        );
        assert.equal(overflowBatch.nativeWatchCount, 0);
        assert.equal(overflowBatch.rebuildReason.includes("cap=1"), true);

        const overflowIndex = await session.waitForEvent((event) =>
          event.kind === "job" &&
          event.job === "index" &&
          event.source === "watch" &&
          typeof event.rebuildReason === "string" &&
          event.rebuildReason.includes("watch pending path overflow"),
        );
        assert.equal(overflowIndex.root, cwd);
      } finally {
        await session.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("serves the expanded bridge parity commands over the persistent session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-bridge-parity-"));
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
      await git(cwd, "config", "user.email", "scplus@example.com");
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
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const session = createBridgeSession(cwd);
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
