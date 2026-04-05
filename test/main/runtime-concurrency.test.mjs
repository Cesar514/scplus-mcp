// Same-repo mutation takeover coverage for real scplus index commands.
// FEATURE: Later same-repo index invocations evict competing scplus holders instead of failing on lock contention.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}

async function createFixtureRepo(rootDir, fileCount = 220) {
  await mkdir(join(rootDir, "src"), { recursive: true });
  for (let index = 0; index < fileCount; index++) {
    await writeFile(
      join(rootDir, "src", `module-${index}.ts`),
      [
        `// Runtime concurrency fixture module ${index}`,
        "// FEATURE: Shared same-repo mutation takeover coverage",
        `export function value${index}(): number {`,
        `  return ${index};`,
        "}",
        "",
      ].join("\n"),
    );
  }
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "scplus-runtime-concurrency",
      version: "1.0.0",
      type: "module",
    }, null, 2) + "\n",
  );
}

async function waitForPath(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for pid ${child.pid} to exit.`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("runtime concurrency", () => {
  it("allows a later same-repo index process to take over the mutation lock", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-runtime-lock-"));
    const mutationLockPath = join(rootDir, ".scplus", "locks", "mutation.lock");
    try {
      await createFixtureRepo(rootDir, 260);
      await git(rootDir, "init");
      await git(rootDir, "config", "user.email", "scplus@example.com");
      await git(rootDir, "config", "user.name", "Context Plus");
      await git(rootDir, "add", ".");
      await git(rootDir, "commit", "-m", "init");

      const first = spawn(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "index", rootDir],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SCPLUS_EMBED_PROVIDER: "mock",
            SCPLUS_EMBED_TRACKER: "disabled",
            NODE_NO_WARNINGS: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      first.stdout.resume();
      first.stderr.resume();

      await waitForPath(mutationLockPath);

      const second = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "index", rootDir],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SCPLUS_EMBED_PROVIDER: "mock",
            SCPLUS_EMBED_TRACKER: "disabled",
            NODE_NO_WARNINGS: "1",
          },
        },
      );
      assert.match(second.stdout, /^Indexed /);

      const firstExit = await waitForExit(first);
      assert.equal(firstExit.code !== 0 || firstExit.signal !== null, true);

      const validation = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "build", "index.js"), "validate-index", "--root", rootDir],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SCPLUS_EMBED_PROVIDER: "mock",
            NODE_NO_WARNINGS: "1",
          },
        },
      );
      assert.match(validation.stdout, /Index validation: ok/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
