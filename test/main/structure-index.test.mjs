// Structure index contract tests for richer per-file and per-module artifacts
// FEATURE: Module summaries, ownership edges, and file-to-symbol mappings

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("structure-index", () => {
  it("persists richer file and module structure artifacts", async () => {
    const { refreshStructureIndexState } = await import("../../build/tools/full-index-artifacts.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-structure-index-"));

    try {
      await mkdir(join(rootDir, "src", "lib"), { recursive: true });
      await mkdir(join(rootDir, "src", "services"), { recursive: true });
      await writeFile(
        join(rootDir, "src", "lib", "helper.ts"),
        [
          "// Structure fixture for helper module",
          "// FEATURE: module ownership and symbol mapping coverage",
          "export function helperValue(): string {",
          "  return 'alpha';",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "src", "services", "consumer.ts"),
        [
          "// Structure fixture for consumer module",
          "// FEATURE: module import edges and file-to-symbol mappings",
          "import { helperValue } from '../lib/helper';",
          "",
          "export function consumeValue(): string {",
          "  return helperValue();",
          "}",
          "",
        ].join("\n"),
      );

      const result = await refreshStructureIndexState(rootDir);
      const consumerEntry = result.state.files["src/services/consumer.ts"];
      const helperEntry = result.state.files["src/lib/helper.ts"];

      assert.equal(result.state.artifactVersion, 9);
      assert.equal(result.state.contractVersion, 7);
      assert.equal(result.state.mode, "full");
      assert.ok(consumerEntry);
      assert.ok(helperEntry);
      assert.equal(consumerEntry.artifact.modulePath, "src/services");
      assert.deepEqual(consumerEntry.artifact.dependencyPaths, ["src/lib/helper.ts"]);
      assert.equal(Array.isArray(result.state.fileToSymbolIds["src/services/consumer.ts"]), true);
      assert.equal(result.state.fileToSymbolIds["src/services/consumer.ts"].length >= 1, true);

      const consumerSymbolId = result.state.fileToSymbolIds["src/services/consumer.ts"][0];
      assert.equal(result.state.symbols[consumerSymbolId].filePath, "src/services/consumer.ts");
      assert.equal(result.state.symbols[consumerSymbolId].modulePath, "src/services");

      assert.equal(result.state.ownershipEdges.some((edge) =>
        edge.sourceType === "file"
        && edge.sourcePath === "src/services/consumer.ts"
        && edge.targetType === "symbol"
        && edge.targetId === consumerSymbolId
      ), true);

      assert.equal(result.state.ownershipEdges.some((edge) =>
        edge.sourceType === "module"
        && edge.sourcePath === "src/services"
        && edge.targetType === "file"
        && edge.targetId === "src/services/consumer.ts"
      ), true);

      assert.deepEqual(result.state.moduleSummaries["src/services"].filePaths, ["src/services/consumer.ts"]);
      assert.deepEqual(result.state.moduleSummaries["src/services"].localDependencyPaths, ["src/lib/helper.ts"]);
      assert.equal(result.state.moduleSummaries["src/services"].exportedSymbolIds.length >= 1, true);

      assert.equal(result.state.moduleImportEdges.some((edge) =>
        edge.fromModule === "src/services"
        && edge.toModule === "src/lib"
        && edge.dependencyPath === "src/lib/helper.ts"
      ), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
