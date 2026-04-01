// Project indexing command creates durable Context+ repo-local search state
// FEATURE: CLI coverage for .contextplus layout and persisted search manifests

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rerunIndexStage } from "../../build/tools/index-stages.js";

const execFileAsync = promisify(execFile);

async function expectExists(path) {
  await access(path);
}

function readArtifactFromDb(dbPath, artifactKey) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT artifact_json FROM index_artifacts WHERE artifact_key = ?").get(artifactKey);
    if (!row) return null;
    return JSON.parse(row.artifact_json);
  } finally {
    db.close();
  }
}

function readTextArtifactFromDb(dbPath, artifactKey) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT artifact_text FROM index_text_artifacts WHERE artifact_key = ?").get(artifactKey);
    return row?.artifact_text ?? null;
  } finally {
    db.close();
  }
}

describe("index", () => {
  it("creates the populated .contextplus project layout and snapshots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-index-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// App entrypoint for index testing\n// FEATURE: Index command smoke coverage\n\nexport function run() {\n  return 1;\n}\n",
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "index",
        ],
        {
          cwd,
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
          },
        },
      );

      await expectExists(join(cwd, ".contextplus"));
      await expectExists(join(cwd, ".contextplus", "state"));
      await expectExists(join(cwd, ".contextplus", "state", "index.sqlite"));
      await expectExists(join(cwd, ".contextplus", "hubs"));
      await expectExists(join(cwd, ".contextplus", "hubs", "suggested"));
      assert.deepEqual((await readdir(join(cwd, ".contextplus"))).sort(), ["hubs", "state"]);

      const dbPath = join(cwd, ".contextplus", "state", "index.sqlite");
      const config = readArtifactFromDb(dbPath, "project-config");
      const manifest = readArtifactFromDb(dbPath, "file-manifest");
      const indexStatus = readArtifactFromDb(dbPath, "index-status");
      const stageState = readArtifactFromDb(dbPath, "index-stage-state");
      const fileIndex = readArtifactFromDb(dbPath, "file-search-index");
      const identifierIndex = readArtifactFromDb(dbPath, "identifier-search-index");
      const chunkIndex = readArtifactFromDb(dbPath, "chunk-search-index");
      const hybridChunkIndex = readArtifactFromDb(dbPath, "hybrid-chunk-index");
      const hybridIdentifierIndex = readArtifactFromDb(dbPath, "hybrid-identifier-index");
      const structureIndex = readArtifactFromDb(dbPath, "code-structure-index");
      const semanticClusterIndex = readArtifactFromDb(dbPath, "semantic-cluster-index");
      const hubSuggestionIndex = readArtifactFromDb(dbPath, "hub-suggestion-index");
      const fullManifest = readArtifactFromDb(dbPath, "full-index-manifest");
      const restorePoints = readArtifactFromDb(dbPath, "restore-points");
      const tree = readTextArtifactFromDb(dbPath, "context-tree");
      const dbFullManifest = readArtifactFromDb(dbPath, "full-index-manifest");

      assert.equal(config.version, 12);
      assert.equal(config.artifactVersion, 12);
      assert.equal(config.indexMode, "full");
      assert.equal(config.contract.contractVersion, 10);
      assert.equal(config.contract.defaultMode, "full");
      assert.equal(config.contract.storage.substrate, "sqlite");
      assert.equal(config.contract.storage.databasePath, ".contextplus/state/index.sqlite");
      assert.equal(config.contract.storage.mirrorPolicy, "sqlite-only");
      assert.equal(config.contract.invalidation.fileArtifacts, "content-hash");
      assert.equal(config.contract.failureSemantics.policy, "crash-only");
      assert.equal(config.projectName.startsWith("contextplus-index-"), true);
      assert.ok(Array.isArray(manifest.files));
      assert.ok(manifest.files.includes("src/app.ts"));
      assert.equal(manifest.contractVersion, 10);
      assert.equal(manifest.indexMode, "full");
      assert.equal(indexStatus.state, "completed");
      assert.equal(indexStatus.phase, "completed");
      assert.equal(indexStatus.indexMode, "full");
      assert.equal(indexStatus.contractVersion, 10);
      assert.equal(indexStatus.artifactVersion, 12);
      assert.ok(Array.isArray(indexStatus.stageOrder));
      assert.ok(indexStatus.stageOrder.includes("chunk-embeddings"));
      assert.ok(indexStatus.stageOrder.includes("hybrid-chunk-scan"));
      assert.ok(indexStatus.stageOrder.includes("hybrid-identifier-scan"));
      assert.ok(indexStatus.stageOrder.includes("cluster-scan"));
      assert.ok(indexStatus.stageOrder.includes("hub-scan"));
      assert.equal(stageState.mode, "full");
      assert.equal(stageState.contractVersion, 10);
      assert.equal(stageState.stages.bootstrap.state, "completed");
      assert.equal(stageState.stages["file-search"].state, "completed");
      assert.equal(stageState.stages["identifier-search"].state, "completed");
      assert.equal(stageState.stages["full-artifacts"].state, "completed");
      assert.equal(indexStatus.fileSearch?.indexedDocuments >= 1, true);
      assert.equal(indexStatus.identifierSearch?.indexedIdentifiers >= 1, true);
      assert.equal(indexStatus.fullIndex?.chunkIndex?.indexedChunks >= 1, true);
      assert.equal(indexStatus.fullIndex?.structureIndex?.indexedStructures >= 1, true);
      assert.equal(indexStatus.fullIndex?.hybridChunkIndex?.indexedDocuments >= 1, true);
      assert.equal(indexStatus.fullIndex?.hybridIdentifierIndex?.indexedDocuments >= 1, true);
      assert.equal(indexStatus.fullIndex?.semanticClusterIndex?.clusterCount >= 0, true);
      assert.ok(fileIndex.files["src/app.ts"]);
      assert.equal(identifierIndex.files["src/app.ts"].docs.some((doc) => doc.name === "run"), true);
      assert.equal(chunkIndex.artifactVersion, 12);
      assert.equal(chunkIndex.contractVersion, 10);
      assert.equal(chunkIndex.mode, "full");
      const runChunk = chunkIndex.files["src/app.ts"].chunks.find((chunk) => chunk.symbolName === "run");
      assert.ok(runChunk);
      assert.equal(runChunk.chunkType, "symbol");
      assert.equal(runChunk.symbolKind, "function");
      assert.deepEqual(runChunk.symbolPath, ["run"]);
      assert.equal(runChunk.lineCount >= 1, true);
      assert.match(runChunk.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(hybridChunkIndex.artifactVersion, 12);
      assert.equal(hybridChunkIndex.contractVersion, 10);
      assert.equal(hybridChunkIndex.source, "chunk");
      assert.equal(hybridChunkIndex.documents[runChunk.id].embeddingCacheKey, runChunk.id);
      assert.equal(Object.keys(hybridChunkIndex.documents[runChunk.id].termFrequencies).includes("run"), true);
      const runIdentifier = identifierIndex.files["src/app.ts"].docs.find((doc) => doc.name === "run");
      assert.ok(runIdentifier);
      assert.equal(hybridIdentifierIndex.artifactVersion, 12);
      assert.equal(hybridIdentifierIndex.contractVersion, 10);
      assert.equal(hybridIdentifierIndex.source, "identifier");
      assert.equal(hybridIdentifierIndex.documents[runIdentifier.id].embeddingCacheKey, `id:${runIdentifier.id}`);
      assert.equal(Object.keys(hybridIdentifierIndex.documents[runIdentifier.id].termFrequencies).includes("run"), true);
      assert.equal(structureIndex.artifactVersion, 12);
      assert.equal(structureIndex.contractVersion, 10);
      assert.equal(structureIndex.mode, "full");
      assert.deepEqual(structureIndex.files["src/app.ts"].artifact.dependencyPaths, []);
      assert.equal(Array.isArray(structureIndex.fileToSymbolIds["src/app.ts"]), true);
      assert.equal(structureIndex.fileToSymbolIds["src/app.ts"].length >= 1, true);
      const runSymbolId = structureIndex.fileToSymbolIds["src/app.ts"][0];
      assert.equal(structureIndex.symbols[runSymbolId].filePath, "src/app.ts");
      assert.equal(structureIndex.ownershipEdges.some((edge) =>
        edge.sourceType === "file"
        && edge.sourcePath === "src/app.ts"
        && edge.targetType === "symbol"
        && edge.targetId === runSymbolId
      ), true);
      assert.equal(structureIndex.ownershipEdges.some((edge) =>
        edge.sourceType === "module"
        && edge.sourcePath === "src"
        && edge.targetType === "file"
        && edge.targetId === "src/app.ts"
      ), true);
      assert.deepEqual(structureIndex.moduleSummaries["src"].filePaths, ["src/app.ts"]);
      assert.deepEqual(structureIndex.moduleImportEdges, []);
      assert.equal(structureIndex.files["src/app.ts"].artifact.symbols.some((symbol) => symbol.name === "run"), true);
      assert.equal(semanticClusterIndex.artifactVersion, 12);
      assert.equal(semanticClusterIndex.contractVersion, 10);
      assert.equal(semanticClusterIndex.mode, "full");
      assert.equal(semanticClusterIndex.clusterCount >= 0, true);
      assert.equal(Object.keys(semanticClusterIndex.relatedFiles).length >= 1, true);
      assert.equal(Object.keys(semanticClusterIndex.subsystemSummaries).length >= 1, true);
      assert.equal(hubSuggestionIndex.artifactVersion, 12);
      assert.equal(hubSuggestionIndex.contractVersion, 10);
      assert.equal(Object.keys(hubSuggestionIndex.suggestions).length >= 1, true);
      assert.equal(Object.keys(hubSuggestionIndex.featureGroups).length >= 0, true);
      assert.equal(fullManifest.mode, "full");
      assert.equal(fullManifest.artifactVersion, 12);
      assert.equal(fullManifest.contractVersion, 10);
      assert.equal(fullManifest.contract.defaultMode, "full");
      assert.equal(fullManifest.contract.storage.substrate, "sqlite");
      assert.equal(fullManifest.contract.storage.mirrorPolicy, "sqlite-only");
      assert.equal(fullManifest.chunkCount >= 1, true);
      assert.equal(fullManifest.hybridChunkCount >= 1, true);
      assert.equal(fullManifest.hybridIdentifierCount >= 1, true);
      assert.equal(fullManifest.structureCount >= 1, true);
      assert.equal(fullManifest.semanticClusterCount >= 0, true);
      assert.equal(fullManifest.hubSuggestionCount >= 1, true);
      assert.equal(fullManifest.featureGroupCount >= 0, true);
      assert.equal(fullManifest.stats.chunkIndex.indexedChunks >= 1, true);
      assert.equal(fullManifest.stats.hybridChunkIndex.indexedDocuments >= 1, true);
      assert.equal(fullManifest.stats.hybridIdentifierIndex.indexedDocuments >= 1, true);
      assert.equal(fullManifest.stats.semanticClusterIndex.clusterCount >= 0, true);
      assert.equal(fullManifest.stats.hubSuggestionIndex.suggestionCount >= 1, true);
      assert.equal(dbFullManifest?.contract.storage.databasePath, ".contextplus/state/index.sqlite");
      assert.equal(dbFullManifest?.hybridChunkIndexPath, "sqlite:index_artifacts/hybrid-chunk-index");
      assert.equal(dbFullManifest?.hybridIdentifierIndexPath, "sqlite:index_artifacts/hybrid-identifier-index");
      assert.equal(dbFullManifest?.semanticClusterIndexPath, "sqlite:index_artifacts/semantic-cluster-index");
      assert.equal(dbFullManifest?.hubSuggestionIndexPath, "sqlite:index_artifacts/hub-suggestion-index");
      assert.deepEqual(restorePoints, []);
      assert.ok(tree.includes("src/"));
      assert.ok(stdout.includes("Indexed"));
      assert.ok(stdout.includes("Mode: full"));
      assert.ok(stdout.includes("Progress log:"));
      assert.ok(stdout.includes("file-ready"));
      assert.ok(stdout.includes("identifier-ready"));
      assert.ok(stdout.includes("full-ready"));
      assert.ok(stdout.includes("hybrid chunk docs"));
      assert.ok(stdout.includes("hybrid identifier docs"));
      assert.ok(stdout.includes("sqlite:index_artifacts/project-config"));
      await assert.rejects(access(join(cwd, ".contextplus", "config", "project.json")));
      await assert.rejects(access(join(cwd, ".contextplus", "config", "context-tree.txt")));
      await assert.rejects(access(join(cwd, ".contextplus", "embeddings", "file-search-index.json")));
      await assert.rejects(access(join(cwd, ".contextplus", "derived", "full-index-manifest.json")));
      await assert.rejects(access(join(cwd, ".contextplus", "memories")));
      await assert.rejects(access(join(cwd, ".contextplus", "memories", "memory-graph.json")));
      await assert.rejects(access(join(cwd, ".contextplus", "checkpoints", "restore-points.json")));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("migrates legacy checkpoint manifests into sqlite and deletes legacy memory files on reindex", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-index-"));
    try {
      await mkdir(join(cwd, ".contextplus", "memories"), { recursive: true });
      await mkdir(join(cwd, ".contextplus", "checkpoints"), { recursive: true });
      await writeFile(join(cwd, ".contextplus", "memories", "memory-graph.json"), JSON.stringify({ nodes: { a: 1 }, edges: {} }));
      await writeFile(join(cwd, ".contextplus", "checkpoints", "restore-points.json"), JSON.stringify([{ id: "rp-1" }]));

      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "index",
        ],
        {
          cwd,
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
          },
        },
      );

      const dbPath = join(cwd, ".contextplus", "state", "index.sqlite");
      const restorePoints = readArtifactFromDb(dbPath, "restore-points");
      const indexStatus = readArtifactFromDb(dbPath, "index-status");
      const fullManifest = readArtifactFromDb(dbPath, "full-index-manifest");

      assert.equal(readArtifactFromDb(dbPath, "memory-graph"), null);
      assert.deepEqual(restorePoints, [{ id: "rp-1" }]);
      assert.equal(indexStatus.state, "completed");
      assert.equal(indexStatus.contractVersion, 10);
      assert.equal(fullManifest.mode, "full");
      assert.equal(fullManifest.contract.failureSemantics.recovery, "rerun-from-persisted-artifacts");
      assert.equal(fullManifest.contract.storage.substrate, "sqlite");
      await assert.rejects(access(join(cwd, ".contextplus", "memories", "memory-graph.json")));
      await assert.rejects(access(join(cwd, ".contextplus", "checkpoints", "restore-points.json")));
      await assert.rejects(access(join(cwd, ".contextplus", "checkpoints")));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports core mode without writing full derived artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-index-core-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// App entrypoint for index testing\n// FEATURE: Index command smoke coverage\n\nexport function run() {\n  return 1;\n}\n",
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "index",
          "--mode=core",
        ],
        {
          cwd,
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
          },
        },
      );

      const dbPath = join(cwd, ".contextplus", "state", "index.sqlite");
      const config = readArtifactFromDb(dbPath, "project-config");
      const indexStatus = readArtifactFromDb(dbPath, "index-status");

      assert.equal(config.indexMode, "core");
      assert.equal(config.contract.supportedModes.includes("core"), true);
      assert.equal(config.contract.storage.databasePath, ".contextplus/state/index.sqlite");
      assert.equal(indexStatus.indexMode, "core");
      assert.equal(indexStatus.contractVersion, 10);
      await expectExists(join(cwd, ".contextplus", "state", "index.sqlite"));
      assert.deepEqual(await readdir(join(cwd, ".contextplus")), ["state"]);
      assert.equal(readArtifactFromDb(dbPath, "full-index-manifest"), null);
      assert.ok(stdout.includes("Mode: core"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("persists stage dependencies and allows individual stage reruns", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-stages-"));
    const originalProvider = process.env.CONTEXTPLUS_EMBED_PROVIDER;
    try {
      process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// App entrypoint for staged index tests\n// FEATURE: Stage rerun verification\n\nexport function run() {\n  return 1;\n}\n",
      );

      await rerunIndexStage({ rootDir: cwd, stage: "bootstrap", mode: "full" });
      await assert.rejects(
        rerunIndexStage({ rootDir: cwd, stage: "full-artifacts", mode: "full" }),
        /requires completed dependency/,
      );

      await rerunIndexStage({ rootDir: cwd, stage: "file-search", mode: "full" });
      await rerunIndexStage({ rootDir: cwd, stage: "identifier-search", mode: "full" });
      const result = await rerunIndexStage({ rootDir: cwd, stage: "full-artifacts", mode: "full" });
      const dbPath = join(cwd, ".contextplus", "state", "index.sqlite");
      const stageState = readArtifactFromDb(dbPath, "index-stage-state");
      const dbStageState = readArtifactFromDb(dbPath, "index-stage-state");

      assert.equal(result.stageState.stages.bootstrap.state, "completed");
      assert.equal(result.stageState.stages["file-search"].state, "completed");
      assert.equal(result.stageState.stages["identifier-search"].state, "completed");
      assert.equal(result.stageState.stages["full-artifacts"].state, "completed");
      assert.equal(stageState.stages["full-artifacts"].dependencies.includes("file-search"), true);
      assert.equal(dbStageState.stages["full-artifacts"].dependencies.includes("identifier-search"), true);
      assert.equal(stageState.stages["full-artifacts"].runCount >= 1, true);
      assert.ok(readArtifactFromDb(dbPath, "full-index-manifest"));
    } finally {
      if (originalProvider === undefined) delete process.env.CONTEXTPLUS_EMBED_PROVIDER;
      else process.env.CONTEXTPLUS_EMBED_PROVIDER = originalProvider;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
