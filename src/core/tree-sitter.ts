// Web-tree-sitter based multi-language parser using pooled WASM grammars
// Supports 36 languages via tree-sitter-wasms, extracts symbols from AST

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { CodeSymbol, SymbolKind } from "./parser.js";

type TSParser = any;
type TSLanguage = any;
type TSNode = any;

const GRAMMAR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/tree-sitter-wasms/out");

const EXT_TO_GRAMMAR: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rs": "rust",
  ".go": "go", ".java": "java", ".c": "c", ".h": "c", ".cpp": "cpp",
  ".hpp": "cpp", ".cc": "cpp", ".cs": "c_sharp", ".rb": "ruby", ".php": "php",
  ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin", ".lua": "lua",
  ".dart": "dart", ".ex": "elixir", ".exs": "elixir", ".elm": "elm",
  ".ml": "ocaml", ".scala": "scala", ".sc": "scala", ".sol": "solidity",
  ".zig": "zig", ".vue": "vue", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".toml": "toml", ".yaml": "yaml", ".yml": "yaml", ".json": "json",
  ".html": "html", ".css": "css", ".m": "objc", ".re": "rescript",
};

const DEFINITION_TYPES: Record<string, Record<string, string>> = {
  typescript: {
    function_declaration: "function", method_definition: "method",
    class_declaration: "class", interface_declaration: "interface",
    enum_declaration: "enum", type_alias_declaration: "type",
    lexical_declaration: "const",
  },
  javascript: {
    function_declaration: "function", method_definition: "method",
    class_declaration: "class", variable_declaration: "const",
  },
  tsx: {
    function_declaration: "function", method_definition: "method",
    class_declaration: "class", interface_declaration: "interface",
    enum_declaration: "enum", type_alias_declaration: "type",
  },
  python: {
    function_definition: "function", class_definition: "class",
  },
  rust: {
    function_item: "function", struct_item: "struct",
    enum_item: "enum", trait_item: "trait", impl_item: "class",
  },
  go: {
    function_declaration: "function", method_declaration: "method",
    type_spec: "type",
  },
  java: {
    method_declaration: "method", class_declaration: "class",
    interface_declaration: "interface", enum_declaration: "enum",
  },
  c: {
    function_definition: "function", struct_specifier: "struct",
    enum_specifier: "enum",
  },
  cpp: {
    function_definition: "function", class_specifier: "class",
    struct_specifier: "struct", enum_specifier: "enum",
  },
  c_sharp: {
    method_declaration: "method", class_declaration: "class",
    interface_declaration: "interface", enum_declaration: "enum",
    struct_declaration: "struct",
  },
  ruby: {},
  lua: {},
  dart: {},
  elixir: {},
  php: {
    function_definition: "function", method_declaration: "method",
    class_declaration: "class", interface_declaration: "interface",
    enum_declaration: "enum",
  },
  swift: {
    function_declaration: "function", class_declaration: "class",
    struct_declaration: "struct", enum_declaration: "enum",
    protocol_declaration: "interface",
  },
  kotlin: {
    function_declaration: "function", class_declaration: "class",
    object_declaration: "class", interface_delegation: "interface",
  },

  scala: {
    function_definition: "function", class_definition: "class",
    trait_definition: "trait", object_definition: "class",
  },
  solidity: {
    function_definition: "function", contract_declaration: "class",
    struct_declaration: "struct", enum_declaration: "enum",
    event_definition: "export",
  },
  zig: {
    function_declaration: "function",
  },
  bash: {
    function_definition: "function",
  },
  ocaml: {
    let_binding: "function", type_binding: "type",
  },
};

let ParserClass: any = null;
const grammarCache = new Map<string, TSLanguage>();
const parserCache = new Map<string, TSParser>();
const MAX_RECENT_FAILURES = 10;
let grammarDirOverride: string | null = null;
let parserFactoryOverride: ((ParserCtor: any, language: TSLanguage, grammarName: string) => TSParser) | null = null;

export interface TreeSitterLanguageRuntimeStats {
  parseCalls: number;
  parsersCreated: number;
  parserReuses: number;
  grammarLoads: number;
  grammarLoadFailures: number;
  parseFailures: number;
}

export interface TreeSitterFailureRecord {
  grammarName: string;
  stage: "grammar-load" | "parse";
  message: string;
  at: string;
}

export interface TreeSitterRuntimeStats {
  totalParseCalls: number;
  totalParsersCreated: number;
  totalParserReuses: number;
  totalGrammarLoads: number;
  totalGrammarLoadFailures: number;
  totalParseFailures: number;
  languages: Record<string, TreeSitterLanguageRuntimeStats>;
  recentFailures: TreeSitterFailureRecord[];
}

export class TreeSitterGrammarLoadError extends Error {
  readonly grammarName: string;
  readonly wasmPath: string;
  readonly cause: unknown;

