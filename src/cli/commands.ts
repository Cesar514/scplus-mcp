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

// Purpose: Initialize the MCP configuration file for the selected agent target and runner.
// Inputs: Raw CLI arguments containing the target selector and optional runner flags.
// Returns/Effects: Creates parent directories, writes the generated config file, and logs the output path.
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

// Purpose: Run the prepared-index command for the requested root and index mode.
// Inputs: Raw CLI arguments that may include root selection and mode flags.
// Returns/Effects: Executes the backend index flow and writes the textual result to stdout.
async function runIndexCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const targetRoot = resolveRoot(parsed);
  const requestedMode = getFlag(parsed.flags, "mode");
  const mode = requestedMode === undefined ? "auto" : normalizeIndexMode(requestedMode);
  process.stdout.write(`${await backendCore.index(targetRoot, mode)}\n`);
}

// Purpose: Render the context tree for the requested repository root using the selected output options.
// Inputs: Raw CLI arguments that control root resolution, headers-only mode, token budget, and JSON output.
// Returns/Effects: Computes the tree report and writes either JSON or plain text to stdout.
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

// Purpose: Render the public skeleton for a specific file within the selected repository root.
// Inputs: Raw CLI arguments containing the file path, optional root override, and JSON output flag.
// Returns/Effects: Resolves the target file, renders its skeleton, and writes JSON or plain text output.
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

// Purpose: Validate the prepared index for the selected repository root and print the resulting report.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Runs validation and writes either the raw report JSON or formatted text to stdout.
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

// Purpose: Repair a prepared-index stage for the selected repository root and print the repair output.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Executes the requested repair stage and writes JSON or plain text output to stdout.
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

// Purpose: Show the current git worktree status summary for the selected repository root.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Collects repository status and writes either JSON or a formatted summary to stdout.
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

// Purpose: Show the current git change summary for the selected repository root or path.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Collects repository change data and writes either JSON or a formatted summary to stdout.
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

// Purpose: Render semantic cluster navigation output for the selected repository root.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Runs semantic navigation and writes either JSON or plain text to stdout.
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

// Purpose: Refresh cluster artifacts through the backend core and print the resulting cluster text.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Executes cluster refresh and writes either the payload JSON or rendered text to stdout.
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

// Purpose: Render feature-hub output for the selected repository root using the requested filters.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Runs feature-hub resolution and writes either JSON or plain text to stdout.
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

// Purpose: List available shadow restore points for the selected repository root.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Loads restore points and writes either raw JSON or a formatted summary to stdout.
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

// Purpose: Build the diagnostic doctor report for the selected repository root and print it.
// Inputs: Raw CLI arguments plus a flag indicating whether JSON output is mandatory.
// Returns/Effects: Runs the doctor report builder and writes JSON or formatted text to stdout.
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

// Purpose: Attach prepared-index freshness metadata to a bridge payload before returning it.
// Inputs: The repository root and a payload object that should be extended with bridge metadata.
// Returns/Effects: Returns a new payload object containing the root and freshness header fields.
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

// Purpose: Write a single JSON frame to stdout for the persistent bridge protocol.
// Inputs: Any serializable bridge frame object ready to be emitted to the client.
// Returns/Effects: Resolves after the frame is written or rejects if stdout reports a write failure.
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

// Purpose: Assert that a bridge argument payload is a plain object before accessing its fields.
// Inputs: An unknown runtime value plus the error message to use if validation fails.
// Returns/Effects: Returns the value narrowed to a record or throws with the provided message.
function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

// Purpose: Assert that a bridge argument is a non-empty string.
// Inputs: An unknown runtime value plus the bridge argument name being validated.
// Returns/Effects: Returns the validated string or throws if the value is missing or blank.
function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Persistent bridge command requires string arg "${name}".`);
  }
  return value;
}

// Purpose: Assert that a bridge argument is a boolean.
// Inputs: An unknown runtime value plus the bridge argument name being validated.
// Returns/Effects: Returns the validated boolean or throws if the value is not boolean.
function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Persistent bridge command requires boolean arg "${name}".`);
  }
  return value;
}

