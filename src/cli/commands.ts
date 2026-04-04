// summary: Routes human CLI subcommands onto backend actions and bridge payload handling.
// FEATURE: Human terminal interface subcommands for scplus operator workflows.
// inputs: Parsed CLI arguments, bridge parameters, and operator command requests.
// outputs: Invoked backend workflows and terminal-facing command results.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  buildInitConfig,
  formatDoctorReport,
  formatRestorePoints,
  getFlag,
  hasFlag,
  normalizeIndexMode,
  parseAgentTarget,
  parseArgs,
  parseBridgeRetrievalMode,
  parseBridgeSearchIntent,
  parseBridgeSearchType,
  parseInteger,
  parseRunner,
  parseStringList,
  resolveRoot,
} from "./command-utils.js";
import { getContextTree } from "../tools/context-tree.js";
import { getFileSkeleton } from "../tools/file-skeleton.js";
import {
  formatDependencyInfo,
  formatExactSymbolResults,
  formatRepoStatusSummary,
  formatOutline,
  formatPathCandidates,
  formatRepoChangesSummary,
  formatWordMatches,
  getDependencyInfo,
  getOutline,
  getRepoChanges,
  getRepoStatus,
  lookupExactSymbol,
  lookupWord,
} from "../tools/exact-query.js";
import { getFeatureHub } from "../tools/feature-hub.js";
import { listRestorePoints, restorePoint } from "../git/shadow.js";
import { semanticNavigate } from "../tools/semantic-navigate.js";
import { DEFAULT_INDEX_MODE } from "../tools/index-contract.js";
import { formatIndexValidationReport, repairPreparedIndex, validatePreparedIndex } from "../tools/index-reliability.js";
import { createBackendCore } from "./backend-core.js";
import { buildSearchByIntentReport, type SearchEntityType, type SearchIntent } from "../tools/query-intent.js";
import { buildResearchReport, formatResearchReport } from "../tools/research.js";
import { buildBlastRadiusReport, formatBlastRadiusReport } from "../tools/blast-radius.js";
import { buildStaticAnalysisReport, formatStaticAnalysisReport } from "../tools/static-analysis.js";
import { buildCheckpointReport, formatCheckpointReport } from "../tools/propose-commit.js";
import { formatPreparedIndexFreshnessHeader } from "../tools/write-freshness.js";
import { buildDoctorReport } from "./reports.js";
import type { RetrievalMode } from "../tools/unified-ranking.js";

// Persistent CLI bridge protocol:
// request  => {"type":"request","id":number,"command":string,"args":object}
// response => {"type":"response","id":number,"ok":boolean,"result"?:unknown,"error"?:string}
// event    => {"type":"event","kind":"log"|"job"|"watch-batch"|"watch-state", ...eventFields}
interface BridgeServeRequest {
  type: "request";
  id: number;
  command: string;
  args?: Record<string, unknown>;
}

interface BridgeServeResponse {
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const CLI_SUBCOMMANDS = new Set([
  "bridge",
  "bridge-serve",
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
  "view-clusters",
]);

const backendCore = createBackendCore();
const bridgeServiceCore = createBackendCore(async (event) => {
  await writeBridgeFrame({
    type: "event",
    ...event,
  });
});

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInitCommand(args: string[]): Promise<void> {
  const nonFlags = args.filter((arg) => !arg.startsWith("--"));
  const target = parseAgentTarget(nonFlags[0]);
  const runner = parseRunner(args);
  const { content, outputPath } = buildInitConfig(target, runner);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${content}\n`, "utf8");
  console.error(`scplus-mcp initialized for ${target} using ${runner}.`);
  console.error(`Wrote MCP config: ${outputPath}`);
}

async function runIndexCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const targetRoot = resolveRoot(parsed);
  const requestedMode = getFlag(parsed.flags, "mode");
  const mode = requestedMode === undefined ? "auto" : normalizeIndexMode(requestedMode);
  process.stdout.write(`${await backendCore.index(targetRoot, mode)}\n`);
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

async function runViewClustersCommand(args: string[], forceJson: boolean): Promise<void> {
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

async function runClusterCommand(args: string[], forceJson: boolean): Promise<void> {
  const parsed = parseArgs(args);
  const rootDir = resolveRoot(parsed);
  const payload = await backendCore.refreshClusters(rootDir);
  if (forceJson || hasFlag(parsed.flags, "json")) {
    writeJson(payload);
    return;
  }
  process.stdout.write(`${payload.text}\n`);
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

async function buildPreparedBridgePayload<TPayload extends object>(
  rootDir: string,
  payload: TPayload,
): Promise<TPayload & { root: string; freshnessHeader: string }> {
  return {
    root: rootDir,
    freshnessHeader: await formatPreparedIndexFreshnessHeader(rootDir),
    ...payload,
  };
}

async function writeBridgeFrame(frame: unknown): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Persistent bridge command requires string arg "${name}".`);
  }
  return value;
}

