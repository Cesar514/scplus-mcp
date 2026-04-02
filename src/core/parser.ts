// Multi-language symbol extraction with strict tree-sitter parsing only
// FEATURE: Explicit no-fallback source analysis over supported tree-sitter grammars

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

export function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return getAnalyzableExtensions().includes(ext);
}

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
