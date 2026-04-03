// summary: Runs native diagnostics together with repository hygiene rules for lint reporting.
// FEATURE: Native diagnostics plus repository hygiene rule enforcement surface.
// inputs: Repository files, native lint or typecheck tools, and hygiene rule definitions.
// outputs: Repo score summaries, diagnostics, and practical lint findings.

import { execFile } from "child_process";
import { readFile, stat } from "fs/promises";
import { dirname, extname, relative, resolve } from "path";
import { promisify } from "util";
import { walkDirectory } from "../core/walker.js";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

export interface StaticAnalysisOptions {
  rootDir: string;
  targetPath?: string;
}

interface NativeLintConfig {
  cmd: string;
  args: string[];
  tool: string;
}

export interface NativeLintResult {
  tool: string;
  output: string;
  exitCode: number;
}

export interface RuleFinding {
  file: string;
  line?: number;
  rule: string;
  severity: "error" | "warning";
  message: string;
}

export interface ScoreSummary {
  score: number;
  errors: number;
  warnings: number;
}

export interface StaticAnalysisFileScore {
  file: string;
  summary: ScoreSummary;
}

export interface StaticAnalysisReport {
  targetPath?: string;
  filesInspected: number;
  inspectedFiles: string[];
  nativeResults: NativeLintResult[];
  nativeFailures: NativeLintResult[];
  ruleFindings: RuleFinding[];
  repoScore: ScoreSummary;
  fileScores: StaticAnalysisFileScore[];
}

const COMMENT_PREFIXES: Record<string, string> = {
  ".c": "//",
  ".cpp": "//",
  ".cs": "//",
  ".go": "//",
  ".java": "//",
  ".js": "//",
  ".jsx": "//",
  ".kt": "//",
  ".lua": "--",
  ".py": "#",
  ".rb": "#",
  ".rs": "//",
  ".swift": "//",
  ".ts": "//",
  ".tsx": "//",
  ".zig": "//",
};

const ROOT_ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

const MAX_FILE_LINES = 1000;
const FILE_LENGTH_LIMITS = new Map<string, number>([
  ["cli/internal/ui/model.go", 5000],
  ["src/tools/evaluation.ts", 1500],
]);
const REQUIRED_HEADER_FIELDS = ["summary", "inputs", "outputs"] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveNodeTool(rootDir: string, relativePath: string): Promise<string | null> {
  const localPath = resolve(rootDir, "node_modules", relativePath);
  if (await pathExists(localPath)) return localPath;
  const packagePath = resolve(PACKAGE_ROOT, "node_modules", relativePath);
  if (await pathExists(packagePath)) return packagePath;
  return null;
}

async function runCommand(cmd: string, args: string[], cwd: string, tool: string): Promise<NativeLintResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return { tool, output: `${stdout}${stderr}`.trim(), exitCode: 0 };
  } catch (error: any) {
    return {
      tool,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim(),
      exitCode: error.code ?? 1,
    };
  }
}

async function getTargetFiles(rootDir: string, targetPath?: string): Promise<string[]> {
  if (!targetPath) {
    const entries = await walkDirectory({ rootDir });
    return entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
  }

  const fullTargetPath = resolve(rootDir, targetPath);
  const targetStat = await stat(fullTargetPath);
  if (!targetStat.isDirectory()) return [fullTargetPath];

  const entries = await walkDirectory({ rootDir, targetPath });
  return entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
}

function getSupportedRuleFiles(paths: string[]): string[] {
  return paths.filter((path) => COMMENT_PREFIXES[extname(path)]);
}

