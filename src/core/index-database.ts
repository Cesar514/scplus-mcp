// summary: Owns the sqlite-backed durable storage layer for authoritative scplus machine state.
// FEATURE: Full-engine sqlite-only state substrate, artifacts, vector collections, and backups.
// inputs: Artifact records, vector entries, generation metadata, and transactional write requests.
// outputs: Persisted sqlite state, durable query reads, and backup or maintenance operations.

import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "fs/promises";
import { join, resolve } from "path";
import {
  encodeVectorBlob,
  mapVectorEntryRow,
  type VectorCollectionRow,
  type VectorEntryRow,
  type VectorStoreEntry,
} from "./index-database-vectors.js";
import {
  createBinaryVectorEntriesTable,
  getTableColumns,
  hasTable,
  migrateLegacyVectorEntriesToBinary,
} from "./index-database-schema.js";
import { SCPLUS_INDEX_DB_FILE, ensureScplusLayout } from "./project-layout.js";

export type { VectorStoreEntry } from "./index-database-vectors.js";

export const INDEX_DATABASE_SCHEMA_VERSION = 4;
const GENERATION_KEY_PREFIX = "generation:";
const GLOBAL_ARTIFACT_KEYS = new Set<IndexArtifactKey>(["index-status", "restore-points"]);
const META_ACTIVE_GENERATION = "activeGeneration";
const META_PENDING_GENERATION = "pendingGeneration";
const META_LATEST_GENERATION = "latestGeneration";
const META_ACTIVE_GENERATION_VALIDATED_AT = "activeGenerationValidatedAt";
const META_ACTIVE_GENERATION_FRESHNESS = "activeGenerationFreshness";
const META_ACTIVE_GENERATION_BLOCKED_REASON = "activeGenerationBlockedReason";
const indexGenerationContext = new AsyncLocalStorage<{ readGeneration?: number; writeGeneration?: number }>();

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
  | "query-explanation-index"
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

export type IndexGenerationFreshness = "fresh" | "dirty" | "blocked";

export interface IndexArtifactOptions {
  generation?: number;
  global?: boolean;
}

export interface IndexServingState {
  activeGeneration: number;
  pendingGeneration: number | null;
  latestGeneration: number;
  activeGenerationValidatedAt?: string;
  activeGenerationFreshness: IndexGenerationFreshness;
  activeGenerationBlockedReason?: string;
}

export interface IndexDatabaseInspection {
  schemaVersion: number | null;
  generation: number;
  activeGeneration: number;
  pendingGeneration: number | null;
  latestGeneration: number;
  activeGenerationValidatedAt?: string;
  activeGenerationFreshness: IndexGenerationFreshness;
  activeGenerationBlockedReason?: string;
  artifactKeys: string[];
  textArtifactKeys: string[];
  vectorNamespaces: string[];
}

// Purpose: Resolve the generation-qualified vector namespace for one database operation.
// Inputs: The open index database, logical namespace, and optional artifact options.
// Returns/Effects: Returns the stored namespace qualified for the selected generation.
function resolveStoredVectorNamespace(
  db: DatabaseSync,
  namespace: string,
  options?: IndexArtifactOptions,
): string {
  const serving = readServingStateFromDb(db);
  const context = indexGenerationContext.getStore();
  return qualifyVectorNamespace(namespace, options?.generation ?? context?.readGeneration ?? serving.activeGeneration);
}

// Purpose: Resolve which artifact generation should be used for one read or write operation.
// Inputs: The artifact key, optional artifact options, active generation, and operation mode.
// Returns/Effects: Returns the selected generation number or null for global artifacts.
function resolveArtifactGeneration(
  artifactKey: IndexArtifactKey,
  options: IndexArtifactOptions | undefined,
  activeGeneration: number,
  mode: "read" | "write",
): number | null {
  if (options?.global || GLOBAL_ARTIFACT_KEYS.has(artifactKey)) return null;
  const context = indexGenerationContext.getStore();
  const contextualGeneration = mode === "read" ? context?.readGeneration : context?.writeGeneration;
  return options?.generation ?? contextualGeneration ?? activeGeneration;
}

