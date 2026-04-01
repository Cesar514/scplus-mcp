// Code commit gatekeeper enforcing practical file hygiene before writes
// Validates headers and file complexity before creating shadow restore points

import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname, extname } from "path";
import { createRestorePoint } from "../git/shadow.js";
import { isSupportedFile } from "../core/parser.js";
import { refreshPreparedIndexAfterWrite } from "./write-freshness.js";

export interface ProposeCommitOptions {
  rootDir: string;
  filePath: string;
  newContent: string;
}

export interface ValidationError {
  rule: string;
  message: string;
  line?: number;
}

export interface CheckpointReport {
  filePath: string;
  saved: boolean;
  warnings: ValidationError[];
  refreshMode: "core" | "full";
  restorePointCreated: boolean;
}

function validateHeader(lines: string[], ext: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const commentPrefixes: Record<string, string> = {
    ".ts": "//", ".tsx": "//", ".js": "//", ".jsx": "//",
    ".rs": "//", ".go": "//", ".c": "//", ".cpp": "//",
    ".java": "//", ".cs": "//", ".swift": "//", ".kt": "//",
    ".py": "#", ".rb": "#", ".lua": "--", ".zig": "//",
  };

  const prefix = commentPrefixes[ext];
  if (!prefix) return errors;

  if (lines.length < 2 || !lines[0].startsWith(prefix) || !lines[1].startsWith(prefix)) {
    errors.push({
      rule: "header",
      message: `Missing 2-line file header. The first 2 lines must be ${prefix} comments explaining the file.`,
    });
    return errors;
  }

  if (!lines[1].toUpperCase().includes("FEATURE:")) {
    errors.push({
      rule: "feature-tag",
      message: `Line 2 should include a FEATURE: tag (e.g., "${prefix} FEATURE: Feature Name"). Links files to feature hubs.`,
    });
  }

  return errors;
}

function validateAbstraction(lines: string[]): ValidationError[] {
  const errors: ValidationError[] = [];
  let nestingDepth = 0;
  let maxNesting = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    nestingDepth += (line.match(/{/g) || []).length;
    nestingDepth -= (line.match(/}/g) || []).length;
    maxNesting = Math.max(maxNesting, nestingDepth);
  }

  if (maxNesting > 6) {
    errors.push({
      rule: "nesting",
      message: `Nesting depth of ${maxNesting} detected. Maximum recommended is 3-4 levels. Flatten the structure.`,
    });
  }

  if (lines.length > 1000) {
    errors.push({
      rule: "file-length",
      message: `File is ${lines.length} lines. Maximum recommended is 500-1000. Consider splitting.`,
    });
  }

  return errors;
}

export function formatCheckpointReport(report: CheckpointReport): string {
  const result = [`✅ File saved: ${report.filePath}`];
  if (report.warnings.length > 0) {
    result.push(`\n⚠ ${report.warnings.length} warning(s):`);
    for (const warning of report.warnings) {
      result.push(`  ⚠ [${warning.rule}] ${warning.message}`);
    }
  }
  result.push(`\nIndex refresh completed in ${report.refreshMode} mode.`);
  result.push(`\nRestore point created. Use undo tools if needed.`);
  return result.join("\n");
}

export async function buildCheckpointReport(options: ProposeCommitOptions): Promise<CheckpointReport> {
  const fullPath = resolve(options.rootDir, options.filePath);
  const ext = extname(fullPath);
  const lines = options.newContent.split("\n");
  const allErrors: ValidationError[] = [];

  if (isSupportedFile(fullPath)) {
    allErrors.push(...validateHeader(lines, ext));
  }
  allErrors.push(...validateAbstraction(lines));
  const warnings = allErrors;

  await createRestorePoint(options.rootDir, [options.filePath], `Pre-commit: ${options.filePath}`);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, options.newContent, "utf-8");
  const refresh = await refreshPreparedIndexAfterWrite({
    rootDir: options.rootDir,
    relativePaths: [options.filePath],
    cause: "checkpoint",
  });

  return {
    filePath: options.filePath,
    saved: true,
    warnings,
    refreshMode: refresh.mode,
    restorePointCreated: true,
  };
}

export async function proposeCommit(options: ProposeCommitOptions): Promise<string> {
  return formatCheckpointReport(await buildCheckpointReport(options));
}
