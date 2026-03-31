// Project indexing command creates durable Context+ repo-local bootstrap state
// FEATURE: CLI bootstrap coverage for .contextplus layout and persisted manifests

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

async function expectExists(path) {
  await access(path);
}

describe("index", () => {
  it("creates the .contextplus project layout and snapshots", async () => {
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
        { cwd },
      );

      await expectExists(join(cwd, ".contextplus"));
      await expectExists(join(cwd, ".contextplus", "hubs"));
      await expectExists(join(cwd, ".contextplus", "embeddings"));
      await expectExists(join(cwd, ".contextplus", "memories"));
      await expectExists(join(cwd, ".contextplus", "config"));
      await expectExists(join(cwd, ".contextplus", "checkpoints"));

      const config = JSON.parse(await readFile(join(cwd, ".contextplus", "config", "project.json"), "utf8"));
      const manifest = JSON.parse(await readFile(join(cwd, ".contextplus", "config", "file-manifest.json"), "utf8"));
      const graph = JSON.parse(await readFile(join(cwd, ".contextplus", "memories", "memory-graph.json"), "utf8"));
      const restorePoints = JSON.parse(await readFile(join(cwd, ".contextplus", "checkpoints", "restore-points.json"), "utf8"));
      const tree = await readFile(join(cwd, ".contextplus", "config", "context-tree.txt"), "utf8");

      assert.equal(config.version, 1);
      assert.equal(config.projectName.startsWith("contextplus-index-"), true);
      assert.ok(Array.isArray(manifest.files));
      assert.ok(manifest.files.includes("src/app.ts"));
      assert.deepEqual(graph, { nodes: {}, edges: {} });
      assert.deepEqual(restorePoints, []);
      assert.ok(tree.includes("src/"));
      assert.ok(stdout.includes("Indexed"));
      assert.ok(stdout.includes(".contextplus/config/project.json"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing memory or checkpoint manifests on reindex", async () => {
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
        { cwd },
      );

      const graph = JSON.parse(await readFile(join(cwd, ".contextplus", "memories", "memory-graph.json"), "utf8"));
      const restorePoints = JSON.parse(await readFile(join(cwd, ".contextplus", "checkpoints", "restore-points.json"), "utf8"));

      assert.deepEqual(graph, { nodes: { a: 1 }, edges: {} });
      assert.deepEqual(restorePoints, [{ id: "rp-1" }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