// Purpose: Assert that an optional bridge argument is either undefined or a non-empty string.
// Inputs: An unknown runtime value plus the bridge argument name being validated.
// Returns/Effects: Returns undefined or the validated string, otherwise throws.
function assertOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return assertString(value, name);
}

// Purpose: Assert that an optional bridge argument is either undefined or a positive finite number.
// Inputs: An unknown runtime value plus the bridge argument name being validated.
// Returns/Effects: Returns undefined or the floored numeric value, otherwise throws.
function assertOptionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Persistent bridge command requires positive numeric arg "${name}".`);
  }
  return Math.floor(value);
}

// Purpose: Assert that an optional bridge argument is either undefined or a trimmed string array.
// Inputs: An unknown runtime value plus the bridge argument name being validated.
// Returns/Effects: Returns undefined or the trimmed string array, otherwise throws.
function assertOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Persistent bridge command requires string[] arg "${name}".`);
  }
  return value.map((entry) => entry.trim());
}

// Purpose: Assert that a bridge search intent uses one of the supported intent literals.
// Inputs: An unknown runtime value read from the bridge request payload.
// Returns/Effects: Returns the validated search intent or throws on unsupported values.
function assertSearchIntent(value: unknown): SearchIntent {
  if (value === "exact" || value === "related") return value;
  throw new Error(`Persistent bridge command received invalid intent "${String(value)}".`);
}

// Purpose: Assert that a bridge search type uses one of the supported entity-type literals.
// Inputs: An unknown runtime value read from the bridge request payload.
// Returns/Effects: Returns the validated search type or throws on unsupported values.
function assertSearchType(value: unknown): SearchEntityType {
  if (value === "file" || value === "symbol" || value === "mixed") return value;
  throw new Error(`Persistent bridge command received invalid searchType "${String(value)}".`);
}

// Purpose: Assert that an optional bridge retrieval mode uses one of the supported ranking literals.
// Inputs: An unknown runtime value read from the bridge request payload.
// Returns/Effects: Returns the validated retrieval mode or throws on unsupported values.
function assertRetrievalMode(value: unknown): RetrievalMode | undefined {
  if (value === undefined) return undefined;
  if (value === "semantic" || value === "keyword" || value === "both") return value;
  throw new Error(`Persistent bridge command received invalid retrievalMode "${String(value)}".`);
}

// Purpose: Normalize a bridge index mode to the supported CLI bridge literals.
// Inputs: An unknown runtime value read from the bridge request payload.
// Returns/Effects: Returns a normalized bridge mode or throws when the value is invalid.
function normalizeBridgeIndexMode(value: unknown): "auto" | "core" | "full" {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "core" || value === "full") return value;
  throw new Error(`Persistent bridge command received invalid mode "${String(value)}".`);
}

// Purpose: Normalize a prepared-index validation mode to the supported prepared-index literals.
// Inputs: An unknown runtime value read from the bridge request payload.
// Returns/Effects: Returns a normalized prepared-index mode or throws when the value is invalid.
function normalizePreparedIndexMode(value: unknown): "core" | "full" {
  if (value === undefined) return DEFAULT_INDEX_MODE;
  if (value === "core" || value === "full") return value;
  throw new Error(`Persistent bridge command received invalid mode "${String(value)}".`);
}

// Purpose: Normalize an optional debounce duration passed through the bridge request payload.
// Inputs: An unknown runtime value read from the bridge request payload.
// Returns/Effects: Returns undefined or a floored debounce interval, otherwise throws.
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

type BridgeCommandHandler = (rawArgs: Record<string, unknown>) => Promise<unknown> | unknown;

