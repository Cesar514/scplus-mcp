// Shared invalidation helpers for durable full-engine refresh decisions
// FEATURE: Content-hash and dependency-aware invalidation primitives

import { createHash } from "node:crypto";
import { dirname, extname, posix } from "node:path";
import { readFile } from "fs/promises";

const LOCAL_DEPENDENCY_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".json",
  ".md",
];

const RUNTIME_JS_IMPORT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashTextContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function computeFileContentHash(filePath: string): Promise<string> {
  return hashBytes(await readFile(filePath));
}

export function buildDependencyHash(dependencyPaths: string[], contentHashes: Record<string, string>): string {
  const encoded = dependencyPaths
    .slice()
    .sort()
    .map((dependencyPath) => `${dependencyPath}:${contentHashes[dependencyPath] ?? "missing"}`)
    .join("\n");
  return hashTextContent(encoded);
}

export function resolveLocalDependencyPath(
  fromRelativePath: string,
  source: string,
  availablePaths: Set<string>,
): string | null {
  if (!source.startsWith(".")) return null;

  const baseDir = normalizeRelativePath(dirname(fromRelativePath));
  const basePath = normalizeRelativePath(posix.normalize(posix.join(baseDir, source)));
  const candidates: string[] = [];
  const extension = extname(basePath);

  if (extension) {
    candidates.push(basePath);
    if (RUNTIME_JS_IMPORT_EXTENSIONS.has(extension)) {
      const stem = basePath.slice(0, -extension.length);
      for (const candidateExtension of LOCAL_DEPENDENCY_EXTENSIONS) {
        candidates.push(`${stem}${candidateExtension}`);
      }
    }
  } else {
    candidates.push(basePath);
    for (const candidateExtension of LOCAL_DEPENDENCY_EXTENSIONS) {
      candidates.push(`${basePath}${candidateExtension}`);
      candidates.push(`${basePath}/index${candidateExtension}`);
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeRelativePath(candidate);
    if (availablePaths.has(normalized)) return normalized;
  }

  return null;
}