function qualifyArtifactStorageKey(artifactKey: IndexArtifactKey, generation: number | null): string {
  if (generation === null || generation === 0) return artifactKey;
  return `${GENERATION_KEY_PREFIX}${generation}:${artifactKey}`;
}

function qualifyVectorNamespace(namespace: string, generation: number): string {
  if (generation === 0) return namespace;
  return `${GENERATION_KEY_PREFIX}${generation}:${namespace}`;
}

// Purpose: Decode a stored artifact key back into its logical key and generation.
// Inputs: The raw stored artifact key from sqlite.
// Returns/Effects: Returns the decoded generation and logical artifact key.
function decodeStoredArtifactKey(storedKey: string): { generation: number | null; artifactKey: string } {
  if (storedKey.startsWith(GENERATION_KEY_PREFIX)) {
    const rest = storedKey.slice(GENERATION_KEY_PREFIX.length);
    const separatorIndex = rest.indexOf(":");
    if (separatorIndex > 0) {
      const generation = Number.parseInt(rest.slice(0, separatorIndex), 10);
      const artifactKey = rest.slice(separatorIndex + 1);
      if (Number.isFinite(generation) && artifactKey.length > 0) {
        return { generation, artifactKey };
      }
    }
  }
  return {
    generation: GLOBAL_ARTIFACT_KEYS.has(storedKey as IndexArtifactKey) ? null : 0,
    artifactKey: storedKey,
  };
}

// Purpose: Decode a stored vector namespace back into its logical namespace and generation.
// Inputs: The raw stored namespace from sqlite.
// Returns/Effects: Returns the decoded generation and logical vector namespace.
function decodeStoredVectorNamespace(storedNamespace: string): { generation: number; namespace: string } {
  if (storedNamespace.startsWith(GENERATION_KEY_PREFIX)) {
    const rest = storedNamespace.slice(GENERATION_KEY_PREFIX.length);
    const separatorIndex = rest.indexOf(":");
    if (separatorIndex > 0) {
      const generation = Number.parseInt(rest.slice(0, separatorIndex), 10);
      const namespace = rest.slice(separatorIndex + 1);
      if (Number.isFinite(generation) && namespace.length > 0) {
        return { generation, namespace };
      }
    }
  }
  return { generation: 0, namespace: storedNamespace };
}

// Purpose: Read the current serving-generation state from the index database metadata table.
// Inputs: The open index database connection.
// Returns/Effects: Returns the current active, pending, and freshness serving state.
function readServingStateFromDb(db: DatabaseSync): IndexServingState {
  const rows = db.prepare(`
    SELECT meta_key, meta_value
    FROM index_db_meta
    WHERE meta_key IN (?, ?, ?, ?, ?, ?)
  `).all(
    META_ACTIVE_GENERATION,
    META_PENDING_GENERATION,
    META_LATEST_GENERATION,
    META_ACTIVE_GENERATION_VALIDATED_AT,
    META_ACTIVE_GENERATION_FRESHNESS,
    META_ACTIVE_GENERATION_BLOCKED_REASON,
  ) as Array<{ meta_key: string; meta_value: string }>;
  const values = new Map(rows.map((row) => [row.meta_key, row.meta_value]));
  const activeGeneration = Number.parseInt(values.get(META_ACTIVE_GENERATION) ?? "0", 10);
  const pendingRaw = values.get(META_PENDING_GENERATION);
  const latestGeneration = Number.parseInt(values.get(META_LATEST_GENERATION) ?? String(Number.isFinite(activeGeneration) ? activeGeneration : 0), 10);
  const freshness = (values.get(META_ACTIVE_GENERATION_FRESHNESS) ?? "fresh") as IndexGenerationFreshness;
  const blockedReason = values.get(META_ACTIVE_GENERATION_BLOCKED_REASON) ?? undefined;
  const validatedAt = values.get(META_ACTIVE_GENERATION_VALIDATED_AT) ?? undefined;
  return {
    activeGeneration: Number.isFinite(activeGeneration) ? activeGeneration : 0,
    pendingGeneration: pendingRaw ? Number.parseInt(pendingRaw, 10) : null,
    latestGeneration: Number.isFinite(latestGeneration) ? latestGeneration : 0,
    activeGenerationValidatedAt: validatedAt,
    activeGenerationFreshness: freshness === "dirty" || freshness === "blocked" ? freshness : "fresh",
    activeGenerationBlockedReason: blockedReason,
  };
}