const BRIDGE_COMMAND_HANDLERS: Record<string, BridgeCommandHandler> = {
  doctor: (rawArgs) => bridgeServiceCore.doctor(assertString(rawArgs.root, "root")),
  tree: (rawArgs) => bridgeServiceCore.tree(assertString(rawArgs.root, "root")),
  hubs: async (rawArgs) => {
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
  },
  "find-hub": async (rawArgs) => BRIDGE_COMMAND_HANDLERS.hubs(rawArgs),
  cluster: (rawArgs) => bridgeServiceCore.refreshClusters(assertString(rawArgs.root, "root")),
  "view-clusters": async (rawArgs) => {
    const root = assertString(rawArgs.root, "root");
    const rendered = await semanticNavigate({
      rootDir: root,
      maxDepth: assertOptionalPositiveNumber(rawArgs.maxDepth, "maxDepth"),
      maxClusters: assertOptionalPositiveNumber(rawArgs.maxClusters, "maxClusters"),
    });
    return { root, text: rendered };
  },
  "restore-points": (rawArgs) => bridgeServiceCore.restorePoints(assertString(rawArgs.root, "root")),
  index: async (rawArgs) => ({
    output: await bridgeServiceCore.index(assertString(rawArgs.root, "root"), normalizeBridgeIndexMode(rawArgs.mode)),
  }),
  "job-control": (rawArgs) => bridgeServiceCore.controlJob(assertString(rawArgs.root, "root"), assertJobControlAction(rawArgs.action)),
  status: (rawArgs) => getRepoStatus(assertString(rawArgs.root, "root")),
  changes: (rawArgs) => getRepoChanges(assertString(rawArgs.root, "root"), {
    path: assertOptionalString(rawArgs.path, "path"),
    limit: assertOptionalPositiveNumber(rawArgs.limit, "limit"),
  }),
  "validate-index": (rawArgs) => validatePreparedIndex({
    rootDir: assertString(rawArgs.root, "root"),
    mode: normalizePreparedIndexMode(rawArgs.mode),
  }),
  "repair-index": async (rawArgs) => {
    const target = assertString(rawArgs.target, "target");
    return {
      root: assertString(rawArgs.root, "root"),
      target,
      output: await repairPreparedIndex(assertString(rawArgs.root, "root"), target as Parameters<typeof repairPreparedIndex>[1]),
    };
  },
  symbol: async (rawArgs) => {
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
  },
  word: async (rawArgs) => {
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
  },
  outline: async (rawArgs) => {
    const root = assertString(rawArgs.root, "root");
    const filePath = assertString(rawArgs.filePath, "filePath");
    const outline = await getOutline(root, filePath);
    return buildPreparedBridgePayload(root, {
      filePath,
      outline,
      text: formatOutline(outline),
    });
  },
  deps: async (rawArgs) => {
    const root = assertString(rawArgs.root, "root");
    const target = assertString(rawArgs.target, "target");
    const dependencyInfo = await getDependencyInfo(root, target);
    return buildPreparedBridgePayload(root, {
      target,
      dependencyInfo,
      text: formatDependencyInfo(dependencyInfo),
    });
  },
  search: async (rawArgs) => {
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
  },
  research: async (rawArgs) => {
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
  },
  lint: async (rawArgs) => {
    const root = assertString(rawArgs.root, "root");
    const targetPath = assertOptionalString(rawArgs.targetPath, "targetPath");
    const report = await buildStaticAnalysisReport({ rootDir: root, targetPath });
    return {
      root,
      targetPath,
      report,
      text: formatStaticAnalysisReport(report),
    };
  },
  "blast-radius": async (rawArgs) => {
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
  },
  checkpoint: async (rawArgs) => {
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
  },
  restore: async (rawArgs) => {
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
  },
  "watch-set": (rawArgs) => bridgeServiceCore.setWatchEnabled(
    assertString(rawArgs.root, "root"),
    assertBoolean(rawArgs.enabled, "enabled"),
    normalizeDebounceMs(rawArgs.debounceMs),
  ),
  shutdown: () => ({ shuttingDown: true }),
};

// Purpose: Execute one shared bridge command against the registered bridge handler table.
// Inputs: The requested bridge command name plus its already-validated object arguments.
// Returns/Effects: Invokes the matching bridge handler or throws when the command is unsupported.
async function executeSharedBridgeCommand(command: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const normalizedCommand = normalizeBridgeCommand(command);
  if (Object.prototype.hasOwnProperty.call(BRIDGE_COMMAND_HANDLERS, normalizedCommand)) {
    const handler = BRIDGE_COMMAND_HANDLERS[normalizedCommand];
    if (handler) {
      return handler(rawArgs);
    }
  }
  throw new Error(`Unsupported bridge command "${command}".`);
}

