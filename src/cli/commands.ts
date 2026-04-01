// Human CLI command router for backend actions and bridge payloads
// FEATURE: Human terminal interface subcommands for Context+ backend workflows

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getContextTree } from "../tools/context-tree.js";
import { getFileSkeleton } from "../tools/file-skeleton.js";
import {
  formatRepoChangesSummary,
  formatRepoStatusSummary,
  getRepoChanges,
  getRepoStatus,
} from "../tools/exact-query.js";
import { getFeatureHub } from "../tools/feature-hub.js";
import { listRestorePoints } from "../git/shadow.js";
import { semanticNavigate } from "../tools/semantic-navigate.js";
import { DEFAULT_INDEX_MODE } from "../tools/index-contract.js";
import { formatIndexValidationReport, repairPreparedIndex, validatePreparedIndex } from "../tools/index-reliability.js";
import { indexCodebase } from "../tools/index-codebase.js";
import { buildDoctorReport } from "./reports.js";

type AgentTarget = "claude" | "cursor" | "vscode" | "windsurf" | "opencode" | "codex";

type ParsedFlags = Map<string, string | boolean>;

interface ParsedArgs {
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

export const CLI_SUBCOMMANDS = new Set([
  "bridge",
  "changes",
  "cluster",
  "doctor",
  "find-hub",
  "hubs",
  "index",
  "init",
  "repair-index",
  "repair_index",
  "restore-points",
  "restore_points",
  "skeleton",
  "status",
  "tree",
  "validate-index",
  "validate_index",
]);

function parseAgentTarget(input?: string): AgentTarget {
  const normalized = (input ?? "claude").toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "vscode" || normalized === "vs-code" || normalized === "vs") return "vscode";
  if (normalized === "windsurf") return "windsurf";
  if (normalized === "opencode" || normalized === "open-code") return "opencode";
  if (normalized === "codex") return "codex";
  throw new Error(`Unsupported coding agent "${input}". Use one of: claude, cursor, vscode, windsurf, opencode, codex.`);
}

function parseRunner(args: string[]): "npx" | "bunx" {
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

function buildOpenCodeConfig(runner: "npx" | "bunx"): string {
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

function buildCodexConfig(runner: "npx" | "bunx"): string {
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

function parseArgs(args: string[]): ParsedArgs {
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

function getFlag(flags: ParsedFlags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: ParsedFlags, name: string): boolean {
  return flags.get(name) === true || typeof flags.get(name) === "string";
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveRoot(parsed: ParsedArgs): string {
  const explicit = getFlag(parsed.flags, "root");
  const candidate = explicit ?? parsed.positionals[0];
  return resolve(candidate ?? process.cwd());
}

function normalizeIndexMode(value: string | undefined): "core" | "full" {
  return value === "core" ? "core" : DEFAULT_INDEX_MODE;
}

function formatRestorePoints(points: Awaited<ReturnType<typeof listRestorePoints>>): string {
  if (points.length === 0) return "Restore points (0)\nNo restore points.";
  const lines = [`Restore points (${points.length})`];
  for (const point of points) {
    lines.push(`- ${point.id} | ${new Date(point.timestamp).toISOString()} | ${point.message} | files ${point.files.join(", ")}`);
  }
  return lines.join("\n");
}

function formatDoctorReport(report: Awaited<ReturnType<typeof buildDoctorReport>>): string {
  const lines = [
    `Doctor: ${report.root}`,
    "",
    formatRepoStatusSummary(report.repoStatus, 10),
    "",
    formatIndexValidationReport(report.indexValidation),
    "",
    `Hub suggestions: ${report.hubSummary.suggestionCount}`,
    `Feature groups: ${report.hubSummary.featureGroupCount}`,
    `Restore points: ${report.restorePointCount}`,
    report.ollama.ok
      ? `Ollama: ok | running models ${report.ollama.models.length}`
      : `Ollama: error | ${report.ollama.error}`,
  ];
  for (const model of report.ollama.models) {
    lines.push(`- ${model.name} | ${model.processor ?? "unknown processor"} | ${model.until ?? "unknown expiry"}`);
  }
  return lines.join("\n");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInitCommand(args: string[]): Promise<void> {
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

async function runIndexCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const targetRoot = resolveRoot(parsed);
  const mode = normalizeIndexMode(getFlag(parsed.flags, "mode"));
  process.stdout.write(`${await indexCodebase({ rootDir: targetRoot, mode })}\n`);
}

async function runTreeCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const targetRoot = resolveRoot(parsed);
  const rendered = await getContextTree({
    rootDir: targetRoot,
    includeSymbols: !hasFlag(parsed.flags, "headers-only"),
    maxTokens: parseInteger(getFlag(parsed.flags, "max-tokens"), 50000),
  });
  if (hasFlag(parsed.flags, "json")) {
    writeJson({ root: targetRoot, text: rendered });
    return;
  }
  process.stdout.write(`${rendered}\n`);
}

async function runSkeletonCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error("skeleton requires a file path argument.");
  }
  const rootDir = resolve(getFlag(parsed.flags, "root") ?? process.cwd());
  const rendered = await getFileSkeleton({ rootDir, filePath });
  if (hasFlag(parsed.flags, "json")) {
    writeJson({ root: rootDir, filePath, text: rendered });
    return;
  }
  process.stdout.write(`${rendered}\n`);
}

async function runValidateIndexCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const mode = normalizeIndexMode(getFlag(parsed.flags, "mode"));
  const report = await validatePreparedIndex({ rootDir, mode });
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson(report);
    return;
  }
  process.stdout.write(`${formatIndexValidationReport(report)}\n`);
}

async function runRepairIndexCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const target = getFlag(parsed.flags, "target");
  if (!target) {
    throw new Error("repair-index requires --target=<core|full|bootstrap|file-search|identifier-search|full-artifacts>.");
  }
  const output = await repairPreparedIndex(rootDir, target as Parameters<typeof repairPreparedIndex>[1]);
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson({ root: rootDir, target, output });
    return;
  }
  process.stdout.write(`${output}\n`);
}

