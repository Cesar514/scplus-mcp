// summary: Extracts symbols from supported source files using strict tree-sitter parsing.
// FEATURE: Explicit no-fallback source analysis over supported tree-sitter grammars.
// inputs: Source file contents, language detection, and pooled parser runtime access.
// outputs: Structured symbols, ranges, and explicit parse failures for unsupported inputs.

import { readFile } from "fs/promises";
import { extname } from "path";
import { getAnalyzableExtensions, parseWithTreeSitter } from "./tree-sitter.js";

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Method = "method",
  Enum = "enum",
  Interface = "interface",
  Struct = "struct",
  Type = "type",
  Trait = "trait",
  Const = "const",
  Variable = "variable",
  Export = "export",
}

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature: string;
  children: CodeSymbol[];
}

export interface SymbolLocation {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
}

export interface FileAnalysis {
  path: string;
  header: string;
  symbols: CodeSymbol[];
  lineCount: number;
}

// Purpose: Extract the short two-line file header summary from the start of a source file.
// Inputs: The source file split into lines.
// Returns/Effects: Returns a condensed header string built from the first meaningful comment lines.
function extractHeader(lines: string[]): string {
  const headerLines: string[] = [];
  for (const line of lines.slice(0, 10)) {
    const stripped = line.replace(/^\/\/\s?|^#\s?|^--\s?|^\*\s?|^\/\*\*?\s?|\*\/$/g, "").trim();
    if (stripped && !stripped.startsWith("!") && !stripped.startsWith("use ") && !stripped.startsWith("import ")) {
      headerLines.push(stripped);
      if (headerLines.length >= 2) break;
    }
  }
  return headerLines.join(" | ");
}

// Purpose: Read and analyze one source file into header metadata and parsed symbols.
// Inputs: The absolute or repository-relative file path to analyze.
// Returns/Effects: Loads file contents, parses symbols through tree-sitter, and returns the analysis record.
export async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const ext = extname(filePath).toLowerCase();
  const symbols = await parseWithTreeSitter(content, ext);

  return {
    path: filePath,
    header: extractHeader(lines),
    symbols,
    lineCount: lines.length,
  };
}

// Purpose: Render a parsed symbol tree into an indented human-readable outline line format.
// Inputs: One code symbol plus an optional indentation depth for recursive formatting.
// Returns/Effects: Returns the formatted outline text for the symbol and its children.
export function formatSymbol(sym: CodeSymbol, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  const kindLabel = sym.kind === SymbolKind.Method ? "method" : sym.kind;
  const lineLabel = sym.endLine > sym.line ? `L${sym.line}-L${sym.endLine}` : `L${sym.line}`;
  let result = `${prefix}${kindLabel}: ${sym.name} (${lineLabel})`;

  if (sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method) {
    result = `${prefix}${kindLabel}: ${sym.signature} (${lineLabel})`;
  }

  for (const child of sym.children) {
    result += "\n" + formatSymbol(child, indent + 1);
  }
  return result;
}

// Purpose: Determine whether a file path uses one of the parser-supported source extensions.
// Inputs: The file path whose extension should be checked.
// Returns/Effects: Returns true when the file extension is analyzable by the tree-sitter pipeline.
export function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return getAnalyzableExtensions().includes(ext);
}

// Purpose: Flatten a nested symbol tree into a linear list of symbol locations with parent context.
// Inputs: The symbol tree to flatten plus an optional parent symbol name for recursion.
// Returns/Effects: Returns a flat ordered list of symbol location records.
export function flattenSymbols(symbols: CodeSymbol[], parentName?: string): SymbolLocation[] {
  const out: SymbolLocation[] = [];
  for (const sym of symbols) {
    out.push({
      name: sym.name,
      kind: sym.kind,
      line: sym.line,
      endLine: sym.endLine,
      signature: sym.signature,
      parentName,
    });
    if (sym.children.length > 0) {
      out.push(...flattenSymbols(sym.children, sym.name));
    }
  }
  return out;
}