function validateHeader(file: string, lines: string[]): RuleFinding[] {
  const prefix = COMMENT_PREFIXES[extname(file)];
  if (!prefix) return [];
  const headerStart = lines[0]?.startsWith("#!") ? 1 : 0;
  const headerLines: Array<{ lineNumber: number; text: string }> = [];
  let index = headerStart;
  while (index < lines.length && lines[index].startsWith(prefix)) {
    headerLines.push({ lineNumber: index + 1, text: lines[index].slice(prefix.length).trim() });
    index += 1;
  }
  if (headerLines.length < 2) {
    return [{
      file,
      line: headerStart + 1,
      rule: "header",
      severity: "error",
      message: `The header must begin with at least 2 ${prefix} comment lines.`,
    }];
  }
  const findings: RuleFinding[] = [];
  const featureLine = headerLines.find((line) => line.text.toUpperCase().includes("FEATURE:"));
  if (!featureLine) {
    findings.push({
      file,
      line: headerLines[1]?.lineNumber ?? (headerStart + 2),
      rule: "feature-tag",
      severity: "warning",
      message: "Header must include a FEATURE: line.",
    });
  }
  for (const field of REQUIRED_HEADER_FIELDS) {
    const expectedPrefix = `${field}:`;
    const line = headerLines.find((entry) => entry.text.toLowerCase().startsWith(expectedPrefix));
    if (!line || line.text.slice(expectedPrefix.length).trim().length === 0) {
      findings.push({
        file,
        line: line?.lineNumber ?? headerStart + 1,
        rule: `${field}-header`,
        severity: "warning",
        message: `Header must include a non-empty ${expectedPrefix} field.`,
      });
    }
  }
  return findings;
}

function validateFileLength(file: string, lines: string[]): RuleFinding[] {
  const limit = FILE_LENGTH_LIMITS.get(file) ?? MAX_FILE_LINES;
  if (lines.length <= limit) return [];
  return [{
    file,
    line: limit + 1,
    rule: "file-length",
    severity: "warning",
    message: `File has ${lines.length} lines. Recommended maximum is ${limit}.`,
  }];
}

async function collectRuleFindings(rootDir: string, targetFiles: string[]): Promise<RuleFinding[]> {
  const findings: RuleFinding[] = [];
  for (const file of getSupportedRuleFiles(targetFiles)) {
    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");
    const relativePath = relative(rootDir, file).replace(/\\/g, "/");
    findings.push(...validateHeader(relativePath, lines));
    findings.push(...validateFileLength(relativePath, lines));
  }
  return findings;
}

async function detectNativeLinters(rootDir: string, targetFiles: string[], targetPath?: string): Promise<NativeLintConfig[]> {
  const configs: NativeLintConfig[] = [];
  const extensions = new Set(targetFiles.map((file) => extname(file)));

  const tscPath = await resolveNodeTool(rootDir, "typescript/bin/tsc");
  if ((extensions.has(".ts") || extensions.has(".tsx")) && tscPath && await pathExists(resolve(rootDir, "tsconfig.json"))) {
    configs.push({
      cmd: process.execPath,
      args: [tscPath, "--noEmit", "--pretty", "false", "-p", resolve(rootDir, "tsconfig.json")],
      tool: "tsc",
    });
  }

  const eslintPath = await resolveNodeTool(rootDir, "eslint/bin/eslint.js");
  if ((extensions.has(".js") || extensions.has(".jsx")) && eslintPath && (await Promise.all(ROOT_ESLINT_CONFIGS.map((name) => pathExists(resolve(rootDir, name))))).some(Boolean)) {
    const lintTarget = targetPath ? resolve(rootDir, targetPath) : ".";
    configs.push({
      cmd: process.execPath,
      args: [eslintPath, lintTarget],
      tool: "eslint",
    });
  }

  const pythonFiles = targetFiles.filter((file) => extname(file) === ".py");
  if (pythonFiles.length > 0) {
    configs.push({
      cmd: "python",
      args: ["-m", "py_compile", ...pythonFiles],
      tool: "py_compile",
    });
  }

  if ((extensions.has(".rs") || await pathExists(resolve(rootDir, "Cargo.toml"))) && await pathExists(resolve(rootDir, "Cargo.toml"))) {
    configs.push({
      cmd: "cargo",
      args: ["check", "--message-format=short"],
      tool: "cargo check",
    });
  }

  if ((extensions.has(".go") || await pathExists(resolve(rootDir, "go.mod"))) && await pathExists(resolve(rootDir, "go.mod"))) {
    const goTarget = targetPath ? resolve(rootDir, targetPath) : "./...";
    configs.push({
      cmd: "go",
      args: ["vet", goTarget],
      tool: "go vet",
    });
  }

  return configs;
}

function formatFindings(findings: RuleFinding[]): string[] {
  return findings.map((finding) => {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return `- [${finding.severity}] ${location} [${finding.rule}] ${finding.message}`;
  });
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function summarizeRuleSeverities(findings: RuleFinding[]): ScoreSummary {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    score: clampScore(100 - errors * 18 - warnings * 6),
    errors,
    warnings,
  };
}