  constructor(grammarName: string, wasmPath: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load tree-sitter grammar "${grammarName}" from ${wasmPath}: ${causeMessage}`);
    this.name = "TreeSitterGrammarLoadError";
    this.grammarName = grammarName;
    this.wasmPath = wasmPath;
    this.cause = cause;
  }
}

export class TreeSitterParseError extends Error {
  readonly grammarName: string;
  readonly cause: unknown;

  constructor(grammarName: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to parse content with tree-sitter grammar "${grammarName}": ${causeMessage}`);
    this.name = "TreeSitterParseError";
    this.grammarName = grammarName;
    this.cause = cause;
  }
}

export class TreeSitterUnsupportedLanguageError extends Error {
  readonly extension: string;

  constructor(extension: string) {
    super(`Unsupported tree-sitter extension: ${extension || "<none>"}`);
    this.name = "TreeSitterUnsupportedLanguageError";
    this.extension = extension;
  }
}

function createEmptyRuntimeStats(): TreeSitterRuntimeStats {
  return {
    totalParseCalls: 0,
    totalParsersCreated: 0,
    totalParserReuses: 0,
    totalGrammarLoads: 0,
    totalGrammarLoadFailures: 0,
    totalParseFailures: 0,
    languages: {},
    recentFailures: [],
  };
}

let runtimeStats: TreeSitterRuntimeStats = createEmptyRuntimeStats();

function getGrammarDir(): string {
  return grammarDirOverride ?? GRAMMAR_DIR;
}

function ensureLanguageStats(grammarName: string): TreeSitterLanguageRuntimeStats {
  const existing = runtimeStats.languages[grammarName];
  if (existing) return existing;
  const created: TreeSitterLanguageRuntimeStats = {
    parseCalls: 0,
    parsersCreated: 0,
    parserReuses: 0,
    grammarLoads: 0,
    grammarLoadFailures: 0,
    parseFailures: 0,
  };
  runtimeStats.languages[grammarName] = created;
  return created;
}

function recordFailure(grammarName: string, stage: "grammar-load" | "parse", error: unknown): void {
  const languageStats = ensureLanguageStats(grammarName);
  const message = error instanceof Error ? error.message : String(error);
  runtimeStats.recentFailures.push({
    grammarName,
    stage,
    message,
    at: new Date().toISOString(),
  });
  if (runtimeStats.recentFailures.length > MAX_RECENT_FAILURES) runtimeStats.recentFailures.shift();
  if (stage === "grammar-load") {
    runtimeStats.totalGrammarLoadFailures++;
    languageStats.grammarLoadFailures++;
    return;
  }
  runtimeStats.totalParseFailures++;
  languageStats.parseFailures++;
}

function cloneRuntimeStats(): TreeSitterRuntimeStats {
  return {
    totalParseCalls: runtimeStats.totalParseCalls,
    totalParsersCreated: runtimeStats.totalParsersCreated,
    totalParserReuses: runtimeStats.totalParserReuses,
    totalGrammarLoads: runtimeStats.totalGrammarLoads,
    totalGrammarLoadFailures: runtimeStats.totalGrammarLoadFailures,
    totalParseFailures: runtimeStats.totalParseFailures,
    languages: Object.fromEntries(
      Object.entries(runtimeStats.languages).map(([grammarName, stats]) => [grammarName, { ...stats }]),
    ),
    recentFailures: runtimeStats.recentFailures.map((failure) => ({ ...failure })),
  };
}

function resetParserCache(): void {
  for (const parser of parserCache.values()) {
    parser?.delete?.();
  }
  parserCache.clear();
}

export function getTreeSitterRuntimeStats(): TreeSitterRuntimeStats {
  return cloneRuntimeStats();
}

export function resetTreeSitterRuntimeStats(): void {
  resetParserCache();
  grammarCache.clear();
  runtimeStats = createEmptyRuntimeStats();
}

export function resetTreeSitterRuntimeStateForTests(): void {
  resetTreeSitterRuntimeStats();
  grammarDirOverride = null;
  parserFactoryOverride = null;
}

export function setTreeSitterGrammarDirForTests(directory: string | null): void {
  grammarDirOverride = directory;
  grammarCache.clear();
  resetParserCache();
}

export function setTreeSitterParserFactoryForTests(
  factory: ((ParserCtor: any, language: TSLanguage, grammarName: string) => TSParser) | null,
): void {
  parserFactoryOverride = factory;
  resetParserCache();
}

async function initParser(): Promise<typeof ParserClass> {
  if (ParserClass) return ParserClass;

  const mod = await import("web-tree-sitter");
  const Parser = mod.default ?? mod;
  await Parser.init();
  ParserClass = Parser;
  return Parser;
}

async function loadGrammar(grammarName: string): Promise<TSLanguage> {
  if (grammarCache.has(grammarName)) return grammarCache.get(grammarName)!;

  const wasmPath = join(getGrammarDir(), `tree-sitter-${grammarName}.wasm`);
  try {
    const Parser = await initParser();
    const lang = await Parser.Language.load(wasmPath);
    runtimeStats.totalGrammarLoads++;
    ensureLanguageStats(grammarName).grammarLoads++;
    grammarCache.set(grammarName, lang);
    return lang;
  } catch (error) {
    recordFailure(grammarName, "grammar-load", error);
    throw new TreeSitterGrammarLoadError(grammarName, wasmPath, error);
  }
}

