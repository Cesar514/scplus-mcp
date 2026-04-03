// summary: Supplies shared parsing and formatting helpers for human CLI bridge commands.
// FEATURE: Command-line parsing and output formatting for human bridge commands.
// inputs: Raw CLI arguments, config objects, and backend output payloads.
// outputs: Normalized command options and human-readable formatted output blocks.

import { resolve } from "node:path";
import { listRestorePoints } from "../git/shadow.js";
import { DEFAULT_INDEX_MODE } from "../tools/index-contract.js";
import { formatIndexValidationReport } from "../tools/index-reliability.js";
import { formatRepoStatusSummary } from "../tools/exact-query.js";
import type { SearchEntityType, SearchIntent } from "../tools/query-intent.js";
import { buildDoctorReport } from "./reports.js";
import type { RetrievalMode } from "../tools/unified-ranking.js";

export type AgentTarget = "claude" | "cursor" | "vscode" | "windsurf" | "opencode" | "codex";

export type ParsedFlags = Map<string, string | boolean>;

export interface ParsedArgs {
  positionals: string[];
  flags: ParsedFlags;
}

const AGENT_CONFIG_PATH: Record<AgentTarget, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
  windsurf: ".windsurf/mcp.json",
  opencode: "opencode.json",
  codex: ".codex/config.toml",
};

export function parseAgentTarget(input?: string): AgentTarget {
  const normalized = (input ?? "claude").toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "vscode" || normalized === "vs-code" || normalized === "vs") return "vscode";
  if (normalized === "windsurf") return "windsurf";
  if (normalized === "opencode" || normalized === "open-code") return "opencode";
  if (normalized === "codex") return "codex";
  throw new Error(`Unsupported coding agent "${input}". Use one of: claude, cursor, vscode, windsurf, opencode, codex.`);
}

export function parseRunner(args: string[]): "npx" | "bunx" {
  const explicit = args.find((arg) => arg.startsWith("--runner="));
  if (explicit) {
    const value = explicit.split("=")[1];
    if (value === "npx" || value === "bunx") return value;
    throw new Error(`Unsupported runner "${value}". Use --runner=npx or --runner=bunx.`);
  }
  const runnerFlagIndex = args.findIndex((arg) => arg === "--runner");
  if (runnerFlagIndex >= 0) {
    const value = args[runnerFlagIndex + 1];
    if (value === "npx" || value === "bunx") return value;
    throw new Error(`Unsupported runner "${value}". Use --runner=npx or --runner=bunx.`);
  }
  const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = (process.env.npm_execpath ?? "").toLowerCase();
  if (userAgent.includes("bun/") || execPath.includes("bun")) return "bunx";
  return "npx";
}

