// summary: Renders the token-aware structural repository tree with headers and symbols.
// FEATURE: Token-aware structural tree rendering for rapid repo navigation.
// inputs: Repository files, file headers, symbol metadata, and tree depth limits.
// outputs: Structured tree renderings for rapid repository navigation.

import { walkDirectory, type FileEntry } from "../core/walker.js";
import { analyzeFile, formatSymbol, isSupportedFile } from "../core/parser.js";

export interface ContextTreeOptions {
  rootDir: string;
  targetPath?: string;
  depthLimit?: number;
  includeSymbols?: boolean;
  maxTokens?: number;
}

interface TreeNode {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  header?: string;
  symbols?: string;
  children: TreeNode[];
}

const CHARS_PER_TOKEN = 4;

// Purpose: Estimate token usage for rendered tree text using the repo's fixed character heuristic.
// Inputs: The rendered tree text whose size should be approximated.
// Returns/Effects: Returns the estimated token count for the provided text.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Purpose: Build the in-memory repository tree enriched with file headers and optional symbols.
// Inputs: Walked file entries, the repository root, and whether symbol rendering is enabled.
// Returns/Effects: Returns the populated tree structure used for final text rendering.
async function buildTree(entries: FileEntry[], _rootDir: string, includeSymbols: boolean): Promise<TreeNode> {
  const root: TreeNode = { name: ".", relativePath: ".", isDirectory: true, children: [] };
  const dirMap = new Map<string, TreeNode>();
  dirMap.set(".", root);

  const sortedEntries = entries.sort((a, b) => a.depth - b.depth || a.relativePath.localeCompare(b.relativePath));

  for (const entry of sortedEntries) {
    const parts = entry.relativePath.split("/");
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    let parent = dirMap.get(parentPath);
    if (!parent) {
      parent = root;
    }

    const node: TreeNode = {
      name: parts[parts.length - 1],
      relativePath: entry.relativePath,
      isDirectory: entry.isDirectory,
      children: [],
    };

    if (!entry.isDirectory && isSupportedFile(entry.path)) {
      try {
        const analysis = await analyzeFile(entry.path);
        node.header = analysis.header || undefined;
        if (includeSymbols && analysis.symbols.length > 0) {
          node.symbols = analysis.symbols.map((s) => formatSymbol(s, 0)).join("\n");
        }
      } catch { }
    }

    parent.children.push(node);
    if (entry.isDirectory) {
      dirMap.set(entry.relativePath, node);
    }
  }

  return root;
}

// Purpose: Render the tree structure into the human-readable repository tree text format.
// Inputs: One tree node plus an optional indentation depth for recursive rendering.
// Returns/Effects: Returns the rendered tree text for the node and all descendants.
function renderTree(node: TreeNode, indent: number = 0): string {
  let result = "";
  const pad = "  ".repeat(indent);

  if (indent === 0) {
    result = `${node.name}/\n`;
  } else if (node.isDirectory) {
    result = `${pad}${node.name}/\n`;
  } else {
    result = `${pad}${node.name}`;
    if (node.header) result += ` | ${node.header}`;
    result += "\n";
    if (node.symbols) {
      for (const line of node.symbols.split("\n")) {
        result += `${pad}  ${line}\n`;
      }
    }
  }

  for (const child of node.children) {
    result += renderTree(child, indent + 1);
  }
  return result;
}

// Purpose: Remove symbol payloads from the tree when the full rendering exceeds the token budget.
// Inputs: The tree node whose symbol data should be pruned recursively.
// Returns/Effects: Mutates the tree in place to clear symbol strings from every node.
function pruneSymbols(node: TreeNode): void {
  node.symbols = undefined;
  for (const child of node.children) pruneSymbols(child);
}

// Purpose: Remove header and symbol payloads from the tree for the most compact rendering level.
// Inputs: The tree node whose header and symbol data should be pruned recursively.
// Returns/Effects: Mutates the tree in place to clear header and symbol strings from every node.
function pruneHeaders(node: TreeNode): void {
  node.header = undefined;
  node.symbols = undefined;
  for (const child of node.children) pruneHeaders(child);
}

// Purpose: Produce the token-aware repository tree rendering for the selected root and path scope.
// Inputs: Tree options including root, optional path scope, depth limit, symbol flag, and token budget.
// Returns/Effects: Walks the repository, renders the tree, and progressively prunes detail to fit the token budget.
export async function getContextTree(options: ContextTreeOptions): Promise<string> {
  const entries = await walkDirectory({
    rootDir: options.rootDir,
    targetPath: options.targetPath,
    depthLimit: options.depthLimit,
  });

  const includeSymbols = options.includeSymbols !== false;
  const tree = await buildTree(entries, options.rootDir, includeSymbols);
  const maxTokens = options.maxTokens ?? 20000;

  let rendered = renderTree(tree);
  if (estimateTokens(rendered) <= maxTokens) return rendered;

  pruneSymbols(tree);
  rendered = renderTree(tree);
  if (estimateTokens(rendered) <= maxTokens) return `[Level 1: Headers only, symbols pruned to fit ${maxTokens} tokens]\n\n${rendered}`;

  pruneHeaders(tree);
  rendered = renderTree(tree);
  return `[Level 0: File names only, project too large for ${maxTokens} tokens]\n\n${rendered}`;
}
