// summary: Walks repository files while honoring gitignore rules and depth limits.
// FEATURE: Repository traversal respecting gitignore and scoped path filters.
// inputs: Root paths, target path filters, gitignore rules, and traversal limits.
// outputs: Ordered repository file listings and grouped directory traversal results.

import { readdir, readFile, stat } from "fs/promises";
import { join, relative, resolve } from "path";
import ignore, { type Ignore } from "ignore";

const WALK_DIRECTORY_CONCURRENCY = 10;

export interface WalkOptions {
  targetPath?: string;
  depthLimit?: number;
  rootDir: string;
}

export interface FileEntry {
  path: string;
  relativePath: string;
  isDirectory: boolean;
  depth: number;
}

const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".DS_Store",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  ".scplus",
  ".mcp-shadow-history",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

async function loadIgnoreRules(rootDir: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const content = await readFile(join(rootDir, ".gitignore"), "utf-8");
    ig.add(content);
  } catch {
  }
  return ig;
}

async function walkRecursive(
  dir: string,
  rootDir: string,
  ig: Ignore,
  depth: number,
  maxDepth: number,
): Promise<FileEntry[]> {
  if (maxDepth > 0 && depth > maxDepth) return [];

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const results: FileEntry[] = [];
  const subdirs: Array<{ index: number; fullPath: string }> = [];
  for (const entry of entries) {
    if (ALWAYS_IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    if (ig.ignores(relPath)) continue;

    const isDir = entry.isDirectory();
    results.push({ path: fullPath, relativePath: relPath, isDirectory: isDir, depth });

    if (isDir) subdirs.push({ index: results.length - 1, fullPath });
  }

  const childEntriesByIndex = new Map<number, FileEntry[]>();
  for (let index = 0; index < subdirs.length; index += WALK_DIRECTORY_CONCURRENCY) {
    const batch = subdirs.slice(index, index + WALK_DIRECTORY_CONCURRENCY);
    const childResults = await Promise.all(
      batch.map(async (subdir) => ({
        index: subdir.index,
        entries: await walkRecursive(subdir.fullPath, rootDir, ig, depth + 1, maxDepth),
      })),
    );
    for (const childResult of childResults) childEntriesByIndex.set(childResult.index, childResult.entries);
  }

  const orderedResults: FileEntry[] = [];
  for (let index = 0; index < results.length; index++) {
    orderedResults.push(results[index]);
    const childEntries = childEntriesByIndex.get(index);
    if (childEntries) orderedResults.push(...childEntries);
  }
  return orderedResults;
}

export async function walkDirectory(options: WalkOptions): Promise<FileEntry[]> {
  const rootDir = resolve(options.rootDir);
  const startDir = options.targetPath ? resolve(rootDir, options.targetPath) : rootDir;
  const ig = await loadIgnoreRules(rootDir);

  try {
    await stat(startDir);
  } catch {
    return [];
  }

  return walkRecursive(startDir, rootDir, ig, 0, options.depthLimit ?? 0);
}

export function groupByDirectory(entries: FileEntry[]): Map<string, FileEntry[]> {
  const groups = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const dir = entry.relativePath.includes("/")
      ? entry.relativePath.substring(0, entry.relativePath.lastIndexOf("/"))
      : ".";
    const existing = groups.get(dir) ?? [];
    existing.push(entry);
    groups.set(dir, existing);
  }
  return groups;
}
