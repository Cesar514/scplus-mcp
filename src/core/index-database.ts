// SQLite-backed durable storage for all authoritative Context+ machine state
// FEATURE: Full-engine sqlite-only state substrate, artifacts, vector collections, and backups

import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "fs/promises";
import { join, resolve } from "path";
import { CONTEXTPLUS_INDEX_DB_FILE, ensureContextplusLayout } from "./project-layout.js";

export const INDEX_DATABASE_SCHEMA_VERSION = 3;
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

export interface VectorStoreEntry<TMetadata = unknown> {
  id: string;
  contentHash: string;
  searchText: string;
  vector: number[];
  metadata: TMetadata;
}

interface VectorCollectionRow {
  namespace: string;
}

interface VectorEntryRow {
  entry_id: string;
  content_hash: string;
  search_text: string;
  vector_json: string;
  metadata_json: string;
}

function mapVectorEntryRow<TMetadata>(row: VectorEntryRow): VectorStoreEntry<TMetadata> {
  return {
    id: row.entry_id,
    contentHash: row.content_hash,
    searchText: row.search_text,
    vector: JSON.parse(row.vector_json) as number[],
    metadata: JSON.parse(row.metadata_json) as TMetadata,
  };
}

function resolveStoredVectorNamespace(
  db: DatabaseSync,
  namespace: string,
  options?: IndexArtifactOptions,
): string {
  const serving = readServingStateFromDb(db);
  const context = indexGenerationContext.getStore();
  return qualifyVectorNamespace(namespace, options?.generation ?? context?.readGeneration ?? serving.activeGeneration);
}

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

    CREATE TABLE IF NOT EXISTS vector_entries (
      namespace TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      search_text TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, entry_id)
    );

    CREATE INDEX IF NOT EXISTS idx_vector_entries_namespace
    ON vector_entries(namespace);
  `);

  db.prepare(`
    INSERT INTO index_db_meta (meta_key, meta_value)
    VALUES ('schemaVersion', ?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
  `).run(String(INDEX_DATABASE_SCHEMA_VERSION));
  db.prepare(`INSERT OR IGNORE INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)`).run(META_ACTIVE_GENERATION, "0");
  db.prepare(`INSERT OR IGNORE INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)`).run(META_LATEST_GENERATION, "0");
  db.prepare(`INSERT OR IGNORE INTO index_db_meta (meta_key, meta_value) VALUES (?, ?)`).run(META_ACTIVE_GENERATION_FRESHNESS, "fresh");
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

export async function loadIndexServingState(rootDir: string): Promise<IndexServingState> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    return readServingStateFromDb(db);
  } finally {
    db.close();
  }
}

export async function reservePendingIndexGeneration(rootDir: string): Promise<number> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function activateIndexGeneration(
  rootDir: string,
  generation: number,
  validatedAt: string,
): Promise<IndexServingState> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function clearPendingIndexGeneration(rootDir: string, pendingGeneration?: number): Promise<IndexServingState> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function updateIndexServingFreshness(
  rootDir: string,
  freshness: IndexGenerationFreshness,
  blockedReason?: string,
): Promise<IndexServingState> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function runWithIndexGenerationContext<T>(
  context: { readGeneration?: number; writeGeneration?: number },
  operation: () => Promise<T>,
): Promise<T> {
  return indexGenerationContext.run(context, operation);
}

export function getIndexGenerationContext(): { readGeneration?: number; writeGeneration?: number } | undefined {
  return indexGenerationContext.getStore();
}

export async function saveIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  value: T,
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function loadIndexArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  emptyValue: () => T,
  options?: IndexArtifactOptions,
): Promise<T> {
  await ensureContextplusLayout(resolve(rootDir));
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
    return JSON.parse(row.artifact_json) as T;
  } finally {
    db.close();
  }
}

export async function saveIndexTextArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  value: string,
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function loadIndexTextArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  emptyValue: () => string,
  options?: IndexArtifactOptions,
): Promise<string> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function inspectIndexDatabase(rootDir: string, options?: IndexArtifactOptions): Promise<IndexDatabaseInspection> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function deleteIndexArtifact(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  kind: "artifact" | "text" = "artifact",
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const serving = readServingStateFromDb(db);
    const table = kind === "artifact" ? "index_artifacts" : "index_text_artifacts";
    const storedKey = qualifyArtifactStorageKey(
      artifactKey,
      resolveArtifactGeneration(artifactKey, options, serving.activeGeneration, "write"),
    );
    db.prepare(`DELETE FROM ${table} WHERE artifact_key = ?`).run(storedKey);
  } finally {
    db.close();
  }
}

export async function loadVectorCollection<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  options?: IndexArtifactOptions,
): Promise<VectorStoreEntry<TMetadata>[]> {
  await ensureContextplusLayout(resolve(rootDir));
  const db = openIndexDatabase(rootDir);
  try {
    const storedNamespace = resolveStoredVectorNamespace(db, namespace, options);
    const rows = db.prepare(`
      SELECT entry_id, content_hash, search_text, vector_json, metadata_json
      FROM vector_entries
      WHERE namespace = ?
      ORDER BY entry_id
    `).all(storedNamespace) as unknown as VectorEntryRow[];
    return rows.map((row) => mapVectorEntryRow<TMetadata>(row));
  } finally {
    db.close();
  }
}

export async function loadVectorEntriesById<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  entryIds: string[],
  options?: IndexArtifactOptions,
): Promise<VectorStoreEntry<TMetadata>[]> {
  await ensureContextplusLayout(resolve(rootDir));
  if (entryIds.length === 0) return [];
  const uniqueEntryIds = Array.from(new Set(entryIds));
  const db = openIndexDatabase(rootDir);
  try {
    const storedNamespace = resolveStoredVectorNamespace(db, namespace, options);
    const placeholders = uniqueEntryIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT entry_id, content_hash, search_text, vector_json, metadata_json
      FROM vector_entries
      WHERE namespace = ? AND entry_id IN (${placeholders})
      ORDER BY entry_id
    `).all(storedNamespace, ...uniqueEntryIds) as unknown as VectorEntryRow[];
    return rows.map((row) => mapVectorEntryRow<TMetadata>(row));
  } finally {
    db.close();
  }
}

export async function loadVectorCollectionMap<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  options?: IndexArtifactOptions,
): Promise<Map<string, VectorStoreEntry<TMetadata>>> {
  const entries = await loadVectorCollection<TMetadata>(rootDir, namespace, options);
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export async function replaceVectorCollection<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  entries: VectorStoreEntry<TMetadata>[],
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
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
          vector_json,
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
          JSON.stringify(entry.vector),
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

export async function upsertVectorEntries<TMetadata = unknown>(
  rootDir: string,
  namespace: string,
  entries: VectorStoreEntry<TMetadata>[],
  options?: IndexArtifactOptions,
): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
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
          vector_json,
          metadata_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, entry_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          search_text = excluded.search_text,
          vector_json = excluded.vector_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `);
      for (const entry of entries) {
        statement.run(
          storedNamespace,
          entry.id,
          entry.contentHash,
          entry.searchText,
          JSON.stringify(entry.vector),
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

export async function deleteVectorEntries(rootDir: string, namespace: string, entryIds: string[], options?: IndexArtifactOptions): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
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

export async function deleteVectorCollection(rootDir: string, namespace: string, options?: IndexArtifactOptions): Promise<void> {
  await ensureContextplusLayout(resolve(rootDir));
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
