// summary: Runs native diagnostics together with repository hygiene rules for lint reporting.
// FEATURE: Native diagnostics plus repository hygiene rule enforcement surface.
// inputs: Repository files, native lint or typecheck tools, and hygiene rule definitions.
// outputs: Repo score summaries, diagnostics, and practical lint findings.

import { execFile } from "child_process";
import { readFile, stat } from "fs/promises";
import { dirname, extname, relative, resolve } from "path";
import { promisify } from "util";
import { analyzeFile, flattenSymbols, isSupportedFile, SymbolKind } from "../core/parser.js";
import { withSyntaxTree } from "../core/tree-sitter.js";
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

interface LineInfo {
  lineNumber: number;
  text: string;
  trimmed: string;
  isBlank: boolean;
  isCommentOnly: boolean;
  commentText: string;
}

const COMMENT_PREFIXES: Record<string, string> = {
  ".c": "//",
  ".cc": "//",
  ".cjs": "//",
  ".cpp": "//",
  ".cs": "//",
  ".go": "//",
  ".h": "//",
  ".hpp": "//",
  ".java": "//",
  ".js": "//",
  ".jsx": "//",
  ".kt": "//",
  ".lua": "--",
  ".mjs": "//",
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

const BLOCK_COMMENT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
  ".zig",
]);
const MAX_FILE_LOC = 800;
const MAX_FUNCTION_LOC = 40;
const MAX_PARAMETER_COUNT = 5;
const MAX_NESTING_DEPTH = 2;
const MAX_FUNCTIONS_PER_FILE = 12;
const MAX_LINE_LENGTH = 150;
const FILE_LOC_LIMITS = new Map<string, number>([
  ["cli/internal/ui/model.go", 5000],
  ["src/tools/evaluation.ts", 1500],
]);
const REQUIRED_HEADER_FIELDS = ["summary", "inputs", "outputs"] as const;
const REQUIRED_FUNCTION_HEADER_FIELDS = ["purpose", "inputs", "returns/effects"] as const;
const CALLABLE_KINDS = new Set([SymbolKind.Function, SymbolKind.Method]);
const IGNORED_PARAMETER_NAMES = new Set(["self", "this", "ctx", "cls"]);
const TRACKED_TODO_PATTERN = /\b(?:TODO|FIXME)\b:?\s+(?:[A-Z]+-\d+\b|https?:\/\/\S+|\d{4}-\d{2}-\d{2}\b|v?\d+\.\d+(?:\.\d+)?\b)/;
const WILDCARD_IMPORT_PATTERNS = [
  /^\s*from\s+\S+\s+import\s+\*/,
  /^\s*import\s+[\w.]+\.\*\s*;?\s*$/,
  /^\s*using\s+namespace\s+\w[\w:]*\s*;?\s*$/,
];
const COMMENTED_OUT_CODE_PATTERN = /(?:\b(?:if|for|while|switch|catch|return|import|export|class|def|func|const|let|var)\b|=>|==|!=|=\s*[^=]|[{()}];?$)/;
const CONTROL_FLOW_NODE_TYPES: Record<string, Set<string>> = {
  c: new Set(["if_statement", "for_statement", "while_statement", "do_statement", "switch_statement"]),
  cpp: new Set(["if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement", "try_statement"]),
  c_sharp: new Set(["if_statement", "for_statement", "for_each_statement", "while_statement", "do_statement", "switch_statement", "try_statement"]),
  go: new Set(["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement"]),
  java: new Set(["if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "switch_expression", "switch_statement", "try_statement"]),
  javascript: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "try_statement"]),
  kotlin: new Set(["if_expression", "for_statement", "while_statement", "do_while_statement", "when_expression", "try_expression"]),
  python: new Set(["if_statement", "for_statement", "while_statement", "try_statement", "match_statement"]),
  rust: new Set(["if_expression", "for_expression", "while_expression", "loop_expression", "match_expression"]),
  swift: new Set(["if_statement", "for_statement", "while_statement", "repeat_while_statement", "switch_statement", "do_statement"]),
  tsx: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "try_statement"]),
  typescript: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "try_statement"]),
};
const FUNCTION_NODE_TYPES: Record<string, Set<string>> = {
  c: new Set(["function_definition"]),
  cpp: new Set(["function_definition", "lambda_expression"]),
  c_sharp: new Set(["constructor_declaration", "destructor_declaration", "local_function_statement", "method_declaration"]),
  go: new Set(["function_declaration", "method_declaration", "func_literal"]),
  java: new Set(["constructor_declaration", "lambda_expression", "method_declaration"]),
  javascript: new Set(["arrow_function", "function_declaration", "function_expression", "generator_function_declaration", "generator_function"]),
  kotlin: new Set(["anonymous_function", "function_declaration", "lambda_literal"]),
  python: new Set(["function_definition", "lambda"]),
  rust: new Set(["closure_expression", "function_item"]),
  swift: new Set(["anonymous_function", "function_declaration"]),
  tsx: new Set(["arrow_function", "function_declaration", "function_expression", "generator_function_declaration", "generator_function"]),
  typescript: new Set(["arrow_function", "function_declaration", "function_expression", "generator_function_declaration", "generator_function"]),
};

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

function stripCommentPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : text.trim();
}

function buildLineInfo(file: string, lines: string[]): LineInfo[] {
  const prefix = COMMENT_PREFIXES[extname(file)];
  const supportsBlockComments = BLOCK_COMMENT_EXTENSIONS.has(extname(file));
  const output: LineInfo[] = [];
  let inBlockComment = false;

  for (const [index, text] of lines.entries()) {
    const trimmed = text.trim();
    const isBlank = trimmed.length === 0;
    let isCommentOnly = false;
    let commentText = "";

    if (inBlockComment) {
      isCommentOnly = true;
      commentText = trimmed.replace(/^\*+\s?/, "").replace(/\*\/$/, "").trim();
      if (trimmed.includes("*/")) inBlockComment = false;
    } else if (!isBlank && prefix && trimmed.startsWith(prefix)) {
      isCommentOnly = true;
      commentText = stripCommentPrefix(trimmed, prefix);
    } else if (!isBlank && supportsBlockComments && trimmed.startsWith("/*")) {
      isCommentOnly = true;
      commentText = trimmed.replace(/^\/\*\*?\s?/, "").replace(/\*\/$/, "").trim();
      if (!trimmed.includes("*/")) inBlockComment = true;
    }

    output.push({
      lineNumber: index + 1,
      text,
      trimmed,
      isBlank,
      isCommentOnly,
      commentText,
    });
  }

  return output;
}

function countNonCommentLines(lineInfo: LineInfo[], startLine: number, endLine: number): number {
  return lineInfo
    .filter((line) =>
      line.lineNumber >= startLine
      && line.lineNumber <= endLine
      && !line.isBlank
      && !line.isCommentOnly)
    .length;
}

function countFileNonCommentLines(lineInfo: LineInfo[]): number {
  return lineInfo.filter((line) => !line.isBlank && !line.isCommentOnly).length;
}

function extractParameterGroup(signature: string): string | null {
  const groups: string[] = [];
  let start = -1;
  let depth = 0;

  for (let index = 0; index < signature.length; index += 1) {
    const char = signature[index];
    if (char === "(") {
      if (depth === 0) start = index + 1;
      depth += 1;
      continue;
    }
    if (char !== ")") continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      groups.push(signature.slice(start, index));
      start = -1;
    }
  }

  return groups.at(-1) ?? null;
}