// Purpose: Persist the serving-generation state into the index database metadata table.
// Inputs: The open index database connection and the next serving state to store.
// Returns/Effects: Updates the serving-generation metadata rows in sqlite.
function writeServingStateToDb(db: DatabaseSync, state: IndexServingState): void {
  const statement = db.prepare(`
    INSERT INTO index_db_meta (meta_key, meta_value)
    VALUES (?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
  `);
  statement.run(META_ACTIVE_GENERATION, String(state.activeGeneration));
  statement.run(META_LATEST_GENERATION, String(state.latestGeneration));
  statement.run(META_ACTIVE_GENERATION_FRESHNESS, state.activeGenerationFreshness);
  if (state.pendingGeneration === null) {
    db.prepare(`DELETE FROM index_db_meta WHERE meta_key = ?`).run(META_PENDING_GENERATION);
  } else {
    statement.run(META_PENDING_GENERATION, String(state.pendingGeneration));
  }
  if (state.activeGenerationValidatedAt) {
    statement.run(META_ACTIVE_GENERATION_VALIDATED_AT, state.activeGenerationValidatedAt);
  } else {
    db.prepare(`DELETE FROM index_db_meta WHERE meta_key = ?`).run(META_ACTIVE_GENERATION_VALIDATED_AT);
  }
  if (state.activeGenerationBlockedReason) {
    statement.run(META_ACTIVE_GENERATION_BLOCKED_REASON, state.activeGenerationBlockedReason);
  } else {
    db.prepare(`DELETE FROM index_db_meta WHERE meta_key = ?`).run(META_ACTIVE_GENERATION_BLOCKED_REASON);
  }
}

// Purpose: Initialize the sqlite schema and required metadata for the index database.
// Inputs: The open index database connection to initialize.
// Returns/Effects: Creates required tables, migrates vector storage, and seeds metadata rows.
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

    CREATE TABLE IF NOT EXISTS vector_collections (
      namespace TEXT PRIMARY KEY,
      entry_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  if (!hasTable(db, "vector_entries")) createBinaryVectorEntriesTable(db);
  else migrateLegacyVectorEntriesToBinary(db);

  db.prepare(`
    INSERT INTO index_db_meta (meta_key, meta_value)
    VALUES ('schemaVersion', ?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
  `).run(String(INDEX_DATABASE_SCHEMA_VERSION));
  db.prepare(`INSERT OR IGNORE INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)`).run(META_ACTIVE_GENERATION, "0");
  db.prepare(`INSERT OR IGNORE INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)`).run(META_LATEST_GENERATION, "0");
  db.prepare(`INSERT OR IGNORE INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)`).run(META_ACTIVE_GENERATION_FRESHNESS, "fresh");
}

// Purpose: Open the repository index database and ensure its schema is initialized.
// Inputs: The repository root whose durable index database should be opened.
// Returns/Effects: Returns an initialized sqlite database connection.
function openIndexDatabase(rootDir: string): DatabaseSync {
  const dbPath = join(resolve(rootDir), SCPLUS_INDEX_DB_FILE);
  const db = new DatabaseSync(dbPath);
  initializeIndexDatabase(db);
  return db;
}

export async function getIndexDatabasePath(rootDir: string): Promise<string> {
  const layout = await ensureScplusLayout(resolve(rootDir));
  return join(layout.state, "index.sqlite");
}

