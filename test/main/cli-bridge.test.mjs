// Human CLI bridge command coverage for machine-readable scplus outputs
// FEATURE: CLI bridge verification for doctor, tree, and restore-point payloads

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}

async function execBridge(cwd, ...args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(process.cwd(), "build", "index.js"), "bridge", ...args, "--root", cwd],
    {
      env: {
        ...process.env,
        SCPLUS_EMBED_PROVIDER: "mock",
        NODE_NO_WARNINGS: "1",
      },
    },
  );
  return JSON.parse(stdout);
}

describe("cli bridge", () => {
  it("returns structured query, analysis, and restore payloads for a prepared repo", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-cli-bridge-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// App entrypoint used to exercise CLI bridge indexing paths\n// FEATURE: CLI bridge smoke fixture for prepared repo data\n\nexport function runApp() {\n  return helperValue();\n}\n\nfunction helperValue() {\n  return 1;\n}\n",
      );
      await writeFile(
        join(cwd, "src", "runner.ts"),
        "// Runner entrypoint used to exercise CLI bridge dependency paths\n// FEATURE: CLI bridge smoke fixture for dependency and blast-radius coverage\n\nimport { runApp } from \"./app.js\";\n\nexport function startRunner() {\n  return runApp();\n}\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "scplus@example.com");
      await git(cwd, "config", "user.name", "Context Plus");
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", "init");

      await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "index"],
        {
          cwd,
          env: {
            ...process.env,
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const doctor = await execBridge(cwd, "doctor");
      assert.equal(doctor.root, cwd);
      assert.equal(doctor.indexValidation.ok, true);
      assert.equal(doctor.restorePointCount, 0);
      assert.equal(typeof doctor.ollama.ok, "boolean");
      assert.equal(doctor.hubSummary.suggestionCount >= 1, true);
      assert.equal(typeof doctor.treeSitter.totalParseCalls, "number");
      assert.equal(typeof doctor.treeSitter.totalParseFailures, "number");
      assert.equal(doctor.hybridVectors.chunk.vectorCoverage.state, "complete");
      assert.equal(doctor.hybridVectors.identifier.vectorCoverage.state, "complete");
      assert.equal(doctor.observability.indexing.stages["file-search"].durationMs > 0, true);
      assert.equal(typeof doctor.observability.caches.embeddings.processNamespaceHits, "number");
      assert.equal(typeof doctor.observability.caches.parserPoolReuseCount, "number");
      assert.equal(typeof doctor.observability.caches.hybridSearch.chunk.lexicalCandidateCount, "number");
      assert.equal(typeof doctor.observability.caches.hybridSearch.chunk.lastLexicalCandidateCount, "number");
      assert.equal(doctor.observability.integrity.fallbackMarkerCount, 0);
      assert.deepEqual(doctor.observability.integrity.parseFailuresByLanguage, {});
      assert.equal(typeof doctor.observability.scheduler.queueDepth, "number");
      assert.equal(typeof doctor.observability.scheduler.batchCount, "number");
      assert.equal(typeof doctor.observability.scheduler.canceledJobs, "number");

      const treePayload = await execBridge(cwd, "tree");
      assert.equal(treePayload.root, cwd);
      assert.equal(treePayload.text.includes("src/"), true);

      const symbolPayload = await execBridge(cwd, "symbol", "runApp");
      assert.equal(symbolPayload.root, cwd);
      assert.equal(symbolPayload.hits.length, 1);
      assert.equal(symbolPayload.text.includes("Exact symbol matches"), true);
      assert.equal(symbolPayload.freshnessHeader.includes("Index freshness"), true);

      const wordPayload = await execBridge(cwd, "word", "helperValue");
      assert.equal(wordPayload.hits.length >= 1, true);
      assert.equal(wordPayload.text.includes("Word hits"), true);

      const outlinePayload = await execBridge(cwd, "outline", "src/app.ts");
      assert.equal(outlinePayload.outline.path, "src/app.ts");
      assert.equal(outlinePayload.outline.symbols.some((symbol) => symbol.name === "runApp"), true);

      const depsPayload = await execBridge(cwd, "deps", "src/app.ts");
      assert.equal(depsPayload.dependencyInfo.targetPath, "src/app.ts");
      assert.equal(depsPayload.dependencyInfo.reverseDependencies.includes("src/runner.ts"), true);

      const exactSearchPayload = await execBridge(cwd, "search", "runApp", "--intent", "exact", "--search-type", "mixed");
      assert.equal(exactSearchPayload.intent, "exact");
      assert.equal(exactSearchPayload.symbolHits.length, 1);
      assert.equal(exactSearchPayload.text.includes("Exact symbol matches"), true);

      const relatedSearchPayload = await execBridge(cwd, "search", "app entrypoint", "--intent", "related", "--search-type", "mixed");
      assert.equal(relatedSearchPayload.intent, "related");
      assert.equal(relatedSearchPayload.hits.length >= 1, true);
      assert.equal(relatedSearchPayload.diagnostics.chunk.vectorCoverage.state, "complete");
      assert.equal(relatedSearchPayload.text.includes(relatedSearchPayload.hits[0].path), true);
      assert.equal(relatedSearchPayload.text.includes("Vector coverage:"), true);

      const researchPayload = await execBridge(cwd, "research", "app entrypoint flow");
      assert.equal(researchPayload.report.codeHits.length >= 1, true);
      assert.equal(researchPayload.report.fileCards.length >= 1, true);
      assert.equal(researchPayload.report.moduleCards.length >= 1, true);
      assert.equal(researchPayload.report.layers.explanation.artifactKeys.includes("query-explanation-index"), true);
      assert.equal(researchPayload.text.includes(researchPayload.report.codeHits[0].path), true);
      assert.equal(researchPayload.text.includes("Explanation context:"), true);
      assert.equal(researchPayload.text.includes("Change risk:"), true);

      const findHubPayload = await execBridge(cwd, "find-hub", "--query", "app entrypoint", "--ranking-mode", "both");
      assert.equal(findHubPayload.root, cwd);
      assert.equal(findHubPayload.text.includes('Ranked hubs for: "app entrypoint"'), true);

      const lintPayload = await execBridge(cwd, "lint");
      assert.equal(lintPayload.report.filesInspected >= 2, true);
      assert.equal(lintPayload.text.includes("Lint target"), true);

      const blastRadiusPayload = await execBridge(cwd, "blast-radius", "runApp", "--file-context", "src/app.ts");
      assert.equal(blastRadiusPayload.report.usageCount, 2);
      assert.equal(blastRadiusPayload.report.files[0].file, "src/runner.ts");

      const checkpointPayload = await execBridge(
        cwd,
        "checkpoint",
        "src/runner.ts",
        "--new-content",
        "// Runner entrypoint used to exercise CLI bridge dependency paths\n// FEATURE: CLI bridge smoke fixture for dependency and blast-radius coverage\n\nimport { runApp } from \"./app.js\";\n\nexport function startRunner() {\n  return runApp() + 1;\n}\n",
      );
      assert.equal(checkpointPayload.report.filePath, "src/runner.ts");
      assert.equal(checkpointPayload.text.includes("File saved"), true);

      const statusPayload = await execBridge(cwd, "status");
      assert.equal(statusPayload.modifiedCount, 1);

      const changesPayload = await execBridge(cwd, "changes", "--path", "src/runner.ts");
      assert.equal(changesPayload.changedFiles, 1);
      assert.equal(changesPayload.files[0].path, "src/runner.ts");
      assert.equal(changesPayload.files[0].patch.includes("runApp() + 1"), true);

      const restorePoints = await execBridge(cwd, "restore-points");
      assert.equal(restorePoints.length, 1);

      const restorePayload = await execBridge(cwd, "restore", restorePoints[0].id);
      assert.deepEqual(restorePayload.restoredFiles, ["src/runner.ts"]);

      const cleanStatusPayload = await execBridge(cwd, "status");
      assert.equal(cleanStatusPayload.modifiedCount, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
