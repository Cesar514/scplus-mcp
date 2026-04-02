#!/usr/bin/env node
// context++ MCP entrypoint for semantic repository navigation and repair.
// FEATURE: Registers public tools and starts the stdio server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "path";
import { z } from "zod";
import { createBackendCore } from "./cli/backend-core.js";
import { CLI_SUBCOMMANDS, handleCliCommand } from "./cli/commands.js";
import { createEmbeddingTrackerController } from "./core/embedding-tracker.js";
import { createIdleMonitor, getIdleShutdownMs, getParentPollMs, isBrokenPipeError, runCleanup, startParentMonitor } from "./core/process-lifecycle.js";
import { getContextTree } from "./tools/context-tree.js";
import { getFileSkeleton } from "./tools/file-skeleton.js";
import { cancelAllEmbeddings } from "./core/embeddings.js";
import { getBlastRadius } from "./tools/blast-radius.js";
import { runStaticAnalysis } from "./tools/static-analysis.js";
import { proposeCommit } from "./tools/propose-commit.js";
import { listRestorePoints, restorePoint } from "./git/shadow.js";
import { semanticNavigate } from "./tools/semantic-navigate.js";
import { getFeatureHub } from "./tools/feature-hub.js";
import { runEvaluation } from "./tools/evaluation.js";
import { DEFAULT_INDEX_MODE } from "./tools/index-contract.js";
import { formatIndexValidationReport, repairPreparedIndex, validatePreparedIndex } from "./tools/index-reliability.js";
import { runResearch } from "./tools/research.js";
import {
  formatDependencyInfo,
  formatExactSymbolResults,
  formatOutline,
  formatRepoChangesSummary,
  formatRepoStatusSummary,
  formatWordMatches,
  getDependencyInfo,
  getOutline,
  getRepoChanges,
  getRepoStatus,
  lookupExactSymbol,
  lookupWord,
} from "./tools/exact-query.js";
import { runSearchByIntent } from "./tools/query-intent.js";
import { formatPreparedIndexFreshnessHeader } from "./tools/write-freshness.js";
const passthroughArgs = process.argv.slice(2);
const ROOT_DIR = passthroughArgs[0] && !CLI_SUBCOMMANDS.has(passthroughArgs[0])
  ? resolve(passthroughArgs[0])
  : process.cwd();
const INSTRUCTIONS_SOURCE_URL = "https://contextplus.vercel.app/api/instructions";
const INSTRUCTIONS_RESOURCE_URI = "context++://instructions";

let noteServerActivity = () => { };
let ensureTrackerRunning = () => { };
const backendCore = createBackendCore();

async function formatPreparedQueryResponse(text: string): Promise<string> {
  return `${await formatPreparedIndexFreshnessHeader(ROOT_DIR)}\n\n${text}`;
}

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

const server = new McpServer({
  name: "context++",
  version: "1.0.0",
}, {
  capabilities: { logging: {} },
});