async function runStatusCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const limit = parseInteger(getFlag(parsed.flags, "limit"), 20);
  const status = await getRepoStatus(rootDir);
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson(status);
    return;
  }
  process.stdout.write(`${formatRepoStatusSummary(status, limit)}\n`);
}

async function runChangesCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const limit = parseInteger(getFlag(parsed.flags, "limit"), 20);
  const path = getFlag(parsed.flags, "path");
  const changes = await getRepoChanges(rootDir, { path, limit });
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson(changes);
    return;
  }
  process.stdout.write(`${formatRepoChangesSummary(changes, limit)}\n`);
}

async function runClusterCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const rendered = await semanticNavigate({
    rootDir,
    maxDepth: parseInteger(getFlag(parsed.flags, "max-depth"), 3),
    maxClusters: parseInteger(getFlag(parsed.flags, "max-clusters"), 20),
  });
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson({ root: rootDir, text: rendered });
    return;
  }
  process.stdout.write(`${rendered}\n`);
}

async function runHubsCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const rendered = await getFeatureHub({
    rootDir,
    hubPath: getFlag(parsed.flags, "hub-path"),
    featureName: getFlag(parsed.flags, "feature-name"),
    query: getFlag(parsed.flags, "query"),
    rankingMode: getFlag(parsed.flags, "ranking-mode") as "keyword" | "semantic" | "both" | undefined,
    showOrphans: hasFlag(parsed.flags, "show-orphans"),
  });
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson({ root: rootDir, text: rendered });
    return;
  }
  process.stdout.write(`${rendered}\n`);
}

async function runRestorePointsCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const points = await listRestorePoints(rootDir);
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson(points);
    return;
  }
  process.stdout.write(`${formatRestorePoints(points)}\n`);
}

async function runDoctorCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const report = await buildDoctorReport(rootDir);
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson(report);
    return;
  }
  process.stdout.write(`${formatDoctorReport(report)}\n`);
}

async function runBridgeCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) throw new Error("bridge requires a subcommand.");
  if (subcommand === "doctor") {
    await runDoctorCommand(rest, true);
    return;
  }
  if (subcommand === "status") {
    await runStatusCommand(rest, true);
    return;
  }
  if (subcommand === "changes") {
    await runChangesCommand(rest, true);
    return;
  }
  if (subcommand === "restore-points" || subcommand === "restore_points") {
    await runRestorePointsCommand(rest, true);
    return;
  }
  if (subcommand === "validate-index" || subcommand === "validate_index") {
    await runValidateIndexCommand(rest, true);
    return;
  }
  if (subcommand === "cluster") {
    await runClusterCommand(rest, true);
    return;
  }
  if (subcommand === "hubs" || subcommand === "find-hub") {
    await runHubsCommand(rest, true);
    return;
  }
  if (subcommand === "tree") {
    await runTreeCommand(rest.concat("--json"));
    return;
  }
  throw new Error(`Unsupported bridge subcommand "${subcommand}".`);
}

export async function handleCliCommand(args: string[]): Promise<boolean> {
  const [subcommand, ...rest] = args;
  if (!subcommand) return false;
  if (subcommand === "init") {
    await runInitCommand(rest);
    return true;
  }
  if (subcommand === "index") {
    await runIndexCommand(rest);
    return true;
  }
  if (subcommand === "tree") {
    await runTreeCommand(rest);
    return true;
  }
  if (subcommand === "skeleton") {
    await runSkeletonCommand(rest);
    return true;
  }
  if (subcommand === "validate-index" || subcommand === "validate_index") {
    await runValidateIndexCommand(rest, false);
    return true;
  }
  if (subcommand === "repair-index" || subcommand === "repair_index") {
    await runRepairIndexCommand(rest, false);
    return true;
  }
  if (subcommand === "status") {
    await runStatusCommand(rest, false);
    return true;
  }
  if (subcommand === "changes") {
    await runChangesCommand(rest, false);
    return true;
  }
  if (subcommand === "cluster") {
    await runClusterCommand(rest, false);
    return true;
  }
  if (subcommand === "hubs" || subcommand === "find-hub") {
    await runHubsCommand(rest, false);
    return true;
  }
  if (subcommand === "restore-points" || subcommand === "restore_points") {
    await runRestorePointsCommand(rest, false);
    return true;
  }
  if (subcommand === "doctor") {
    await runDoctorCommand(rest, false);
    return true;
  }
  if (subcommand === "bridge") {
    await runBridgeCommand(rest);
    return true;
  }
  return false;
}
