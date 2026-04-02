import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

describe("init-codex", () => {
  it("writes valid .codex/config.toml for npx runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-codex-"));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "init",
          "codex",
          "--runner=npx",
        ],
        { cwd },
      );
      const raw = await readFile(join(cwd, ".codex", "config.toml"), "utf8");
      assert.match(raw, /^\[mcp_servers\."context\+\+"\]$/m);
      assert.match(raw, /^command = "npx"$/m);
      assert.match(raw, /^args = \["-y","contextplusplus"\]$/m);
      assert.match(raw, /^\[mcp_servers\."context\+\+"\.env\]$/m);
      assert.match(raw, /^OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b-32k"$/m);
      assert.match(raw, /^OLLAMA_CHAT_MODEL = "nemotron-3-nano:4b-128k"$/m);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes valid .codex/config.toml for bunx runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "contextplus-codex-"));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "build", "index.js"),
          "init",
          "codex",
          "--runner=bunx",
        ],
        { cwd },
      );
      const raw = await readFile(join(cwd, ".codex", "config.toml"), "utf8");
      assert.match(raw, /^command = "bunx"$/m);
      assert.match(raw, /^args = \["contextplusplus"\]$/m);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
