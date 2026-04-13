// summary: Manages shadow restore points for reversible AI-authored repository changes.
// FEATURE: Restore point persistence for reversible AI-authored file changes.
// inputs: Repository paths, changed files, and restore-point lifecycle requests.
// outputs: Persisted restore metadata and reversible restore operations.

import { simpleGit, type SimpleGit } from "simple-git";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { deleteRestorePointBackups, loadIndexArtifact, loadRestorePointBackup, pruneRestorePointBackups, saveIndexArtifact, saveRestorePointBackup } from "../core/index-database.js";
import { ensureScplusLayout } from "../core/project-layout.js";
import { refreshPreparedIndexAfterWrite, runSerializedRootMutation } from "../tools/write-freshness.js";

const SHADOW_BRANCH = "mcp-shadow-history";
const RESTORE_POINT_BACKUP_BATCH_SIZE = 32;
export interface RestorePoint {
  id: string;
  timestamp: number;
  files: string[];
  message: string;
}

// Purpose: Load the persisted restore-point manifest for the repository.
// Inputs: The repository root whose restore-point manifest should be read.
// Returns/Effects: Returns the persisted restore-point list from the index artifact store.
async function loadManifest(rootDir: string): Promise<RestorePoint[]> {
  return loadIndexArtifact(rootDir, "restore-points", () => []);
}

// Purpose: Persist the restore-point manifest and prune orphaned restore-point backups.
// Inputs: The repository root plus the updated restore-point list to save.
// Returns/Effects: Writes the manifest artifact and removes backups for deleted restore points.
async function saveManifest(rootDir: string, points: RestorePoint[]): Promise<void> {
  await saveIndexArtifact(rootDir, "restore-points", points);
  await pruneRestorePointBackups(rootDir, points.map((point) => point.id));
}

// Purpose: Create a restore point capturing the current contents of the listed files.
// Inputs: The repository root, the file paths to snapshot, and the restore-point message.
// Returns/Effects: Saves file backups, updates the manifest, and returns the created restore point.
export async function createRestorePoint(rootDir: string, files: string[], message: string): Promise<RestorePoint> {
  await ensureScplusLayout(rootDir);
  const id = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (let index = 0; index < files.length; index += RESTORE_POINT_BACKUP_BATCH_SIZE) {
    const batch = files.slice(index, index + RESTORE_POINT_BACKUP_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const fullPath = join(rootDir, file);
        try {
          const content = await readFile(fullPath, "utf-8");
          await saveRestorePointBackup(rootDir, id, file, content);
        } catch (error) {
          const readError = error as NodeJS.ErrnoException;
          if (readError?.code === "ENOENT") return;
          throw error;
        }
      }),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) {
      await deleteRestorePointBackups(rootDir, id);
      throw rejected.reason;
    }
  }

  const point: RestorePoint = { id, timestamp: Date.now(), files, message };
  const manifest = await loadManifest(rootDir);
  manifest.push(point);
  if (manifest.length > 100) manifest.splice(0, manifest.length - 100);
  await saveManifest(rootDir, manifest);

  return point;
}

// Purpose: Restore file contents from one previously created restore point.
// Inputs: The repository root and the restore-point id to apply.
// Returns/Effects: Restores backed-up file contents to disk, refreshes prepared indexes, and returns restored paths.
export async function restorePoint(rootDir: string, pointId: string): Promise<string[]> {
  return runSerializedRootMutation(rootDir, async () => {
    const manifest = await loadManifest(rootDir);
    const point = manifest.find((p) => p.id === pointId);
    if (!point) throw new Error(`Restore point ${pointId} not found`);

    const restoredFiles: string[] = [];

    for (const file of point.files) {
      const content = await loadRestorePointBackup(rootDir, pointId, file);
      if (content === null) continue;
      const targetPath = join(rootDir, file);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      restoredFiles.push(file);
    }

    if (restoredFiles.length > 0) {
      await refreshPreparedIndexAfterWrite({
        rootDir,
        relativePaths: restoredFiles,
        cause: "restore",
      });
    }

    return restoredFiles;
  });
}

// Purpose: List all restore points recorded for the repository.
// Inputs: The repository root whose restore-point manifest should be read.
// Returns/Effects: Returns the current restore-point manifest entries.
export async function listRestorePoints(rootDir: string): Promise<RestorePoint[]> {
  return loadManifest(rootDir);
}

// Purpose: Save a shadow-history git commit that preserves current local changes on a dedicated branch.
// Inputs: The repository root plus the descriptive shadow-commit message.
// Returns/Effects: Stashes changes, commits them onto the shadow branch when needed, and reports success or failure.
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