function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Persistent bridge command requires boolean arg "${name}".`);
  }
  return value;
}

function assertOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return assertString(value, name);
}

function assertOptionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Persistent bridge command requires positive numeric arg "${name}".`);
  }
  return Math.floor(value);
}

function assertOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Persistent bridge command requires string[] arg "${name}".`);
  }
  return value.map((entry) => entry.trim());
}

function assertSearchIntent(value: unknown): SearchIntent {
  if (value === "exact" || value === "related") return value;
  throw new Error(`Persistent bridge command received invalid intent "${String(value)}".`);
}

function assertSearchType(value: unknown): SearchEntityType {
  if (value === "file" || value === "symbol" || value === "mixed") return value;
  throw new Error(`Persistent bridge command received invalid searchType "${String(value)}".`);
}

function assertRetrievalMode(value: unknown): RetrievalMode | undefined {
  if (value === undefined) return undefined;
  if (value === "semantic" || value === "keyword" || value === "both") return value;
  throw new Error(`Persistent bridge command received invalid retrievalMode "${String(value)}".`);
}

function normalizeBridgeIndexMode(value: unknown): "auto" | "core" | "full" {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "core" || value === "full") return value;
  throw new Error(`Persistent bridge command received invalid mode "${String(value)}".`);
}

function normalizePreparedIndexMode(value: unknown): "core" | "full" {
  if (value === undefined) return DEFAULT_INDEX_MODE;
  if (value === "core" || value === "full") return value;
  throw new Error(`Persistent bridge command received invalid mode "${String(value)}".`);
}

function normalizeDebounceMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Persistent bridge command received invalid debounceMs "${String(value)}".`);
  }
  return Math.floor(value);
}

function assertJobControlAction(value: unknown): "cancel-pending" | "retry-last" | "supersede-pending" {
  if (value === "cancel-pending" || value === "retry-last" || value === "supersede-pending") return value;
  throw new Error(`Persistent bridge command received invalid job action "${String(value)}".`);
}

function normalizeBridgeCommand(command: string): string {
  return command.replace(/_/g, "-");
}

