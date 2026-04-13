// summary: Encodes and decodes sqlite vector rows for the durable scplus index.
// FEATURE: Binary vector encoding and row mapping for durable retrieval data.
// inputs: In-memory vectors, sqlite row payloads, and vector collection metadata.
// outputs: Serialized vector blobs and typed row-mapping helpers for retrieval storage.

export interface VectorStoreEntry<TMetadata = unknown> {
  id: string;
  contentHash: string;
  searchText: string;
  vector: number[];
  metadata: TMetadata;
}

export interface VectorCollectionRow {
  namespace: string;
}

export interface VectorEntryRow {
  entry_id: string;
  content_hash: string;
  search_text: string;
  vector_blob: Uint8Array;
  metadata_json: string;
}

export interface LegacyVectorEntryRow {
  namespace: string;
  entry_id: string;
  content_hash: string;
  search_text: string;
  vector_json: string;
  metadata_json: string;
  updated_at: string;
}

// Purpose: Encode one numeric vector into the binary blob format stored in sqlite.
// Inputs: The numeric vector that should be serialized.
// Returns/Effects: Returns the vector as a Float32-backed byte array or throws on invalid values.
export function encodeVectorBlob(vector: number[]): Uint8Array {
  if (!Array.isArray(vector)) throw new Error("Vector entry must be an array of numbers.");
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Vector entry contained a non-finite number.");
  }
  return new Uint8Array(Float32Array.from(vector).buffer);
}

// Purpose: Decode one sqlite vector blob back into a numeric vector.
// Inputs: The raw blob bytes read from sqlite.
// Returns/Effects: Returns the decoded numeric vector or throws when the blob shape is invalid.
function decodeVectorBlob(blob: Uint8Array): number[] {
  if (!(blob instanceof Uint8Array)) {
    throw new Error("Vector blob row was not returned as binary data.");
  }
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Vector blob length ${blob.byteLength} is not divisible by ${Float32Array.BYTES_PER_ELEMENT}.`);
  }
  const bytes = blob.byteOffset === 0 && blob.byteLength === blob.buffer.byteLength
    ? blob
    : blob.slice();
  const vector = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  return Array.from(vector);
}

// Purpose: Map one sqlite vector-entry row into the in-memory typed vector store shape.
// Inputs: The raw sqlite row containing ids, hashes, search text, blob bytes, and metadata JSON.
// Returns/Effects: Parses metadata JSON, decodes the vector blob, and returns the typed vector entry.
export function mapVectorEntryRow<TMetadata>(row: VectorEntryRow): VectorStoreEntry<TMetadata> {
  let metadata: TMetadata;
  try {
    metadata = JSON.parse(row.metadata_json) as TMetadata;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed vector metadata JSON for entry "${row.entry_id}": ${error.message}`);
    }
    throw error;
  }
  return {
    id: row.entry_id,
    contentHash: row.content_hash,
    searchText: row.search_text,
    vector: decodeVectorBlob(row.vector_blob),
    metadata,
  };
}
