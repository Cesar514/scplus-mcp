// summary: Validates and repairs prepared index generations over durable sqlite-backed artifacts.
// FEATURE: Crash-only reliability checks and repair flows for prepared indexes.
// inputs: Active generations, artifact manifests, validation requests, and repair targets.
// outputs: Validation reports, repair outcomes, and generation health metadata.

import { INDEX_DATABASE_SCHEMA_VERSION, inspectIndexDatabase, loadIndexArtifact, loadIndexServingState, type IndexArtifactKey } from "../core/index-database.js";
import { indexCodebase } from "./index-codebase.js";
import { buildIndexContract, getStageDefinitions, INDEX_ARTIFACT_VERSION, type FileManifest, type FullArtifactManifest, type IndexMode, type IndexStageName, type PersistedIndexStageState, type ProjectIndexConfig } from "./index-contract.js";
import { createIndexRuntime, loadIndexStatus } from "./index-stages.js";

export type IndexRepairTarget = IndexStageName | "core" | "full";

export interface IndexValidationIssue {
  code: string;
  message: string;
}

export interface IndexValidationReport {
  ok: boolean;
  mode: IndexMode;
  generation: number;
  activeGeneration: number;
  pendingGeneration: number | null;
  latestGeneration: number;
  activeGenerationValidatedAt?: string;
  activeGenerationFreshness: "fresh" | "dirty" | "blocked";
  activeGenerationBlockedReason?: string;
  checkedAt: string;
  schemaVersion: number | null;
  requiredArtifactKeys: string[];
  requiredTextArtifactKeys: string[];
  requiredVectorNamespaces: string[];
  presentArtifactKeys: string[];
  presentTextArtifactKeys: string[];
  presentVectorNamespaces: string[];
  issues: IndexValidationIssue[];
}

export interface ValidatePreparedIndexOptions {
  rootDir: string;
  mode: IndexMode;
  generation?: number;
}

export interface AssertPreparedIndexOptions extends ValidatePreparedIndexOptions {
  consumer: string;
}

