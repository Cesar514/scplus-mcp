// summary: Parses hub markdown files into wikilinks, feature tags, and cross-link metadata.
// FEATURE: Hierarchical context management via feature hub graph.
// inputs: Hub markdown text, repository-relative link targets, and tag patterns.
// outputs: Parsed hub structures, wikilink lists, and feature metadata.

import { readFile, readdir } from "fs/promises";
import { resolve, relative, join, extname, basename } from "path";

export interface HubLink {
  target: string;
  description?: string;
}

export interface CrossLink {
  hubName: string;
  sourceFile: string;
}

export interface HubInfo {
  hubPath: string;
  title: string;
  links: HubLink[];
  crossLinks: CrossLink[];
  raw: string;
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const CROSS_LINK_RE = /@linked-to\s+\[\[([^\]]+)\]\]/g;
const HEADER_FEATURE_RE = /^(?:\/\/|#|--)\s*FEATURE:\s*(.+)$/m;

// Purpose: Parse unique wikilinks from hub markdown content while ignoring cross-link directives.
// Inputs: The raw hub markdown content.
// Returns/Effects: Returns the ordered unique wikilinks found in the content.
export function parseWikiLinks(content: string): HubLink[] {
  const links: HubLink[] = [];
  const seen = new Set<string>();
  const cleaned = content.replace(CROSS_LINK_RE, "");

  for (const match of cleaned.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    if (!seen.has(target)) {
      seen.add(target);
      links.push({ target, description: match[2]?.trim() });
    }
  }
  return links;
}

// Purpose: Parse cross-link directives that point from one source file to related hubs.
// Inputs: The raw hub markdown content plus the source file that owns the cross-links.
// Returns/Effects: Returns the parsed cross-link records found in the content.
export function parseCrossLinks(content: string, sourceFile: string): CrossLink[] {
  const crossLinks: CrossLink[] = [];
  for (const match of content.matchAll(CROSS_LINK_RE)) {
    crossLinks.push({ hubName: match[1].trim(), sourceFile });
  }
  return crossLinks;
}

// Purpose: Extract the first FEATURE tag found in a supported file header or markdown heading block.
// Inputs: The raw file content to inspect.
// Returns/Effects: Returns the trimmed feature tag string or null when absent.
export function extractFeatureTag(content: string): string | null {
  const match = content.match(HEADER_FEATURE_RE);
  return match ? match[1].trim() : null;
}

// Purpose: Parse one hub markdown file into its title, wikilinks, cross-links, and raw content.
// Inputs: The absolute path to the hub markdown file.
// Returns/Effects: Reads the file and returns the parsed hub information.
export async function parseHubFile(hubPath: string): Promise<HubInfo> {
  const content = await readFile(hubPath, "utf-8");
  const lines = content.split("\n");

  let title = basename(hubPath, extname(hubPath));
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) title = headingMatch[1].trim();

  return {
    hubPath,
    title,
    links: parseWikiLinks(content),
    crossLinks: parseCrossLinks(content, hubPath),
    raw: content,
  };
}

// Purpose: Discover markdown files under the repository root that contain wikilinks and therefore behave as hubs.
// Inputs: The repository root directory to scan.
// Returns/Effects: Walks the repository tree and returns sorted relative hub paths.
export async function discoverHubs(rootDir: string): Promise<string[]> {
  const hubs: string[] = [];
  const skip = new Set(["node_modules", ".git", "build", "dist", ".scplus"]);

  // Purpose: Recursively scan directories for markdown files that contain wikilinks.
  // Inputs: The absolute directory path currently being traversed.
  // Returns/Effects: Adds discovered hub-relative paths into the outer `hubs` collection.
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (skip.has(entry.name)) return;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        return;
      }
      if (!entry.name.endsWith(".md")) return;
      const content = await readFile(full, "utf-8");
      const wikilinkRe = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/;
      if (wikilinkRe.test(content)) {
        hubs.push(relative(rootDir, full).replace(/\\/g, "/"));
      }
    }));
  }

  await walk(rootDir);
  return hubs.sort();
}

// Purpose: Find non-markdown files that are not referenced by any discovered hub.
// Inputs: The repository root plus the full list of repository file paths to evaluate.
// Returns/Effects: Returns the relative file paths that are not linked from any hub.
export async function findOrphanedFiles(
  rootDir: string,
  allFilePaths: string[],
): Promise<string[]> {
  const hubs = await discoverHubs(rootDir);
  const linkedFiles = new Set<string>();

  for (const hubRelPath of hubs) {
    const info = await parseHubFile(resolve(rootDir, hubRelPath));
    for (const link of info.links) {
      linkedFiles.add(link.target.replace(/\\/g, "/"));
    }
    linkedFiles.add(hubRelPath);
  }

  return allFilePaths
    .filter((f) => !f.endsWith(".md"))
    .filter((f) => !linkedFiles.has(f.replace(/\\/g, "/")));
}

// Purpose: Render one hub wikilink in markdown with an optional display description.
// Inputs: The linked target path plus the optional link description.
// Returns/Effects: Returns the formatted markdown wikilink string.
export function formatHubLink(target: string, description: string): string {
  return description
    ? `- [[${target}|${description}]]`
    : `- [[${target}]]`;
}
