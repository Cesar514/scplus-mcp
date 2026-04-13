// summary: Computes invalidation decisions for durable refresh and rebuild workflows.
// FEATURE: Content-hash and dependency-aware invalidation primitives.
// inputs: File hashes, dependency graphs, and generation refresh context.
// outputs: Invalidation plans for files, structures, chunks, and retrieval artifacts.

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

// Purpose: Normalize repository-relative paths into forward-slash form for stable indexing.
// Inputs: A filesystem path that may contain platform-specific separators.
// Returns/Effects: Returns the normalized repository-relative path string.
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

// Purpose: Compute the stable SHA-256 hash for raw file bytes.
// Inputs: The file content bytes to hash.
// Returns/Effects: Returns the hexadecimal digest for the provided bytes.
export function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

// Purpose: Compute the stable SHA-256 hash for UTF-8 text content.
// Inputs: The text content to hash.
// Returns/Effects: Returns the hexadecimal digest for the provided text.
export function hashTextContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Purpose: Load a file from disk and compute its content hash.
// Inputs: The file path whose bytes should be read and hashed.
// Returns/Effects: Reads the file from disk and returns its SHA-256 digest.
export async function computeFileContentHash(filePath: string): Promise<string> {
  return hashBytes(await readFile(filePath));
}

// Purpose: Build a deterministic aggregate hash for a file's resolved dependency set.
// Inputs: The dependency paths plus the current content-hash map for known files.
// Returns/Effects: Returns a stable hash representing the ordered dependency fingerprint.
export function buildDependencyHash(dependencyPaths: string[], contentHashes: Record<string, string>): string {
  const encoded = dependencyPaths
    .slice()
    .sort()
    .map((dependencyPath) => `${dependencyPath}:${contentHashes[dependencyPath] ?? "missing"}`)
    .join("\n");
  return hashTextContent(encoded);
}

// Purpose: Resolve one local import source against the repository's available file paths.
// Inputs: The importing file path, the raw import source, and the set of available repository paths.
// Returns/Effects: Returns the normalized resolved dependency path or null when no local match exists.
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
