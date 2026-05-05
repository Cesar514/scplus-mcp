// summary: Runs native diagnostics together with repository hygiene rules for lint reporting.
// purpose: Evaluate files against repository lint rules and collect scored findings.
// inputs: Repository files, native lint or typecheck tools, and hygiene rule definitions.
// returns/effects: Repo score summaries, diagnostics, and practical lint findings.

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

interface RuleFileContext {
  fullPath: string;
  relativePath: string;
  extension: string;
  lineInfo: LineInfo[];
}

interface LogicalCodeLine {
  lineNumber: number;
  normalized: string;
}

interface NormalizedToken {
  lineNumber: number;
  token: string;
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
const MAX_COGNITIVE_COMPLEXITY = 15;
const MAX_NESTING_DEPTH = 2;
const MAX_FUNCTIONS_PER_FILE = 12;
const MAX_LINE_LENGTH = 150;
const DUPLICATE_LINE_WINDOW = 10;
const DUPLICATE_TOKEN_WINDOW = 100;
const FILE_LOC_LIMITS = new Map<string, number>([
  ["cli/internal/ui/model.go", 5000],
  ["src/tools/evaluation.ts", 1500],
]);
const REQUIRED_HEADER_FIELDS = ["summary", "purpose", "inputs", "returns/effects"] as const;
const REQUIRED_FUNCTION_HEADER_FIELDS = ["purpose", "inputs", "returns/effects"] as const;
const REQUIRED_PUBLIC_API_DOC_FIELDS = ["purpose", "inputs"] as const;
const CALLABLE_KINDS = new Set([SymbolKind.Function, SymbolKind.Method]);
const PUBLIC_API_KINDS = new Set([
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
]);
const IGNORED_PARAMETER_NAMES = new Set(["self", "this", "ctx", "cls"]);
const TRACKED_TODO_PATTERN = /\b(?:TODO|FIXME)\b:?\s+(?:[A-Z]+-\d+\b|https?:\/\/\S+|\d{4}-\d{2}-\d{2}\b|v?\d+\.\d+(?:\.\d+)?\b)/;
const WILDCARD_IMPORT_PATTERNS = [
  /^\s*from\s+\S+\s+import\s+\*/,
  /^\s*import\s+[\w.]+\.\*\s*;?\s*$/,
  /^\s*using\s+namespace\s+\w[\w:]*\s*;?\s*$/,
];
const COMMENTED_OUT_CODE_PATTERN = /(?:\b(?:if|for|while|switch|catch|return|import|export|class|def|func|const|let|var)\b|=>|==|!=|=\s*[^=]|[{()}];?$)/;
const NORMALIZED_TOKEN_PATTERN = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|[A-Za-z_][$\w]*|==|!=|<=|>=|=>|->|::|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||[{}()[\].,;:+\-*/%<>=!?&|^~]/g;
const LANGUAGE_KEYWORDS = new Set([
  "and",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "do",
  "else",
  "enum",
  "except",
  "export",
  "extends",
  "false",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "let",
  "loop",
  "match",
  "mod",
  "new",
  "nil",
  "None",
  "null",
  "package",
  "pub",
  "raise",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "use",
  "using",
  "var",
  "void",
  "while",
]);
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
const COGNITIVE_COMPLEXITY_NODE_TYPES: Record<string, Set<string>> = {
  c: new Set(["if_statement", "for_statement", "while_statement", "do_statement", "switch_statement", "conditional_expression"]),
  cpp: new Set(["if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement", "conditional_expression", "catch_clause"]),
  c_sharp: new Set(["if_statement", "for_statement", "for_each_statement", "while_statement", "do_statement", "switch_statement", "conditional_expression", "catch_clause"]),
  go: new Set(["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement"]),
  java: new Set(["if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "switch_expression", "switch_statement", "ternary_expression", "catch_clause"]),
  javascript: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "ternary_expression", "catch_clause"]),
  kotlin: new Set(["if_expression", "for_statement", "while_statement", "do_while_statement", "when_expression", "try_expression"]),
  python: new Set(["if_statement", "for_statement", "while_statement", "except_clause", "match_statement", "conditional_expression"]),
  rust: new Set(["if_expression", "for_expression", "while_expression", "loop_expression", "match_expression"]),
  swift: new Set(["if_statement", "for_statement", "while_statement", "repeat_while_statement", "switch_statement", "catch_clause"]),
  tsx: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "ternary_expression", "catch_clause"]),
  typescript: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "ternary_expression", "catch_clause"]),
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

// Purpose: Check whether a filesystem path exists without surfacing the stat failure.
// Inputs: An absolute or repo-relative filesystem path string.
// Returns/Effects: Returns true when the path resolves on disk, otherwise false.
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Purpose: Resolve a Node-installed tool from either the repo or package-local node_modules tree.
// Inputs: A repository root directory and the relative executable path inside a package.
// Returns/Effects: Returns the resolved executable path when present, otherwise null.
async function resolveNodeTool(rootDir: string, relativePath: string): Promise<string | null> {
  const localPath = resolve(rootDir, "node_modules", relativePath);
  if (await pathExists(localPath)) return localPath;
  const packagePath = resolve(PACKAGE_ROOT, "node_modules", relativePath);
  if (await pathExists(packagePath)) return packagePath;
  return null;
}

// Purpose: Execute one native lint command and normalize its stdout, stderr, and exit code.
// Inputs: A command binary, its argument vector, the working directory, and a tool label.
// Returns/Effects: Returns a native lint result object after spawning the external process.
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

// Purpose: Expand an optional lint target into the concrete files that static analysis should inspect.
// Inputs: A repository root directory and an optional file-or-directory target path.
// Returns/Effects: Returns the matching file paths, walking directories when needed.
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

