// Project indexing bootstrap that materializes durable Context+ repo state
// FEATURE: Codebase indexing entrypoint for .contextplus project initialization

import { access, writeFile } from "fs/promises";
import { basename, join, relative, resolve } from "path";
import { getContextTree } from "./context-tree.js";
import { ensureContextplusLayout } from "../core/project-layout.js";
import { walkDirectory } from "../core/walker.js";

export interface IndexCodebaseOptions {
  rootDir: string;
}

interface ProjectIndexConfig {
  indexedAt: string;
  projectName: string;
  rootDir: string;
  version: number;
}

function buildProjectConfig(rootDir: string): ProjectIndexConfig {
  return {
    indexedAt: new Date().toISOString(),
    projectName: basename(resolve(rootDir)),
    rootDir: resolve(rootDir),
    version: 1,
  };
}

async function writeJsonIfMissing(path: string, value: unknown): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  }
}

export async function indexCodebase(options: IndexCodebaseOptions): Promise<string> {
  const rootDir = resolve(options.rootDir);
  const layout = await ensureContextplusLayout(rootDir);
  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((entry) => !entry.isDirectory);
  const directories = entries.filter((entry) => entry.isDirectory);
  const tree = await getContextTree({
    rootDir,
    includeSymbols: true,
    maxTokens: 50_000,
  });
  const config = buildProjectConfig(rootDir);
  const configPath = join(layout.config, "project.json");
  const treePath = join(layout.config, "context-tree.txt");
  const manifestPath = join(layout.config, "file-manifest.json");
  const graphPath = join(layout.memories, "memory-graph.json");
  const restorePath = join(layout.checkpoints, "restore-points.json");
  const manifest = {
    directories: directories.map((entry) => entry.relativePath),
    files: files.map((entry) => entry.relativePath),
    generatedAt: config.indexedAt,
    rootDir,
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(treePath, tree + "\n", "utf8");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeJsonIfMissing(graphPath, { nodes: {}, edges: {} });
  await writeJsonIfMissing(restorePath, []);

  return [
    `Indexed ${config.projectName}`,
    `Root: ${rootDir}`,
    `Context+ root: ${relative(rootDir, layout.root) || ".contextplus"}`,
    `Files: ${files.length}`,
    `Directories: ${directories.length}`,
    "",
    "Created or updated:",
    `  ${relative(rootDir, configPath)}`,
    `  ${relative(rootDir, treePath)}`,
    `  ${relative(rootDir, manifestPath)}`,
    `  ${relative(rootDir, graphPath)}`,
    `  ${relative(rootDir, restorePath)}`,
  ].join("\n");
}
