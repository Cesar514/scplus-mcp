// summary: Loads pooled tree-sitter grammars and parses supported files into ASTs.
// FEATURE: Multi-language parser runtime with pooled grammars and AST access.
// inputs: Grammar assets, file contents, and parser runtime initialization requests.
// outputs: Parsed ASTs, grammar availability checks, and explicit parser load failures.

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
  ".zig": "zig", ".vue": "vue",
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

export interface TreeSitterGrammarLoadError extends Error {
  grammarName: string;
  wasmPath: string;
  cause: unknown;
}

// Purpose: Build a typed grammar-load error that preserves wasm-path context.
// Inputs: A grammar name, the expected wasm path, and the original thrown cause.
// Returns/Effects: Returns an `Error` object augmented with grammar-load metadata.
export function createTreeSitterGrammarLoadError(
  grammarName: string,
  wasmPath: string,
  cause: unknown,
): TreeSitterGrammarLoadError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Failed to load tree-sitter grammar "${grammarName}" from ${wasmPath}: ${causeMessage}`,
  ) as TreeSitterGrammarLoadError;
  error.name = "TreeSitterGrammarLoadError";
  error.grammarName = grammarName;
  error.wasmPath = wasmPath;
  error.cause = cause;
  return error;
}

export interface TreeSitterParseError extends Error {
  grammarName: string;
  cause: unknown;
}

// Purpose: Build a typed parse error that preserves the active grammar context.
// Inputs: A grammar name and the original thrown parse cause.
// Returns/Effects: Returns an `Error` object augmented with parse-failure metadata.
export function createTreeSitterParseError(
  grammarName: string,
  cause: unknown,
): TreeSitterParseError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Failed to parse content with tree-sitter grammar "${grammarName}": ${causeMessage}`,
  ) as TreeSitterParseError;
  error.name = "TreeSitterParseError";
  error.grammarName = grammarName;
  error.cause = cause;
  return error;
}

export interface TreeSitterUnsupportedLanguageError extends Error {
  extension: string;
}

// Purpose: Build a typed unsupported-language error for unmapped file extensions.
// Inputs: The unsupported file extension supplied by the caller.
// Returns/Effects: Returns an `Error` object augmented with extension metadata.
export function createTreeSitterUnsupportedLanguageError(extension: string): TreeSitterUnsupportedLanguageError {
  const error = new Error(`Unsupported tree-sitter extension: ${extension || "<none>"}`) as TreeSitterUnsupportedLanguageError;
  error.name = "TreeSitterUnsupportedLanguageError";
  error.extension = extension;
  return error;
}

// Purpose: Create the zeroed runtime statistics structure for tree-sitter observability.
// Inputs: No direct inputs beyond the fixed runtime-stats shape.
// Returns/Effects: Returns a fresh runtime-stats object with empty counters and failures.
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

// Purpose: Ensure one per-language runtime-stats bucket exists before updating counters.
// Inputs: The grammar name whose counters should be read or initialized.
// Returns/Effects: Returns the mutable stats bucket for that grammar.
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

// Purpose: Record one grammar-load or parse failure in the runtime observability snapshot.
// Inputs: The grammar name, failure stage, and thrown error or value.
// Returns/Effects: Updates failure counters and recent-failure history in memory.
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

// Purpose: Clone the current runtime observability snapshot without exposing mutable internals.
// Inputs: No direct inputs beyond the in-memory runtime stats owned by this module.
// Returns/Effects: Returns a defensive copy of the runtime statistics object.
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

// Purpose: Dispose and clear cached parser instances across all loaded grammars.
// Inputs: No direct inputs beyond the in-memory parser cache.
// Returns/Effects: Deletes cached parser instances and empties the parser cache map.
function resetParserCache(): void {
  for (const parser of parserCache.values()) {
    parser?.delete?.();
  }
  parserCache.clear();
}

// Purpose: Return a defensive snapshot of tree-sitter runtime counters and recent failures.
// Inputs: No direct inputs beyond the in-memory runtime state tracked by this module.
// Returns/Effects: Returns cloned observability data without mutating parser or grammar state.
export function getTreeSitterRuntimeStats(): TreeSitterRuntimeStats {
  return cloneRuntimeStats();
}

