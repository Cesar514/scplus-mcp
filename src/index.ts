#!/usr/bin/env node
// Context+ MCP - Semantic codebase navigator for AI agents
// Structural AST tree, blast radius, semantic search, commit gatekeeper

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { z } from "zod";
import { createEmbeddingTrackerController } from "./core/embedding-tracker.js";
import { createIdleMonitor, getIdleShutdownMs, getParentPollMs, isBrokenPipeError, runCleanup, startParentMonitor } from "./core/process-lifecycle.js";
import { getContextTree } from "./tools/context-tree.js";
import { getFileSkeleton } from "./tools/file-skeleton.js";
import { cancelAllEmbeddings } from "./core/embeddings.js";
import { invalidateSearchCache } from "./tools/semantic-search.js";
import { invalidateIdentifierSearchCache } from "./tools/semantic-identifiers.js";
import { getBlastRadius } from "./tools/blast-radius.js";
import { runStaticAnalysis } from "./tools/static-analysis.js";
import { proposeCommit } from "./tools/propose-commit.js";
import { listRestorePoints, restorePoint } from "./git/shadow.js";
import { semanticNavigate } from "./tools/semantic-navigate.js";
import { getFeatureHub } from "./tools/feature-hub.js";
import { runEvaluation } from "./tools/evaluation.js";
import { indexCodebase } from "./tools/index-codebase.js";
import { DEFAULT_INDEX_MODE } from "./tools/index-contract.js";
import { formatIndexValidationReport, repairPreparedIndex, validatePreparedIndex } from "./tools/index-reliability.js";
import { runResearch } from "./tools/research.js";
import { runCanonicalSearch } from "./tools/unified-ranking.js";

type AgentTarget = "claude" | "cursor" | "vscode" | "windsurf" | "opencode" | "codex";

const AGENT_CONFIG_PATH: Record<AgentTarget, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
  windsurf: ".windsurf/mcp.json",
  opencode: "opencode.json",
  codex: ".codex/config.toml",
};

const SUB_COMMANDS = ["init", "index", "skeleton", "tree"];
const passthroughArgs = process.argv.slice(2);
const ROOT_DIR = passthroughArgs[0] && !SUB_COMMANDS.includes(passthroughArgs[0])
  ? resolve(passthroughArgs[0])
  : process.cwd();
const INSTRUCTIONS_SOURCE_URL = "https://contextplus.vercel.app/api/instructions";
const INSTRUCTIONS_RESOURCE_URI = "contextplus://instructions";

let noteServerActivity = () => { };
let ensureTrackerRunning = () => { };

function withRequestActivity<TArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: { useEmbeddingTracker?: boolean },
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    noteServerActivity();
    if (options?.useEmbeddingTracker) ensureTrackerRunning();
    return handler(args);
  };
}

function parseAgentTarget(input?: string): AgentTarget {
  const normalized = (input ?? "claude").toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "vscode" || normalized === "vs-code" || normalized === "vs") return "vscode";
  if (normalized === "windsurf") return "windsurf";
  if (normalized === "opencode" || normalized === "open-code") return "opencode";
  if (normalized === "codex") return "codex";
  throw new Error(`Unsupported coding agent \"${input}\". Use one of: claude, cursor, vscode, windsurf, opencode, codex.`);
}

function parseRunner(args: string[]): "npx" | "bunx" {
  const explicit = args.find((arg) => arg.startsWith("--runner="));
  if (explicit) {
    const value = explicit.split("=")[1];
    if (value === "npx" || value === "bunx") return value;
    throw new Error(`Unsupported runner \"${value}\". Use --runner=npx or --runner=bunx.`);
  }
  const runnerFlagIndex = args.findIndex((arg) => arg === "--runner");
  if (runnerFlagIndex >= 0) {
    const value = args[runnerFlagIndex + 1];
    if (value === "npx" || value === "bunx") return value;
    throw new Error(`Unsupported runner \"${value}\". Use --runner=npx or --runner=bunx.`);
  }
  const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = (process.env.npm_execpath ?? "").toLowerCase();
  if (userAgent.includes("bun/") || execPath.includes("bun")) return "bunx";
  return "npx";
}