// Purpose: Load the current serving-generation state for one repository.
// Inputs: The repository root whose index database should be inspected.
// Returns/Effects: Returns the persisted active, pending, and freshness state.
export async function loadIndexServingState(rootDir: string): Promise<IndexServingState> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    return readServingStateFromDb(db);
  } finally {
    db.close();
  }
}

// Purpose: Reserve the next pending generation number for a new index build.
// Inputs: The repository root whose serving state should be updated.
// Returns/Effects: Persists and returns the reserved pending generation number.
export async function reservePendingIndexGeneration(rootDir: string): Promise<number> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.exec("BEGIN");
    const current = readServingStateFromDb(db);
    const nextGeneration = Math.max(current.latestGeneration, current.activeGeneration, current.pendingGeneration ?? 0) + 1;
    writeServingStateToDb(db, {
      ...current,
      pendingGeneration: nextGeneration,
      latestGeneration: nextGeneration,
    });
    db.exec("COMMIT");
    return nextGeneration;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Promote one validated generation to become the active serving generation.
// Inputs: The repository root, validated generation number, and validation timestamp.
// Returns/Effects: Persists and returns the new serving state with that active generation.
export async function activateIndexGeneration(
  rootDir: string,
  generation: number,
  validatedAt: string,
): Promise<IndexServingState> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.exec("BEGIN");
    const current = readServingStateFromDb(db);
    const nextState: IndexServingState = {
      activeGeneration: generation,
      pendingGeneration: null,
      latestGeneration: Math.max(current.latestGeneration, generation),
      activeGenerationValidatedAt: validatedAt,
      activeGenerationFreshness: "fresh",
      activeGenerationBlockedReason: undefined,
    };
    writeServingStateToDb(db, nextState);
    db.exec("COMMIT");
    return nextState;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Clear the pending generation marker after a build completes or fails.
// Inputs: The repository root and optional pending generation expected to be cleared.
// Returns/Effects: Persists and returns the serving state after clearing the pending generation.
export async function clearPendingIndexGeneration(rootDir: string, pendingGeneration?: number): Promise<IndexServingState> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.exec("BEGIN");
    const current = readServingStateFromDb(db);
    if (pendingGeneration === undefined || current.pendingGeneration === pendingGeneration) {
      writeServingStateToDb(db, { ...current, pendingGeneration: null });
    }
    const nextState = readServingStateFromDb(db);
    db.exec("COMMIT");
    return nextState;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Update the freshness state for the active serving generation.
// Inputs: The repository root, new freshness value, and optional blocked reason.
// Returns/Effects: Persists and returns the updated serving state.
export async function updateIndexServingFreshness(
  rootDir: string,
  freshness: IndexGenerationFreshness,
  blockedReason?: string,
): Promise<IndexServingState> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.exec("BEGIN");
    const current = readServingStateFromDb(db);
    const nextState: IndexServingState = {
      ...current,
      activeGenerationFreshness: freshness,
      activeGenerationBlockedReason: freshness === "blocked" ? blockedReason : undefined,
    };
    writeServingStateToDb(db, nextState);
    db.exec("COMMIT");
    return nextState;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Run an async operation with an explicit read/write generation context.
// Inputs: The generation context to apply and the async operation to execute.
// Returns/Effects: Runs the operation within AsyncLocalStorage and returns its result.
export async function runWithIndexGenerationContext<T>(
  context: { readGeneration?: number; writeGeneration?: number },
  operation: () => Promise<T>,
): Promise<T> {
  return indexGenerationContext.run(context, operation);
}

export function getIndexGenerationContext(): { readGeneration?: number; writeGeneration?: number } | undefined {
  return indexGenerationContext.getStore();
}

// Purpose: Save one JSON index artifact into the durable sqlite artifact store.
// Inputs: The repository root, artifact key, JSON value, and optional generation options.
// Returns/Effects: Persists the artifact payload under its generation-qualified key.
export async function saveIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  value: T,
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const storedKey = qualifyArtifactStorageKey(
      artifactKey,
      resolveArtifactGeneration(artifactKey, options, serving.activeGeneration, "write"),
    );
    db.prepare(`
      INSERT INTO index_artifacts (artifact_key, artifact_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(artifact_key) DO UPDATE SET
        artifact_json = excluded.artifact_json,
        updated_at = excluded.updated_at
    `).run(storedKey, JSON.stringify(value), new Date().toISOString());
  } finally {
    db.close();
  }
}

