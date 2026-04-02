// MCP integration coverage for exact, related, and broad query routing
// FEATURE: Step 19 direct verification of search intent and research usage

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

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

async function git(rootDir, ...args) {
  await execFileAsync("git", args, { cwd: rootDir });
}

async function createFixtureRepo(rootDir) {
  await mkdir(join(rootDir, "src", "auth"), { recursive: true });
  await mkdir(join(rootDir, "src", "middleware"), { recursive: true });
  await writeFile(
    join(rootDir, "src", "auth", "jwt.ts"),
    [
      "// JWT auth helpers for query intent routing coverage",
      "// FEATURE: search intent and research routing coverage",
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "src", "auth", "session.ts"),
    [
      "// Session auth helpers for query intent routing coverage",
      "// FEATURE: search intent and research routing coverage",
      "import { verifyToken } from './jwt';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(rootDir, "src", "middleware", "guard.ts"),
    [
      "// Auth middleware guard for query intent routing coverage",
      "// FEATURE: search intent and research routing coverage",
      "import { verifyToken } from '../auth/jwt';",
      "",
      "export function guardRequest(token: string): boolean {",
      "  return verifyToken(token).length > 0;",
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

describe("query-intent", () => {
  it("routes exact questions through the fast substrate, related discovery through ranked search, and broad questions through research", async () => {
    const { indexCodebase } = await import("../../build/tools/index-codebase.js");
    const rootDir = await mkdtemp(join(tmpdir(), "contextplus-query-intent-"));
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

      client = new Client({ name: "contextplus-test", version: "1.0.0" });
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "build", "index.js"), rootDir],
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONTEXTPLUS_EMBED_PROVIDER: "mock",
          CONTEXTPLUS_EMBED_TRACKER: "disabled",
        },
      });
      await client.connect(transport);

      const exactResult = getTextResult(await client.callTool({
        name: "search",
        arguments: {
          intent: "exact",
          search_type: "symbol",
          query: "verifyToken",
        },
      }));
      assert.match(exactResult, /Index freshness: fresh \| Active generation: 1/);
      assert.match(exactResult, /Exact symbol matches for "verifyToken" \(1\)/);
      assert.doesNotMatch(exactResult, /\[file\]|\[symbol\]/);

      const relatedResult = getTextResult(await client.callTool({
        name: "search",
        arguments: {
          intent: "related",
          search_type: "mixed",
          query: "auth token session verification",
        },
      }));
      assert.match(relatedResult, /\[file\]|\[symbol\]/);
      assert.match(relatedResult, /evidence file=/);
      assert.match(relatedResult, /Vector coverage:/);

      const researchResult = getTextResult(await client.callTool({
        name: "research",
        arguments: {
          query: "How does auth token session verification work across this repository?",
        },
      }));
      assert.match(researchResult, /Research:/);
      assert.match(researchResult, /Code hits:/);
      assert.match(researchResult, /Related context:/);
    } finally {
      if (client) await client.close();
      if (transport) await transport.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
