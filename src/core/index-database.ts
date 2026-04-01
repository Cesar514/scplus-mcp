// SQLite-backed durable storage for all authoritative Context+ machine state
// FEATURE: Full-engine sqlite-only state substrate, artifacts, text exports, and restore backups

import { DatabaseSync } from "node:sqlite";
import { rm } from "fs/promises";
import { join, resolve } from "path";
import { CONTEXTPLUS_INDEX_DB_FILE, ensureContextplusLayout } from "./project-layout.js";

export const INDEX_DATABASE_SCHEMA_VERSION = 2;

export type IndexArtifactKey =
  | "project-config"
  | "context-tree"
  | "file-manifest"
  | "index-status"
  | "index-stage-state"
  | "file-search-index"
  | "identifier-search-index"
  | "chunk-search-index"
  | "hybrid-chunk-index"
  | "hybrid-identifier-index"
  | "code-structure-index"
  | "semantic-cluster-index"
  | "hub-suggestion-index"
  | "full-index-manifest"
  | "restore-points"
  | `embedding-cache:${string}`;

interface IndexArtifactRow {
  artifact_json: string;
}

interface IndexTextRow {
  artifact_text: string;
}

interface RestorePointBackupRow {
  file_content: string;
}

interface IndexDatabaseMetaRow {
  meta_value: string;
}

export interface IndexDatabaseInspection {
  schemaVersion: number | null;
  artifactKeys: string[];
  textArtifactKeys: string[];
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

    CREATE TABLE IF NOT EXISTS index_text_artifacts (
      artifact_key TEXT PRIMARY KEY,
      artifact_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS restore_point_backups (
      point_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (point_id, file_path)
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
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.prepare(`
      INSERT INTO index_artifacts (artifact_key, artifact_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(artifact_key) DO UPDATE SET
        artifact_json = excluded.artifact_json,
        updated_at = excluded.updated_at
    `).run(artifactKey, JSON.stringify(value), new Date().toISOString());
  } finally {
    db.close();
  }
}

export async function loadIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  emptyValue: () => T,
): Promise<T> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const row = db.prepare(`
      SELECT artifact_json
      FROM index_artifacts
      WHERE artifact_key = ?
    `).get(artifactKey) as IndexArtifactRow | undefined;
    if (!row) return emptyValue();
    return JSON.parse(row.artifact_json) as T;
  } finally {
    db.close();
  }
}

export async function saveIndexTextArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  value: string,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.prepare(`
      INSERT INTO index_text_artifacts (artifact_key, artifact_text, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(artifact_key) DO UPDATE SET
        artifact_text = excluded.artifact_text,
        updated_at = excluded.updated_at
    `).run(artifactKey, value, new Date().toISOString());
  } finally {
    db.close();
  }
}

export async function loadIndexTextArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  emptyValue: () => string,
): Promise<string> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const row = db.prepare(`
      SELECT artifact_text
      FROM index_text_artifacts
      WHERE artifact_key = ?
    `).get(artifactKey) as IndexTextRow | undefined;
    return row?.artifact_text ?? emptyValue();
  } finally {
    db.close();
  }
}

export async function saveRestorePointBackup(
  rootDir: string,
  pointId: string,
  filePath: string,
  fileContent: string,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.prepare(`
      INSERT INTO restore_point_backups (point_id, file_path, file_content, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(point_id, file_path) DO UPDATE SET
        file_content = excluded.file_content,
        updated_at = excluded.updated_at
    `).run(pointId, filePath, fileContent, new Date().toISOString());
  } finally {
    db.close();
  }
}

export async function loadRestorePointBackup(
  rootDir: string,
  pointId: string,
  filePath: string,
): Promise<string | null> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const row = db.prepare(`
      SELECT file_content
      FROM restore_point_backups
      WHERE point_id = ? AND file_path = ?
    `).get(pointId, filePath) as RestorePointBackupRow | undefined;
    return row?.file_content ?? null;
  } finally {
    db.close();
  }
}

export async function pruneRestorePointBackups(
  rootDir: string,
  keepPointIds: string[],
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    if (keepPointIds.length === 0) {
      db.prepare("DELETE FROM restore_point_backups").run();
      return;
    }

    const placeholders = keepPointIds.map(() => "?").join(", ");
    db.prepare(`
      DELETE FROM restore_point_backups
      WHERE point_id NOT IN (${placeholders})
    `).run(...keepPointIds);
  } finally {
    db.close();
  }
}

export async function deleteLegacyArtifacts(paths: string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { recursive: true, force: true });
  }
}

export async function inspectIndexDatabase(rootDir: string): Promise<IndexDatabaseInspection> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const schemaRow = db.prepare(`
      SELECT meta_value
      FROM index_db_meta
      WHERE meta_key = 'schemaVersion'
    `).get() as IndexDatabaseMetaRow | undefined;
    const artifactRows = db.prepare(`
      SELECT artifact_key
      FROM index_artifacts
      ORDER BY artifact_key
    `).all() as Array<{ artifact_key: string }>;
    const textRows = db.prepare(`
      SELECT artifact_key
      FROM index_text_artifacts
      ORDER BY artifact_key
    `).all() as Array<{ artifact_key: string }>;
    return {
      schemaVersion: schemaRow ? Number(schemaRow.meta_value) : null,
      artifactKeys: artifactRows.map((row) => row.artifact_key),
      textArtifactKeys: textRows.map((row) => row.artifact_key),
    };
  } finally {
    db.close();
  }
}

export async function deleteIndexArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  kind: "artifact" | "text" = "artifact",
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const table = kind === "artifact" ? "index_artifacts" : "index_text_artifacts";
    db.prepare(`DELETE FROM ${table} WHERE artifact_key = ?`).run(artifactKey);
  } finally {
    db.close();
  }
}
