// Shadow git branch manager for safe AI change tracking
// Creates restore points on hidden branch without polluting main history

import { simpleGit, type SimpleGit } from "simple-git";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { loadIndexArtifact, loadRestorePointBackup, pruneRestorePointBackups, saveIndexArtifact, saveRestorePointBackup } from "../core/index-database.js";
import { ensureContextplusLayout } from "../core/project-layout.js";

const SHADOW_BRANCH = "mcp-shadow-history";
export interface RestorePoint {
  id: string;
  timestamp: number;
  files: string[];
  message: string;
}

async function loadManifest(rootDir: string): Promise<RestorePoint[]> {
  return loadIndexArtifact(rootDir, "restore-points", () => []);
}

async function saveManifest(rootDir: string, points: RestorePoint[]): Promise<void> {
  await saveIndexArtifact(rootDir, "restore-points", points);
  await pruneRestorePointBackups(rootDir, points.map((point) => point.id));
}

export async function createRestorePoint(rootDir: string, files: string[], message: string): Promise<RestorePoint> {
  await ensureContextplusLayout(rootDir);
  const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (const file of files) {
    const fullPath = join(rootDir, file);
    try {
      const content = await readFile(fullPath, "utf-8");
      await saveRestorePointBackup(rootDir, id, file, content);
    } catch {
    }
  }

  const point: RestorePoint = { id, timestamp: Date.now(), files, message };
  const manifest = await loadManifest(rootDir);
  manifest.push(point);
  if (manifest.length > 100) manifest.splice(0, manifest.length - 100);
  await saveManifest(rootDir, manifest);

  return point;
}

export async function restorePoint(rootDir: string, pointId: string): Promise<string[]> {
  const manifest = await loadManifest(rootDir);
  const point = manifest.find((p) => p.id === pointId);
  if (!point) throw new Error(`Restore point ${pointId} not found`);

  const restoredFiles: string[] = [];

  for (const file of point.files) {
    try {
      const content = await loadRestorePointBackup(rootDir, pointId, file);
      if (content === null) continue;
      const targetPath = join(rootDir, file);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      restoredFiles.push(file);
    } catch {
    }
  }

  return restoredFiles;
}

export async function listRestorePoints(rootDir: string): Promise<RestorePoint[]> {
  return loadManifest(rootDir);
}

export async function shadowCommit(rootDir: string, message: string): Promise<boolean> {
  try {
    const git: SimpleGit = simpleGit(rootDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return false;

    const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]);
    const stashResult = await git.stash(["push", "-m", `mcp-shadow: ${message}`]);

    if (!stashResult.includes("No local changes")) {
      try {
        const branchExists = await git.branch(["-l", SHADOW_BRANCH]);
        if (!branchExists.all.includes(SHADOW_BRANCH)) {
          await git.branch([SHADOW_BRANCH]);
        }
        await git.checkout(SHADOW_BRANCH);
        await git.stash(["pop"]);
        await git.add(".");
        await git.commit(`[MCP Shadow] ${message}`);
        await git.checkout(currentBranch);
      } catch (e) {
        await git.checkout(currentBranch);
        try { await git.stash(["pop"]); } catch { }
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