// Purpose: Reset parser caches and clear accumulated tree-sitter runtime statistics.
// Inputs: No direct inputs beyond the in-memory caches owned by this module.
// Returns/Effects: Deletes cached parsers, clears loaded grammars, and zeros runtime counters.
export function resetTreeSitterRuntimeStats(): void {
  resetParserCache();
  grammarCache.clear();
  runtimeStats = createEmptyRuntimeStats();
}

// Purpose: Reset tree-sitter runtime state and test overrides back to the default environment.
// Inputs: No direct inputs beyond the in-memory overrides managed for tests.
// Returns/Effects: Clears caches, runtime stats, grammar-dir overrides, and parser-factory overrides.
export function resetTreeSitterRuntimeStateForTests(): void {
  resetTreeSitterRuntimeStats();
  grammarDirOverride = null;
  parserFactoryOverride = null;
}

// Purpose: Override the grammar directory used by tests that need controlled wasm fixtures.
// Inputs: A replacement grammar directory path or null to restore the default location.
// Returns/Effects: Updates the override, clears cached grammars, and resets parser instances.
export function setTreeSitterGrammarDirForTests(directory: string | null): void {
  grammarDirOverride = directory;
  grammarCache.clear();
  resetParserCache();
}

// Purpose: Inject a parser factory for tests that need controlled parser behavior.
// Inputs: A parser factory callback or null to restore normal parser construction.
// Returns/Effects: Updates the override and clears cached parser instances for subsequent parses.
export function setTreeSitterParserFactoryForTests(
  factory: ((ParserCtor: any, language: TSLanguage, grammarName: string) => TSParser) | null,
): void {
  parserFactoryOverride = factory;
  resetParserCache();
}

// Purpose: Lazily initialize and cache the web-tree-sitter Parser class.
// Inputs: No direct inputs beyond the module-level parser runtime state.
// Returns/Effects: Returns the initialized Parser constructor for subsequent parsing.
async function initParser(): Promise<typeof ParserClass> {
  if (ParserClass) return ParserClass;

  const mod = await import("web-tree-sitter");
  const Parser = mod.default ?? mod;
  await Parser.init();
  ParserClass = Parser;
  return Parser;
}

// Purpose: Load and cache one tree-sitter grammar wasm by grammar name.
// Inputs: The grammar name whose wasm asset should be loaded.
// Returns/Effects: Returns the loaded grammar or throws a typed grammar-load error.
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
    throw createTreeSitterGrammarLoadError(grammarName, wasmPath, error);
  }
}

// Purpose: Reuse or create a parser instance configured for the requested grammar.
// Inputs: The grammar name and loaded tree-sitter language object.
// Returns/Effects: Returns a cached parser or throws a typed parse error when setup fails.
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
    throw createTreeSitterParseError(grammarName, error);
  }
  parserCache.set(grammarName, parser);
  runtimeStats.totalParsersCreated++;
  ensureLanguageStats(grammarName).parsersCreated++;
  return parser;
}

// Purpose: Extract the most relevant symbol name from one tree-sitter node.
// Inputs: The node being inspected and its mapped kind label.
// Returns/Effects: Returns a best-effort symbol name string for the node.
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

// Purpose: Build a short single-line signature preview from one syntax node.
// Inputs: The syntax node whose leading text should become the signature string.
// Returns/Effects: Returns the first trimmed line, truncated to 150 characters when needed.
function extractSignature(node: TSNode): string {
  const lines = node.text.split("\n");
  const firstLine = lines[0].trim();
  return firstLine.length > 150 ? firstLine.substring(0, 150) + "..." : firstLine;
}

// Purpose: Map tree-sitter definition labels onto repository symbol kinds.
// Inputs: The intermediate kind label derived from language-specific definition types.
// Returns/Effects: Returns the normalized symbol kind used by parser consumers.
function mapKind(typeStr: string): SymbolKind {
  const kinds: Record<string, string> = {
    function: "function", method: "method", class: "class",
    struct: "struct", enum: "enum", interface: "interface",
    type: "type", trait: "trait", const: "const", variable: "variable",
    export: "export",
  };
  return (kinds[typeStr] ?? "function") as SymbolKind;
}