async function getOrCreateParser(grammarName: string, lang: TSLanguage): Promise<TSParser> {
  const cachedParser = parserCache.get(grammarName);
  if (cachedParser) {
    runtimeStats.totalParserReuses++;
    ensureLanguageStats(grammarName).parserReuses++;
    return cachedParser;
  }

  const Parser = await initParser();
  const parser = parserFactoryOverride ? parserFactoryOverride(Parser, lang, grammarName) : new Parser();
  try {
    parser.setLanguage(lang);
  } catch (error) {
    parser?.delete?.();
    recordFailure(grammarName, "parse", error);
    throw new TreeSitterParseError(grammarName, error);
  }
  parserCache.set(grammarName, parser);
  runtimeStats.totalParsersCreated++;
  ensureLanguageStats(grammarName).parsersCreated++;
  return parser;
}

function extractName(node: TSNode, _kind: string): string {
  const nameNode = node.childForFieldName("name")
    ?? node.childForFieldName("declarator")
    ?? node.namedChildren?.find((c: TSNode) =>
      c.type === "identifier" || c.type === "type_identifier"
      || c.type === "property_identifier" || c.type === "simple_identifier"
    );

  if (nameNode) {
    if (nameNode.type === "function_declarator" || nameNode.type === "pointer_declarator") {
      const inner = nameNode.childForFieldName("declarator") ?? nameNode.namedChildren?.[0];
      if (inner) return inner.text;
    }
    return nameNode.text;
  }

  for (const child of node.namedChildren ?? []) {
    if (child.type === "variable_declarator" || child.type === "const_declaration") {
      const inner = child.childForFieldName("name");
      if (inner) return inner.text;
    }
  }

  return node.text.split(/[\s({]/)[0]?.trim() ?? "anonymous";
}

function extractSignature(node: TSNode): string {
  const lines = node.text.split("\n");
  const firstLine = lines[0].trim();
  return firstLine.length > 150 ? firstLine.substring(0, 150) + "..." : firstLine;
}

function mapKind(typeStr: string): SymbolKind {
  const kinds: Record<string, string> = {
    function: "function", method: "method", class: "class",
    struct: "struct", enum: "enum", interface: "interface",
    type: "type", trait: "trait", const: "const", variable: "variable",
    export: "export",
  };
  return (kinds[typeStr] ?? "function") as SymbolKind;
}

function walkTree(rootNode: TSNode, defTypes: Record<string, string>, maxDepth: number = 3): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function visit(node: TSNode, depth: number, parent: CodeSymbol | null): void {
    if (depth > maxDepth) return;

    const kindStr = defTypes[node.type];
    if (kindStr) {
      const sym: CodeSymbol = {
        name: extractName(node, kindStr),
        kind: mapKind(kindStr),
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: extractSignature(node),
        children: [],
      };

      if (parent && depth > 0) {
        parent.children.push(sym);
      } else {
        symbols.push(sym);
      }

      for (const child of node.namedChildren ?? []) {
        visit(child, depth + 1, sym);
      }
      return;
    }

    for (const child of node.namedChildren ?? []) {
      visit(child, depth, parent);
    }
  }

  visit(rootNode, 0, null);
  return symbols;
}

export function getGrammarName(ext: string): string | null {
  return EXT_TO_GRAMMAR[ext.toLowerCase()] ?? null;
}

export async function parseWithTreeSitter(content: string, ext: string): Promise<CodeSymbol[]> {
  const grammarName = getGrammarName(ext);
  if (!grammarName) throw new TreeSitterUnsupportedLanguageError(ext);

  const defTypes = DEFINITION_TYPES[grammarName];
  if (!defTypes) {
    const error = new Error(`No tree-sitter definition mapping configured for grammar "${grammarName}".`);
    recordFailure(grammarName, "parse", error);
    throw new TreeSitterParseError(grammarName, error);
  }

  const lang = await loadGrammar(grammarName);
  runtimeStats.totalParseCalls++;
  ensureLanguageStats(grammarName).parseCalls++;

  let tree: any = null;
  try {
    const parser = await getOrCreateParser(grammarName, lang);
    tree = parser.parse(content);
    return walkTree(tree.rootNode, defTypes);
  } catch (error) {
    if (error instanceof TreeSitterGrammarLoadError || error instanceof TreeSitterParseError) throw error;
    recordFailure(grammarName, "parse", error);
    throw new TreeSitterParseError(grammarName, error);
  } finally {
    tree?.delete?.();
  }
}

export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_GRAMMAR);
}

export function getAnalyzableExtensions(): string[] {
  const analyzableGrammars = new Set(Object.keys(DEFINITION_TYPES));
  return Object.entries(EXT_TO_GRAMMAR)
    .filter(([, grammarName]) => analyzableGrammars.has(grammarName))
    .map(([ext]) => ext);
}