function buildMcpConfig(runner: "npx" | "bunx") {
  const commandArgs = runner === "npx" ? ["-y", "contextplus"] : ["contextplus"];
  return JSON.stringify(
    {
      mcpServers: {
        contextplus: {
          command: runner,
          args: commandArgs,
          env: {
            OLLAMA_EMBED_MODEL: "qwen3-embedding:0.6b-32k",
            OLLAMA_CHAT_MODEL: "nemotron-3-nano:4b-128k",
            OLLAMA_API_KEY: "YOUR_OLLAMA_API_KEY",
            CONTEXTPLUS_EMBED_BATCH_SIZE: "8",
            CONTEXTPLUS_EMBED_TRACKER: "lazy",
          },
        },
      },
    },
    null,
    2,
  );
}

function buildOpenCodeConfig(runner: "npx" | "bunx") {
  const command = runner === "npx" ? ["npx", "-y", "contextplus"] : ["bunx", "contextplus"];
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        contextplus: {
          type: "local",
          command,
          enabled: true,
          environment: {
            OLLAMA_EMBED_MODEL: "qwen3-embedding:0.6b-32k",
            OLLAMA_CHAT_MODEL: "nemotron-3-nano:4b-128k",
            OLLAMA_API_KEY: "YOUR_OLLAMA_API_KEY",
            CONTEXTPLUS_EMBED_BATCH_SIZE: "8",
            CONTEXTPLUS_EMBED_TRACKER: "lazy",
          },
        },
      },
    },
    null,
    2,
  );
}

function buildCodexConfig(runner: "npx" | "bunx") {
  const command = runner;
  const args = runner === "npx" ? ["-y", "contextplus"] : ["contextplus"];
  return [
    "[mcp_servers.contextplus]",
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    "",
    "[mcp_servers.contextplus.env]",
    'OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b-32k"',
    'OLLAMA_CHAT_MODEL = "nemotron-3-nano:4b-128k"',
    'OLLAMA_API_KEY = "YOUR_OLLAMA_API_KEY"',
    'CONTEXTPLUS_EMBED_BATCH_SIZE = "8"',
    'CONTEXTPLUS_EMBED_TRACKER = "lazy"',
    "",
  ].join("\n");
}