async function executeSharedBridgeCommand(command: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const normalizedCommand = normalizeBridgeCommand(command);
  if (normalizedCommand === "doctor") {
    return bridgeServiceCore.doctor(assertString(rawArgs.root, "root"));
  }
  if (normalizedCommand === "tree") {
    return bridgeServiceCore.tree(assertString(rawArgs.root, "root"));
  }
  if (normalizedCommand === "hubs" || normalizedCommand === "find-hub") {
    const root = assertString(rawArgs.root, "root");
    const rendered = await getFeatureHub({
      rootDir: root,
      hubPath: assertOptionalString(rawArgs.hubPath, "hubPath"),
      featureName: assertOptionalString(rawArgs.featureName, "featureName"),
      query: assertOptionalString(rawArgs.query, "query"),
      rankingMode: assertRetrievalMode(rawArgs.rankingMode),
      showOrphans: rawArgs.showOrphans === undefined ? false : assertBoolean(rawArgs.showOrphans, "showOrphans"),
    });
    return { root, text: rendered };
  }
  if (normalizedCommand === "cluster") {
    return bridgeServiceCore.refreshClusters(assertString(rawArgs.root, "root"));
  }
  if (normalizedCommand === "view-clusters") {
    const root = assertString(rawArgs.root, "root");
    const rendered = await semanticNavigate({
      rootDir: root,
      maxDepth: assertOptionalPositiveNumber(rawArgs.maxDepth, "maxDepth"),
      maxClusters: assertOptionalPositiveNumber(rawArgs.maxClusters, "maxClusters"),
    });
    return { root, text: rendered };
  }
  if (normalizedCommand === "restore-points") {
    return bridgeServiceCore.restorePoints(assertString(rawArgs.root, "root"));
  }
  if (normalizedCommand === "index") {
    return {
      output: await bridgeServiceCore.index(assertString(rawArgs.root, "root"), normalizeBridgeIndexMode(rawArgs.mode)),
    };
  }
  if (normalizedCommand === "job-control") {
    return bridgeServiceCore.controlJob(assertString(rawArgs.root, "root"), assertJobControlAction(rawArgs.action));
  }
  if (normalizedCommand === "status") {
    return getRepoStatus(assertString(rawArgs.root, "root"));
  }
  if (normalizedCommand === "changes") {
    return getRepoChanges(assertString(rawArgs.root, "root"), {
      path: assertOptionalString(rawArgs.path, "path"),
      limit: assertOptionalPositiveNumber(rawArgs.limit, "limit"),
    });
  }
  if (normalizedCommand === "validate-index") {
    return validatePreparedIndex({
      rootDir: assertString(rawArgs.root, "root"),
      mode: normalizePreparedIndexMode(rawArgs.mode),
    });
  }
  if (normalizedCommand === "repair-index") {
    const target = assertString(rawArgs.target, "target");
    return {
      root: assertString(rawArgs.root, "root"),
      target,
      output: await repairPreparedIndex(assertString(rawArgs.root, "root"), target as Parameters<typeof repairPreparedIndex>[1]),
    };
  }
  if (normalizedCommand === "symbol") {
    const root = assertString(rawArgs.root, "root");
    const query = assertString(rawArgs.query, "query");
    const topK = assertOptionalPositiveNumber(rawArgs.topK, "topK") ?? 10;
    const hits = await lookupExactSymbol(root, query, topK);
    return buildPreparedBridgePayload(root, {
      query,
      topK,
      hits,
      text: formatExactSymbolResults(query, hits),
    });
  }
  if (normalizedCommand === "word") {
    const root = assertString(rawArgs.root, "root");
    const query = assertString(rawArgs.query, "query");
    const topK = assertOptionalPositiveNumber(rawArgs.topK, "topK") ?? 10;
    const hits = await lookupWord(root, query, topK);
    return buildPreparedBridgePayload(root, {
      query,
      topK,
      hits,
      text: formatWordMatches(query, hits),
    });
  }
  if (normalizedCommand === "outline") {
    const root = assertString(rawArgs.root, "root");
    const filePath = assertString(rawArgs.filePath, "filePath");
    const outline = await getOutline(root, filePath);
    return buildPreparedBridgePayload(root, {
      filePath,
      outline,
      text: formatOutline(outline),
    });
  }
  if (normalizedCommand === "deps") {
    const root = assertString(rawArgs.root, "root");
    const target = assertString(rawArgs.target, "target");
    const dependencyInfo = await getDependencyInfo(root, target);
    return buildPreparedBridgePayload(root, {
      target,
      dependencyInfo,
      text: formatDependencyInfo(dependencyInfo),
    });
  }
  if (normalizedCommand === "search") {
    const root = assertString(rawArgs.root, "root");
    const report = await buildSearchByIntentReport({
      rootDir: root,
      intent: assertSearchIntent(rawArgs.intent),
      searchType: assertSearchType(rawArgs.searchType),
      query: assertString(rawArgs.query, "query"),
      retrievalMode: assertRetrievalMode(rawArgs.retrievalMode),
      topK: assertOptionalPositiveNumber(rawArgs.topK, "topK"),
      includeKinds: assertOptionalStringArray(rawArgs.includeKinds, "includeKinds"),
    });
    return buildPreparedBridgePayload(root, report);
  }
  if (normalizedCommand === "research") {
    const root = assertString(rawArgs.root, "root");
    const query = assertString(rawArgs.query, "query");
    const report = await buildResearchReport({
      rootDir: root,
      query,
      topK: assertOptionalPositiveNumber(rawArgs.topK, "topK"),
      includeKinds: assertOptionalStringArray(rawArgs.includeKinds, "includeKinds"),
      maxRelated: assertOptionalPositiveNumber(rawArgs.maxRelated, "maxRelated"),
      maxSubsystems: assertOptionalPositiveNumber(rawArgs.maxSubsystems, "maxSubsystems"),
      maxHubs: assertOptionalPositiveNumber(rawArgs.maxHubs, "maxHubs"),
    });
    return buildPreparedBridgePayload(root, {
      query,
      report,
      text: formatResearchReport(report),
    });
  }
  if (normalizedCommand === "lint") {
    const root = assertString(rawArgs.root, "root");
    const targetPath = assertOptionalString(rawArgs.targetPath, "targetPath");
    const report = await buildStaticAnalysisReport({ rootDir: root, targetPath });
    return {
      root,
      targetPath,
      report,
      text: formatStaticAnalysisReport(report),
    };
  }
  if (normalizedCommand === "blast-radius") {
    const root = assertString(rawArgs.root, "root");
    const symbolName = assertString(rawArgs.symbolName, "symbolName");
    const fileContext = assertOptionalString(rawArgs.fileContext, "fileContext");
    const report = await buildBlastRadiusReport({ rootDir: root, symbolName, fileContext });
    return {
      root,
      symbolName,
      fileContext,
      report,
      text: formatBlastRadiusReport(report),
    };
  }
  if (normalizedCommand === "checkpoint") {
    const root = assertString(rawArgs.root, "root");
    const filePath = assertString(rawArgs.filePath, "filePath");
    const report = await buildCheckpointReport({
      rootDir: root,
      filePath,
      newContent: assertString(rawArgs.newContent, "newContent"),
    });
    return {
      root,
      filePath,
      report,
      text: formatCheckpointReport(report),
    };
  }
  if (normalizedCommand === "restore") {
    const root = assertString(rawArgs.root, "root");
    const pointId = assertString(rawArgs.pointId, "pointId");
    const restoredFiles = await restorePoint(root, pointId);
    return {
      root,
      pointId,
      restoredFiles,
      text: restoredFiles.length > 0
        ? `Restored ${restoredFiles.length} file(s):\n${restoredFiles.join("\n")}`
        : "No files were restored. The backup may be empty.",
    };
  }
  if (normalizedCommand === "watch-set") {
    return bridgeServiceCore.setWatchEnabled(
      assertString(rawArgs.root, "root"),
      assertBoolean(rawArgs.enabled, "enabled"),
      normalizeDebounceMs(rawArgs.debounceMs),
    );
  }
  if (normalizedCommand === "shutdown") {
    return { shuttingDown: true };
  }
  throw new Error(`Unsupported bridge command "${command}".`);
}

