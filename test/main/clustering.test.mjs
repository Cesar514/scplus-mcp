// Scalable clustering and path pattern tests
// Tests deterministic centroid clustering and file path pattern detection

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clusterVectors, findPathPattern } from "../../build/core/clustering.js";

function makeClusteredVectors(count, groupCount = 4) {
  return Array.from({ length: count }, (_, index) => {
    const group = index % groupCount;
    const angle = (index + 1) * 0.07;
    const base = new Array(8).fill(0);
    base[group % base.length] = 1;
    base[(group + 3) % base.length] = 0.35;
    return base.map((value, dimension) => value + (Math.sin(angle + dimension) * 0.02));
  });
}

describe("clustering", () => {
  describe("clusterVectors", () => {
    it("returns single cluster for 1 vector", () => {
      const result = clusterVectors([[1, 0, 0]]);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0].indices, [0]);
    });

    it("returns individual clusters when n <= maxClusters", () => {
      const vectors = [
        [1, 0],
        [0, 1],
        [0.5, 0.5],
      ];
      const result = clusterVectors(vectors, 20);
      assert.equal(result.length, 3);
    });

    it("clusters similar vectors together", () => {
      const vectors = [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0.95, 0.05, 0],
        [0, 1, 0],
        [0.1, 0.9, 0],
        [0.05, 0.95, 0],
      ];
      const result = clusterVectors(vectors, 2);
      assert.equal(result.length, 2);
      const allIndices = result.flatMap((cluster) => cluster.indices).sort();
      assert.deepEqual(allIndices, [0, 1, 2, 3, 4, 5]);
      const normalized = result
        .map((cluster) => [...cluster.indices].sort((left, right) => left - right))
        .sort((left, right) => left[0] - right[0]);
      assert.deepEqual(normalized, [[0, 1, 2], [3, 4, 5]]);
    });

    it("respects maxClusters parameter", () => {
      const vectors = Array.from({ length: 50 }, (_, i) => [
        Math.cos(i),
        Math.sin(i),
        i / 50,
      ]);
      const result = clusterVectors(vectors, 5);
      assert.ok(result.length <= 5);
      assert.ok(result.length >= 1);
    });

    it("covers all indices exactly once", () => {
      const n = 30;
      const vectors = Array.from({ length: n }, (_, i) => [
        Math.cos(i * 0.5),
        Math.sin(i * 0.5),
        i / n,
      ]);
      const result = clusterVectors(vectors, 10);
      const allIndices = result.flatMap((c) => c.indices).sort((a, b) => a - b);
      assert.equal(allIndices.length, n);
      assert.deepEqual(
        allIndices,
        Array.from({ length: n }, (_, i) => i),
      );
    });

    it("handles identical vectors", () => {
      const vectors = [
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ];
      const result = clusterVectors(vectors, 20);
      assert.ok(result.length >= 1);
    });

    it("handles medium and large clustered vector sets without matrix-based decomposition", () => {
      for (const vectorCount of [240, 1800]) {
        const vectors = makeClusteredVectors(vectorCount, 6);
        const result = clusterVectors(vectors, 12);
        const allIndices = result.flatMap((cluster) => cluster.indices).sort((left, right) => left - right);
        assert.equal(result.length <= 12, true);
        assert.equal(allIndices.length, vectorCount);
        assert.deepEqual(allIndices, Array.from({ length: vectorCount }, (_, index) => index));
      }
    });
  });

  describe("findPathPattern", () => {
    it("returns null for single path", () => {
      assert.equal(findPathPattern(["src/index.ts"]), null);
    });

    it("finds common prefix", () => {
      const result = findPathPattern([
        "src/core/parser.ts",
        "src/core/walker.ts",
      ]);
      assert.equal(result, "src/core/*");
    });

    it("finds common suffix", () => {
      const result = findPathPattern(["src/types.ts", "lib/types.ts"]);
      assert.equal(result, "*/types.ts");
    });

    it("finds both prefix and suffix", () => {
      const result = findPathPattern(["test/a/index.ts", "test/b/index.ts"]);
      assert.equal(result, "test/index.ts");
    });

    it("returns null when no common pattern", () => {
      const result = findPathPattern([
        "src/app.ts",
        "lib/utils.js",
        "test/main.py",
      ]);
      assert.equal(result, null);
    });

    it("returns null for empty array", () => {
      const result = findPathPattern([]);
      assert.equal(result, null);
    });
  });
});
