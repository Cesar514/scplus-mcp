import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Ollama } from "ollama";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SearchIndex,
  fetchEmbedding,
  getEmbeddingRuntimeStats,
  getEmbeddingBatchSize,
  loadEmbeddingCache,
  loadEmbeddingCacheEntries,
  resetEmbeddingRuntimeStats,
  saveEmbeddingCache,
  upsertEmbeddingCacheEntries,
} from "../../build/core/embeddings.js";
import {
  activateIndexGeneration,
  getIndexDatabasePath,
  reservePendingIndexGeneration,
  runWithIndexGenerationContext,
} from "../../build/core/index-database.js";

function getActiveGeneration(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT meta_value FROM index_db_meta WHERE meta_key = 'activeGeneration'").get();
    return row ? Number.parseInt(row.meta_value, 10) : 0;
  } finally {
    db.close();
  }
}

function qualifyNamespace(namespace, generation) {
  if (generation === 0) return namespace;
  return `generation:${generation}:${namespace}`;
}

function readVectorEntries(dbPath, namespace) {
  const db = new DatabaseSync(dbPath);
  try {
    const generation = getActiveGeneration(dbPath);
    const storedNamespace = qualifyNamespace(namespace, generation);
    return db.prepare(`
      SELECT entry_id, content_hash, updated_at
      FROM vector_entries
      WHERE namespace = ?
      ORDER BY entry_id
    `).all(storedNamespace);
  } finally {
    db.close();
  }
}

function readVectorEntryStorage(dbPath, namespace, entryId) {
  const db = new DatabaseSync(dbPath);
  try {
    const generation = getActiveGeneration(dbPath);
    const storedNamespace = qualifyNamespace(namespace, generation);
    return db.prepare(`
      SELECT typeof(vector_blob) AS vector_type, length(vector_blob) AS vector_length
      FROM vector_entries
      WHERE namespace = ? AND entry_id = ?
    `).get(storedNamespace, entryId);
  } finally {
    db.close();
  }
}

function readVectorCollectionEntryCount(dbPath, namespace) {
  const db = new DatabaseSync(dbPath);
  try {
    const generation = getActiveGeneration(dbPath);
    const storedNamespace = qualifyNamespace(namespace, generation);
    const row = db.prepare(`
      SELECT entry_count
      FROM vector_collections
      WHERE namespace = ?
    `).get(storedNamespace);
    return row ? row.entry_count : null;
  } finally {
    db.close();
  }
}