// Purpose: Derive per-line metadata used by the rule validators from raw file contents.
// Inputs: A repository-relative file path and the file's raw text split into lines.
// Returns/Effects: Returns line records with blank and comment classification for each source line.
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

// Purpose: Count the non-comment lines inside an inclusive line range for one file.
// Inputs: Line metadata plus the starting and ending line numbers to inspect.
// Returns/Effects: Returns the non-comment logical line count within the requested span.
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

// Purpose: Remove inline comments while preserving quoted strings used in code comparisons.
// Inputs: One source line and the source-file extension that determines comment syntax.
// Returns/Effects: Returns the source text with inline comments removed where safe.
function stripInlineComments(text: string, extension: string): string {
  let stripped = BLOCK_COMMENT_EXTENSIONS.has(extension)
    ? text.replace(/\/\*.*?\*\//g, " ")
    : text;
  const prefix = COMMENT_PREFIXES[extension];
  if (!prefix) return stripped;

  let quote: string | null = null;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (quote) {
      if (char === "\\" && index + 1 < stripped.length) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (stripped.startsWith(prefix, index)) {
      return stripped.slice(0, index);
    }
  }

  return stripped;
}

// Purpose: Normalize literals and whitespace so duplicate-block checks compare stable code shapes.
// Inputs: A code snippet with comments already removed.
// Returns/Effects: Returns normalized text with literals canonicalized for comparison.
function normalizeCodeText(text: string): string {
  return text
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "__STR__")
    .replace(/\b\d+(?:\.\d+)?\b/g, "__NUM__")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoilerplateLine(text: string): boolean {
  return /^(?:import|from|package|using|use|namespace|module|#include)\b/.test(text)
    || /^[{}()[\];,]+$/.test(text);
}

// Purpose: Collect normalized, signal-bearing code lines for duplicate-line detection.
// Inputs: One rule-file context containing extension, path, and per-line metadata.
// Returns/Effects: Returns normalized logical code lines with original source line numbers.
function collectLogicalCodeLines(context: RuleFileContext): LogicalCodeLine[] {
  return context.lineInfo.flatMap((line) => {
    if (line.isBlank || line.isCommentOnly) return [];
    const stripped = stripInlineComments(line.text, context.extension).trim();
    if (stripped.length === 0 || isBoilerplateLine(stripped)) return [];
    const normalized = normalizeCodeText(stripped);
    if (normalized.length === 0) return [];
    return [{ lineNumber: line.lineNumber, normalized }];
  });
}

// Purpose: Canonicalize identifier-like tokens while preserving structural punctuation and sentinels.
// Inputs: One normalized token produced by the duplicate-block tokenizer.
// Returns/Effects: Returns a comparable token representation for duplicate-token matching.
function normalizeToken(token: string): string {
  if (/^__(?:STR|NUM)__$/.test(token)) return token;
  if (/^[A-Za-z_][$\w]*$/.test(token) && !LANGUAGE_KEYWORDS.has(token)) return "__ID__";
  return token;
}

// Purpose: Tokenize normalized code into a stream suitable for duplicate-token detection.
// Inputs: One rule-file context containing the source lines and extension metadata.
// Returns/Effects: Returns normalized tokens annotated with their originating source line.
function collectNormalizedTokens(context: RuleFileContext): NormalizedToken[] {
  return context.lineInfo.flatMap((line) => {
    if (line.isBlank || line.isCommentOnly) return [];
    const stripped = stripInlineComments(line.text, context.extension).trim();
    if (stripped.length === 0 || isBoilerplateLine(stripped)) return [];
    const normalized = normalizeCodeText(stripped);
    const tokens = normalized.match(NORMALIZED_TOKEN_PATTERN) ?? [];
    return tokens.map((token) => ({
      lineNumber: line.lineNumber,
      token: normalizeToken(token),
    }));
  });
}

// Purpose: Filter duplicate-line windows down to spans with enough signal to matter.
// Inputs: A candidate duplicate window made of normalized logical code lines.
// Returns/Effects: Returns true when the window carries enough non-trivial content to report.
function hasUsefulDuplicateLineWindow(window: LogicalCodeLine[]): boolean {
  const signal = window
    .map((line) => line.normalized)
    .join(" ")
    .replace(/__STR__|__NUM__/g, "")
    .replace(/[^A-Za-z0-9]+/g, "");
  return signal.length >= 40;
}

function hasUsefulDuplicateTokenWindow(window: NormalizedToken[]): boolean {
  return new Set(window.map((entry) => entry.token)).size >= 8;
}

// Purpose: Detect duplicated logical line and token windows across the lint target contexts.
// Inputs: The rule-file contexts prepared for the current static-analysis run.
// Returns/Effects: Returns duplicate-block findings sorted by file and source line.
function validateDuplicateBlocks(contexts: RuleFileContext[]): RuleFinding[] {
  const orderedContexts = [...contexts].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const findingByLocation = new Map<string, { weight: number; finding: RuleFinding }>();
  const lastReportedRun = new Map<string, { currentLine: number; originalLine: number }>();

  // Purpose: Record the strongest duplicate finding for one source location while coalescing nearby runs.
  // Inputs: The current and original file locations plus the duplicate kind and matched span size.
  // Returns/Effects: Updates the in-memory duplicate finding maps for the enclosing validator.
  function recordDuplicate(
    currentFile: string,
    currentLine: number,
    originalFile: string,
    originalLine: number,
    kind: "lines" | "tokens",
    size: number,
  ): void {
    const runKey = `${kind}:${currentFile}:${originalFile}`;
    const previousRun = lastReportedRun.get(runKey);
    if (
      previousRun
      && currentLine <= previousRun.currentLine + 2
      && originalLine <= previousRun.originalLine + 2
    ) {
      return;
    }

    const key = `${currentFile}:${currentLine}`;
    const finding: RuleFinding = {
      file: currentFile,
      line: currentLine,
      rule: "no-duplicate-blocks",
      severity: "error",
      message: kind === "lines"
        ? `Block duplicates ${size} logical lines already seen at ${originalFile}:${originalLine}.`
        : `Block duplicates ${size} successive normalized tokens already seen at ${originalFile}:${originalLine}.`,
    };
    const weight = kind === "tokens" ? size + 1000 : size;
    const existing = findingByLocation.get(key);
    if (!existing || weight > existing.weight) {
      findingByLocation.set(key, { weight, finding });
    }
    lastReportedRun.set(runKey, { currentLine, originalLine });
  }

  const lineWindows = new Map<string, Array<{ file: string; line: number; index: number }>>();
  for (const context of orderedContexts) {
    const logicalLines = collectLogicalCodeLines(context);
    for (let index = 0; index <= logicalLines.length - DUPLICATE_LINE_WINDOW; index += 1) {
      const window = logicalLines.slice(index, index + DUPLICATE_LINE_WINDOW);
      if (!hasUsefulDuplicateLineWindow(window)) continue;
      const signature = window.map((line) => line.normalized).join("\n");
      const previousMatches = lineWindows.get(signature) ?? [];
      const currentLine = window[0].lineNumber;
      const previous = previousMatches.find((match) =>
        match.file !== context.relativePath || Math.abs(match.index - index) >= DUPLICATE_LINE_WINDOW,
      );
      if (previous) {
        recordDuplicate(
          context.relativePath,
          currentLine,
          previous.file,
          previous.line,
          "lines",
          DUPLICATE_LINE_WINDOW,
        );
      }
      previousMatches.push({ file: context.relativePath, line: currentLine, index });
      lineWindows.set(signature, previousMatches);
    }
  }

  const tokenWindows = new Map<string, Array<{ file: string; line: number; index: number }>>();
  for (const context of orderedContexts) {
    const tokens = collectNormalizedTokens(context);
    for (let index = 0; index <= tokens.length - DUPLICATE_TOKEN_WINDOW; index += 1) {
      const window = tokens.slice(index, index + DUPLICATE_TOKEN_WINDOW);
      if (!hasUsefulDuplicateTokenWindow(window)) continue;
      const signature = window.map((entry) => entry.token).join(" ");
      const previousMatches = tokenWindows.get(signature) ?? [];
      const currentLine = window[0].lineNumber;
      const previous = previousMatches.find((match) =>
        match.file !== context.relativePath || Math.abs(match.index - index) >= DUPLICATE_TOKEN_WINDOW,
      );
      if (previous) {
        recordDuplicate(
          context.relativePath,
          currentLine,
          previous.file,
          previous.line,
          "tokens",
          DUPLICATE_TOKEN_WINDOW,
        );
      }
      previousMatches.push({ file: context.relativePath, line: currentLine, index });
      tokenWindows.set(signature, previousMatches);
    }
  }

  return [...findingByLocation.values()]
    .map((entry) => entry.finding)
    .sort((left, right) =>
      left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0),
    );
}

// Purpose: Extract the final top-level parameter group from a callable signature string.
// Inputs: A reconstructed callable signature gathered from parser or source lines.
// Returns/Effects: Returns the innermost parameter text for counting, or null when absent.
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

// Purpose: Split a parameter group on top-level commas without breaking nested syntax.
// Inputs: The raw parameter-group substring taken from a callable signature.
// Returns/Effects: Returns the individual parameter fragments in declaration order.
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

// Purpose: Decide whether one parsed parameter should be ignored for parameter-count enforcement.
// Inputs: A single parameter fragment reconstructed from a callable signature.
// Returns/Effects: Returns true for ignorable placeholders such as `self`, `this`, or empty markers.
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

// Purpose: Count the meaningful parameters declared by a callable signature.
// Inputs: A reconstructed callable signature string from the analyzed source.
// Returns/Effects: Returns the parameter count after filtering ignorable placeholders.
function countParameters(signature: string): number {
  const parameterGroup = extractParameterGroup(signature);
  if (!parameterGroup) return 0;
  return splitTopLevelParameters(parameterGroup)
    .filter((parameter) => !shouldIgnoreParameter(parameter))
    .length;
}

// Purpose: Reconstruct a readable callable signature from source lines for lint messages.
// Inputs: The callable line range, file line metadata, and a parser-provided fallback signature.
// Returns/Effects: Returns a signature string suitable for user-facing diagnostics.
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

// Purpose: Validate the file-level summary header required at the top of supported source files.
// Inputs: A repository-relative file path and the raw source lines for that file.
// Returns/Effects: Returns header findings for missing or incomplete top-of-file metadata.
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
  if (headerLines.length < REQUIRED_HEADER_FIELDS.length) {
    return [{
      file,
      line: headerStart + 1,
      rule: "header",
      severity: "error",
      message: `The header must begin with at least ${REQUIRED_HEADER_FIELDS.length} ${prefix} comment lines for summary, purpose, inputs, and returns/effects.`,
    }];
  }
  const findings: RuleFinding[] = [];
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

// Purpose: Flag files whose non-comment LOC exceeds the configured per-file limit.
// Inputs: A repository-relative file path and its derived line metadata.
// Returns/Effects: Returns a size finding when the file is too large for the configured limit.
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

// Purpose: Flag source lines that exceed the repository line-length policy.
// Inputs: A repository-relative file path and its derived line metadata.
// Returns/Effects: Returns line-length findings for overlong non-exempt lines.
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

// Purpose: Enforce tracked TODO and FIXME comments that point to real follow-up work.
// Inputs: A repository-relative file path and its derived line metadata.
// Returns/Effects: Returns findings for untracked TODO or FIXME comments.
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

// Purpose: Detect wildcard imports that weaken review clarity and dependency precision.
// Inputs: A repository-relative file path and its derived line metadata.
// Returns/Effects: Returns findings for wildcard or namespace-wide import statements.
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

// Purpose: Detect executable lines that pack multiple semicolon-terminated statements together.
// Inputs: A repository-relative file path and its derived line metadata.
// Returns/Effects: Returns findings for multi-statement lines outside valid loop syntax.
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

// Purpose: Detect adjacent comment-only lines that look like commented-out code blocks.
// Inputs: A repository-relative file path and its derived line metadata.
// Returns/Effects: Returns findings for suspicious commented-out code spans.
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

// Purpose: Collect the contiguous comment block immediately above a symbol or callable.
// Inputs: The starting source line for the target node and the file's line metadata.
// Returns/Effects: Returns the adjacent comment-only lines directly above that source line.
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

// Purpose: Check whether a structured doc block includes one accepted return or side-effect field.
// Inputs: The normalized comment lines extracted from a structured documentation block.
// Returns/Effects: Returns true when the block documents returns, effects, or both.
function hasReturnOrEffectsField(lines: string[]): boolean {
  return lines.some((line) =>
    line.startsWith("returns:")
    || line.startsWith("effects:")
    || line.startsWith("returns/effects:"),
  );
}

// Purpose: Enforce the 3-line structured header required above non-trivial callable bodies.
// Inputs: The file path, callable line, rendered signature, callable LOC, and line metadata.
// Returns/Effects: Returns findings for missing or incomplete callable header blocks.
function validateFunctionHeaderBlock(
  file: string,
  callableLine: number,
  signatureText: string,
  nonCommentLoc: number,
  lineInfo: LineInfo[],
): RuleFinding[] {
  if (nonCommentLoc <= 4) return [];
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

// Purpose: Decide whether one parsed symbol should be treated as a public API surface.
// Inputs: The rendered signature text, resolved symbol name, and parser grammar identifier.
// Returns/Effects: Returns true when the symbol appears publicly reachable in its language.
function isLikelyPublicApi(signatureText: string, symbolName: string, grammarName: string): boolean {
  if (grammarName === "typescript" || grammarName === "javascript" || grammarName === "tsx") {
    return /\bexport\b/.test(signatureText);
  }
  if (grammarName === "python") {
    return !symbolName.startsWith("_");
  }
  if (grammarName === "go") {
    return /^[A-Z]/.test(symbolName);
  }
  if (grammarName === "rust") {
    return /\bpub\b/.test(signatureText);
  }
  if (grammarName === "java" || grammarName === "c_sharp") {
    return /\bpublic\b/.test(signatureText);
  }
  return false;
}

// Purpose: Validate the structured public API doc block required above exported symbols.
// Inputs: The file path, symbol line, rendered signature, and file line metadata.
// Returns/Effects: Returns findings for missing or incomplete public API documentation.
function validatePublicApiDocBlock(
  file: string,
  symbolLine: number,
  signatureText: string,
  lineInfo: LineInfo[],
): RuleFinding[] {
  const block = collectImmediateCommentBlock(symbolLine, lineInfo);
  if (block.length === 0) {
    return [{
      file,
      line: symbolLine,
      rule: "public-api-requires-doc",
      severity: "error",
      message: `${signatureText} must have a structured public API doc block directly above it.`,
    }];
  }

  const normalized = block.map((line) => line.text.toLowerCase());
  const missingField = REQUIRED_PUBLIC_API_DOC_FIELDS.find((field) =>
    !normalized.some((line) => line.startsWith(`${field}:`)),
  );
  if (missingField) {
    return [{
      file,
      line: symbolLine,
      rule: "public-api-requires-doc",
      severity: "error",
      message: `${signatureText} is missing the "${missingField}:" line in its public API doc block.`,
    }];
  }
  if (!hasReturnOrEffectsField(normalized)) {
    return [{
      file,
      line: symbolLine,
      rule: "public-api-requires-doc",
      severity: "error",
      message: `${signatureText} must document either "Returns:", "Effects:", or "Returns/Effects:".`,
    }];
  }

  return [];
}

// Purpose: Check whether a public signature uses explicit parameter and return typing for its language.
// Inputs: The rendered signature text and the parser grammar identifier for that source file.
// Returns/Effects: Returns true when the signature satisfies the typed public interface policy.
function hasTypedPublicInterface(signatureText: string, grammarName: string): boolean {
  const trimmed = signatureText.trim();

  if (grammarName === "typescript" || grammarName === "tsx") {
    const hasTypedParameters = /\([^)]*:\s*[^,)]+/.test(trimmed) || /\(\s*\)/.test(trimmed);
    const hasReturnType = /\)\s*:\s*[^{=]+/.test(trimmed);
    return hasTypedParameters && hasReturnType;
  }

  if (grammarName === "python") {
    const hasTypedParameters = /\([^)]*:\s*[^,)]+/.test(trimmed) || /\(\s*(?:self|cls)?\s*\)/.test(trimmed);
    const hasReturnType = /\)\s*->\s*[^:]+:/.test(trimmed);
    return hasTypedParameters && hasReturnType;
  }

  if (grammarName === "go") {
    const parameterList = trimmed.match(/\(([^)]*)\)/)?.[1] ?? "";
    const hasTypedParameters = parameterList.trim().length === 0 || /\b[A-Za-z_]\w*\s+[\*\[\]A-Za-z_]/.test(parameterList);
    const hasReturnType = /\)\s+[({\[*A-Za-z_]/.test(trimmed) && !/\)\s*\{/.test(trimmed);
    return hasTypedParameters && hasReturnType;
  }

  if (grammarName === "java" || grammarName === "c_sharp") {
    const parameterList = trimmed.match(/\(([^)]*)\)/)?.[1] ?? "";
    const hasTypedParameters = parameterList.trim().length === 0 || /\b(?:final\s+)?[A-Za-z_<>\[\]?.,]+\s+[A-Za-z_]\w*/.test(parameterList);
    const beforeParen = trimmed.split("(")[0] ?? "";
    const hasReturnType = /\b[A-Za-z_<>\[\]?.,]+\s+[A-Za-z_]\w*$/.test(beforeParen);
    return hasTypedParameters && hasReturnType;
  }

  if (grammarName === "rust") {
    const parameterList = trimmed.match(/\(([^)]*)\)/)?.[1] ?? "";
    const parameters = parameterList
      .split(",")
      .map((parameter) => parameter.trim())
      .filter((parameter) => parameter.length > 0 && parameter !== "&self" && parameter !== "&mut self" && parameter !== "self");
    const hasTypedParameters = parameters.every((parameter) => /:\s*[^,]+/.test(parameter));
    const hasReturnType = /\)\s*->\s*[^{]+/.test(trimmed);
    return hasTypedParameters && hasReturnType;
  }

  return true;
}

