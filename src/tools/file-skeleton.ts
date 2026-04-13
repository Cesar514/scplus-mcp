// summary: Extracts detailed function signatures and type surfaces without full file reads.
// FEATURE: Signature-first structural inspection without loading whole files.
// inputs: Target file paths, parsed symbols, and supported language inspection rules.
// outputs: Signature-first skeleton views with line ranges and type information.

import { analyzeFile, isSupportedFile, type FileAnalysis } from "../core/parser.js";
import { readFile } from "fs/promises";
import { resolve } from "path";

export interface SkeletonOptions {
  filePath: string;
  rootDir: string;
}

// Purpose: Format a symbol line range for the skeleton output.
// Inputs: The starting and ending source lines for the symbol.
// Returns/Effects: Returns a single-line or range-style line label.
function formatLineRange(line: number, endLine: number): string {
  return endLine > line ? `L${line}-L${endLine}` : `L${line}`;
}

// Purpose: Render the parsed symbol list into the compact signature-block skeleton format.
// Inputs: The analyzed file metadata and symbol tree.
// Returns/Effects: Returns the formatted signature block text for the file skeleton output.
function formatSignatureBlock(analysis: FileAnalysis): string {
  const lines: string[] = [];

  if (analysis.header) {
    lines.push(`// ${analysis.header}`);
    lines.push("");
  }

  for (const sym of analysis.symbols) {
    lines.push(`[${sym.kind}] ${formatLineRange(sym.line, sym.endLine)} ${sym.signature};`);
    for (const child of sym.children) {
      lines.push(`  [${child.kind}] ${formatLineRange(child.line, child.endLine)} ${child.signature};`);
    }
    if (sym.children.length > 0) lines.push("");
  }

  return lines.join("\n");
}

// Purpose: Produce a signature-first skeleton view for a target file within the repository root.
// Inputs: Skeleton options containing the repository root and target file path.
// Returns/Effects: Reads or analyzes the file and returns a skeleton or preview text representation.
export async function getFileSkeleton(options: SkeletonOptions): Promise<string> {
  const fullPath = resolve(options.rootDir, options.filePath);

  if (!isSupportedFile(fullPath)) {
    const content = await readFile(fullPath, "utf-8");
    const preview = content.split("\n").slice(0, 20).join("\n");
    return `[Unsupported language, showing first 20 lines]\n\n${preview}`;
  }

  const analysis = await analyzeFile(fullPath);

  if (analysis.symbols.length === 0) {
    const content = await readFile(fullPath, "utf-8");
    const preview = content.split("\n").slice(0, 30).join("\n");
    return `[No symbols detected, showing first 30 lines]\n\n${preview}`;
  }

  return [
    `File: ${options.filePath} (${analysis.lineCount} lines)`,
    `Symbols: ${analysis.symbols.length} top-level definitions`,
    "",
    formatSignatureBlock(analysis),
  ].join("\n");
}
