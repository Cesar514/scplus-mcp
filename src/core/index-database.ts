// SQLite-backed durable storage for Context+ indexing and metadata state artifacts
// FEATURE: Full-engine index substrate and repo-local durable artifact persistence

import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { CONTEXTPLUS_INDEX_DB_FILE, ensureContextplusLayout } from "./project-layout.js";

export const INDEX_DATABASE_SCHEMA_VERSION = 1;

export type IndexArtifactKey =
  | "project-config"
  | "file-manifest"
  | "index-status"
  | "index-stage-state"
  | "file-search-index"
  | "identifier-search-index"
  | "chunk-search-index"
  | "code-structure-index"
  | "full-index-manifest";

interface IndexArtifactRow {
  artifact_key: IndexArtifactKey;
  artifact_json: string;
  updated_at: string;
}

async function readJsonMirror<T>(mirrorPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(mirrorPath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonMirror(mirrorPath: string, value: unknown): Promise<void> {
  await writeFile(mirrorPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function initializeIndexDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS index_db_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_artifacts (
      artifact_key TEXT PRIMARY KEY,
      artifact_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO index_db_meta (meta_key, meta_value)
    VALUES ('schemaVersion', ?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
  `).run(String(INDEX_DATABASE_SCHEMA_VERSION));
}

function openIndexDatabase(rootDir: string): DatabaseSync {
  const dbPath = join(resolve(rootDir), CONTEXTPLUS_INDEX_DB_FILE);
  const db = new DatabaseSync(dbPath);
  initializeIndexDatabase(db);
  return db;
}

export async function getIndexDatabasePath(rootDir: string): Promise<string> {
  const layout = await ensureContextplusLayout(resolve(rootDir));
  return join(layout.state, "index.sqlite");
}

export async function saveIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  value: T,
  mirrorPath: string,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const json = JSON.stringify(value);
    db.prepare(`
      INSERT INTO index_artifacts (artifact_key, artifact_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(artifact_key) DO UPDATE SET
        artifact_json = excluded.artifact_json,
        updated_at = excluded.updated_at
    `).run(artifactKey, json, new Date().toISOString());
  } finally {
    db.close();
  }
  await writeJsonMirror(mirrorPath, value);
}

export async function loadIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  mirrorPath: string,
  emptyValue: () => T,
): Promise<T> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const row = db.prepare(`
      SELECT artifact_key, artifact_json, updated_at
      FROM index_artifacts
      WHERE artifact_key = ?
    `).get(artifactKey) as IndexArtifactRow | undefined;
    if (row) {
      return JSON.parse(row.artifact_json) as T;
    }
  } finally {
    db.close();
  }

  const mirrored = await readJsonMirror<T>(mirrorPath);
  if (mirrored !== null) {
    await saveIndexArtifact(rootDir, artifactKey, mirrored, mirrorPath);
    return mirrored;
  }
  return emptyValue();
}