// Purpose: Walk a syntax tree and collect nested symbols up to a bounded depth.
// Inputs: The root node, language definition-type mapping, and optional max traversal depth.
// Returns/Effects: Returns collected code symbols with nested children.
function walkTree(rootNode: TSNode, defTypes: Record<string, string>, maxDepth: number = 3): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  // Purpose: Visit one syntax node and attach discovered symbols to the current parent.
  // Inputs: The node to inspect, current traversal depth, and optional parent symbol.
  // Returns/Effects: Mutates the enclosing symbol list or parent children as nodes are visited.
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

// Purpose: Resolve a file extension to the configured tree-sitter grammar name.
// Inputs: A source-file extension such as `.ts` or `.py`.
// Returns/Effects: Returns the grammar name when configured, otherwise null with no side effects.
export function getGrammarName(ext: string): string | null {
  return EXT_TO_GRAMMAR[ext.toLowerCase()] ?? null;
}

// Purpose: Parse source text into the code-symbol model used by the rest of the repository tools.
// Inputs: Source-file contents and the file extension used to select a grammar.
// Returns/Effects: Returns extracted symbols or throws an explicit tree-sitter error on failure.
export async function parseWithTreeSitter(content: string, ext: string): Promise<CodeSymbol[]> {
  return withSyntaxTree(content, ext, ({ rootNode, grammarName }) => {
    const defTypes = DEFINITION_TYPES[grammarName];
    return walkTree(rootNode, defTypes);
  });
}

// Purpose: Run a visitor against a live syntax tree while keeping parser lifecycle management internal.
// Inputs: Source-file contents, the file extension, and a visitor that consumes the parsed root node.
// Returns/Effects: Returns the visitor result and always cleans up the temporary syntax tree afterwards.
export async function withSyntaxTree<T>(
  content: string,
  ext: string,
  visitor: (context: { rootNode: TSNode; grammarName: string }) => T,
): Promise<T> {
  const grammarName = getGrammarName(ext);
  if (!grammarName) throw createTreeSitterUnsupportedLanguageError(ext);

  const defTypes = DEFINITION_TYPES[grammarName];
  if (!defTypes) {
    const error = new Error(`No tree-sitter definition mapping configured for grammar "${grammarName}".`);
    recordFailure(grammarName, "parse", error);
    throw createTreeSitterParseError(grammarName, error);
  }

  const lang = await loadGrammar(grammarName);
  runtimeStats.totalParseCalls++;
  ensureLanguageStats(grammarName).parseCalls++;

  let tree: any = null;
  try {
    const parser = await getOrCreateParser(grammarName, lang);
    tree = parser.parse(content);
    return visitor({ rootNode: tree.rootNode, grammarName });
  } catch (error) {
    if (error instanceof Error && (error.name === "TreeSitterGrammarLoadError" || error.name === "TreeSitterParseError")) throw error;
    recordFailure(grammarName, "parse", error);
    throw createTreeSitterParseError(grammarName, error);
  } finally {
    tree?.delete?.();
  }
}

// Purpose: List every file extension that has any configured tree-sitter grammar mapping.
// Inputs: No direct inputs beyond the static extension-to-grammar registry.
// Returns/Effects: Returns the configured extension list without mutating runtime state.
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_GRAMMAR);
}

// Purpose: List the subset of extensions that also have symbol-definition mappings for analysis.
// Inputs: No direct inputs beyond the configured grammar and definition registries.
// Returns/Effects: Returns the analyzable extension list without mutating runtime state.
export function getAnalyzableExtensions(): string[] {
  const analyzableGrammars = new Set(Object.keys(DEFINITION_TYPES));
  return Object.entries(EXT_TO_GRAMMAR)
    .filter(([, grammarName]) => analyzableGrammars.has(grammarName))
    .map(([ext]) => ext);
}