// Purpose: Normalize an untyped persistent bridge payload and dispatch it through the shared bridge handlers.
// Inputs: The requested bridge command name plus the raw unknown argument payload from stdin.
// Returns/Effects: Validates the payload shape and returns the executed bridge command result.
async function executePersistentBridgeCommand(command: string, rawArgs: unknown): Promise<unknown> {
  const args = rawArgs === undefined ? {} : assertObject(rawArgs, "Persistent bridge args must be an object.");
  return executeSharedBridgeCommand(command, args);
}

// Purpose: Parse and validate one JSON line from the persistent bridge protocol input stream.
// Inputs: The raw newline-delimited JSON request line received on stdin.
// Returns/Effects: Returns a validated bridge request object or throws a protocol error.
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

// Purpose: Run the long-lived stdin/stdout bridge server protocol for repeated CLI bridge requests.
// Inputs: No direct inputs beyond process stdin and the shared bridge backend core.
// Returns/Effects: Streams requests from stdin, emits bridge responses, and closes backend state on shutdown.
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

// Purpose: Handle bridge subcommands that reuse the human CLI command printers with forced JSON output.
// Inputs: The raw bridge subcommand plus the remaining CLI arguments for that subcommand.
// Returns/Effects: Runs a direct command handler and returns whether the subcommand was handled.
async function handleDirectBridgeCommand(subcommand: string, rest: string[]): Promise<boolean> {
  if (subcommand === "doctor") {
    await runDoctorCommand(rest, true);
    return true;
  }
  if (subcommand === "status") {
    await runStatusCommand(rest, true);
    return true;
  }
  if (subcommand === "changes") {
    await runChangesCommand(rest, true);
    return true;
  }
  if (subcommand === "restore-points" || subcommand === "restore_points") {
    await runRestorePointsCommand(rest, true);
    return true;
  }
  if (subcommand === "validate-index" || subcommand === "validate_index") {
    await runValidateIndexCommand(rest, true);
    return true;
  }
  if (subcommand === "cluster") {
    await runClusterCommand(rest, true);
    return true;
  }
  if (subcommand === "view-clusters") {
    await runViewClustersCommand(rest, true);
    return true;
  }
  if (subcommand === "hubs" || subcommand === "find-hub") {
    await runHubsCommand(rest, true);
    return true;
  }
  if (subcommand === "tree") {
    await runTreeCommand(rest.concat("--json"));
    return true;
  }
  return false;
}

