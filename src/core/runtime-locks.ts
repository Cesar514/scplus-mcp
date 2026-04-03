// summary: Coordinates cross-process runtime locks for shared repo-level backend work.
// FEATURE: Loud cross-process watcher and mutation ownership for Context+ runtimes.
// inputs: Repository roots, lock kinds, acquisition timing, and lock-owner metadata.
// outputs: Acquired lock handles or explicit ownership errors instead of silent races.

import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ensureContextplusLayout } from "./project-layout.js";

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
}

export interface RepoRuntimeLockHandle {
  release(): Promise<void>;
}

export class RepoRuntimeLockBusyError extends Error {
  constructor(
    readonly rootDir: string,
    readonly kind: RepoRuntimeLockKind,
    readonly owner: RepoRuntimeLockOwner,
  ) {
    super(
      `Context+ ${kind} lock for ${rootDir} is already held by pid ${owner.pid} ` +
      `(${owner.holder}, started ${owner.startedAt}). Close the competing runtime or wait for it to finish.`,
    );
    this.name = "RepoRuntimeLockBusyError";
  }
}

const DEFAULT_POLL_MS = 100;

function runtimeLockPath(rootDir: string, kind: RepoRuntimeLockKind): string {
  return join(resolve(rootDir), ".scplus", "locks", `${kind}.lock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveCurrent) => {
    setTimeout(resolveCurrent, ms);
  });
}

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

export async function acquireRepoRuntimeLock(
  rootDir: string,
  kind: RepoRuntimeLockKind,
  options: AcquireRepoRuntimeLockOptions,
): Promise<RepoRuntimeLockHandle> {
  const normalizedRootDir = resolve(rootDir);
  await ensureContextplusLayout(normalizedRootDir);
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
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const currentOwner = await readLockOwner(lockPath);
            if (currentOwner.token !== owner.token) {
              throw new Error(`Runtime ${kind} lock ownership changed unexpectedly for ${normalizedRootDir}.`);
            }
            await rm(lockPath, { force: true });
          } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === "ENOENT") return;
            throw error;
          }
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
      if (Date.now() > deadline) {
        throw new RepoRuntimeLockBusyError(normalizedRootDir, kind, currentOwner);
      }
      if (!notifiedBusy) {
        notifiedBusy = true;
        await options.onBusy?.(currentOwner);
      }
      await sleep(pollMs);
    }
  }
}