// Purpose: Emit a finding when a public API surface lacks an explicit typed boundary.
// Inputs: The file path, symbol line, rendered signature, and parser grammar identifier.
// Returns/Effects: Returns either an empty list or one typed-interface finding for the symbol.
function validateTypedPublicInterface(
  file: string,
  symbolLine: number,
  signatureText: string,
  grammarName: string,
): RuleFinding[] {
  if (grammarName === "javascript") return [];
  if (hasTypedPublicInterface(signatureText, grammarName)) return [];
  return [{
    file,
    line: symbolLine,
    rule: "typed-public-interfaces",
    severity: "error",
    message: `${signatureText} must declare typed public parameters and a typed return boundary.`,
  }];
}

// Purpose: Decide whether an AST initializer node represents obvious mutable top-level state.
// Inputs: An AST node candidate plus the parser grammar identifier for the current file.
// Returns/Effects: Returns true when the initializer shape indicates mutable shared state.
function isLikelyMutableTopLevelInitializer(node: any, grammarName: string): boolean {
  if (!node) return false;
  const mutableNodeTypes = new Set([
    "array",
    "array_expression",
    "array_literal",
    "dictionary",
    "list",
    "map_literal",
    "new_expression",
    "object",
    "object_pattern",
    "object_type",
    "object_creation_expression",
    "object_creation_expr",
    "set",
    "set_or_dict",
    "vector_expression",
  ]);
  if (mutableNodeTypes.has(node.type)) return true;
  const text = node.text ?? "";
  if (grammarName === "python") {
    return text === "{}" || text === "[]" || /^dict\(/.test(text) || /^list\(/.test(text) || /^set\(/.test(text);
  }
  if (grammarName === "typescript" || grammarName === "javascript" || grammarName === "tsx") {
    return text === "{}" || text === "[]" || /^new\s+(Map|Set|WeakMap|WeakSet)\b/.test(text);
  }
  return false;
}

// Purpose: Run AST-backed checks that reject obvious mutable top-level state across supported languages.
// Inputs: A repository-relative file path, its absolute path, and the derived line metadata.
// Returns/Effects: Returns mutable-state findings or an AST-analysis failure for unsupported parsing paths.
async function validateGlobalMutableState(file: string, fullPath: string, lineInfo: LineInfo[]): Promise<RuleFinding[]> {
  const extension = extname(fullPath).toLowerCase();
  if (!isSupportedFile(fullPath)) return [];

  try {
    return await withSyntaxTree(
      lineInfo.map((line) => line.text).join("\n"),
      extension,
      ({ rootNode, grammarName }) => {
        const findings: RuleFinding[] = [];

        // Purpose: Append one mutable-state finding tied to the AST node currently under review.
        // Inputs: The offending AST node and a short explanation of why it is mutable.
        // Returns/Effects: Pushes a new rule finding into the enclosing findings array.
        function addFinding(node: any, detail: string): void {
          findings.push({
            file,
            line: node.startPosition.row + 1,
            rule: "no-global-mutable-state",
            severity: "error",
            message: `${lineInfo[node.startPosition.row]?.trimmed ?? node.type} creates mutable top-level state (${detail}).`,
          });
        }

        if (grammarName === "typescript" || grammarName === "javascript" || grammarName === "tsx") {
          for (const child of rootNode.namedChildren ?? []) {
            if (child.type !== "lexical_declaration" && child.type !== "variable_declaration") continue;
            const declarationText = child.text ?? "";
            const isLetOrVar = declarationText.startsWith("let ") || declarationText.startsWith("var ");
            for (const declarator of child.namedChildren ?? []) {
              if (declarator.type !== "variable_declarator") continue;
              const initializer = declarator.namedChildren?.[1];
              if (isLetOrVar) {
                addFinding(child, "top-level let/var declaration");
                continue;
              }
              if (isLikelyMutableTopLevelInitializer(initializer, grammarName)) {
                addFinding(child, "top-level mutable container");
              }
            }
          }
          return findings;
        }

        if (grammarName === "python") {
          for (const child of rootNode.namedChildren ?? []) {
            if (child.type !== "expression_statement") continue;
            const assignment = child.namedChildren?.find((node: any) => node.type === "assignment");
            if (!assignment) continue;
            const target = assignment.namedChildren?.[0];
            const value = assignment.namedChildren?.[1];
            const targetName = target?.text ?? "";
            if (targetName === targetName.toUpperCase()) continue;
            if (isLikelyMutableTopLevelInitializer(value, grammarName) || value?.type === "none") {
              addFinding(child, "module-level mutable assignment");
            }
          }
          return findings;
        }

        if (grammarName === "go") {
          for (const child of rootNode.namedChildren ?? []) {
            if (child.type !== "var_declaration") continue;
            addFinding(child, "package-level var declaration");
          }
          return findings;
        }

        if (grammarName === "rust") {
          for (const child of rootNode.namedChildren ?? []) {
            if (child.type === "static_item" && child.text.includes("static mut")) {
              addFinding(child, "static mut declaration");
            }
          }
          return findings;
        }

        if (grammarName === "java") {
          const stack = [rootNode];
          while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;
            if (current.type === "field_declaration") {
              const modifiers = current.namedChildren?.find((node: any) => node.type === "modifiers")?.text ?? "";
              if (modifiers.includes("static") && !modifiers.includes("final")) {
                addFinding(current, "mutable static field");
              }
            }
            for (const child of current.namedChildren ?? []) stack.push(child);
          }
          return findings;
        }

        if (grammarName === "c_sharp") {
          const stack = [rootNode];
          while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;
            if (current.type === "field_declaration") {
              const modifiers = (current.namedChildren ?? [])
                .filter((node: any) => node.type === "modifier")
                .map((node: any) => node.text);
              if (modifiers.includes("static") && !modifiers.includes("readonly") && !modifiers.includes("const")) {
                addFinding(current, "mutable static field");
              }
            }
            for (const child of current.namedChildren ?? []) stack.push(child);
          }
          return findings;
        }

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
      message: `AST-backed global mutable state analysis could not analyze this file: ${message}`,
    }];
  }
}

// Purpose: Detect whether a catch handler body escalates failure by rethrowing or raising.
// Inputs: An AST node representing the handler body and the parser grammar identifier.
// Returns/Effects: Returns true when the block contains an escalation statement.
function blockContainsEscalation(node: any, grammarName: string): boolean {
  const escalationNodeTypes = new Set(
    grammarName === "python"
      ? ["raise_statement"]
      : ["throw_statement"],
  );
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (escalationNodeTypes.has(current.type)) return true;
    for (const child of current.namedChildren ?? []) stack.push(child);
  }
  return false;
}