// Purpose: Handle structured bridge subcommands that dispatch into shared bridge command handlers.
// Inputs: The normalized bridge subcommand, resolved root directory, and parsed CLI argument structure.
// Returns/Effects: Validates per-command arguments, writes JSON responses, or throws on unsupported commands.
async function handleSharedBridgeCommand(
  normalizedSubcommand: string,
  rootDir: string,
  parsed: ReturnType<typeof parseArgs>
): Promise<void> {
  const { flags, positionals } = parsed;

  if (normalizedSubcommand === "symbol") {
    const query = getFlag(flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge symbol requires a query argument.");
    writeJson(await executeSharedBridgeCommand("symbol", {
      root: rootDir,
      query,
      topK: parseInteger(getFlag(flags, "top-k"), 10),
    }));
    return;
  }
  if (normalizedSubcommand === "word") {
    const query = getFlag(flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge word requires a query argument.");
    writeJson(await executeSharedBridgeCommand("word", {
      root: rootDir,
      query,
      topK: parseInteger(getFlag(flags, "top-k"), 10),
    }));
    return;
  }
  if (normalizedSubcommand === "outline") {
    const filePath = getFlag(flags, "file-path") ?? positionals[0];
    if (!filePath) throw new Error("bridge outline requires a file path argument.");
    writeJson(await executeSharedBridgeCommand("outline", {
      root: rootDir,
      filePath,
    }));
    return;
  }
  if (normalizedSubcommand === "deps") {
    const target = getFlag(flags, "target") ?? positionals[0];
    if (!target) throw new Error("bridge deps requires a target path argument.");
    writeJson(await executeSharedBridgeCommand("deps", {
      root: rootDir,
      target,
    }));
    return;
  }
  if (normalizedSubcommand === "search") {
    const query = getFlag(flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge search requires a query argument.");
    writeJson(await executeSharedBridgeCommand("search", {
      root: rootDir,
      intent: parseBridgeSearchIntent(getFlag(flags, "intent")),
      searchType: parseBridgeSearchType(getFlag(flags, "search-type")),
      query,
      retrievalMode: parseBridgeRetrievalMode(getFlag(flags, "retrieval-mode")),
      topK: parseInteger(getFlag(flags, "top-k"), 5),
      includeKinds: parseStringList(getFlag(flags, "include-kinds")),
    }));
    return;
  }
  if (normalizedSubcommand === "research") {
    const query = getFlag(flags, "query") ?? positionals[0];
    if (!query) throw new Error("bridge research requires a query argument.");
    writeJson(await executeSharedBridgeCommand("research", {
      root: rootDir,
      query,
      topK: parseInteger(getFlag(flags, "top-k"), 5),
      includeKinds: parseStringList(getFlag(flags, "include-kinds")),
      maxRelated: getFlag(flags, "max-related") ? parseInteger(getFlag(flags, "max-related"), 6) : undefined,
      maxSubsystems: getFlag(flags, "max-subsystems") ? parseInteger(getFlag(flags, "max-subsystems"), 3) : undefined,
      maxHubs: getFlag(flags, "max-hubs") ? parseInteger(getFlag(flags, "max-hubs"), 4) : undefined,
    }));
    return;
  }
  if (normalizedSubcommand === "lint") {
    writeJson(await executeSharedBridgeCommand("lint", {
      root: rootDir,
      targetPath: getFlag(flags, "target-path") ?? positionals[0],
    }));
    return;
  }
  if (normalizedSubcommand === "blast-radius") {
    const symbolName = getFlag(flags, "symbol-name") ?? positionals[0];
    if (!symbolName) throw new Error("bridge blast-radius requires a symbol name argument.");
    writeJson(await executeSharedBridgeCommand("blast-radius", {
      root: rootDir,
      symbolName,
      fileContext: getFlag(flags, "file-context"),
    }));
    return;
  }
  if (normalizedSubcommand === "checkpoint") {
    const filePath = getFlag(flags, "file-path") ?? positionals[0];
    const newContent = getFlag(flags, "new-content");
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
    const pointId = getFlag(flags, "point-id") ?? positionals[0];
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
      mode: normalizeIndexMode(getFlag(flags, "mode")),
    }));
    return;
  }
  if (normalizedSubcommand === "repair-index") {
    const target = getFlag(flags, "target");
    if (!target) throw new Error("bridge repair-index requires --target.");
    writeJson(await executeSharedBridgeCommand("repair-index", {
      root: rootDir,
      target,
    }));
    return;
  }

  throw new Error(`Unsupported bridge subcommand "${normalizedSubcommand}".`);
}

// Purpose: Route the top-level `bridge` CLI command onto direct or shared bridge subcommand handlers.
// Inputs: Raw CLI arguments beginning with the bridge subcommand and its remaining flags.
// Returns/Effects: Dispatches the selected bridge workflow and writes any bridge output to stdout.
async function runBridgeCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) throw new Error("bridge requires a subcommand.");

  if (await handleDirectBridgeCommand(subcommand, rest)) {
    return;
  }

  const normalizedSubcommand = normalizeBridgeCommand(subcommand);
  const parsed = parseArgs(rest);
  const rootDir = resolve(getFlag(parsed.flags, "root") ?? process.cwd());

  await handleSharedBridgeCommand(normalizedSubcommand, rootDir, parsed);
}

// Purpose: Route the top-level CLI argument vector onto the matching human or bridge subcommand.
// Inputs: Raw CLI arguments beginning with the optional subcommand name and its flags.
// Returns/Effects: Executes the selected CLI handler and returns whether a known subcommand was handled.
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
