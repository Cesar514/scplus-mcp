import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

describe("init-opencode", () => {
  it("writes valid opencode.json for npx runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-opencode-"));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "init",
          "opencode",
          "--runner=npx",
        ],
        { cwd },
      );
      const raw = await readFile(join(cwd, "opencode.json"), "utf8");
      const cfg = JSON.parse(raw);
      assert.equal(cfg.$schema, "https://opencode.ai/config.json");
      assert.equal(cfg.mcp["scplus-mcp"].type, "local");
      assert.deepEqual(cfg.mcp["scplus-mcp"].command, [
        "npx",
        "-y",
        "scplus-mcp",
      ]);
      assert.equal(cfg.mcp["scplus-mcp"].enabled, true);
      assert.equal(
        cfg.mcp["scplus-mcp"].environment.OLLAMA_EMBED_MODEL,
        "qwen3-embedding:0.6b-32k",
      );
      assert.equal(
        cfg.mcp["scplus-mcp"].environment.OLLAMA_CHAT_MODEL,
        "nemotron-3-nano:4b-128k",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes valid opencode.json for bunx runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "scplus-opencode-"));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "init",
          "opencode",
          "--runner=bunx",
        ],
        { cwd },
      );
      const raw = await readFile(join(cwd, "opencode.json"), "utf8");
      const cfg = JSON.parse(raw);
      assert.deepEqual(cfg.mcp["scplus-mcp"].command, ["bunx", "scplus-mcp"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
