// Vector row helpers for sqlite-backed Context+ index storage.
// FEATURE: Binary vector encoding and row mapping for durable retrieval data.

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

export function encodeVectorBlob(vector: number[]): Uint8Array {
  if (!Array.isArray(vector)) throw new Error("Vector entry must be an array of numbers.");
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Vector entry contained a non-finite number.");
  }
  return new Uint8Array(Float32Array.from(vector).buffer);
}

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

export function mapVectorEntryRow<TMetadata>(row: VectorEntryRow): VectorStoreEntry<TMetadata> {
  return {
    id: row.entry_id,
    contentHash: row.content_hash,
    searchText: row.search_text,
    vector: decodeVectorBlob(row.vector_blob),
    metadata: JSON.parse(row.metadata_json) as TMetadata,
  };
}
