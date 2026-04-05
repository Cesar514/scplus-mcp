// summary: Encapsulates sqlite schema helpers and vector table migration for the index database.
// FEATURE: Table discovery, column inspection, vector-entry schema creation, and legacy migration.
// inputs: Open sqlite database handles and legacy vector entry rows.
// outputs: Initialized vector-entry schema state and migrated binary vector rows.

import { DatabaseSync } from "node:sqlite";
import { encodeVectorBlob, type LegacyVectorEntryRow } from "./index-database-vectors.js";

export function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined;
  return row?.name === tableName;
}

export function getTableColumns(db: DatabaseSync, tableName: string): string[] {
  if (!/^[a-z0-9_]+$/i.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  if (!hasTable(db, tableName)) return [];
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function createBinaryVectorEntriesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_entries (
      namespace TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      search_text TEXT NOT NULL,
      vector_blob BLOB NOT NULL,
      metadata_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, entry_id)
    );

    CREATE INDEX IF NOT EXISTS idx_vector_entries_namespace
    ON vector_entries(namespace);
  `);
}

export function migrateLegacyVectorEntriesToBinary(db: DatabaseSync): void {
  const columns = getTableColumns(db, "vector_entries");
  if (columns.includes("vector_blob")) return;
  if (!columns.includes("vector_json")) {
    throw new Error("vector_entries table exists but does not expose either vector_blob or vector_json.");
  }

  db.exec("BEGIN");
  try {
    db.prepare(`ALTER TABLE vector_entries RENAME TO vector_entries_legacy`).run();
    createBinaryVectorEntriesTable(db);
    const legacyRows = db.prepare(`
      SELECT namespace, entry_id, content_hash, search_text, vector_json, metadata_json, updated_at
      FROM vector_entries_legacy
      ORDER BY namespace, entry_id
    `).all() as unknown as LegacyVectorEntryRow[];
    const insert = db.prepare(`
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
    for (const row of legacyRows) {
      let parsedVector: unknown;
      try {
        parsedVector = JSON.parse(row.vector_json) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Malformed legacy vector JSON for ${row.namespace}/${row.entry_id}: ${error.message}`);
        }
        throw error;
      }
      if (!Array.isArray(parsedVector)) {
        throw new Error(`Legacy vector entry ${row.namespace}/${row.entry_id} did not contain a JSON array.`);
      }
      insert.run(
        row.namespace,
        row.entry_id,
        row.content_hash,
        row.search_text,
        encodeVectorBlob(parsedVector as number[]),
        row.metadata_json,
        row.updated_at,
      );
    }
    db.prepare(`DROP TABLE vector_entries_legacy`).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