function addIssue(issues: IndexValidationIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

function parseStageOutputs(mode: IndexMode): { artifactKeys: Set<string>; textArtifactKeys: Set<string>; vectorNamespaces: Set<string> } {
  const definitions = getStageDefinitions();
  const activeStages = Object.values(definitions)
    .filter((definition) => definition.modes.includes(mode))
    .map((definition) => definition.name);
  const artifactKeys = new Set<string>();
  const textArtifactKeys = new Set<string>();
  const vectorNamespaces = new Set<string>();

  for (const stage of activeStages) {
    for (const output of definitions[stage].outputs) {
      if (output.startsWith("sqlite:index_artifacts/")) {
        const artifactKey = output.slice("sqlite:index_artifacts/".length);
        if (!artifactKey.startsWith("embedding-cache:")) artifactKeys.add(artifactKey);
      } else if (output.startsWith("sqlite:index_text_artifacts/")) {
        textArtifactKeys.add(output.slice("sqlite:index_text_artifacts/".length));
      } else if (output.startsWith("sqlite:vector_collections/")) {
        vectorNamespaces.add(output.slice("sqlite:vector_collections/".length));
      }
    }
  }

  return { artifactKeys, textArtifactKeys, vectorNamespaces };
}

function modeSatisfies(persistedMode: string | undefined, requestedMode: IndexMode): boolean {
  if (requestedMode === "core") return persistedMode === "core" || persistedMode === "full";
  return persistedMode === "full";
}

async function loadRequiredArtifact<T>(
  rootDir: string,
  artifactKey: IndexArtifactKey,
  generation?: number,
): Promise<T> {
  return loadIndexArtifact(rootDir, artifactKey, () => {
    throw new Error(`Missing required artifact "${artifactKey}".`);
  }, generation === undefined ? undefined : { generation });
}

function validateVersionFields(
  issues: IndexValidationIssue[],
  label: string,
  artifactVersion: number | undefined,
  contractVersion: number | undefined,
): void {
  const contract = buildIndexContract();
  if (artifactVersion !== INDEX_ARTIFACT_VERSION) {
    addIssue(
      issues,
      "artifact-version-mismatch",
      `${label} has artifactVersion=${String(artifactVersion)} but expected ${INDEX_ARTIFACT_VERSION}.`,
    );
  }
  if (contractVersion !== contract.contractVersion) {
    addIssue(
      issues,
      "contract-version-mismatch",
      `${label} has contractVersion=${String(contractVersion)} but expected ${contract.contractVersion}.`,
    );
  }
}

function validateRequiredStages(
  issues: IndexValidationIssue[],
  stageState: PersistedIndexStageState,
  requestedMode: IndexMode,
): void {
  const requiredStages = Object.values(getStageDefinitions())
    .filter((definition) => definition.modes.includes(requestedMode))
    .map((definition) => definition.name);

  for (const stage of requiredStages) {
    if (stageState.stages[stage]?.state !== "completed") {
      addIssue(
        issues,
        "stage-incomplete",
        `Stage "${stage}" is ${stageState.stages[stage]?.state ?? "missing"} but must be completed for ${requestedMode} mode.`,
      );
    }
  }
}

export async function validatePreparedIndex(options: ValidatePreparedIndexOptions): Promise<IndexValidationReport> {
  const checkedAt = new Date().toISOString();
  const serving = await loadIndexServingState(options.rootDir);
  const generation = options.generation ?? serving.activeGeneration;
  const inspection = await inspectIndexDatabase(options.rootDir, { generation });
  const required = parseStageOutputs(options.mode);
  const issues: IndexValidationIssue[] = [];
  const contract = buildIndexContract();

  if (inspection.schemaVersion !== INDEX_DATABASE_SCHEMA_VERSION) {
    addIssue(
      issues,
      "database-schema-mismatch",
      `Index database schemaVersion=${String(inspection.schemaVersion)} but expected ${INDEX_DATABASE_SCHEMA_VERSION}.`,
    );
  }

  if (generation === serving.activeGeneration && serving.activeGenerationFreshness !== "fresh") {
    addIssue(
      issues,
      "serving-generation-not-fresh",
      `Active serving generation ${serving.activeGeneration} is ${serving.activeGenerationFreshness}${serving.activeGenerationBlockedReason ? `: ${serving.activeGenerationBlockedReason}` : ""}.`,
    );
  }

  for (const artifactKey of required.artifactKeys) {
    if (!inspection.artifactKeys.includes(artifactKey)) {
      addIssue(issues, "missing-artifact", `Missing required artifact "${artifactKey}" for ${options.mode} mode.`);
    }
  }
  for (const artifactKey of required.textArtifactKeys) {
    if (!inspection.textArtifactKeys.includes(artifactKey)) {
      addIssue(issues, "missing-text-artifact", `Missing required text artifact "${artifactKey}" for ${options.mode} mode.`);
    }
  }
  for (const namespace of required.vectorNamespaces) {
    if (!inspection.vectorNamespaces.includes(namespace)) {
      addIssue(issues, "missing-vector-namespace", `Missing required vector collection "${namespace}" for ${options.mode} mode.`);
    }
  }

  if (issues.length === 0) {
    const config = await loadRequiredArtifact<ProjectIndexConfig>(options.rootDir, "project-config", generation);
    const fileManifest = await loadRequiredArtifact<FileManifest>(options.rootDir, "file-manifest", generation);
    const stageState = await loadRequiredArtifact<PersistedIndexStageState>(options.rootDir, "index-stage-state", generation);
    const runtime = await createIndexRuntime({ rootDir: options.rootDir, mode: config.indexMode });
    const status = await loadIndexStatus(runtime, checkedAt);

    validateVersionFields(issues, "project-config", config.artifactVersion, config.contract?.contractVersion);
    validateVersionFields(issues, "file-manifest", fileManifest.artifactVersion, fileManifest.contractVersion);
    validateVersionFields(issues, "index-stage-state", stageState.artifactVersion, stageState.contractVersion);
    validateVersionFields(issues, "index-status", status.artifactVersion, status.contractVersion);

    if (!modeSatisfies(config.indexMode, options.mode)) {
      addIssue(issues, "mode-mismatch", `project-config indexMode=${config.indexMode} cannot satisfy requested ${options.mode} validation.`);
    }
    if (!modeSatisfies(fileManifest.indexMode, options.mode)) {
      addIssue(issues, "mode-mismatch", `file-manifest indexMode=${fileManifest.indexMode} cannot satisfy requested ${options.mode} validation.`);
    }
    if (!modeSatisfies(stageState.mode, options.mode)) {
      addIssue(issues, "mode-mismatch", `index-stage-state mode=${stageState.mode} cannot satisfy requested ${options.mode} validation.`);
    }
    if (!modeSatisfies(status.indexMode, options.mode)) {
      addIssue(issues, "mode-mismatch", `index-status indexMode=${status.indexMode} cannot satisfy requested ${options.mode} validation.`);
    }
    if (config.generation !== generation) {
      addIssue(issues, "generation-mismatch", `project-config generation=${config.generation} does not match requested generation ${generation}.`);
    }
    if (fileManifest.generation !== generation) {
      addIssue(issues, "generation-mismatch", `file-manifest generation=${fileManifest.generation} does not match requested generation ${generation}.`);
    }
    if (stageState.generation !== generation) {
      addIssue(issues, "generation-mismatch", `index-stage-state generation=${stageState.generation} does not match requested generation ${generation}.`);
    }

    if (config.rootDir !== status.rootDir) {
      addIssue(issues, "rootdir-mismatch", `project-config rootDir=${config.rootDir} does not match index-status rootDir=${status.rootDir}.`);
    }
    if (config.projectName !== status.projectName) {
      addIssue(issues, "projectname-mismatch", `project-config projectName=${config.projectName} does not match index-status projectName=${status.projectName}.`);
    }
    if (fileManifest.rootDir !== config.rootDir) {
      addIssue(issues, "manifest-rootdir-mismatch", `file-manifest rootDir=${fileManifest.rootDir} does not match project-config rootDir=${config.rootDir}.`);
    }
    if (status.state === "failed") {
      addIssue(issues, "failed-status", `index-status is failed: ${status.error ?? "unknown error"}.`);
    }
    if (generation === serving.activeGeneration && status.activeGeneration !== serving.activeGeneration) {
      addIssue(issues, "generation-mismatch", `index-status activeGeneration=${status.activeGeneration} does not match serving activeGeneration=${serving.activeGeneration}.`);
    }
    if (generation !== serving.activeGeneration && status.runGeneration !== generation && status.pendingGeneration !== generation) {
      addIssue(
        issues,
        "generation-mismatch",
        `index-status does not reference requested generation ${generation}; runGeneration=${status.runGeneration}, pendingGeneration=${String(status.pendingGeneration)}.`,
      );
    }
    validateRequiredStages(issues, stageState, options.mode);

    if (options.mode === "full") {
      const fullManifest = await loadRequiredArtifact<FullArtifactManifest>(options.rootDir, "full-index-manifest", generation);
      validateVersionFields(issues, "full-index-manifest", fullManifest.artifactVersion, fullManifest.contractVersion);
      if (fullManifest.mode !== "full") {
        addIssue(issues, "mode-mismatch", `full-index-manifest mode=${fullManifest.mode} must be full.`);
      }
      if (fullManifest.generation !== generation) {
        addIssue(issues, "generation-mismatch", `full-index-manifest generation=${fullManifest.generation} does not match requested generation ${generation}.`);
      }
      if (fullManifest.contract.contractVersion !== contract.contractVersion) {
        addIssue(
          issues,
          "contract-version-mismatch",
          `full-index-manifest contractVersion=${fullManifest.contract.contractVersion} but expected ${contract.contractVersion}.`,
        );
      }
      if (fullManifest.contract.artifactVersion !== INDEX_ARTIFACT_VERSION) {
        addIssue(
          issues,
          "artifact-version-mismatch",
          `full-index-manifest contract artifactVersion=${fullManifest.contract.artifactVersion} but expected ${INDEX_ARTIFACT_VERSION}.`,
        );
      }
    }
  }

  return {
    ok: issues.length === 0,
    mode: options.mode,
    generation,
    activeGeneration: serving.activeGeneration,
    pendingGeneration: serving.pendingGeneration,
    latestGeneration: serving.latestGeneration,
    activeGenerationValidatedAt: serving.activeGenerationValidatedAt,
    activeGenerationFreshness: serving.activeGenerationFreshness,
    activeGenerationBlockedReason: serving.activeGenerationBlockedReason,
    checkedAt,
    schemaVersion: inspection.schemaVersion,
    requiredArtifactKeys: Array.from(required.artifactKeys).sort(),
    requiredTextArtifactKeys: Array.from(required.textArtifactKeys).sort(),
    requiredVectorNamespaces: Array.from(required.vectorNamespaces).sort(),
    presentArtifactKeys: inspection.artifactKeys,
    presentTextArtifactKeys: inspection.textArtifactKeys,
    presentVectorNamespaces: inspection.vectorNamespaces,
    issues,
  };
}

export function formatIndexValidationReport(report: IndexValidationReport): string {
  const lines = [
    `Index validation: ${report.ok ? "ok" : "failed"}`,
    `Checked at: ${report.checkedAt}`,
    `Mode: ${report.mode}`,
    `Generation: ${report.generation}`,
    `Serving active generation: ${report.activeGeneration}`,
    `Serving pending generation: ${report.pendingGeneration === null ? "none" : String(report.pendingGeneration)}`,
    `Latest generation: ${report.latestGeneration}`,
    `Serving freshness: ${report.activeGenerationFreshness}`,
    `Database schemaVersion: ${String(report.schemaVersion)}`,
    `Required artifacts: ${report.requiredArtifactKeys.length}`,
    `Required text artifacts: ${report.requiredTextArtifactKeys.length}`,
    `Required vector collections: ${report.requiredVectorNamespaces.length}`,
    `Present artifacts: ${report.presentArtifactKeys.length}`,
    `Present text artifacts: ${report.presentTextArtifactKeys.length}`,
    `Present vector collections: ${report.presentVectorNamespaces.length}`,
  ];

  if (report.issues.length === 0) {
    lines.push("", "No validation issues found.");
    return lines.join("\n");
  }

  lines.push("", `Issues (${report.issues.length}):`);
  for (const issue of report.issues) {
    lines.push(`- [${issue.code}] ${issue.message}`);
  }
  return lines.join("\n");
}

export async function assertValidPreparedIndex(options: AssertPreparedIndexOptions): Promise<void> {
  const report = await validatePreparedIndex(options);
  if (report.ok) return;
  throw new Error(
    `${options.consumer} requires a valid prepared ${options.mode} index.\n` +
    `${formatIndexValidationReport(report)}\n` +
    `Repair by running repair_index with target="${options.mode}" or rerun index --mode=${options.mode}.`,
  );
}

export async function repairPreparedIndex(rootDir: string, target: IndexRepairTarget): Promise<string> {
  if (target === "core" || target === "full") {
    const output = await indexCodebase({ rootDir, mode: target });
    const report = await validatePreparedIndex({ rootDir, mode: target });
    if (!report.ok) throw new Error(formatIndexValidationReport(report));
    return `${output}\n\n${formatIndexValidationReport(report)}`;
  }

  const output = await indexCodebase({ rootDir, mode: "full" });
  const report = await validatePreparedIndex({ rootDir, mode: "full" });
  if (!report.ok) throw new Error(formatIndexValidationReport(report));
  return [
    `Repaired stage: ${target}`,
    "Repair strategy: rebuilt a new validated full generation before switching serving state.",
    "",
    output,
    "",
    formatIndexValidationReport(report),
  ].join("\n");
}
