// summary: Coordinates cross-process runtime locks for shared repo-level backend work.
// FEATURE: Loud cross-process watcher and mutation ownership for scplus runtimes.
// inputs: Repository roots, lock kinds, acquisition timing, and lock-owner metadata.
// outputs: Acquired lock handles or explicit ownership errors instead of silent races.

import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureScplusLayout } from "./project-layout.js";

export type RepoRuntimeLockKind = "mutation" | "watcher";

interface RepoRuntimeLockOwner {
  token: string;
  pid: number;
  startedAt: string;
  kind: RepoRuntimeLockKind;
  rootDir: string;
  holder: string;
}

export interface AcquireRepoRuntimeLockOptions {
  holder: string;
  timeoutMs?: number;
  pollMs?: number;
  onBusy?: (owner: RepoRuntimeLockOwner) => Promise<void> | void;
  allowTakeover?: boolean;
  onTakeover?: (owner: RepoRuntimeLockOwner) => Promise<void> | void;
}

export interface RepoRuntimeLockHandle {
  release(): Promise<void>;
}

export interface RepoRuntimeLockBusyError extends Error {
  rootDir: string;
  kind: RepoRuntimeLockKind;
  owner: RepoRuntimeLockOwner;
}

// Purpose: Build a typed runtime-lock contention error with current owner context.
// Inputs: The repo root, lock kind, and validated owner metadata from the lock file.
// Returns/Effects: Returns an `Error` carrying the lock owner details for callers.
export function createRepoRuntimeLockBusyError(
  rootDir: string,
  kind: RepoRuntimeLockKind,
  owner: RepoRuntimeLockOwner,
): RepoRuntimeLockBusyError {
  const error = new Error(
    `scplus ${kind} lock for ${rootDir} is already held by pid ${owner.pid} ` +
    `(${owner.holder}, started ${owner.startedAt}). Close the competing runtime or wait for it to finish.`,
  ) as RepoRuntimeLockBusyError;
  error.name = "RepoRuntimeLockBusyError";
  error.rootDir = rootDir;
  error.kind = kind;
  error.owner = owner;
  return error;
}

const DEFAULT_POLL_MS = 100;
const TAKEOVER_TERM_WAIT_MS = 1500;
const execFileAsync = promisify(execFile);

function runtimeLockPath(rootDir: string, kind: RepoRuntimeLockKind): string {
  return join(resolve(rootDir), ".scplus", "locks", `${kind}.lock`);
}

// Purpose: Pause lock polling or takeover loops for a fixed delay.
// Inputs: The number of milliseconds to wait before resolving.
// Returns/Effects: Resolves asynchronously after the timer completes.
function sleep(ms: number): Promise<void> {
  return new Promise((resolveCurrent) => {
    setTimeout(resolveCurrent, ms);
  });
}

// Purpose: Check whether a process id still refers to a live process.
// Inputs: A process id recorded in the runtime lock owner metadata.
// Returns/Effects: Returns false only when the process is confirmed absent.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ESRCH") return false;
    return true;
  }
}

// Purpose: Read and validate the runtime lock owner payload from disk.
// Inputs: The absolute path to the lock file that stores owner metadata.
// Returns/Effects: Returns a validated owner record or throws on invalid content.
async function readLockOwner(lockPath: string): Promise<RepoRuntimeLockOwner> {
  const raw = await readFile(lockPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<RepoRuntimeLockOwner>;
  if (
    typeof parsed.token !== "string"
    || typeof parsed.pid !== "number"
    || typeof parsed.startedAt !== "string"
    || (parsed.kind !== "mutation" && parsed.kind !== "watcher")
    || typeof parsed.rootDir !== "string"
    || typeof parsed.holder !== "string"
  ) {
    throw new Error(`Runtime lock file ${lockPath} is invalid.`);
  }
  return parsed as RepoRuntimeLockOwner;
}

// Purpose: Inspect the command line for a lock-owning process.
// Inputs: The process id from the runtime lock owner record.
// Returns/Effects: Returns the command line text from `/proc` or `ps`.
async function processCommandLine(pid: number): Promise<string> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.replace(/\0/g, " ").trim();
  } catch {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="]);
    return stdout.trim();
  }
}

