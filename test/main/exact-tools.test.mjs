// MCP integration coverage for fast exact-query public tool surface
// FEATURE: Step 18 direct verification of tiny exact lookup tools

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

process.env.SCPLUS_EMBED_PROVIDER = "mock";

async function git(rootDir, ...args) {
  await execFileAsync("git", args, { cwd: rootDir });
}

async function createFixtureRepo(rootDir) {
  await mkdir(join(rootDir, "src", "auth"), { recursive: true });
  await mkdir(join(rootDir, "scripts"), { recursive: true });
  await writeFile(
    join(rootDir, "src", "auth", "jwt.ts"),
    [
      "// JWT auth helpers for fast exact tool fixtures",
      "// FEATURE: exact tool mcp coverage",
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "src", "auth", "session.ts"),
    [
      "// Session auth helpers for fast exact tool fixtures",
      "// FEATURE: exact tool mcp coverage",
      "import { verifyToken } from './jwt.js';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "scripts", "setup-auth.ts"),
    [
      "// Script used to bootstrap auth exact tool fixtures",
      "// FEATURE: exact tool mcp coverage",
      "import { createSession } from '../src/auth/session.js';",
      "",
      "export function setupAuth(): string {",
      "  return createSession('Token');",
      "}",
      "",
    ].join("\n"),
  );
}

function getTextResult(result) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

describe("exact-tools", () => {
  it("exposes tiny exact-query MCP tools over the prepared fast-query substrate", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const rootDir = await mkdtemp(join(tmpdir(), "scplus-exact-tools-"));
    let client = null;
    let transport = null;
    try {
      await createFixtureRepo(rootDir);
      await git(rootDir, "init");
      await git(rootDir, "config", "user.email", "codex@example.com");
      await git(rootDir, "config", "user.name", "Codex");
      await git(rootDir, "add", ".");
      await git(rootDir, "commit", "-m", "initial");
      await indexCodebase({ rootDir, mode: "full" });

      client = new Client({ name: "scplus-test", version: "1.0.0" });
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "build", "index.js"), rootDir],
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCPLUS_EMBED_PROVIDER: "mock",
          SCPLUS_EMBED_TRACKER: "disabled",
        },
        stderr: "pipe",
      });
      await client.connect(transport);

      const tools = await client.listTools();
      const toolNames = new Set(tools.tools.map((tool) => tool.name));
      assert.equal(toolNames.has("symbol"), true);
      assert.equal(toolNames.has("word"), true);
      assert.equal(toolNames.has("outline"), true);
      assert.equal(toolNames.has("deps"), true);
      assert.equal(toolNames.has("status"), true);
      assert.equal(toolNames.has("changes"), true);

      const symbolResult = getTextResult(await client.callTool({
        name: "symbol",
        arguments: { query: "verifyToken" },
      }));
      assert.match(symbolResult, /Index freshness: fresh \| Active generation: 1/);
      assert.match(symbolResult, /Exact symbol matches for "verifyToken" \(1\)/);
      assert.match(symbolResult, /src\/auth\/jwt\.ts:3-5/);

      const wordResult = getTextResult(await client.callTool({
        name: "word",
        arguments: { query: "auth", top_k: 6 },
      }));
      assert.match(wordResult, /Word hits for "auth"/);
      assert.match(wordResult, /scripts\/setup-auth\.ts/);

      const outlineResult = getTextResult(await client.callTool({
        name: "outline",
        arguments: { file_path: "src/auth/session.ts" },
      }));
      assert.match(outlineResult, /Outline: src\/auth\/session\.ts/);
      assert.match(outlineResult, /Symbols \(1\)/);
      assert.match(outlineResult, /createSession/);

      const depsResult = getTextResult(await client.callTool({
        name: "deps",
        arguments: { target: "src/auth/jwt.ts" },
      }));
      assert.match(depsResult, /Dependencies: src\/auth\/jwt\.ts/);
      assert.match(depsResult, /Reverse \(1\)/);
      assert.match(depsResult, /src\/auth\/session\.ts/);

      const cleanStatusResult = getTextResult(await client.callTool({
        name: "status",
        arguments: {},
      }));
      assert.match(cleanStatusResult, /Status: master|Status: main/);
      assert.match(cleanStatusResult, /untracked=0/);

      await writeFile(
        join(rootDir, "src", "auth", "session.ts"),
        [
          "// Session auth helpers for fast exact tool fixtures",
          "// FEATURE: exact tool mcp coverage",
          "import { verifyToken } from './jwt.js';",
          "",
          "export function createSession(token: string): string {",
          "  return `session:${verifyToken(token)}:changed`;",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(rootDir, "scripts", "auth-status.ts"),
        [
          "// Extra auth status script fixture for exact tool coverage",
          "// FEATURE: exact tool mcp coverage",
          "export const authStatus = 'dirty';",
          "",
        ].join("\n"),
      );

      const dirtyStatusResult = getTextResult(await client.callTool({
        name: "status",
        arguments: { limit: 5 },
      }));
      assert.match(dirtyStatusResult, /Files \([12]/);
      assert.match(dirtyStatusResult, /src\/auth\/session\.ts/);

      const changeResult = getTextResult(await client.callTool({
        name: "changes",
        arguments: { limit: 10 },
      }));
      assert.match(changeResult, /Changes: files=/);
      assert.match(changeResult, /scripts\/auth-status\.ts/);

      const fileChangeResult = getTextResult(await client.callTool({
        name: "changes",
        arguments: { path: "src/auth/session.ts" },
      }));
      assert.match(fileChangeResult, /src\/auth\/session\.ts/);
      assert.match(fileChangeResult, /ranges old/);
    } finally {
      if (client) await client.close();
      if (transport) await transport.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