function buildMcpConfig(runner: "npx" | "bunx"): string {
  const commandArgs = runner === "npx" ? ["-y", "scplus-mcp"] : ["scplus-mcp"];
  return JSON.stringify(
    {
      mcpServers: {
        "scplus-mcp": {
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

function buildOpenCodeConfig(runner: "npx" | "bunx"): string {
  const command = runner === "npx" ? ["npx", "-y", "scplus-mcp"] : ["bunx", "scplus-mcp"];
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "scplus-mcp": {
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

function buildCodexConfig(runner: "npx" | "bunx"): string {
  const args = runner === "npx" ? ["-y", "scplus-mcp"] : ["scplus-mcp"];
  return [
    '[mcp_servers."scplus-mcp"]',
    `command = ${JSON.stringify(runner)}`,
    `args = ${JSON.stringify(args)}`,
    "",
    '[mcp_servers."scplus-mcp".env]',
    'OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b-32k"',
    'OLLAMA_CHAT_MODEL = "nemotron-3-nano:4b-128k"',
    'OLLAMA_API_KEY = "YOUR_OLLAMA_API_KEY"',
    'CONTEXTPLUS_EMBED_BATCH_SIZE = "8"',
    'CONTEXTPLUS_EMBED_TRACKER = "lazy"',
    "",
  ].join("\n");
}

export function buildInitConfig(target: AgentTarget, runner: "npx" | "bunx"): { content: string; outputPath: string } {
  const outputPath = resolve(process.cwd(), AGENT_CONFIG_PATH[target]);
  const content = target === "opencode"
    ? buildOpenCodeConfig(runner)
    : target === "codex"
      ? buildCodexConfig(runner)
      : buildMcpConfig(runner);
  return { content, outputPath };
}

export function parseArgs(args: string[]): ParsedArgs {
  const flags: ParsedFlags = new Map();
  const positionals: string[] = [];
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      index += 1;
      continue;
    }
    const trimmed = value.slice(2);
    const [name, inline] = trimmed.split("=", 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      index += 1;
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 2;
      continue;
    }
    flags.set(name, true);
    index += 1;
  }
  return { positionals, flags };
}

export function getFlag(flags: ParsedFlags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function hasFlag(flags: ParsedFlags, name: string): boolean {
  return flags.get(name) === true || typeof flags.get(name) === "string";
}

export function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parseBridgeSearchIntent(value: string | undefined): SearchIntent {
  if (!value) return "related";
  if (value === "exact" || value === "related") return value;
  throw new Error(`Unsupported search intent "${value}". Use "exact" or "related".`);
}

export function parseBridgeSearchType(value: string | undefined): SearchEntityType {
  if (!value) return "mixed";
  if (value === "file" || value === "symbol" || value === "mixed") return value;
  throw new Error(`Unsupported search type "${value}". Use "file", "symbol", or "mixed".`);
}

export function parseBridgeRetrievalMode(value: string | undefined): RetrievalMode | undefined {
  if (value === undefined) return undefined;
  if (value === "semantic" || value === "keyword" || value === "both") return value;
  throw new Error(`Unsupported retrieval mode "${value}". Use "semantic", "keyword", or "both".`);
}

export function parseStringList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function resolveRoot(parsed: ParsedArgs): string {
  const explicit = getFlag(parsed.flags, "root");
  const candidate = explicit ?? parsed.positionals[0];
  return resolve(candidate ?? process.cwd());
}

export function normalizeIndexMode(value: string | undefined): "core" | "full" {
  return value === "core" ? "core" : DEFAULT_INDEX_MODE;
}

export function formatRestorePoints(points: Awaited<ReturnType<typeof listRestorePoints>>): string {
  if (points.length === 0) return "Restore points (0)\nNo restore points.";
  const lines = [`Restore points (${points.length})`];
  for (const point of points) {
    lines.push(`- ${point.id} | ${new Date(point.timestamp).toISOString()} | ${point.message} | files ${point.files.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatDoctorReport(report: Awaited<ReturnType<typeof buildDoctorReport>>): string {
  const chunkCoverage = report.hybridVectors.chunk.vectorCoverage;
  const identifierCoverage = report.hybridVectors.identifier.vectorCoverage;
  const parseFailuresByLanguage = Object.entries(report.observability.integrity.parseFailuresByLanguage)
    .map(([language, failures]) => `${language}:${failures}`)
    .join(", ");
  const indexingStages = Object.entries(report.observability.indexing.stages)
    .map(([stage, metrics]) => {
      const throughputParts = [
        metrics.filesPerSecond ? `files/s=${metrics.filesPerSecond}` : "",
        metrics.chunksPerSecond ? `chunks/s=${metrics.chunksPerSecond}` : "",
        metrics.embedsPerSecond ? `embeds/s=${metrics.embedsPerSecond}` : "",
      ].filter(Boolean);
      return `- ${stage}: ${metrics.durationMs}ms${throughputParts.length > 0 ? ` | ${throughputParts.join(" | ")}` : ""}`;
    });
  const lines = [
    `Doctor: ${report.root}`,
    "",
    `Serving generation: ${report.serving.activeGeneration}`,
    `Pending generation: ${report.serving.pendingGeneration ?? "none"}`,
    `Serving freshness: ${report.serving.activeGenerationFreshness}`,
    "",
    formatRepoStatusSummary(report.repoStatus, 10),
    "",
    formatIndexValidationReport(report.indexValidation),
    "",
    `Hub suggestions: ${report.hubSummary.suggestionCount}`,
    `Feature groups: ${report.hubSummary.featureGroupCount}`,
    `Restore points: ${report.restorePointCount}`,
    `Hybrid vectors: chunk ${chunkCoverage.loadedVectorCount}/${chunkCoverage.requestedVectorCount} ${chunkCoverage.state} | identifier ${identifierCoverage.loadedVectorCount}/${identifierCoverage.requestedVectorCount} ${identifierCoverage.state}`,
    `Tree-sitter: parses=${report.treeSitter.totalParseCalls} | parse failures=${report.treeSitter.totalParseFailures} | grammar load failures=${report.treeSitter.totalGrammarLoadFailures} | parser reuses=${report.treeSitter.totalParserReuses}`,
    report.ollama.ok
      ? `Ollama: ok | running models ${report.ollama.models.length}`
      : `Ollama: error | ${report.ollama.error}`,
    "",
    `Observability: staleAgeMs=${report.observability.integrity.staleGenerationAgeMs ?? "none"} | fallback markers=${report.observability.integrity.fallbackMarkerCount} | parse failures by language=${parseFailuresByLanguage || "none"}`,
    `Refresh failures: file-search=${report.observability.integrity.refreshFailures.fileSearch.refreshFailures} | failed-files=${report.observability.integrity.refreshFailures.fileSearch.refreshFailedFiles} | write-refresh=${report.observability.integrity.refreshFailures.writeFreshness.refreshFailures}`,
    `Embedding cache: namespace hits=${report.observability.caches.embeddings.processNamespaceHits} | namespace misses=${report.observability.caches.embeddings.processNamespaceMisses} | vector hits=${report.observability.caches.embeddings.processVectorHits} | vector misses=${report.observability.caches.embeddings.processVectorMisses}`,
    `Hybrid search runtime: chunk lexical=${report.observability.caches.hybridSearch.chunk.lexicalCandidateCount} | chunk last=${report.observability.caches.hybridSearch.chunk.lastLexicalCandidateCount} | identifier lexical=${report.observability.caches.hybridSearch.identifier.lexicalCandidateCount} | identifier last=${report.observability.caches.hybridSearch.identifier.lastLexicalCandidateCount}`,
    `Scheduler: watch=${report.observability.scheduler.watchEnabled} | queueDepth=${report.observability.scheduler.queueDepth} | pendingChanges=${report.observability.scheduler.pendingChangeCount} | pendingJob=${report.observability.scheduler.pendingJobKind ?? "none"} | maxQueueDepth=${report.observability.scheduler.maxQueueDepth} | batches=${report.observability.scheduler.batchCount} | dedupedPathEvents=${report.observability.scheduler.dedupedPathEvents} | canceledJobs=${report.observability.scheduler.canceledJobs} | supersededJobs=${report.observability.scheduler.supersededJobs}`,
    `Pending paths: ${report.observability.scheduler.pendingPaths.length > 0 ? report.observability.scheduler.pendingPaths.join(", ") : "none"}`,
  ];
  if (indexingStages.length > 0) {
    lines.push("Index stages:");
    lines.push(...indexingStages);
  }
  if (report.observability.scheduler.fullRebuildReasons.length > 0) {
    lines.push("Recent full rebuild reasons:");
    for (const reason of report.observability.scheduler.fullRebuildReasons) lines.push(`- ${reason}`);
  }
  for (const model of report.ollama.models) {
    lines.push(`- ${model.name} | ${model.processor ?? "unknown processor"} | ${model.until ?? "unknown expiry"}`);
  }
  return lines.join("\n");
}
