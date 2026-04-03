// Code commit gatekeeper enforcing practical file hygiene before writes
// FEATURE: Write-time validation and restore point creation for file edits

import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname, extname } from "path";
import { createRestorePoint } from "../git/shadow.js";
import { isSupportedFile } from "../core/parser.js";
import { refreshPreparedIndexAfterWrite, runSerializedRootMutation } from "./write-freshness.js";

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

const REQUIRED_HEADER_FIELDS = ["summary", "inputs", "outputs"] as const;

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

  const headerStart = lines[0]?.startsWith("#!") ? 1 : 0;
  const headerLines: string[] = [];
  let index = headerStart;
  while (index < lines.length && lines[index].startsWith(prefix)) {
    headerLines.push(lines[index].slice(prefix.length).trim());
    index += 1;
  }

  if (headerLines.length < 2) {
    errors.push({
      rule: "header",
      message: `Missing header block. Start the file with at least 2 ${prefix} comment lines.`,
    });
    return errors;
  }

  if (!headerLines.some((line) => line.toUpperCase().includes("FEATURE:"))) {
    errors.push({
      rule: "feature-tag",
      message: `Header must include a FEATURE: line (e.g., "${prefix} FEATURE: Feature Name").`,
    });
  }

  for (const field of REQUIRED_HEADER_FIELDS) {
    const expectedPrefix = `${field}:`;
    const line = headerLines.find((entry) => entry.toLowerCase().startsWith(expectedPrefix));
    if (!line || line.slice(expectedPrefix.length).trim().length === 0) {
      errors.push({
        rule: `${field}-header`,
        message: `Header must include a non-empty ${expectedPrefix} field.`,
      });
    }
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
  return runSerializedRootMutation(options.rootDir, async () => {
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
  });
}

export async function proposeCommit(options: ProposeCommitOptions): Promise<string> {
  return formatCheckpointReport(await buildCheckpointReport(options));
}
