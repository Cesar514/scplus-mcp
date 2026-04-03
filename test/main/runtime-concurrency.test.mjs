// Runtime concurrency coverage for MCP and CLI access against the same repository.
// FEATURE: Prevent cross-process watcher and mutation races between CLI bridge and MCP runtimes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}

async function createFixtureRepo(rootDir, fileCount = 12) {
  await mkdir(join(rootDir, "src"), { recursive: true });
  for (let index = 0; index < fileCount; index++) {
    await writeFile(
      join(rootDir, "src", `module-${index}.ts`),
      [
        `// Runtime concurrency fixture module ${index}`,
        "// FEATURE: Shared MCP and CLI runtime lock coverage",
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

class BridgeSession {
  constructor(cwd) {
    this.cwd = cwd;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.stderrLines = [];
    this.process = spawn(process.execPath, [join(process.cwd(), "build", "index.js"), "bridge-serve"], {
      cwd,
      env: {
        ...process.env,
        SCPLUS_EMBED_PROVIDER: "mock",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    this.readline.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.type === "response") {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.result);
          return;
        }
        pending.reject(new Error(frame.error));
        return;
      }
      if (frame.type !== "event") {
        throw new Error(`Unexpected frame type ${String(frame.type)}`);
      }
      this.events.push(frame);
      const remaining = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(frame)) {
          waiter.resolve(frame);
          continue;
        }
        remaining.push(waiter);
      }
      this.waiters = remaining;
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.stderrLines.push(...String(chunk).split("\n").filter(Boolean));
    });
  }

  request(command, args = {}) {
    const id = ++this.nextId;
    const payload = JSON.stringify({
      type: "request",
      id,
      command,
      args,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${payload}\n`);
    });
  }

  waitForEvent(predicate, timeoutMs = 20000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== pending);
        reject(new Error(`Timed out waiting for bridge event.\nstderr:\n${this.stderrLines.join("\n")}`));
      }, timeoutMs);
      const pending = {
        predicate,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
      };
      this.waiters.push(pending);
    });
  }

  async close() {
    try {
      await this.request("shutdown");
    } catch {
      // The process may already be exiting.
    }
    this.process.stdin.end();
    if (this.process.exitCode === null) {
      await new Promise((resolve) => this.process.once("exit", resolve));
    }
    this.readline.close();
  }
}

function getTextResult(result) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

describe("runtime concurrency", () => {
  it("rejects a second watcher owner for the same repo across bridge processes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-watch-lock-"));
    const left = new BridgeSession(rootDir);
    const right = new BridgeSession(rootDir);
    try {
      await createFixtureRepo(rootDir);
      await git(rootDir, "init");
      await git(rootDir, "config", "user.email", "scplus@example.com");
      await git(rootDir, "config", "user.name", "Context Plus");
      await git(rootDir, "add", ".");
      await git(rootDir, "commit", "-m", "init");
      await left.request("watch-set", { root: rootDir, enabled: true, debounceMs: 100 });
      await left.waitForEvent((event) => event.kind === "watch-state" && event.enabled === true);

      await assert.rejects(
        right.request("watch-set", { root: rootDir, enabled: true, debounceMs: 100 }),
        /scplus watcher lock .* already held/i,
      );

      const doctor = await right.request("doctor", { root: rootDir });
      assert.equal(doctor.root, rootDir);
    } finally {
      await left.close();
      await right.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent MCP and CLI index mutations for the same repo instead of racing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-runtime-lock-"));
    let client = null;
    let transport = null;
    const session = new BridgeSession(rootDir);
    try {
      await createFixtureRepo(rootDir, 220);
      await git(rootDir, "init");
      await git(rootDir, "config", "user.email", "scplus@example.com");
      await git(rootDir, "config", "user.name", "Context Plus");
      await git(rootDir, "add", ".");
      await git(rootDir, "commit", "-m", "init");

      client = new Client({ name: "scplus-runtime-lock-test", version: "1.0.0" });
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "build", "index.js"), rootDir],
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCPLUS_EMBED_PROVIDER: "mock",
          SCPLUS_EMBED_TRACKER: "disabled",
          NODE_NO_WARNINGS: "1",
        },
      });
      await client.connect(transport);

      const bridgeIndexPromise = session.request("index", { root: rootDir, mode: "full" });
      await session.waitForEvent((event) =>
        event.kind === "job"
        && event.job === "index"
        && event.state === "running"
        && event.source === "manual",
      );

      const concurrentIndexResult = await client.callTool({
        name: "index",
        arguments: { mode: "full" },
      });
      assert.equal(concurrentIndexResult.isError, true);
      assert.match(getTextResult(concurrentIndexResult), /scplus mutation lock .* already held/i);

      const bridgeResult = await bridgeIndexPromise;
      assert.match(bridgeResult.output, /^Indexed /);

      const validationResult = getTextResult(await client.callTool({
        name: "validate_index",
        arguments: { mode: "full" },
      }));
      assert.match(validationResult, /Index validation: ok/);
    } finally {
      await session.close();
      if (client) await client.close();
      if (transport) await transport.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