// Purpose: Load one JSON index artifact from the durable sqlite artifact store.
// Inputs: The repository root, artifact key, empty-value factory, and optional generation options.
// Returns/Effects: Returns the stored artifact payload or the provided empty value when absent.
export async function loadIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  emptyValue: () => T,
  options?: IndexArtifactOptions,
): Promise<T> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const storedKey = qualifyArtifactStorageKey(
      artifactKey,
      resolveArtifactGeneration(artifactKey, options, serving.activeGeneration, "read"),
    );
    const row = db.prepare(`
      SELECT artifact_json
      FROM index_artifacts
      WHERE artifact_key = ?
    `).get(storedKey) as IndexArtifactRow | undefined;
    if (!row) return emptyValue();
    try {
      return JSON.parse(row.artifact_json) as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Malformed persisted index artifact "${storedKey}" in ${resolve(rootDir)}/.scplus/state/index.sqlite: ${error.message}`,
        );
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

// Purpose: Save one text index artifact into the durable sqlite text-artifact store.
// Inputs: The repository root, artifact key, text value, and optional generation options.
// Returns/Effects: Persists the text artifact under its generation-qualified key.
export async function saveIndexTextArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  value: string,
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const storedKey = qualifyArtifactStorageKey(
      artifactKey,
      resolveArtifactGeneration(artifactKey, options, serving.activeGeneration, "write"),
    );
    db.prepare(`
      INSERT INTO index_text_artifacts (artifact_key, artifact_text, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(artifact_key) DO UPDATE SET
        artifact_text = excluded.artifact_text,
        updated_at = excluded.updated_at
    `).run(storedKey, value, new Date().toISOString());
  } finally {
    db.close();
  }
}

// Purpose: Load one text index artifact from the durable sqlite text-artifact store.
// Inputs: The repository root, artifact key, empty-value factory, and optional generation options.
// Returns/Effects: Returns the stored text artifact or the provided empty value when absent.
export async function loadIndexTextArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  emptyValue: () => string,
  options?: IndexArtifactOptions,
): Promise<string> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const storedKey = qualifyArtifactStorageKey(
      artifactKey,
      resolveArtifactGeneration(artifactKey, options, serving.activeGeneration, "read"),
    );
    const row = db.prepare(`
      SELECT artifact_text
      FROM index_text_artifacts
      WHERE artifact_key = ?
    `).get(storedKey) as IndexTextRow | undefined;
    return row?.artifact_text ?? emptyValue();
  } finally {
    db.close();
  }
}

// Purpose: Persist one restore-point file backup into the durable sqlite backup store.
// Inputs: The repository root, restore point id, file path, and backed-up file content.
// Returns/Effects: Upserts the restore-point backup record for that file.
export async function saveRestorePointBackup(
  rootDir: string,
  pointId: string,
  filePath: string,
  fileContent: string,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
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

// Purpose: Load one restore-point file backup from the durable sqlite backup store.
// Inputs: The repository root, restore point id, and file path to restore.
// Returns/Effects: Returns the stored backup content or null when it is absent.
export async function loadRestorePointBackup(
  rootDir: string,
  pointId: string,
  filePath: string,
): Promise<string | null> {
  await ensureScplusLayout(resolve(rootDir));
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

// Purpose: Delete restore-point backups that are no longer referenced.
// Inputs: The repository root and the point ids that should be kept.
// Returns/Effects: Removes backup rows for restore points outside the keep set.
export async function pruneRestorePointBackups(
  rootDir: string,
  keepPointIds: string[],
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
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

// Purpose: Delete every backup row associated with one restore point.
// Inputs: The repository root and restore point id to purge.
// Returns/Effects: Removes all restore-point backup rows for that point id.
export async function deleteRestorePointBackups(
  rootDir: string,
  pointId: string,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    db.prepare(`
      DELETE FROM restore_point_backups
      WHERE point_id = ?
    `).run(pointId);
  } finally {
    db.close();
  }
}

// Purpose: Delete legacy on-disk artifacts that have been replaced by sqlite storage.
// Inputs: The legacy filesystem paths to remove.
// Returns/Effects: Removes those files or directories in bounded concurrent batches.
export async function deleteLegacyArtifacts(paths: string[]): Promise<void> {
  const batchSize = 32;
  for (let index = 0; index < paths.length; index += batchSize) {
    const batch = paths.slice(index, index + batchSize);
    await Promise.all(
      batch.map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

// Purpose: Inspect the durable index database contents for one generation.
// Inputs: The repository root and optional generation-selection options.
// Returns/Effects: Returns the decoded database inspection summary for that generation.
export async function inspectIndexDatabase(rootDir: string, options?: IndexArtifactOptions): Promise<IndexDatabaseInspection> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const generation = options?.generation ?? serving.activeGeneration;
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
    const vectorRows = db.prepare(`
      SELECT namespace
      FROM vector_collections
      ORDER BY namespace
    `).all() as unknown as VectorCollectionRow[];
    const artifactKeys = artifactRows
      .map((row) => decodeStoredArtifactKey(row.artifact_key))
      .filter((row) => row.generation === null || row.generation === generation)
      .map((row) => row.artifactKey);
    const textArtifactKeys = textRows
      .map((row) => decodeStoredArtifactKey(row.artifact_key))
      .filter((row) => row.generation === generation)
      .map((row) => row.artifactKey);
    const vectorNamespaces = vectorRows
      .map((row) => decodeStoredVectorNamespace(row.namespace))
      .filter((row) => row.generation === generation)
      .map((row) => row.namespace);
    return {
      schemaVersion: schemaRow ? Number(schemaRow.meta_value) : null,
      generation,
      activeGeneration: serving.activeGeneration,
      pendingGeneration: serving.pendingGeneration,
      latestGeneration: serving.latestGeneration,
      activeGenerationValidatedAt: serving.activeGenerationValidatedAt,
      activeGenerationFreshness: serving.activeGenerationFreshness,
      activeGenerationBlockedReason: serving.activeGenerationBlockedReason,
      artifactKeys,
      textArtifactKeys,
      vectorNamespaces,
    };
  } finally {
    db.close();
  }
}

// Purpose: Delete one stored JSON or text artifact from the durable sqlite store.
// Inputs: The repository root, artifact key, artifact kind, and optional generation options.
// Returns/Effects: Removes the selected generation-qualified artifact row.
export async function deleteIndexArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  kind: "artifact" | "text" = "artifact",
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const storedKey = qualifyArtifactStorageKey(
      artifactKey,
      resolveArtifactGeneration(artifactKey, options, serving.activeGeneration, "write"),
    );
    if (kind === "artifact") {
      db.prepare("DELETE FROM index_artifacts WHERE artifact_key = ?").run(storedKey);
    } else {
      db.prepare("DELETE FROM index_text_artifacts WHERE artifact_key = ?").run(storedKey);
    }
  } finally {
    db.close();
  }
}

// Purpose: Load every vector entry from one generation-qualified vector namespace.
// Inputs: The repository root, logical namespace, and optional generation options.
// Returns/Effects: Returns the decoded vector entries stored in that namespace.
export async function loadVectorCollection<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  options?: IndexArtifactOptions,
): Promise<VectorStoreEntry<TMetadata>[]> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const storedNamespace = resolveStoredVectorNamespace(db, namespace, options);
    const rows = db.prepare(`
      SELECT entry_id, content_hash, search_text, vector_blob, metadata_json
      FROM vector_entries
      WHERE namespace = ?
      ORDER BY entry_id
    `).all(storedNamespace) as unknown as VectorEntryRow[];
    return rows.map((row) => mapVectorEntryRow<TMetadata>(row));
  } finally {
    db.close();
  }
}

// Purpose: Load selected vector entries by id from one generation-qualified namespace.
// Inputs: The repository root, logical namespace, entry ids, and optional generation options.
// Returns/Effects: Returns the decoded vector entries found for those ids.
export async function loadVectorEntriesById<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  entryIds: string[],
  options?: IndexArtifactOptions,
): Promise<VectorStoreEntry<TMetadata>[]> {
  await ensureScplusLayout(resolve(rootDir));
  if (entryIds.length === 0) return [];
  const uniqueEntryIds = Array.from(new Set(entryIds));
  const db = openIndexDatabase(rootDir);
  try {
    const storedNamespace = resolveStoredVectorNamespace(db, namespace, options);
    const placeholders = uniqueEntryIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT entry_id, content_hash, search_text, vector_blob, metadata_json
      FROM vector_entries
      WHERE namespace = ? AND entry_id IN (${placeholders})
      ORDER BY entry_id
    `).all(storedNamespace, ...uniqueEntryIds) as unknown as VectorEntryRow[];
    return rows.map((row) => mapVectorEntryRow<TMetadata>(row));
  } finally {
    db.close();
  }
}

