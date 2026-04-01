// Human CLI bridge command coverage for machine-readable Context+ outputs
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

describe("cli bridge", () => {
  it("returns structured doctor, tree, and restore-point data for a prepared repo", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-cli-bridge-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(
        join(cwd, "src", "app.ts"),
        "// App entrypoint used to exercise CLI bridge indexing paths\n// FEATURE: CLI bridge smoke fixture for prepared repo data\n\nexport function run() {\n  return 1;\n}\n",
      );
      await git(cwd, "init");
      await git(cwd, "config", "user.email", "contextplus@example.com");
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
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );

      const { stdout: doctorStdout } = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "bridge", "doctor", "--root", cwd],
        {
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );
      const doctor = JSON.parse(doctorStdout);
      assert.equal(doctor.root, cwd);
      assert.equal(doctor.indexValidation.ok, true);
      assert.equal(doctor.restorePointCount, 0);
      assert.equal(typeof doctor.ollama.ok, "boolean");
      assert.equal(doctor.hubSummary.suggestionCount >= 1, true);

      const { stdout: treeStdout } = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "bridge", "tree", "--root", cwd],
        {
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );
      const treePayload = JSON.parse(treeStdout);
      assert.equal(treePayload.root, cwd);
      assert.equal(treePayload.text.includes("src/"), true);

      const { stdout: restoreStdout } = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "bridge", "restore-points", "--root", cwd],
        {
          env: {
            ...process.env,
            CONTEXTPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );
      const restorePoints = JSON.parse(restoreStdout);
      assert.deepEqual(restorePoints, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