// Purpose: Verify that a current lock owner looks like an scplus runtime process.
// Inputs: The parsed owner record containing the process id to inspect.
// Returns/Effects: Returns true when the command line matches known scplus entrypoints.
async function isVerifiedScplusOwnerProcess(owner: RepoRuntimeLockOwner): Promise<boolean> {
  const commandLine = await processCommandLine(owner.pid).catch(() => "");
  const mentionsScplus =
    commandLine.includes("scplus")
    || commandLine.includes("bridge-serve")
    || commandLine.includes("cli-launcher.js")
    || commandLine.includes("index.js");
  return mentionsScplus;
}

// Purpose: Terminate a competing verified scplus process during takeover.
// Inputs: The current lock owner record for the process to stop.
// Returns/Effects: Sends termination signals and throws if the process does not exit.
async function terminateProcessForTakeover(owner: RepoRuntimeLockOwner): Promise<void> {
  try {
    process.kill(owner.pid, "SIGTERM");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + TAKEOVER_TERM_WAIT_MS;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(owner.pid)) return;
    await sleep(DEFAULT_POLL_MS);
  }
  try {
    process.kill(owner.pid, "SIGKILL");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ESRCH") return;
    throw error;
  }
  const killDeadline = Date.now() + TAKEOVER_TERM_WAIT_MS;
  while (Date.now() <= killDeadline) {
    if (!isProcessAlive(owner.pid)) return;
    await sleep(DEFAULT_POLL_MS);
  }
  throw new Error(`Timed out terminating competing scplus process ${owner.pid} for ${owner.rootDir}.`);
}

// Purpose: Release a runtime lock after verifying that the caller still owns the lock file.
// Inputs: The lock path, expected owner token, lock kind, normalized root dir, and release state accessors.
// Returns/Effects: Removes the lock file or throws if ownership changed unexpectedly.
async function releaseRuntimeLock(args: {
  lockPath: string;
  owner: RepoRuntimeLockOwner;
  kind: RepoRuntimeLockKind;
  normalizedRootDir: string;
  isReleased: () => boolean;
  markReleased: () => void;
}): Promise<void> {
  if (args.isReleased()) return;
  args.markReleased();
  try {
    const currentOwner = await readLockOwner(args.lockPath);
    if (currentOwner.token !== args.owner.token) {
      throw new Error(`Runtime ${args.kind} lock ownership changed unexpectedly for ${args.normalizedRootDir}.`);
    }
    await rm(args.lockPath, { force: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return;
    throw error;
  }
}

// Purpose: Acquire an exclusive repo runtime lock for mutation or watcher work.
// Inputs: The repo root, desired lock kind, and acquisition callbacks and timing options.
// Returns/Effects: Creates the lock file and returns a release handle or throws on contention.
export async function acquireRepoRuntimeLock(
  rootDir: string,
  kind: RepoRuntimeLockKind,
  options: AcquireRepoRuntimeLockOptions,
): Promise<RepoRuntimeLockHandle> {
  const normalizedRootDir = resolve(rootDir);
  await ensureScplusLayout(normalizedRootDir);
  const lockDir = join(normalizedRootDir, ".scplus", "locks");
  await mkdir(lockDir, { recursive: true });
  const lockPath = runtimeLockPath(normalizedRootDir, kind);
  const owner: RepoRuntimeLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    kind,
    rootDir: normalizedRootDir,
    holder: options.holder,
  };
  const pollMs = Math.max(25, options.pollMs ?? DEFAULT_POLL_MS);
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 0);
  let notifiedBusy = false;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        release: async (): Promise<void> => {
          await releaseRuntimeLock({
            lockPath,
            owner,
            kind,
            normalizedRootDir,
            isReleased: () => released,
            markReleased: () => {
              released = true;
            },
          });
        },
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") throw error;
      const currentOwner = await readLockOwner(lockPath);
      if (!isProcessAlive(currentOwner.pid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (
        options.allowTakeover
        && currentOwner.pid !== process.pid
        && await isVerifiedScplusOwnerProcess(currentOwner)
      ) {
        await options.onTakeover?.(currentOwner);
        await terminateProcessForTakeover(currentOwner);
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw createRepoRuntimeLockBusyError(normalizedRootDir, kind, currentOwner);
      }
      if (!notifiedBusy) {
        notifiedBusy = true;
        await options.onBusy?.(currentOwner);
      }
      await sleep(pollMs);
    }
  }
}