function summarizeRepoScore(findings: RuleFinding[], nativeFailures: NativeLintResult[]): ScoreSummary {
  const ruleSummary = summarizeRuleSeverities(findings);
  return {
    score: clampScore(ruleSummary.score - nativeFailures.length * 25),
    errors: ruleSummary.errors + nativeFailures.length,
    warnings: ruleSummary.warnings,
  };
}

function summarizeFileScores(findings: RuleFinding[]): StaticAnalysisFileScore[] {
  const grouped = new Map<string, RuleFinding[]>();
  for (const finding of findings) {
    grouped.set(finding.file, [...(grouped.get(finding.file) ?? []), finding]);
  }
  return Array.from(grouped.entries())
    .map(([file, fileFindings]) => ({ file, summary: summarizeRuleSeverities(fileFindings) }))
    .sort((left, right) =>
      left.summary.score - right.summary.score
      || right.summary.errors - left.summary.errors
      || right.summary.warnings - left.summary.warnings
      || left.file.localeCompare(right.file));
}

export function formatStaticAnalysisReport(report: StaticAnalysisReport): string {
  const lines = [
    `Lint target: ${report.targetPath ?? "."}`,
    `Files inspected: ${report.filesInspected}`,
    `Native tools run: ${report.nativeResults.length > 0 ? report.nativeResults.map((result) => result.tool).join(", ") : "none"}`,
    `Repo score: ${report.repoScore.score}/100`,
    `Severity summary: ${report.repoScore.errors} errors, ${report.repoScore.warnings} warnings`,
    `Rule findings: ${report.ruleFindings.length}`,
  ];

  if (report.nativeFailures.length === 0 && report.ruleFindings.length === 0) {
    lines.push("", "No issues found.");
  }

  if (report.ruleFindings.length > 0) {
    lines.push("", "context++ rule findings:");
    lines.push(...formatFindings(report.ruleFindings));
  }

  if (report.fileScores.length > 0) {
    lines.push("", "Lowest-scoring files:");
    for (const entry of report.fileScores.slice(0, 5)) {
      lines.push(`- ${entry.file} score=${entry.summary.score}/100 errors=${entry.summary.errors} warnings=${entry.summary.warnings}`);
    }
  }

  const nativeOutput = report.nativeResults.filter((result) => result.output);
  if (nativeOutput.length > 0) {
    lines.push("", "Native diagnostics:");
    for (const result of nativeOutput) {
      lines.push(`[${result.tool}] exit=${result.exitCode}`);
      lines.push(result.output.substring(0, 4000));
    }
  }

  if (report.nativeResults.length === 0 && report.filesInspected === 0) {
    lines.push("", "No supported files found for linting.");
  } else if (report.nativeResults.length === 0) {
    lines.push("", "No native lint tool matched this target.");
  }

  return lines.join("\n");
}

export async function buildStaticAnalysisReport(options: StaticAnalysisOptions): Promise<StaticAnalysisReport> {
  const rootDir = resolve(options.rootDir);
  const targetFiles = await getTargetFiles(rootDir, options.targetPath);
  const relativeFiles = targetFiles.map((file) => relative(rootDir, file).replace(/\\/g, "/"));
  const nativeLinters = await detectNativeLinters(rootDir, targetFiles, options.targetPath);
  const nativeResults = await Promise.all(nativeLinters.map((config) => runCommand(config.cmd, config.args, rootDir, config.tool)));
  const ruleFindings = await collectRuleFindings(rootDir, targetFiles);
  const nativeFailures = nativeResults.filter((result) => result.exitCode !== 0);
  const repoScore = summarizeRepoScore(ruleFindings, nativeFailures);
  const fileScores = summarizeFileScores(ruleFindings);

  return {
    targetPath: options.targetPath,
    filesInspected: relativeFiles.length,
    inspectedFiles: relativeFiles,
    nativeResults,
    nativeFailures,
    ruleFindings,
    repoScore,
    fileScores,
  };
}

export async function runStaticAnalysis(options: StaticAnalysisOptions): Promise<string> {
  return formatStaticAnalysisReport(await buildStaticAnalysisReport(options));
}