function splitTopLevelParameters(parameterGroup: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (const char of parameterGroup) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if ("([{<".includes(char)) {
      depth += 1;
      current += char;
      continue;
    }
    if (")]}>".includes(char)) {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function shouldIgnoreParameter(parameter: string): boolean {
  const cleaned = parameter
    .replace(/^\.\.\./, "")
    .replace(/\s*=.*$/, "")
    .trim();
  if (cleaned.length === 0 || cleaned === "/" || cleaned === "*") return true;
  const name = cleaned.match(/^([A-Za-z_][$\w]*)\s*[:?=]/)?.[1]
    ?? cleaned.match(/^([A-Za-z_][$\w]*)\s+/)?.[1]
    ?? cleaned.match(/^&?([A-Za-z_][$\w]*)$/)?.[1]
    ?? "";
  return IGNORED_PARAMETER_NAMES.has(name);
}

function countParameters(signature: string): number {
  const parameterGroup = extractParameterGroup(signature);
  if (!parameterGroup) return 0;
  return splitTopLevelParameters(parameterGroup)
    .filter((parameter) => !shouldIgnoreParameter(parameter))
    .length;
}

function buildCallableSignatureText(
  startLine: number,
  endLine: number,
  lineInfo: LineInfo[],
  fallbackSignature: string,
): string {
  const signatureLines: string[] = [];

  for (const line of lineInfo) {
    if (line.lineNumber < startLine || line.lineNumber > endLine || line.isCommentOnly) continue;
    signatureLines.push(line.trimmed);
    if (line.trimmed.includes("{") || line.trimmed.endsWith(":")) break;
  }

  const reconstructed = signatureLines.join(" ").trim();
  return reconstructed.length > 0 ? reconstructed : fallbackSignature;
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

function validateFileLength(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  const limit = FILE_LOC_LIMITS.get(file) ?? MAX_FILE_LOC;
  const nonCommentLoc = countFileNonCommentLines(lineInfo);
  if (nonCommentLoc <= limit) return [];
  return [{
    file,
    line: lineInfo.find((line) => !line.isBlank && !line.isCommentOnly)?.lineNumber ?? 1,
    rule: "max-file-loc",
    severity: "warning",
    message: `File has ${nonCommentLoc} non-comment LOC. Recommended maximum is ${limit}.`,
  }];
}

function validateLineLength(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  return lineInfo.flatMap((line) => {
    if (line.text.length <= MAX_LINE_LENGTH) return [];
    if (line.trimmed.startsWith("import ") || line.trimmed.startsWith("from ")) return [];
    if (line.isCommentOnly && /https?:\/\//.test(line.text)) return [];
    return [{
      file,
      line: line.lineNumber,
      rule: "line-length",
      severity: "error" as const,
      message: `Line exceeds ${MAX_LINE_LENGTH} columns (${line.text.length}).`,
    }];
  });
}

function validateTrackedTodos(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  return lineInfo.flatMap((line) => {
    if (!/\b(?:TODO|FIXME)\b/.test(line.text)) return [];
    if (TRACKED_TODO_PATTERN.test(line.text)) return [];
    return [{
      file,
      line: line.lineNumber,
      rule: "tracked-todo-only",
      severity: "error" as const,
      message: "TODO/FIXME comments must include an issue ID, URL, or milestone/date token.",
    }];
  });
}

function validateWildcardImports(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  return lineInfo.flatMap((line) => {
    if (line.isBlank || line.isCommentOnly) return [];
    if (!WILDCARD_IMPORT_PATTERNS.some((pattern) => pattern.test(line.trimmed))) return [];
    return [{
      file,
      line: line.lineNumber,
      rule: "no-wildcard-imports",
      severity: "error" as const,
      message: "Wildcard or namespace-wide imports are not allowed.",
    }];
  });
}

function validateSingleStatementLines(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  return lineInfo.flatMap((line) => {
    if (line.isBlank || line.isCommentOnly) return [];
    const semicolonCount = (line.text.match(/;/g) ?? []).length;
    if (semicolonCount < 2) return [];
    if (/for\s*\([^)]*;[^)]*;[^)]*\)/.test(line.text)) return [];
    return [{
      file,
      line: line.lineNumber,
      rule: "one-statement-per-line",
      severity: "error" as const,
      message: "Multiple executable statements on one line make patching and review less reliable.",
    }];
  });
}

function validateCommentedOutCode(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const suspiciousLines = lineInfo.filter((line) => line.isCommentOnly && COMMENTED_OUT_CODE_PATTERN.test(line.commentText));

  for (let index = 0; index < suspiciousLines.length - 1; index += 1) {
    const current = suspiciousLines[index];
    const next = suspiciousLines[index + 1];
    if (next.lineNumber !== current.lineNumber + 1) continue;
    findings.push({
      file,
      line: current.lineNumber,
      rule: "no-commented-out-code",
      severity: "error",
      message: "Commented-out code blocks are not allowed.",
    });
    index += 1;
  }

  return findings;
}

function collectImmediateCommentBlock(startLine: number, lineInfo: LineInfo[]): Array<{ lineNumber: number; text: string }> {
  const block: Array<{ lineNumber: number; text: string }> = [];
  let lineNumber = startLine - 1;

  while (lineNumber >= 1) {
    const line = lineInfo[lineNumber - 1];
    if (line.isBlank) break;
    if (!line.isCommentOnly) return [];
    block.unshift({ lineNumber: line.lineNumber, text: line.commentText });
    lineNumber -= 1;
  }

  return block;
}

function validateFunctionHeaderBlock(
  file: string,
  callableLine: number,
  signatureText: string,
  nonCommentLoc: number,
  lineInfo: LineInfo[],
): RuleFinding[] {
  if (nonCommentLoc <= 5) return [];
  const block = collectImmediateCommentBlock(callableLine, lineInfo);
  if (block.length < 3) {
    return [{
      file,
      line: callableLine,
      rule: "function-header-3-lines",
      severity: "warning",
      message: `${signatureText} must have a 3-line structured function header directly above it.`,
    }];
  }

  const normalized = block.map((line) => line.text.toLowerCase());
  const missingField = REQUIRED_FUNCTION_HEADER_FIELDS.find((field) =>
    !normalized.some((line) => line.startsWith(`${field}:`)),
  );
  if (!missingField) return [];

  return [{
    file,
    line: callableLine,
    rule: "function-header-3-lines",
    severity: "warning",
    message: `${signatureText} is missing the "${missingField}:" line in its structured function header.`,
  }];
}

function computeMaxControlFlowDepth(
  node: any,
  grammarName: string,
  currentDepth: number,
  isRootCallable: boolean,
): number {
  const controlFlowTypes = CONTROL_FLOW_NODE_TYPES[grammarName] ?? new Set<string>();
  const functionTypes = FUNCTION_NODE_TYPES[grammarName] ?? new Set<string>();
  const isCallableNode = functionTypes.has(node.type);
  if (!isRootCallable && isCallableNode) return currentDepth;

  const nextDepth = controlFlowTypes.has(node.type) ? currentDepth + 1 : currentDepth;
  let maxDepth = nextDepth;

  for (const child of node.namedChildren ?? []) {
    maxDepth = Math.max(
      maxDepth,
      computeMaxControlFlowDepth(child, grammarName, nextDepth, false),
    );
  }

  return maxDepth;
}

async function validateNestingDepth(file: string, fullPath: string, lineInfo: LineInfo[]): Promise<RuleFinding[]> {
  const extension = extname(fullPath).toLowerCase();
  if (!isSupportedFile(fullPath)) return [];

  try {
    return await withSyntaxTree(
      lineInfo.map((line) => line.text).join("\n"),
      extension,
      ({ rootNode, grammarName }) => {
        const functionTypes = FUNCTION_NODE_TYPES[grammarName] ?? new Set<string>();
        const findings: RuleFinding[] = [];

        function visit(node: any): void {
          if (functionTypes.has(node.type)) {
            const nestingDepth = computeMaxControlFlowDepth(node, grammarName, 0, true);
            if (nestingDepth > MAX_NESTING_DEPTH) {
              const signatureText = buildCallableSignatureText(
                node.startPosition.row + 1,
                node.endPosition.row + 1,
                lineInfo,
                lineInfo[node.startPosition.row]?.trimmed ?? node.type,
              );
              findings.push({
                file,
                line: node.startPosition.row + 1,
                rule: "max-nesting-depth",
                severity: "error",
                message: `${signatureText} exceeds nesting depth ${MAX_NESTING_DEPTH} (${nestingDepth}).`,
              });
            }
          }

          for (const child of node.namedChildren ?? []) visit(child);
        }

        visit(rootNode);
        return findings;
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{
      file,
      line: 1,
      rule: "ast-analysis",
      severity: "error",
      message: `AST-backed nesting analysis could not analyze this file: ${message}`,
    }];
  }
}

function validateBareExcepts(file: string, lineInfo: LineInfo[]): RuleFinding[] {
  if (extname(file) !== ".py") return [];
  return lineInfo.flatMap((line) => {
    if (!/^\s*except\s*:\s*$/.test(line.text)) return [];
    return [{
      file,
      line: line.lineNumber,
      rule: "no-generic-catch",
      severity: "error" as const,
      message: "Bare except blocks hide failures; catch a specific exception and rethrow or escalate.",
    }];
  });
}

async function validateFunctionMetrics(file: string, fullPath: string, lineInfo: LineInfo[]): Promise<RuleFinding[]> {
  if (!isSupportedFile(fullPath)) return [];

  let analysis;
  try {
    analysis = await analyzeFile(fullPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{
      file,
      line: 1,
      rule: "ast-analysis",
      severity: "error",
      message: `AST-backed lint rules could not analyze this file: ${message}`,
    }];
  }

  const findings: RuleFinding[] = [];
  const callables = flattenSymbols(analysis.symbols).filter((symbol) => CALLABLE_KINDS.has(symbol.kind));

  if (callables.length > MAX_FUNCTIONS_PER_FILE) {
    findings.push({
      file,
      line: callables[MAX_FUNCTIONS_PER_FILE]?.line ?? 1,
      rule: "max-functions-per-file",
      severity: "warning",
      message: `File declares ${callables.length} callable bodies. Recommended maximum is ${MAX_FUNCTIONS_PER_FILE}.`,
    });
  }

  for (const callable of callables) {
    const signatureText = buildCallableSignatureText(
      callable.line,
      callable.endLine,
      lineInfo,
      callable.signature,
    );
    const nonCommentLoc = countNonCommentLines(lineInfo, callable.line, callable.endLine);
    if (nonCommentLoc > MAX_FUNCTION_LOC) {
      findings.push({
        file,
        line: callable.line,
        rule: "max-function-loc",
        severity: "error",
        message: `${signatureText} exceeds ${MAX_FUNCTION_LOC} non-comment LOC (${nonCommentLoc}).`,
      });
    }

    const parameterCount = countParameters(signatureText);
    if (parameterCount > MAX_PARAMETER_COUNT) {
      findings.push({
        file,
        line: callable.line,
        rule: "max-parameter-count",
        severity: "error",
        message: `${signatureText} declares ${parameterCount} parameters. Maximum allowed is ${MAX_PARAMETER_COUNT}.`,
      });
    }

    findings.push(
      ...validateFunctionHeaderBlock(file, callable.line, signatureText, nonCommentLoc, lineInfo),
    );
  }

  return findings;
}

async function collectRuleFindings(rootDir: string, targetFiles: string[]): Promise<RuleFinding[]> {
  const findings: RuleFinding[] = [];
  for (const file of getSupportedRuleFiles(targetFiles)) {
    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");
    const relativePath = relative(rootDir, file).replace(/\\/g, "/");
    const lineInfo = buildLineInfo(relativePath, lines);
    findings.push(...validateHeader(relativePath, lines));
    findings.push(...validateFileLength(relativePath, lineInfo));
    findings.push(...validateLineLength(relativePath, lineInfo));
    findings.push(...validateTrackedTodos(relativePath, lineInfo));
    findings.push(...validateWildcardImports(relativePath, lineInfo));
    findings.push(...validateSingleStatementLines(relativePath, lineInfo));
    findings.push(...validateCommentedOutCode(relativePath, lineInfo));
    findings.push(...validateBareExcepts(relativePath, lineInfo));
    findings.push(...await validateFunctionMetrics(relativePath, file, lineInfo));
    findings.push(...await validateNestingDepth(relativePath, file, lineInfo));
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
    lines.push("", "scplus rule findings:");
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