async function executePersistentBridgeCommand(command: string, rawArgs: unknown): Promise<unknown> {
  const args = rawArgs === undefined ? {} : assertObject(rawArgs, "Persistent bridge args must be an object.");
  return executeSharedBridgeCommand(command, args);
}

function parseBridgeServeRequest(line: string): BridgeServeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Persistent bridge received invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const request = assertObject(parsed, "Persistent bridge request must be an object.");
  if (request.type !== "request") {
    throw new Error(`Persistent bridge request type must be "request", got "${String(request.type)}".`);
  }
  if (typeof request.id !== "number" || !Number.isFinite(request.id)) {
    throw new Error("Persistent bridge request requires numeric field \"id\".");
  }
  if (typeof request.command !== "string" || request.command.trim() === "") {
    throw new Error("Persistent bridge request requires string field \"command\".");
  }
  return {
    type: "request",
    id: request.id,
    command: request.command,
    args: request.args === undefined ? undefined : assertObject(request.args, "Persistent bridge args must be an object."),
  };
}

async function runBridgeServeCommand(): Promise<void> {
  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let shuttingDown = false;
  const inFlight = new Set<Promise<void>>();

  const startRequest = (request: BridgeServeRequest): void => {
    const task = (async () => {
      try {
        const result = await executePersistentBridgeCommand(request.command, request.args);
        const response: BridgeServeResponse = {
          type: "response",
          id: request.id,
          ok: true,
          result,
        };
        await writeBridgeFrame(response);
        if (request.command === "shutdown") {
          shuttingDown = true;
          input.close();
        }
      } catch (error) {
        const response: BridgeServeResponse = {
          type: "response",
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        await writeBridgeFrame(response);
      }
    })();
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  };

  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      if (shuttingDown) {
        throw new Error("Persistent bridge received a request after shutdown started.");
      }
      startRequest(parseBridgeServeRequest(line));
    }
  } finally {
    await Promise.allSettled(inFlight);
    await bridgeServiceCore.close();
  }
}