// Purpose: Detect broad catch handlers that likely swallow failures in each supported language.
// Inputs: One AST node candidate and the parser grammar identifier for the current file.
// Returns/Effects: Returns true when the node represents a generic catch or except clause.
function isGenericCatchClause(node: any, grammarName: string): boolean {
  if (grammarName === "typescript" || grammarName === "javascript" || grammarName === "tsx") {
    return node.type === "catch_clause";
  }
  if (grammarName === "python") {
    if (node.type !== "except_clause") return false;
    const identifier = node.namedChildren?.find((child: any) => child.type === "identifier");
    if (!identifier) return true;
    return identifier.text === "Exception" || identifier.text === "BaseException";
  }
  if (grammarName === "java") {
    if (node.type !== "catch_clause") return false;
    const declaration = node.namedChildren?.find((child: any) => child.type === "catch_formal_parameter");
    return declaration?.text?.includes("Exception") || declaration?.text?.includes("Throwable");
  }
  if (grammarName === "c_sharp") {
    if (node.type !== "catch_clause") return false;
    const declaration = node.namedChildren?.find((child: any) => child.type === "catch_declaration");
    return declaration?.text?.includes("Exception") || declaration?.text?.includes("System.Exception");
  }
  if (grammarName === "cpp") {
    if (node.type !== "catch_clause") return false;
    const parameterList = node.namedChildren?.find((child: any) => child.type === "parameter_list");
    return parameterList?.text === "(...)";
  }
  return false;
}