function deleteVectorEntry(dbPath, namespace, entryId) {
  const db = new DatabaseSync(dbPath);
  try {
    const generation = getActiveGeneration(dbPath);
    const storedNamespace = qualifyNamespace(namespace, generation);
    db.exec("BEGIN");
    db.prepare(`
      DELETE FROM vector_entries
      WHERE namespace = ? AND entry_id = ?
    `).run(storedNamespace, entryId);
    db.prepare(`
      UPDATE vector_collections
      SET entry_count = (
        SELECT COUNT(*)
        FROM vector_entries
        WHERE namespace = ?
      )
      WHERE namespace = ?
    `).run(storedNamespace, storedNamespace);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

describe("embeddings", () => {
  it("tracks process-cache hits, misses, and sqlite loads for embedding lookups", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-runtime-"));
    try {
      resetEmbeddingRuntimeStats();
      const pendingGeneration = await reservePendingIndexGeneration(rootDir);
      await runWithIndexGenerationContext({ writeGeneration: pendingGeneration }, async () => {
        await saveEmbeddingCache(rootDir, {
          alpha: { hash: "hash-a", vector: [1, 0, 0] },
          beta: { hash: "hash-b", vector: [0, 1, 0] },
        }, "chunk-embeddings-cache.json");
      });
      await activateIndexGeneration(rootDir, pendingGeneration, new Date().toISOString());
      resetEmbeddingRuntimeStats();

      await loadEmbeddingCacheEntries(rootDir, "chunk-embeddings-cache.json", ["alpha"]);
      await loadEmbeddingCacheEntries(rootDir, "chunk-embeddings-cache.json", ["alpha", "beta"]);
      const stats = getEmbeddingRuntimeStats();

      assert.equal(stats.processNamespaceHits+stats.processNamespaceMisses >= 1, true);
      assert.equal(stats.processVectorHits >= 1, true);
      assert.equal(typeof stats.sqliteEntryLoads, "number");
      assert.equal(typeof stats.sqliteNamespaceLoads, "number");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  describe("getEmbeddingBatchSize", () => {
    it("returns a GPU-safe value between 5 and 10", () => {
      const value = getEmbeddingBatchSize();
      assert.ok(value >= 5 && value <= 10);
    });
  });

  describe("SearchIndex", () => {
    it("creates an instance", () => {
      const index = new SearchIndex();
      assert.ok(index);
    });

    it("has zero documents initially", () => {
      const index = new SearchIndex();
      assert.equal(index.getDocumentCount(), 0);
    });

    it("index method exists", () => {
      const index = new SearchIndex();
      assert.equal(typeof index.index, "function");
    });

    it("search method exists", () => {
      const index = new SearchIndex();
      assert.equal(typeof index.search, "function");
    });

    it("getDocumentCount method exists", () => {
      const index = new SearchIndex();
      assert.equal(typeof index.getDocumentCount, "function");
    });

    it("re-embeds when content changes beyond first 8000 characters", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-"));
      let callCount = 0;
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        for (const value of batch) {
          if (value.length > 8000)
            throw new Error("input length exceeds context length");
        }
        callCount += batch.length;
        return { embeddings: batch.map(() => [1, 0, 0]) };
      };

      try {
        const index = new SearchIndex();
        const sharedPrefix = "x".repeat(8500);
        const firstDoc = [
          {
            path: "src/long.ts",
            header: "header",
            symbols: ["alpha"],
            content: `${sharedPrefix} tail_one`,
          },
        ];
        const secondDoc = [
          {
            path: "src/long.ts",
            header: "header",
            symbols: ["alpha"],
            content: `${sharedPrefix} tail_two`,
          },
        ];

        await index.index(firstDoc, rootDir);
        const firstPassCalls = callCount;
        assert.ok(firstPassCalls > 0);

        callCount = 0;
        await index.index(secondDoc, rootDir);
        assert.ok(callCount > 0);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe("fetchEmbedding", () => {
    it("splits failing batches and preserves embedding order", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const calls = [];
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        calls.push(batch.map((value) => value.length));
        if (batch.length > 1)
          throw new Error("the input length exceeds the context length");
        return { embeddings: batch.map((value) => [value.length]) };
      };

      try {
        const inputs = ["alpha", "beta", "gamma", "delta", "epsilon"];
        const vectors = await fetchEmbedding(inputs);
        assert.deepEqual(vectors, [[5], [4], [5], [5], [7]]);
        assert.ok(calls.some((batch) => batch.length > 1));
        assert.ok(calls.some((batch) => batch.length === 1));
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("shrinks oversized single inputs until they fit context", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const seenLengths = [];
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        seenLengths.push(batch[0].length);
        if (batch[0].length > 400)
          throw new Error("input length exceeds context length");
        return { embeddings: [[batch[0].length]] };
      };

      try {
        const vectors = await fetchEmbedding("x".repeat(2048));
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0][0] <= 400);
        assert.ok(seenLengths.length > 1);
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("splits oversized text into chunks and merges vectors", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const tailMarker = "__tail_marker__";
      const seenLengths = [];

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        for (const value of batch) {
          seenLengths.push(value.length);
          if (value.length > 8000)
            throw new Error("input length exceeds context length");
        }
        return {
          embeddings: batch.map((value) => [
            value.includes(tailMarker) ? 10 : 1,
          ]),
        };
      };

      try {
        const vectors = await fetchEmbedding(
          `${"a".repeat(9000)}${tailMarker}${"b".repeat(1000)}`,
        );
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0][0] > 1);
        assert.ok(seenLengths.every((length) => length <= 8000));
        assert.ok(seenLengths.length > 1);
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("keeps shrinking under strict context limits beyond eight retries", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const seenLengths = [];

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        seenLengths.push(...batch.map((value) => value.length));
        if (batch.some((value) => value.length > 20)) {
          throw new Error("input length exceeds context length");
        }
        return { embeddings: batch.map((value) => [value.length]) };
      };

      try {
        const vectors = await fetchEmbedding("x".repeat(8000));
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0][0] <= 20);
        assert.ok(seenLengths.length > 9);
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("forwards configured embed runtime options to Ollama", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const previousEnv = {
        CONTEXTPLUS_EMBED_NUM_GPU: process.env.CONTEXTPLUS_EMBED_NUM_GPU,
        CONTEXTPLUS_EMBED_MAIN_GPU: process.env.CONTEXTPLUS_EMBED_MAIN_GPU,
        CONTEXTPLUS_EMBED_NUM_THREAD: process.env.CONTEXTPLUS_EMBED_NUM_THREAD,
        CONTEXTPLUS_EMBED_NUM_BATCH: process.env.CONTEXTPLUS_EMBED_NUM_BATCH,
        CONTEXTPLUS_EMBED_NUM_CTX: process.env.CONTEXTPLUS_EMBED_NUM_CTX,
        CONTEXTPLUS_EMBED_LOW_VRAM: process.env.CONTEXTPLUS_EMBED_LOW_VRAM,
      };
      const requests = [];

      process.env.CONTEXTPLUS_EMBED_NUM_GPU = "1";
      process.env.CONTEXTPLUS_EMBED_MAIN_GPU = "0";
      process.env.CONTEXTPLUS_EMBED_NUM_THREAD = "6";
      process.env.CONTEXTPLUS_EMBED_NUM_BATCH = "64";
      process.env.CONTEXTPLUS_EMBED_NUM_CTX = "4096";
      process.env.CONTEXTPLUS_EMBED_LOW_VRAM = "true";

      Ollama.prototype.embed = async function (request) {
        requests.push(request);
        const batch = Array.isArray(request.input)
          ? request.input
          : [request.input];
        return { embeddings: batch.map((value) => [value.length]) };
      };

      try {
        const vectors = await fetchEmbedding("gpu options probe");
        assert.equal(vectors.length, 1);
        assert.ok(requests.length > 0);
        assert.deepEqual(requests[0].options, {
          num_gpu: 1,
          main_gpu: 0,
          num_thread: 6,
          num_batch: 64,
          num_ctx: 4096,
          low_vram: true,
        });
      } finally {
        Ollama.prototype.embed = originalEmbed;
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  describe("saveEmbeddingCache", () => {
    it("stores vectors as sqlite blobs instead of JSON text", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-binary-"));
      try {
        await saveEmbeddingCache(rootDir, {
          "src/a.ts": { hash: "hash-a-v1", vector: [1, 0.5, -2] },
        }, "chunk-embeddings-cache.json");

        const dbPath = await getIndexDatabasePath(rootDir);
        const storage = readVectorEntryStorage(dbPath, "chunk-search", "src/a.ts");
        assert.equal(storage.vector_type, "blob");
        assert.equal(storage.vector_length, 3 * Float32Array.BYTES_PER_ELEMENT);

        const cache = await loadEmbeddingCache(rootDir, "chunk-embeddings-cache.json");
        assert.deepEqual(cache["src/a.ts"].vector, [1, 0.5, -2]);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("updates only changed entries and deletes removed entries without rewriting untouched vectors", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-cache-"));
      try {
        await saveEmbeddingCache(rootDir, {
          "src/a.ts": { hash: "hash-a-v1", vector: [1, 0, 0] },
          "src/b.ts": { hash: "hash-b-v1", vector: [0, 1, 0] },
        }, "chunk-embeddings-cache.json");

        const dbPath = await getIndexDatabasePath(rootDir);
        const firstEntries = readVectorEntries(dbPath, "chunk-search");
        assert.equal(firstEntries.length, 2);
        const firstUpdatedAtById = new Map(firstEntries.map((entry) => [entry.entry_id, entry.updated_at]));

        await new Promise((resolve) => setTimeout(resolve, 20));

        await saveEmbeddingCache(rootDir, {
          "src/b.ts": { hash: "hash-b-v2", vector: [0, 1, 1] },
          "src/c.ts": { hash: "hash-c-v1", vector: [1, 1, 0] },
        }, "chunk-embeddings-cache.json");

        const nextEntries = readVectorEntries(dbPath, "chunk-search");
        assert.deepEqual(nextEntries.map((entry) => entry.entry_id), ["src/b.ts", "src/c.ts"]);
        assert.equal(readVectorCollectionEntryCount(dbPath, "chunk-search"), 2);
        assert.equal(nextEntries.find((entry) => entry.entry_id === "src/b.ts").content_hash, "hash-b-v2");
        assert.equal(nextEntries.find((entry) => entry.entry_id === "src/c.ts").content_hash, "hash-c-v1");
        assert.equal(nextEntries.find((entry) => entry.entry_id === "src/b.ts").updated_at !== firstUpdatedAtById.get("src/b.ts"), true);
        assert.equal(firstUpdatedAtById.has("src/c.ts"), false);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("preserves split identifier namespaces and materializes empty callsite collections", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-identifier-cache-"));
      try {
        await saveEmbeddingCache(rootDir, {
          "id:run": { hash: "hash-run", vector: [1, 2, 3] },
          "callsite:run@src/app.ts:10": { hash: "hash-callsite", vector: [3, 2, 1] },
        }, "identifier-embeddings-cache.json");

        let cache = await loadEmbeddingCache(rootDir, "identifier-embeddings-cache.json");
        assert.deepEqual(Object.keys(cache).sort(), ["callsite:run@src/app.ts:10", "id:run"]);

        await saveEmbeddingCache(rootDir, {
          "id:run": { hash: "hash-run-v2", vector: [4, 5, 6] },
        }, "identifier-embeddings-cache.json");

        cache = await loadEmbeddingCache(rootDir, "identifier-embeddings-cache.json");
        assert.deepEqual(Object.keys(cache), ["id:run"]);
        assert.equal(cache["id:run"].hash, "hash-run-v2");

        const dbPath = await getIndexDatabasePath(rootDir);
        assert.equal(readVectorCollectionEntryCount(dbPath, "identifier-search"), 1);
        assert.equal(readVectorCollectionEntryCount(dbPath, "identifier-callsite-search"), 0);
        assert.deepEqual(readVectorEntries(dbPath, "identifier-callsite-search"), []);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("reuses process-cached namespace entries for repeated candidate loads", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-process-cache-"));
      try {
        await saveEmbeddingCache(rootDir, {
          "src/a.ts": { hash: "hash-a", vector: [1, 0, 0] },
          "src/b.ts": { hash: "hash-b", vector: [0, 1, 0] },
        }, "chunk-embeddings-cache.json");

        const first = await loadEmbeddingCacheEntries(rootDir, "chunk-embeddings-cache.json", ["src/a.ts"]);
        assert.equal(first["src/a.ts"].hash, "hash-a");

        const dbPath = await getIndexDatabasePath(rootDir);
        deleteVectorEntry(dbPath, "chunk-search", "src/a.ts");
        assert.deepEqual(readVectorEntries(dbPath, "chunk-search").map((entry) => entry.entry_id), ["src/b.ts"]);

        const second = await loadEmbeddingCacheEntries(rootDir, "chunk-embeddings-cache.json", ["src/a.ts"]);
        assert.equal(second["src/a.ts"].hash, "hash-a");
        assert.deepEqual(second["src/a.ts"].vector, [1, 0, 0]);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("invalidates process-cached namespace entries when the active generation changes", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-generation-cache-"));
      try {
        await saveEmbeddingCache(rootDir, {
          "src/a.ts": { hash: "hash-generation-0", vector: [1, 0, 0] },
        }, "chunk-embeddings-cache.json");

        const generationZero = await loadEmbeddingCacheEntries(rootDir, "chunk-embeddings-cache.json", ["src/a.ts"]);
        assert.equal(generationZero["src/a.ts"].hash, "hash-generation-0");

        const pendingGeneration = await reservePendingIndexGeneration(rootDir);
        await runWithIndexGenerationContext({ readGeneration: 0, writeGeneration: pendingGeneration }, async () => {
          await saveEmbeddingCache(rootDir, {
            "src/a.ts": { hash: "hash-generation-1", vector: [0, 1, 0] },
          }, "chunk-embeddings-cache.json");
        });
        await activateIndexGeneration(rootDir, pendingGeneration, new Date().toISOString());

        const generationOne = await loadEmbeddingCacheEntries(rootDir, "chunk-embeddings-cache.json", ["src/a.ts"]);
        assert.equal(generationOne["src/a.ts"].hash, "hash-generation-1");
        assert.deepEqual(generationOne["src/a.ts"].vector, [0, 1, 0]);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("upserts only requested embedding cache entries without replacing the namespace", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-partial-upsert-"));
      try {
        await saveEmbeddingCache(rootDir, {
          "src/a.ts": { hash: "hash-a", vector: [1, 0, 0] },
          "src/b.ts": { hash: "hash-b", vector: [0, 1, 0] },
        }, "chunk-embeddings-cache.json");

        const dbPath = await getIndexDatabasePath(rootDir);
        const firstEntries = readVectorEntries(dbPath, "chunk-search");
        const firstUpdatedAtById = new Map(firstEntries.map((entry) => [entry.entry_id, entry.updated_at]));

        await new Promise((resolve) => setTimeout(resolve, 20));
        await upsertEmbeddingCacheEntries(rootDir, {
          "src/b.ts": { hash: "hash-b-v2", vector: [0, 1, 1] },
        }, "chunk-embeddings-cache.json");

        const nextEntries = readVectorEntries(dbPath, "chunk-search");
        assert.deepEqual(nextEntries.map((entry) => entry.entry_id), ["src/a.ts", "src/b.ts"]);
        assert.equal(nextEntries.find((entry) => entry.entry_id === "src/a.ts").updated_at, firstUpdatedAtById.get("src/a.ts"));
        assert.equal(nextEntries.find((entry) => entry.entry_id === "src/b.ts").content_hash, "hash-b-v2");
        assert.equal(nextEntries.find((entry) => entry.entry_id === "src/b.ts").updated_at !== firstUpdatedAtById.get("src/b.ts"), true);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("migrates legacy JSON vector rows to binary blobs when opening an existing database", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-migrate-"));
      try {
        const dbPath = await getIndexDatabasePath(rootDir);
        const db = new DatabaseSync(dbPath);
        try {
          db.exec(`
            DROP TABLE IF EXISTS vector_entries;
            DROP TABLE IF EXISTS vector_collections;
            DROP TABLE IF EXISTS index_db_meta;
            CREATE TABLE index_db_meta (
              meta_key TEXT PRIMARY KEY,
              meta_value TEXT NOT NULL
            );
            CREATE TABLE vector_collections (
              namespace TEXT PRIMARY KEY,
              entry_count INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE vector_entries (
              namespace TEXT NOT NULL,
              entry_id TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              search_text TEXT NOT NULL,
              vector_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (namespace, entry_id)
            );
            INSERT INTO index_db_meta (meta_key, meta_value) VALUES ('schemaVersion', '3');
            INSERT INTO index_db_meta (meta_key, meta_value) VALUES ('activeGeneration', '0');
            INSERT INTO index_db_meta (meta_key, meta_value) VALUES ('latestGeneration', '0');
            INSERT INTO index_db_meta (meta_key, meta_value) VALUES ('activeGenerationFreshness', 'fresh');
            INSERT INTO vector_collections (namespace, entry_count, updated_at)
            VALUES ('chunk-search', 1, '2026-01-01T00:00:00.000Z');
            INSERT INTO vector_entries (
              namespace,
              entry_id,
              content_hash,
              search_text,
              vector_json,
              metadata_json,
              updated_at
            ) VALUES (
              'chunk-search',
              'src/legacy.ts',
              'legacy-hash',
              'legacy text',
              '[1,0.5,-2]',
              '{\"source\":\"legacy\"}',
              '2026-01-01T00:00:00.000Z'
            );
          `);
        } finally {
          db.close();
        }

        const cache = await loadEmbeddingCache(rootDir, "chunk-embeddings-cache.json");
        assert.deepEqual(cache["src/legacy.ts"].vector, [1, 0.5, -2]);

        const migratedDb = new DatabaseSync(dbPath);
        try {
          const schemaVersion = migratedDb.prepare(`
            SELECT meta_value
            FROM index_db_meta
            WHERE meta_key = 'schemaVersion'
          `).get();
          const columns = migratedDb.prepare(`PRAGMA table_info(vector_entries)`).all();
          const legacyTable = migratedDb.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'vector_entries_legacy'
          `).get();
          assert.equal(schemaVersion.meta_value, "4");
          assert.equal(columns.some((column) => column.name === "vector_blob"), true);
          assert.equal(columns.some((column) => column.name === "vector_json"), false);
          assert.equal(legacyTable, undefined);
        } finally {
          migratedDb.close();
        }

        const storage = readVectorEntryStorage(dbPath, "chunk-search", "src/legacy.ts");
        assert.equal(storage.vector_type, "blob");
        assert.equal(storage.vector_length, 3 * Float32Array.BYTES_PER_ELEMENT);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });
});
