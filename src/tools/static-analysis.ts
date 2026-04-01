// Static analysis runner combining native diagnostics with practical repo hygiene
// Reports deterministic findings for headers, file size, and tool errors

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

interface NativeLintResult {
  tool: string;
  output: string;
  exitCode: number;
}

interface RuleFinding {
  file: string;
  line?: number;
  rule: string;
  severity: "error" | "warning";
  message: string;
}

interface ScoreSummary {
  score: number;
  errors: number;
  warnings: number;
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
  if (lines.length >= 2 && lines[0].startsWith(prefix) && lines[1].startsWith(prefix)) {
    const featureLine = lines[1].toUpperCase().includes("FEATURE:");
    return featureLine
      ? []
      : [{
          file,
          line: 2,
          rule: "feature-tag",
          severity: "warning",
          message: "Line 2 should include a FEATURE: tag.",
        }];
  }
  return [{
    file,
    line: 1,
    rule: "header",
    severity: "error",
    message: `The first 2 lines must be ${prefix} header comments.`,
  }];
}

function validateFileLength(file: string, lines: string[]): RuleFinding[] {
  if (lines.length <= MAX_FILE_LINES) return [];
  return [{
    file,
    line: MAX_FILE_LINES + 1,
    rule: "file-length",
    severity: "warning",
    message: `File has ${lines.length} lines. Recommended maximum is ${MAX_FILE_LINES}.`,
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

function summarizeFileScores(findings: RuleFinding[]): Array<{ file: string; summary: ScoreSummary }> {
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

export async function runStaticAnalysis(options: StaticAnalysisOptions): Promise<string> {
  const rootDir = resolve(options.rootDir);
  const targetFiles = await getTargetFiles(rootDir, options.targetPath);
  const relativeFiles = targetFiles.map((file) => relative(rootDir, file).replace(/\\/g, "/"));
  const nativeLinters = await detectNativeLinters(rootDir, targetFiles, options.targetPath);
  const nativeResults = await Promise.all(nativeLinters.map((config) => runCommand(config.cmd, config.args, rootDir, config.tool)));
  const ruleFindings = await collectRuleFindings(rootDir, targetFiles);
  const nativeFailures = nativeResults.filter((result) => result.exitCode !== 0);
  const nativeOutput = nativeResults.filter((result) => result.output);
  const repoScore = summarizeRepoScore(ruleFindings, nativeFailures);
  const fileScores = summarizeFileScores(ruleFindings);

  const lines = [
    `Lint target: ${options.targetPath ?? "."}`,
    `Files inspected: ${relativeFiles.length}`,
    `Native tools run: ${nativeResults.length > 0 ? nativeResults.map((result) => result.tool).join(", ") : "none"}`,
    `Repo score: ${repoScore.score}/100`,
    `Severity summary: ${repoScore.errors} errors, ${repoScore.warnings} warnings`,
    `Rule findings: ${ruleFindings.length}`,
  ];

  if (nativeFailures.length === 0 && ruleFindings.length === 0) {
    lines.push("", "No issues found.");
  }

  if (ruleFindings.length > 0) {
    lines.push("", "Context+ rule findings:");
    lines.push(...formatFindings(ruleFindings));
  }

  if (fileScores.length > 0) {
    lines.push("", "Lowest-scoring files:");
    for (const entry of fileScores.slice(0, 5)) {
      lines.push(`- ${entry.file} score=${entry.summary.score}/100 errors=${entry.summary.errors} warnings=${entry.summary.warnings}`);
    }
  }

  if (nativeOutput.length > 0) {
    lines.push("", "Native diagnostics:");
    for (const result of nativeOutput) {
      lines.push(`[${result.tool}] exit=${result.exitCode}`);
      lines.push(result.output.substring(0, 4000));
    }
  }

  if (nativeResults.length === 0 && targetFiles.length === 0) {
    lines.push("", "No supported files found for linting.");
  } else if (nativeResults.length === 0) {
    lines.push("", "No native lint tool matched this target.");
  }

  return lines.join("\n");
}