// Purpose: Run AST-backed checks that reject generic catch handlers which fail to escalate errors.
// Inputs: A repository-relative file path, its absolute path, and the derived line metadata.
// Returns/Effects: Returns generic-catch findings or an AST-analysis failure for the file.
async function validateGenericCatch(file: string, fullPath: string, lineInfo: LineInfo[]): Promise<RuleFinding[]> {
  const extension = extname(fullPath).toLowerCase();
  if (!isSupportedFile(fullPath)) return [];

  try {
    return await withSyntaxTree(
      lineInfo.map((line) => line.text).join("\n"),
      extension,
      ({ rootNode, grammarName }) => {
        if (!["typescript", "javascript", "tsx", "python", "java", "c_sharp", "cpp"].includes(grammarName)) {
          return [];
        }
        const findings: RuleFinding[] = [];

        // Purpose: Walk the syntax tree and collect generic catch findings for matching handler nodes.
        // Inputs: The current AST node in the recursive syntax-tree traversal.
        // Returns/Effects: Pushes generic-catch findings into the enclosing findings array.
        function visit(node: any): void {
          if (isGenericCatchClause(node, grammarName)) {
            const handlerBlock = node.namedChildren?.find((child: any) =>
              child.type === "block"
              || child.type === "statement_block"
              || child.type === "compound_statement",
            );
            if (handlerBlock && !blockContainsEscalation(handlerBlock, grammarName)) {
              findings.push({
                file,
                line: node.startPosition.row + 1,
                rule: "no-generic-catch",
                severity: "error",
                message: `${lineInfo[node.startPosition.row]?.trimmed ?? node.type} catches too broadly and swallows the failure instead of escalating it.`,
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
      message: `AST-backed generic catch analysis could not analyze this file: ${message}`,
    }];
  }
}

// Purpose: Compute the deepest nested control-flow level inside one callable subtree.
// Inputs: An AST node, grammar identifier, current depth, and root-callable traversal flag.
// Returns/Effects: Returns the maximum control-flow nesting depth below the provided node.
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

function countConditionDecisionPoints(node: any): number {
  const text = node?.text ?? "";
  return (text.match(/&&|\|\|/g) ?? []).length;
}

// Purpose: Compute cognitive complexity for one callable subtree using the repository scoring rules.
// Inputs: An AST node, grammar identifier, current nesting level, and root-callable traversal flag.
// Returns/Effects: Returns the accumulated cognitive complexity score for that subtree.
function computeCognitiveComplexity(
  node: any,
  grammarName: string,
  nestingLevel: number,
  isRootCallable: boolean,
): number {
  const complexityTypes = COGNITIVE_COMPLEXITY_NODE_TYPES[grammarName] ?? new Set<string>();
  const functionTypes = FUNCTION_NODE_TYPES[grammarName] ?? new Set<string>();
  const isCallableNode = functionTypes.has(node.type);
  if (!isRootCallable && isCallableNode) return 0;

  let score = 0;
  const isComplexityNode = complexityTypes.has(node.type);
  const nextNestingLevel = isComplexityNode ? nestingLevel + 1 : nestingLevel;

  if (isComplexityNode) {
    score += 1 + nestingLevel;
    if (node.type === "if_statement" || node.type === "if_expression") {
      const conditionNode = node.namedChildren?.find((child: any) =>
        child.type === "condition_clause"
        || child.type === "parenthesized_expression"
        || child.type === "binary_expression"
        || child.type === "identifier"
        || child.type === "comparison_operator"
      ) ?? node.namedChildren?.[0];
      score += countConditionDecisionPoints(conditionNode);
    }
    if (
      node.type === "while_statement"
      || node.type === "while_expression"
      || node.type === "for_statement"
      || node.type === "for_expression"
      || node.type === "for_in_statement"
    ) {
      score += countConditionDecisionPoints(node);
    }
  }

  for (const child of node.namedChildren ?? []) {
    score += computeCognitiveComplexity(child, grammarName, nextNestingLevel, false);
  }

  return score;
}

// Purpose: Run AST-backed checks that flag callables exceeding the configured nesting-depth limit.
// Inputs: A repository-relative file path, its absolute path, and the derived line metadata.
// Returns/Effects: Returns nesting-depth findings or an AST-analysis failure for the file.
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

        // Purpose: Walk each callable subtree and emit findings for excessive control-flow nesting.
        // Inputs: The current AST node in the recursive syntax-tree traversal.
        // Returns/Effects: Pushes nesting-depth findings into the enclosing findings array.
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

// Purpose: Run AST-backed checks that flag callables exceeding the cognitive-complexity threshold.
// Inputs: A repository-relative file path, its absolute path, and the derived line metadata.
// Returns/Effects: Returns cognitive-complexity findings or an AST-analysis failure for the file.
async function validateCognitiveComplexity(file: string, fullPath: string, lineInfo: LineInfo[]): Promise<RuleFinding[]> {
  const extension = extname(fullPath).toLowerCase();
  if (!isSupportedFile(fullPath)) return [];

  try {
    return await withSyntaxTree(
      lineInfo.map((line) => line.text).join("\n"),
      extension,
      ({ rootNode, grammarName }) => {
        const functionTypes = FUNCTION_NODE_TYPES[grammarName] ?? new Set<string>();
        const findings: RuleFinding[] = [];

        // Purpose: Walk each callable subtree and emit findings for excessive cognitive complexity.
        // Inputs: The current AST node in the recursive syntax-tree traversal.
        // Returns/Effects: Pushes cognitive-complexity findings into the enclosing findings array.
        function visit(node: any): void {
          if (functionTypes.has(node.type)) {
            const complexity = computeCognitiveComplexity(node, grammarName, 0, true);
            if (complexity > MAX_COGNITIVE_COMPLEXITY) {
              const signatureText = buildCallableSignatureText(
                node.startPosition.row + 1,
                node.endPosition.row + 1,
                lineInfo,
                lineInfo[node.startPosition.row]?.trimmed ?? node.type,
              );
              findings.push({
                file,
                line: node.startPosition.row + 1,
                rule: "max-cognitive-complexity",
                severity: "error",
                message: `${signatureText} exceeds cognitive complexity ${MAX_COGNITIVE_COMPLEXITY} (${complexity}).`,
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
      message: `AST-backed cognitive complexity analysis could not analyze this file: ${message}`,
    }];
  }
}

// Purpose: Run AST-backed checks that enforce docs and typed boundaries for public APIs.
// Inputs: A repository-relative file path, its absolute path, and the derived line metadata.
// Returns/Effects: Returns public-API documentation findings or an AST-analysis failure for the file.
async function validatePublicApiDocs(file: string, fullPath: string, lineInfo: LineInfo[]): Promise<RuleFinding[]> {
  const extension = extname(fullPath).toLowerCase();
  if (!isSupportedFile(fullPath)) return [];

  try {
    return await withSyntaxTree(
      lineInfo.map((line) => line.text).join("\n"),
      extension,
      ({ rootNode, grammarName }) => {
        const functionTypes = FUNCTION_NODE_TYPES[grammarName] ?? new Set<string>();
        const findings: RuleFinding[] = [];

        // Purpose: Walk the syntax tree and emit doc and type findings for public symbols.
        // Inputs: The current AST node in the recursive syntax-tree traversal.
        // Returns/Effects: Pushes public API findings into the enclosing findings array.
        function visit(node: any): void {
          const lineNumber = node.startPosition.row + 1;
          const signatureText = buildCallableSignatureText(
            lineNumber,
            node.endPosition.row + 1,
            lineInfo,
            lineInfo[node.startPosition.row]?.trimmed ?? node.type,
          );
          const nameText = (() => {
            const nameNode = node.childForFieldName?.("name");
            if (nameNode?.text) return nameNode.text;
            const declarator = node.childForFieldName?.("declarator");
            if (declarator?.text) return declarator.text;
            return "";
          })();

          const kindFromNode = (() => {
            if (functionTypes.has(node.type)) return SymbolKind.Function;
            if (node.type.includes("class")) return SymbolKind.Class;
            return null;
          })();

          if (
            kindFromNode
            && PUBLIC_API_KINDS.has(kindFromNode)
            && isLikelyPublicApi(signatureText, nameText, grammarName)
          ) {
            findings.push(...validatePublicApiDocBlock(file, lineNumber, signatureText, lineInfo));
            findings.push(...validateTypedPublicInterface(file, lineNumber, signatureText, grammarName));
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
      message: `AST-backed public API doc analysis could not analyze this file: ${message}`,
    }];
  }
}

// Purpose: Validate callable-level metrics such as size, parameter count, and required headers.
// Inputs: A repository-relative file path, its absolute path, and the derived line metadata.
// Returns/Effects: Returns function-metric findings gathered from parser-produced callable symbols.
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

// Purpose: Run every repository hygiene rule across the supported files selected for linting.
// Inputs: A repository root directory and the absolute file paths selected for the lint target.
// Returns/Effects: Returns the complete rule finding list for the requested lint scope.
async function collectRuleFindings(rootDir: string, targetFiles: string[]): Promise<RuleFinding[]> {
  const findings: RuleFinding[] = [];
  const contexts: RuleFileContext[] = [];
  for (const file of getSupportedRuleFiles(targetFiles)) {
    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");
    const relativePath = relative(rootDir, file).replace(/\\/g, "/");
    const lineInfo = buildLineInfo(relativePath, lines);
    contexts.push({
      fullPath: file,
      relativePath,
      extension: extname(file).toLowerCase(),
      lineInfo,
    });
    findings.push(...validateHeader(relativePath, lines));
    findings.push(...validateFileLength(relativePath, lineInfo));
    findings.push(...validateLineLength(relativePath, lineInfo));
    findings.push(...validateTrackedTodos(relativePath, lineInfo));
    findings.push(...validateWildcardImports(relativePath, lineInfo));
    findings.push(...validateSingleStatementLines(relativePath, lineInfo));
    findings.push(...validateCommentedOutCode(relativePath, lineInfo));
    findings.push(...await validateGenericCatch(relativePath, file, lineInfo));
    findings.push(...await validateGlobalMutableState(relativePath, file, lineInfo));
    findings.push(...await validateFunctionMetrics(relativePath, file, lineInfo));
    findings.push(...await validateNestingDepth(relativePath, file, lineInfo));
    findings.push(...await validateCognitiveComplexity(relativePath, file, lineInfo));
    findings.push(...await validatePublicApiDocs(relativePath, file, lineInfo));
  }
  findings.push(...validateDuplicateBlocks(contexts));
  return findings;
}

// Purpose: Discover which native lint or typecheck commands apply to the current lint target.
// Inputs: A repository root, the selected target files, and an optional scoped target path.
// Returns/Effects: Returns the native lint command configurations that should be executed.
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

// Purpose: Render structured rule findings into the human-readable report line format.
// Inputs: The rule finding list produced by the static-analysis validators.
// Returns/Effects: Returns formatted finding lines for the final lint report.
function formatFindings(findings: RuleFinding[]): string[] {
  return findings.map((finding) => {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return `- [${finding.severity}] ${location} [${finding.rule}] ${finding.message}`;
  });
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Purpose: Summarize rule findings into a score plus error and warning counts.
// Inputs: The rule findings that should contribute to one lint score summary.
// Returns/Effects: Returns the computed score, error count, and warning count.
function summarizeRuleSeverities(findings: RuleFinding[]): ScoreSummary {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    score: clampScore(100 - errors * 18 - warnings * 6),
    errors,
    warnings,
  };
}

// Purpose: Combine rule findings and failing native tools into one repository score summary.
// Inputs: Rule findings from repository checks and native lint results with non-zero exits.
// Returns/Effects: Returns the final repository score including native tool penalties.
function summarizeRepoScore(findings: RuleFinding[], nativeFailures: NativeLintResult[]): ScoreSummary {
  const ruleSummary = summarizeRuleSeverities(findings);
  return {
    score: clampScore(ruleSummary.score - nativeFailures.length * 25),
    errors: ruleSummary.errors + nativeFailures.length,
    warnings: ruleSummary.warnings,
  };
}

// Purpose: Compute per-file lint scores so reports can highlight the lowest-scoring files first.
// Inputs: The complete rule finding list for the current lint run.
// Returns/Effects: Returns file-level score summaries sorted from worst to best.
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

// Purpose: Render a human-readable lint report from the structured static-analysis result model.
// Inputs: A completed static-analysis report with native diagnostics, findings, and score summaries.
// Returns/Effects: Returns formatted report text without mutating the underlying report data.
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

// Purpose: Build the structured static-analysis report for a repository root or scoped target path.
// Inputs: A repository root plus an optional file or directory target for linting.
// Returns/Effects: Returns the full lint report after running native tools and repository rule checks.
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

// Purpose: Run static analysis and return the formatted report text used by CLI and MCP surfaces.
// Inputs: A repository root plus an optional file or directory target for linting.
// Returns/Effects: Returns formatted lint output after building the structured static-analysis report.
export async function runStaticAnalysis(options: StaticAnalysisOptions): Promise<string> {
  return formatStaticAnalysisReport(await buildStaticAnalysisReport(options));
}