async function runInitCommand(args: string[]) {
  const nonFlags = args.filter((arg) => !arg.startsWith("--"));
  const target = parseAgentTarget(nonFlags[0]);
  const runner = parseRunner(args);
  const outputPath = resolve(process.cwd(), AGENT_CONFIG_PATH[target]);
  const content = target === "opencode"
    ? buildOpenCodeConfig(runner)
    : target === "codex"
      ? buildCodexConfig(runner)
      : buildMcpConfig(runner);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${content}\n`, "utf8");
  console.error(`Context+ initialized for ${target} using ${runner}.`);
  console.error(`Wrote MCP config: ${outputPath}`);
}

async function runIndexCommand(args: string[]) {
  const targetRootArg = args.find((arg) => !arg.startsWith("--"));
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.split("=")[1] === "core" ? "core" : DEFAULT_INDEX_MODE;
  const targetRoot = targetRootArg ? resolve(targetRootArg) : process.cwd();
  process.stdout.write(await indexCodebase({ rootDir: targetRoot, mode }) + "\n");
}

const server = new McpServer({
  name: "contextplus",
  version: "1.0.0",
}, {
  capabilities: { logging: {} },
});

server.resource(
  "contextplus_instructions",
  INSTRUCTIONS_RESOURCE_URI,
  withRequestActivity(async (uri) => {
    const response = await fetch(INSTRUCTIONS_SOURCE_URL);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: await response.text(),
      }],
    };
  }),
);

server.tool(
  "index",
  "Create or refresh the .contextplus project state for this repo. Builds the repo-local Context+ layout, " +
  "writes project config plus a context-tree snapshot into the durable sqlite substrate at .contextplus/state/index.sqlite, " +
  "persists stage state, indexing status, embedding caches, memory state, restore points, and file/identifier indexes there, " +
  "and in full mode also persists chunk and code-structure artifacts with explicit contract metadata and no JSON mirrors.",
  {
    mode: z.enum(["core", "full"]).optional().describe("Indexing mode. Defaults to full and persists derived chunk and code-structure artifacts."),
  },
  withRequestActivity(async ({ mode }) => ({
    content: [{
      type: "text" as const,
      text: await indexCodebase({ rootDir: ROOT_DIR, mode }),
    }],
  })),
);

server.tool(
  "validate_index",
  "Validate that the prepared sqlite-backed index is present, version-compatible, and internally consistent for core or full mode.",
  {
    mode: z.enum(["core", "full"]).optional().describe("Validation mode. Defaults to full."),
  },
  withRequestActivity(async ({ mode }) => ({
    content: [{
      type: "text" as const,
      text: formatIndexValidationReport(await validatePreparedIndex({
        rootDir: ROOT_DIR,
        mode: mode ?? DEFAULT_INDEX_MODE,
      })),
    }],
  })),
);

server.tool(
  "repair_index",
  "Repair the prepared index by rerunning the full pipeline or a specific durable stage, then validate the repaired state.",
  {
    target: z.enum(["core", "full", "bootstrap", "file-search", "identifier-search", "full-artifacts"])
      .describe("Repair target. Use core/full for full pipeline rebuilds or a stage name for a targeted rerun."),
  },
  withRequestActivity(async ({ target }) => ({
    content: [{
      type: "text" as const,
      text: await repairPreparedIndex(ROOT_DIR, target),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "tree",
  "Get the structural tree of the project with file headers, function names, classes, enums, and line ranges. " +
  "Automatically reads 2-line headers for file purpose. Dynamic token-aware pruning: " +
  "Level 2 (deep symbols) -> Level 1 (headers only) -> Level 0 (file names only) based on project size.",
  {
    target_path: z.string().optional().describe("Specific directory or file to analyze (relative to project root). Defaults to root."),
    depth_limit: z.number().optional().describe("How many folder levels deep to scan. Use 1-2 for large projects."),
    include_symbols: z.boolean().optional().describe("Include function/class/enum names in the tree. Defaults to true."),
    max_tokens: z.number().optional().describe("Maximum tokens for output. Auto-prunes if exceeded. Default: 20000."),
  },
  withRequestActivity(async ({ target_path, depth_limit, include_symbols, max_tokens }) => ({
    content: [{
      type: "text" as const,
      text: await getContextTree({
        rootDir: ROOT_DIR,
        targetPath: target_path,
        depthLimit: depth_limit,
        includeSymbols: include_symbols,
        maxTokens: max_tokens,
      }),
    }],
  })),
);

server.tool(
  "research",
  "Aggregate code retrieval, structure-backed related files, subsystem summaries, and relevant hubs into one bounded report.",
  {
    query: z.string().describe("Natural language repository question to investigate."),
    top_k: z.number().optional().describe("How many top ranked code hits to include. Default: 5."),
    include_kinds: z.array(z.string()).optional().describe("Optional symbol-kind filter for the ranked code hits."),
    max_related: z.number().optional().describe("Maximum related files to include. Default: 6."),
    max_subsystems: z.number().optional().describe("Maximum subsystem summaries to include. Default: 3."),
    max_hubs: z.number().optional().describe("Maximum relevant manual or suggested hubs to include. Default: 4."),
  },
  withRequestActivity(async ({ query, top_k, include_kinds, max_related, max_subsystems, max_hubs }) => ({
    content: [{
      type: "text" as const,
      text: await runResearch({
        rootDir: ROOT_DIR,
        query,
        topK: top_k,
        includeKinds: include_kinds,
        maxRelated: max_related,
        maxSubsystems: max_subsystems,
        maxHubs: max_hubs,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "evaluate",
  "Run the built-in synthetic benchmark suite for retrieval quality, navigation quality, reindex speed, artifact freshness, and research output quality.",
  {},
  withRequestActivity(async () => ({
    content: [{
      type: "text" as const,
      text: await runEvaluation(),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "search",
  "Search the prepared full-engine artifacts with unified ranking. Use search_type='file' for file results, " +
  "search_type='symbol' for symbol-level results, or search_type='mixed' to rank both together.",
  {
    search_type: z.enum(["file", "symbol", "mixed"]).describe("Select file results, symbol results, or both together."),
    query: z.string().describe("Natural language intent to rank against the prepared full-engine artifacts."),
    top_k: z.number().optional().describe("How many ranked hits to return. Default: 5."),
    include_kinds: z.array(z.string()).optional().describe("Optional symbol-kind filter, e.g. [\"function\", \"method\", \"variable\"]."),
    semantic_weight: z.number().optional().describe("Weight for semantic similarity inside the hybrid retrieval layers."),
    lexical_weight: z.number().optional().describe("Weight for lexical overlap inside the hybrid retrieval layers."),
    file_weight: z.number().optional().describe("Weight for file-level evidence in the final unified rank."),
    chunk_weight: z.number().optional().describe("Weight for chunk-level evidence in the final unified rank."),
    identifier_weight: z.number().optional().describe("Weight for identifier evidence in the final unified rank."),
    structure_weight: z.number().optional().describe("Weight for structure-graph evidence in the final unified rank."),
  },
  withRequestActivity(async ({
    search_type,
    query,
    top_k,
    include_kinds,
    semantic_weight,
    lexical_weight,
    file_weight,
    chunk_weight,
    identifier_weight,
    structure_weight,
  }) => ({
    content: [{
      type: "text" as const,
      text: await runCanonicalSearch({
        rootDir: ROOT_DIR,
        query,
        topK: top_k,
        entityTypes: search_type === "mixed" ? ["file", "symbol"] : [search_type],
        includeKinds: include_kinds,
        semanticWeight: semantic_weight,
        lexicalWeight: lexical_weight,
        fileWeight: file_weight,
        chunkWeight: chunk_weight,
        identifierWeight: identifier_weight,
        structureWeight: structure_weight,
      }),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "skeleton",
  "Get detailed function signatures, class methods, and type definitions of a specific file WITHOUT reading the full body. " +
  "Shows the API surface: function names, parameters, return types, and line ranges. Perfect for understanding how to use code without loading it all.",
  {
    file_path: z.string().describe("Path to the file to inspect (relative to project root)."),
  },
  withRequestActivity(async ({ file_path }) => ({
    content: [{
      type: "text" as const,
      text: await getFileSkeleton({ rootDir: ROOT_DIR, filePath: file_path }),
    }],
  })),
);

server.tool(
  "blast_radius",
  "Before deleting or modifying code, check the BLAST RADIUS. Traces every file and line where a specific symbol " +
  "(function, class, variable) is imported or used. Prevents orphaned code. Also warns if usage count is low (candidate for inlining).",
  {
    symbol_name: z.string().describe("The function, class, or variable name to trace across the codebase."),
    file_context: z.string().optional().describe("The file where the symbol is defined. Excludes the definition line from results."),
  },
  withRequestActivity(async ({ symbol_name, file_context }) => ({
    content: [{
      type: "text" as const,
      text: await getBlastRadius({ rootDir: ROOT_DIR, symbolName: symbol_name, fileContext: file_context }),
    }],
  })),
);

server.tool(
  "lint",
  "Run the project's native linter/compiler to find unused variables, dead code, type errors, and syntax issues. " +
  "Delegates detection to deterministic tools instead of LLM guessing. Supports TypeScript, Python, Rust, Go.",
  {
    target_path: z.string().optional().describe("Specific file or folder to lint (relative to root). Omit for full project."),
  },
  withRequestActivity(async ({ target_path }) => ({
    content: [{
      type: "text" as const,
      text: await runStaticAnalysis({ rootDir: ROOT_DIR, targetPath: target_path }),
    }],
  })),
);

server.tool(
  "checkpoint",
  "The ONLY way to write code. Validates the code against strict rules before saving: " +
  "2-line header comments, FEATURE tags, max nesting depth, max file length. " +
  "Creates a shadow restore point before writing. REJECTS code that violates formatting rules.",
  {
    file_path: z.string().describe("Where to save the file (relative to project root)."),
    new_content: z.string().describe("The complete file content to save."),
  },
  withRequestActivity(async ({ file_path, new_content }) => {
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    return {
      content: [{
        type: "text" as const,
        text: await proposeCommit({ rootDir: ROOT_DIR, filePath: file_path, newContent: new_content }),
      }],
    };
  }),
);

server.tool(
  "restore_points",
  "List all shadow restore points created by checkpoint. Each point captures the file state before the AI made changes. " +
  "Use this to find a restore point ID for undoing a bad change.",
  {},
  withRequestActivity(async () => {
    const points = await listRestorePoints(ROOT_DIR);
    if (points.length === 0) return { content: [{ type: "text" as const, text: "No restore points found." }] };

    const lines = points.map((p) =>
      `${p.id} | ${new Date(p.timestamp).toISOString()} | ${p.files.join(", ")} | ${p.message}`,
    );
    return { content: [{ type: "text" as const, text: `Restore Points (${points.length}):\n\n${lines.join("\n")}` }] };
  }),
);

server.tool(
  "restore",
  "Restore files to their state before a specific AI change. Uses the shadow restore point system. " +
  "Does NOT affect git history. Call restore_points first to find the point ID.",
  {
    point_id: z.string().describe("The restore point ID (format: rp-timestamp-hash). Get from restore_points."),
  },
  withRequestActivity(async ({ point_id }) => {
    const restored = await restorePoint(ROOT_DIR, point_id);
    invalidateSearchCache();
    invalidateIdentifierSearchCache();
    return {
      content: [{
        type: "text" as const,
        text: restored.length > 0
          ? `Restored ${restored.length} file(s):\n${restored.join("\n")}`
          : "No files were restored. The backup may be empty.",
      }],
    };
  }),
);

server.tool(
  "cluster",
  "Browse the codebase by MEANING, not directory structure. Renders persisted semantic clusters, subsystem summaries, " +
  "and related-file neighborhoods from the full index instead of recomputing them on demand.",
  {
    max_depth: z.number().optional().describe("Maximum nesting depth of clusters. Default: 3."),
    max_clusters: z.number().optional().describe("Maximum rendered child clusters per level. Default: 20."),
  },
  withRequestActivity(async ({ max_depth, max_clusters }) => ({
    content: [{
      type: "text" as const,
      text: await semanticNavigate({ rootDir: ROOT_DIR, maxDepth: max_depth, maxClusters: max_clusters }),
    }],
  })),
);

server.tool(
  "find_hub",
  "Obsidian-style feature hub navigator. Hub files are .md files containing [[path/to/file]] wikilinks that act as a Map of Content. " +
  "Modes: (1) No args = list all hubs plus persisted suggested hubs and feature-group candidates, " +
  "(2) hub_path or feature_name = show hub with bundled skeletons of all linked files, " +
  "(3) show_orphans = find files not linked to any hub. Prevents orphaned code and enables graph-based codebase navigation.",
  {
    hub_path: z.string().optional().describe("Path to a specific hub .md file (relative to root)."),
    feature_name: z.string().optional().describe("Feature name to search for. Finds matching hub file automatically."),
    show_orphans: z.boolean().optional().describe("If true, lists all source files not linked to any feature hub."),
  },
  withRequestActivity(async ({ hub_path, feature_name, show_orphans }) => ({
    content: [{
      type: "text" as const,
      text: await getFeatureHub({
        rootDir: ROOT_DIR,
        hubPath: hub_path,
        featureName: feature_name,
        showOrphans: show_orphans,
      }),
    }],
  })),
);


async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "init") {
    await runInitCommand(args.slice(1));
    return;
  }
  if (args[0] === "index") {
    await runIndexCommand(args.slice(1));
    return;
  }
  if (args[0] === "skeleton" || args[0] === "tree") {
    const targetRoot = args[1] ? resolve(args[1]) : process.cwd();
    const tree = await getContextTree({
      rootDir: targetRoot,
      includeSymbols: true,
      maxTokens: 50000,
    });
    process.stdout.write(tree + "\n");
    return;
  }
  const trackerController = createEmbeddingTrackerController({
    rootDir: ROOT_DIR,
    mode: process.env.CONTEXTPLUS_EMBED_TRACKER,
    debounceMs: Number.parseInt(process.env.CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS ?? "700", 10),
    maxFilesPerTick: Number.parseInt(process.env.CONTEXTPLUS_EMBED_TRACKER_MAX_FILES ?? "8", 10),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  let stopParentMonitor = () => { };
  const idleMonitor = createIdleMonitor({
    timeoutMs: getIdleShutdownMs(process.env.CONTEXTPLUS_IDLE_TIMEOUT_MS),
    onIdle: () => requestShutdown("idle-timeout", 0),
    isTransportAlive: () => process.stdin.readable && !process.stdin.destroyed,
  });

  noteServerActivity = idleMonitor.touch;
  ensureTrackerRunning = trackerController.ensureStarted;

  const closeServer = async () => {
    const closable = server as unknown as { close?: () => Promise<void> | void };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  };
  const closeTransport = async () => {
    const closable = transport as unknown as { close?: () => Promise<void> | void };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  };
  const shutdown = async (reason: string, exitCode: number = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Context+ MCP shutdown requested: ${reason}`);
    await runCleanup({
      cancelEmbeddings: cancelAllEmbeddings,
      stopTracker: trackerController.stop,
      closeServer,
      closeTransport,
      stopMonitors: () => {
        idleMonitor.stop();
        stopParentMonitor();
      },
    });
    process.exit(exitCode);
  };
  const requestShutdown = (reason: string, exitCode: number = 0) => {
    void shutdown(reason, exitCode);
  };

  stopParentMonitor = startParentMonitor({
    parentPid: process.ppid,
    pollIntervalMs: getParentPollMs(process.env.CONTEXTPLUS_PARENT_POLL_MS),
    onParentExit: () => requestShutdown("parent-exit", 0),
  });

  process.once("SIGINT", () => requestShutdown("SIGINT", 0));
  process.once("SIGTERM", () => requestShutdown("SIGTERM", 0));
  process.once("SIGHUP", () => requestShutdown("SIGHUP", 0));
  process.once("disconnect", () => requestShutdown("disconnect", 0));
  process.once("exit", () => {
    idleMonitor.stop();
    stopParentMonitor();
    trackerController.stop();
  });
  process.stdin.once("end", () => requestShutdown("stdin-end", 0));
  process.stdin.once("close", () => requestShutdown("stdin-close", 0));
  process.stdin.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stdin-error", 0);
  });
  process.stdout.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stdout-error", 0);
  });
  process.stderr.once("error", (error) => {
    if (isBrokenPipeError(error)) requestShutdown("stderr-error", 0);
  });

  noteServerActivity();
  console.error(`Context+ MCP server running on stdio | root: ${ROOT_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