server.resource(
  "context++_instructions",
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
  "Create or refresh the .contextplus project state for this repo. Builds the repo-local context++ layout, " +
  "writes project config plus a context-tree snapshot into the durable sqlite substrate at .contextplus/state/index.sqlite, " +
  "persists stage state, indexing status, embedding caches, restore points, and file/identifier indexes there, " +
  "and in full mode also persists chunk and code-structure artifacts with explicit contract metadata and no JSON mirrors.",
  {
    mode: z.enum(["core", "full"]).optional().describe("Indexing mode. Defaults to full and persists derived chunk and code-structure artifacts."),
  },
  withRequestActivity(async ({ mode }) => ({
    content: [{
      type: "text" as const,
      text: await backendCore.index(ROOT_DIR, mode),
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
  "symbol",
  "Run a tiny exact symbol lookup over the prepared fast-query substrate. Use this when you already know the symbol name and want deterministic exact matches instead of ranked related search.",
  {
    query: z.string().describe("Exact symbol name to look up."),
    top_k: z.number().optional().describe("Maximum number of exact matches to return. Default: 10."),
  },
  withRequestActivity(async ({ query, top_k }) => ({
    content: [{
      type: "text" as const,
      text: await formatPreparedQueryResponse(
        formatExactSymbolResults(query, await lookupExactSymbol(ROOT_DIR, query, top_k)),
      ),
    }],
  })),
);

server.tool(
  "word",
  "Run a tiny indexed word lookup over paths, headers, symbols, and content snippets. Use this for exact words or short phrases before escalating to broader ranked search.",
  {
    query: z.string().describe("Word or short phrase to look up."),
    top_k: z.number().optional().describe("Maximum number of hits to return. Default: 10."),
  },
  withRequestActivity(async ({ query, top_k }) => ({
    content: [{
      type: "text" as const,
      text: await formatPreparedQueryResponse(
        formatWordMatches(query, await lookupWord(ROOT_DIR, query, top_k)),
      ),
    }],
  })),
);

server.tool(
  "outline",
  "Return a compact file outline from the prepared fast-query substrate. Use this when you know the file and want imports, exports, and symbols without broader search or full-body reads.",
  {
    file_path: z.string().describe("Path to the indexed file to inspect (relative to project root)."),
  },
  withRequestActivity(async ({ file_path }) => ({
    content: [{
      type: "text" as const,
      text: await formatPreparedQueryResponse(
        formatOutline(await getOutline(ROOT_DIR, file_path)),
      ),
    }],
  })),
);

server.tool(
  "deps",
  "Return compact direct and reverse dependency information for one indexed file. Use this for exact dependency tracing instead of broader related search.",
  {
    target: z.string().describe("Indexed file path or close path fragment to resolve."),
  },
  withRequestActivity(async ({ target }) => ({
    content: [{
      type: "text" as const,
      text: await formatPreparedQueryResponse(
        formatDependencyInfo(await getDependencyInfo(ROOT_DIR, target)),
      ),
    }],
  })),
);

server.tool(
  "status",
  "Return a tiny git worktree status summary for the current repository. Use this for branch and dirty-file checks instead of reading broader change context.",
  {
    limit: z.number().optional().describe("Maximum number of status entries to render. Default: 20."),
  },
  withRequestActivity(async ({ limit }) => ({
    content: [{
      type: "text" as const,
      text: formatRepoStatusSummary(await getRepoStatus(ROOT_DIR), limit),
    }],
  })),
);

server.tool(
  "changes",
  "Return a tiny git change summary, optionally for one file. Use this for exact changed-file inspection and line-range summaries instead of broader repository search.",
  {
    path: z.string().optional().describe("Optional indexed file path to scope the change summary to one file."),
    limit: z.number().optional().describe("Maximum number of changed files to render when path is omitted. Default: 20."),
  },
  withRequestActivity(async ({ path, limit }) => ({
    content: [{
      type: "text" as const,
      text: formatRepoChangesSummary(await getRepoChanges(ROOT_DIR, { path, limit }), limit),
    }],
  })),
);

server.tool(
  "research",
  "Aggregate ranked code retrieval, structure-backed related files, subsystem summaries, and relevant hubs into one bounded report. Use this for broad subsystem understanding after exact lookup or related-item search is no longer enough.",
  {
    query: z.string().describe("Natural language repository question to investigate."),
  },
  withRequestActivity(async ({ query }) => ({
    content: [{
      type: "text" as const,
      text: await formatPreparedQueryResponse(
        await runResearch({
          rootDir: ROOT_DIR,
          query,
        }),
      ),
    }],
  }), { useEmbeddingTracker: true }),
);

server.tool(
  "evaluate",
  "Run the built-in real benchmark harness across small, medium, monorepo, polyglot, ignored-tree, broken-state, and rename-freshness scenarios. Reports golden-query accuracy, validation rates, freshness reliability, and p50/p95/p99 query latency.",
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
  "Route repository search by explicit intent. Use intent='exact' for deterministic fast-substrate answers when you know the exact symbol or file target, " +
  "and intent='related' for ranked related-item and pattern discovery over the prepared full-engine artifacts.",
  {
    intent: z.enum(["exact", "related"]).describe("Query intent. exact = deterministic fast lookup, related = ranked discovery."),
    search_type: z.enum(["file", "symbol", "mixed"]).describe("Select file results, symbol results, or both together."),
    query: z.string().describe("Natural language intent to rank against the prepared full-engine artifacts."),
    retrieval_mode: z.enum(["semantic", "keyword", "both"]).optional().describe("For related search, force semantic-only, keyword-only, or mixed retrieval. Defaults to both."),
    top_k: z.number().optional().describe("How many ranked hits to return. Default: 5."),
    include_kinds: z.array(z.string()).optional().describe("Optional symbol-kind filter, e.g. [\"function\", \"method\", \"variable\"]."),
  },
  withRequestActivity(async ({
    intent,
    search_type,
    query,
    retrieval_mode,
    top_k,
    include_kinds,
  }) => ({
    content: [{
      type: "text" as const,
      text: await formatPreparedQueryResponse(
        await runSearchByIntent({
          rootDir: ROOT_DIR,
          intent,
          searchType: search_type,
          query,
          retrievalMode: retrieval_mode,
          topK: top_k,
          includeKinds: include_kinds,
        }),
      ),
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
  withRequestActivity(async ({ file_path, new_content }) => ({
    content: [{
      type: "text" as const,
      text: await proposeCommit({ rootDir: ROOT_DIR, filePath: file_path, newContent: new_content }),
    }],
  })),
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
  "(3) query = rank candidate hubs by keyword, semantic, or mixed retrieval, " +
  "(4) show_orphans = find files not linked to any hub. Prevents orphaned code and enables graph-based codebase navigation.",
  {
    hub_path: z.string().optional().describe("Path to a specific hub .md file (relative to root)."),
    feature_name: z.string().optional().describe("Feature name to search for. Finds matching hub file automatically."),
    query: z.string().optional().describe("Rank hubs against a natural-language feature or subsystem query."),
    ranking_mode: z.enum(["keyword", "semantic", "both"]).optional().describe("How to rank hub query candidates. Defaults to both."),
    show_orphans: z.boolean().optional().describe("If true, lists all source files not linked to any feature hub."),
  },
  withRequestActivity(async ({ hub_path, feature_name, query, ranking_mode, show_orphans }) => ({
    content: [{
      type: "text" as const,
      text: await getFeatureHub({
        rootDir: ROOT_DIR,
        hubPath: hub_path,
        featureName: feature_name,
        query,
        rankingMode: ranking_mode,
        showOrphans: show_orphans,
      }),
    }],
  })),
);


async function main() {
  const args = process.argv.slice(2);
  if (await handleCliCommand(args)) {
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
    console.error(`context++ MCP shutdown requested: ${reason}`);
    await backendCore.close();
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
  console.error(`context++ MCP server running on stdio | root: ${ROOT_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