// Purpose: Check which requested vector entry ids are present in one namespace.
// Inputs: The repository root, logical namespace, candidate entry ids, and optional generation options.
// Returns/Effects: Returns the subset of entry ids currently present in sqlite.
export async function loadPresentVectorEntryIds(
  rootDir: string,
  namespace: string,
  entryIds: string[],
  options?: IndexArtifactOptions,
): Promise<string[]> {
  await ensureScplusLayout(resolve(rootDir));
  if (entryIds.length === 0) return [];
  const uniqueEntryIds = Array.from(new Set(entryIds));
  const db = openIndexDatabase(rootDir);
  try {
    const storedNamespace = resolveStoredVectorNamespace(db, namespace, options);
    const presentEntryIds: string[] = [];
    const chunkSize = 400;
    for (let index = 0; index < uniqueEntryIds.length; index += chunkSize) {
      const chunk = uniqueEntryIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT entry_id
        FROM vector_entries
        WHERE namespace = ? AND entry_id IN (${placeholders})
        ORDER BY entry_id
      `).all(storedNamespace, ...chunk) as Array<{ entry_id: string }>;
      for (const row of rows) presentEntryIds.push(row.entry_id);
    }
    return presentEntryIds;
  } finally {
    db.close();
  }
}

// Purpose: Load one vector namespace and index it by entry id.
// Inputs: The repository root, logical namespace, and optional generation options.
// Returns/Effects: Returns the vector entries as a map keyed by entry id.
export async function loadVectorCollectionMap<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  options?: IndexArtifactOptions,
): Promise<Map<string, VectorStoreEntry<TMetadata>>> {
  const entries = await loadVectorCollection<TMetadata>(rootDir, namespace, options);
  return new Map(entries.map((entry) => [entry.id, entry]));
}

// Purpose: Replace the entire contents of one generation-qualified vector namespace.
// Inputs: The repository root, logical namespace, next entries, and optional generation options.
// Returns/Effects: Rewrites the namespace rows and updates its collection metadata.
export async function replaceVectorCollection<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  entries: VectorStoreEntry<TMetadata>[],
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  const updatedAt = new Date().toISOString();
  try {
    const serving = readServingStateFromDb(db);
    const context = indexGenerationContext.getStore();
    const storedNamespace = qualifyVectorNamespace(namespace, options?.generation ?? context?.writeGeneration ?? serving.activeGeneration);
    db.exec("BEGIN");
    db.prepare(`
      INSERT INTO vector_collections (namespace, entry_count, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        entry_count = excluded.entry_count,
        updated_at = excluded.updated_at
    `).run(storedNamespace, entries.length, updatedAt);
    db.prepare(`DELETE FROM vector_entries WHERE namespace = ?`).run(storedNamespace);
    if (entries.length > 0) {
      const statement = db.prepare(`
        INSERT INTO vector_entries (
          namespace,
          entry_id,
          content_hash,
          search_text,
          vector_blob,
          metadata_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        statement.run(
          storedNamespace,
          entry.id,
          entry.contentHash,
          entry.searchText,
          encodeVectorBlob(entry.vector),
          JSON.stringify(entry.metadata),
          updatedAt,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Upsert selected vector entries into one generation-qualified namespace.
// Inputs: The repository root, logical namespace, entries to upsert, and optional generation options.
// Returns/Effects: Inserts or updates the entries and refreshes the namespace metadata.
export async function upsertVectorEntries<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  entries: VectorStoreEntry<TMetadata>[],
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  const updatedAt = new Date().toISOString();
  try {
    const serving = readServingStateFromDb(db);
    const context = indexGenerationContext.getStore();
    const storedNamespace = qualifyVectorNamespace(namespace, options?.generation ?? context?.writeGeneration ?? serving.activeGeneration);
    db.exec("BEGIN");
    db.prepare(`
      INSERT INTO vector_collections (namespace, entry_count, updated_at)
      VALUES (
        ?,
        COALESCE((SELECT entry_count FROM vector_collections WHERE namespace = ?), 0),
        ?
      )
      ON CONFLICT(namespace) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(storedNamespace, storedNamespace, updatedAt);
    if (entries.length > 0) {
      const statement = db.prepare(`
        INSERT INTO vector_entries (
          namespace,
          entry_id,
          content_hash,
          search_text,
          vector_blob,
          metadata_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, entry_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          search_text = excluded.search_text,
          vector_blob = excluded.vector_blob,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `);
      for (const entry of entries) {
        statement.run(
          storedNamespace,
          entry.id,
          entry.contentHash,
          entry.searchText,
          encodeVectorBlob(entry.vector),
          JSON.stringify(entry.metadata),
          updatedAt,
        );
      }
    }
    db.prepare(`
      UPDATE vector_collections
      SET entry_count = (
        SELECT COUNT(*)
        FROM vector_entries
        WHERE namespace = ?
      ),
      updated_at = ?
      WHERE namespace = ?
    `).run(storedNamespace, updatedAt, storedNamespace);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Delete selected vector entries from one generation-qualified namespace.
// Inputs: The repository root, logical namespace, entry ids, and optional generation options.
// Returns/Effects: Removes the selected entries and refreshes the namespace metadata.
export async function deleteVectorEntries(rootDir: string, namespace: string, entryIds: string[], options?: IndexArtifactOptions): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  if (entryIds.length === 0) return;
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const context = indexGenerationContext.getStore();
    const storedNamespace = qualifyVectorNamespace(namespace, options?.generation ?? context?.writeGeneration ?? serving.activeGeneration);
    db.exec("BEGIN");
    const placeholders = entryIds.map(() => "?").join(", ");
    db.prepare(`
      DELETE FROM vector_entries
      WHERE namespace = ? AND entry_id IN (${placeholders})
    `).run(storedNamespace, ...entryIds);
    db.prepare(`
      UPDATE vector_collections
      SET entry_count = (
        SELECT COUNT(*)
        FROM vector_entries
        WHERE namespace = ?
      ),
      updated_at = ?
      WHERE namespace = ?
    `).run(storedNamespace, new Date().toISOString(), storedNamespace);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Purpose: Delete an entire generation-qualified vector namespace and its entries.
// Inputs: The repository root, logical namespace, and optional generation options.
// Returns/Effects: Removes the namespace metadata row and all contained vector entries.
export async function deleteVectorCollection(rootDir: string, namespace: string, options?: IndexArtifactOptions): Promise<void> {
  await ensureScplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const context = indexGenerationContext.getStore();
    const storedNamespace = qualifyVectorNamespace(namespace, options?.generation ?? context?.writeGeneration ?? serving.activeGeneration);
    db.exec("BEGIN");
    db.prepare(`DELETE FROM vector_entries WHERE namespace = ?`).run(storedNamespace);
    db.prepare(`DELETE FROM vector_collections WHERE namespace = ?`).run(storedNamespace);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