async function runBridgeCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) throw new Error("bridge requires a subcommand.");
  const normalizedSubcommand = normalizeBridgeCommand(subcommand);
  const parsed = parseArgs(rest);
  const rootDir = resolve(getFlag(parsed.flags, "root") ?? process.cwd());
  const positionals = parsed.positionals;
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
  if (subcommand === "view-clusters") {
    await runViewClustersCommand(rest, true);
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
  if (normalizedSubcommand === "symbol") {
    const query = getFlag(parsed.flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge symbol requires a query argument.");
    writeJson(await executeSharedBridgeCommand("symbol", {
      root: rootDir,
      query,
      topK: parseInteger(getFlag(parsed.flags, "top-k"), 10),
    }));
    return;
  }
  if (normalizedSubcommand === "word") {
    const query = getFlag(parsed.flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge word requires a query argument.");
    writeJson(await executeSharedBridgeCommand("word", {
      root: rootDir,
      query,
      topK: parseInteger(getFlag(parsed.flags, "top-k"), 10),
    }));
    return;
  }
  if (normalizedSubcommand === "outline") {
    const filePath = getFlag(parsed.flags, "file-path") ?? positionals[0];
    if (!filePath) throw new Error("bridge outline requires a file path argument.");
    writeJson(await executeSharedBridgeCommand("outline", {
      root: rootDir,
      filePath,
    }));
    return;
  }
  if (normalizedSubcommand === "deps") {
    const target = getFlag(parsed.flags, "target") ?? positionals[0];
    if (!target) throw new Error("bridge deps requires a target path argument.");
    writeJson(await executeSharedBridgeCommand("deps", {
      root: rootDir,
      target,
    }));
    return;
  }
  if (normalizedSubcommand === "search") {
    const query = getFlag(parsed.flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge search requires a query argument.");
    writeJson(await executeSharedBridgeCommand("search", {
      root: rootDir,
      intent: parseBridgeSearchIntent(getFlag(parsed.flags, "intent")),
      searchType: parseBridgeSearchType(getFlag(parsed.flags, "search-type")),
      query,
      retrievalMode: parseBridgeRetrievalMode(getFlag(parsed.flags, "retrieval-mode")),
      topK: parseInteger(getFlag(parsed.flags, "top-k"), 5),
      includeKinds: parseStringList(getFlag(parsed.flags, "include-kinds")),
    }));
    return;
  }
  if (normalizedSubcommand === "research") {
    const query = getFlag(parsed.flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge research requires a query argument.");
    writeJson(await executeSharedBridgeCommand("research", {
      root: rootDir,
      query,
      topK: parseInteger(getFlag(parsed.flags, "top-k"), 5),
      includeKinds: parseStringList(getFlag(parsed.flags, "include-kinds")),
      maxRelated: getFlag(parsed.flags, "max-related") ? parseInteger(getFlag(parsed.flags, "max-related"), 6) : undefined,
      maxSubsystems: getFlag(parsed.flags, "max-subsystems") ? parseInteger(getFlag(parsed.flags, "max-subsystems"), 3) : undefined,
      maxHubs: getFlag(parsed.flags, "max-hubs") ? parseInteger(getFlag(parsed.flags, "max-hubs"), 4) : undefined,
    }));
    return;
  }
  if (normalizedSubcommand === "lint") {
    writeJson(await executeSharedBridgeCommand("lint", {
      root: rootDir,
      targetPath: getFlag(parsed.flags, "target-path") ?? positionals[0],
    }));
    return;
  }
  if (normalizedSubcommand === "blast-radius") {
    const symbolName = getFlag(parsed.flags, "symbol-name") ?? positionals[0];
    if (!symbolName) throw new Error("bridge blast-radius requires a symbol name argument.");
    writeJson(await executeSharedBridgeCommand("blast-radius", {
      root: rootDir,
      symbolName,
      fileContext: getFlag(parsed.flags, "file-context"),
    }));
    return;
  }
  if (normalizedSubcommand === "checkpoint") {
    const filePath = getFlag(parsed.flags, "file-path") ?? positionals[0];
    const newContent = getFlag(parsed.flags, "new-content");
    if (!filePath) throw new Error("bridge checkpoint requires a file path argument.");
    if (!newContent) throw new Error("bridge checkpoint requires --new-content.");
    writeJson(await executeSharedBridgeCommand("checkpoint", {
      root: rootDir,
      filePath,
      newContent,
    }));
    return;
  }
  if (normalizedSubcommand === "restore") {
    const pointId = getFlag(parsed.flags, "point-id") ?? positionals[0];
    if (!pointId) throw new Error("bridge restore requires a restore point id.");
    writeJson(await executeSharedBridgeCommand("restore", {
      root: rootDir,
      pointId,
    }));
    return;
  }
  if (normalizedSubcommand === "validate-index") {
    writeJson(await executeSharedBridgeCommand("validate-index", {
      root: rootDir,
      mode: normalizeIndexMode(getFlag(parsed.flags, "mode")),
    }));
    return;
  }
  if (normalizedSubcommand === "repair-index") {
    const target = getFlag(parsed.flags, "target");
    if (!target) throw new Error("bridge repair-index requires --target.");
    writeJson(await executeSharedBridgeCommand("repair-index", {
      root: rootDir,
      target,
    }));
    return;
  }
  throw new Error(`Unsupported bridge subcommand "${subcommand}".`);
}

export async function handleCliCommand(args: string[]): Promise<boolean> {
  const [subcommand, ...rest] = args;
  if (!subcommand) return false;
  if (subcommand === "bridge-serve") {
    await runBridgeServeCommand();
    return true;
  }
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
  if (subcommand === "view-clusters") {
    await runViewClustersCommand(rest, false);
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
