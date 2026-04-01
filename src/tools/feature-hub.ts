// Bundled skeleton view of all files linked from a hub map-of-content
// FEATURE: Hierarchical context management via feature hub graph

import { resolve, extname } from "path";
import { readFile, stat } from "fs/promises";
import { parseHubFile, discoverHubs, findOrphanedFiles, type HubInfo } from "../core/hub.js";
import { getFileSkeleton } from "./file-skeleton.js";
import { walkDirectory } from "../core/walker.js";
import { loadHubSuggestionState } from "./hub-suggestions.js";
import { validatePreparedIndex } from "./index-reliability.js";

export interface FeatureHubOptions {
  rootDir: string;
  hubPath?: string;
  featureName?: string;
  showOrphans?: boolean;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findHubByName(rootDir: string, name: string): Promise<string | null> {
  const hubs = await discoverHubs(rootDir);
  const lower = name.toLowerCase();

  const exact = hubs.find((h) => h.toLowerCase() === `${lower}.md` || h.toLowerCase().endsWith(`/${lower}.md`));
  if (exact) return exact;

  const partial = hubs.find((h) => h.toLowerCase().includes(lower));
  return partial ?? null;
}

async function findSuggestedHubByName(rootDir: string, name: string): Promise<string | null> {
  const suggestions = await loadHubSuggestionState(rootDir);
  const lower = name.toLowerCase();
  const match = Object.values(suggestions.suggestions).find((suggestion) =>
    suggestion.label.toLowerCase() === lower
      || suggestion.slug === lower
      || suggestion.label.toLowerCase().includes(lower)
      || suggestion.featureTags.some((tag) => tag.toLowerCase() === lower || tag.toLowerCase().includes(lower)),
  );
  return match?.markdownPath ?? null;
}

export async function getFeatureHub(options: FeatureHubOptions): Promise<string> {
  const { rootDir, showOrphans } = options;
  const out: string[] = [];

  if (!options.hubPath && !options.featureName && !showOrphans) {
    const hubs = await discoverHubs(rootDir);
    const validation = await validatePreparedIndex({ rootDir, mode: "full" });
    const suggestions = validation.ok
      ? await loadHubSuggestionState(rootDir)
      : { suggestions: {}, featureGroups: {} };
    if (hubs.length === 0 && Object.keys(suggestions.suggestions).length === 0) {
      return "No hub files found. Create a .md file with [[path/to/file]] links to establish a feature hub.";
    }
    if (hubs.length > 0) {
      out.push(`Feature Hubs (${hubs.length}):`);
      out.push("");
      for (const h of hubs) {
        const info = await parseHubFile(resolve(rootDir, h));
        out.push(`  ${h} | ${info.title} | ${info.links.length} links`);
      }
    }
    const suggestionList = Object.values(suggestions.suggestions);
    if (suggestionList.length > 0) {
      if (out.length > 0) out.push("");
      out.push(`Suggested Hubs (${suggestionList.length}):`);
      out.push("");
      for (const suggestion of suggestionList.sort((left, right) => left.label.localeCompare(right.label))) {
        out.push(`  ${suggestion.markdownPath} | ${suggestion.label} | ${suggestion.filePaths.length} files`);
      }
    }
    const featureGroups = Object.values(suggestions.featureGroups);
    if (featureGroups.length > 0) {
      if (out.length > 0) out.push("");
      out.push(`Feature Group Candidates (${featureGroups.length}):`);
      out.push("");
      for (const group of featureGroups.sort((left, right) => left.label.localeCompare(right.label))) {
        out.push(`  ${group.label} | tag=${group.featureTag} | ${group.filePaths.length} files | ${group.suggestionIds.length} suggested hubs`);
      }
    }
    return out.join("\n");
  }

  if (showOrphans) {
    const entries = await walkDirectory({ rootDir, depthLimit: 10 });
    const filePaths = entries.filter((e) => !e.isDirectory).map((e) => e.relativePath);
    const orphans = await findOrphanedFiles(rootDir, filePaths);
    if (orphans.length === 0) return "No orphaned files. All source files are linked to a hub.";

    out.push(`Orphaned Files (${orphans.length}):`);
    out.push("These files are not linked to any feature hub:");
    out.push("");
    for (const o of orphans) out.push(`  ⚠ ${o}`);
    out.push("");
    out.push("Fix: Add [[" + orphans[0] + "]] to the appropriate hub .md file.");
    return out.join("\n");
  }

  let hubRelPath = options.hubPath;
  if (!hubRelPath && options.featureName) {
    const manualHubPath = await findHubByName(rootDir, options.featureName);
    if (manualHubPath) hubRelPath = manualHubPath;
    if (!hubRelPath) {
      const validation = await validatePreparedIndex({ rootDir, mode: "full" });
      if (validation.ok) {
        const suggestedHubPath = await findSuggestedHubByName(rootDir, options.featureName);
        if (suggestedHubPath) hubRelPath = suggestedHubPath;
      }
    }
    if (!hubRelPath) {
      return `No hub found for feature "${options.featureName}". Available hubs:\n` +
        (await discoverHubs(rootDir)).map((h) => `  - ${h}`).join("\n") || "  (none)";
    }
  }

  if (!hubRelPath) return "Provide hub_path, feature_name, or set show_orphans=true.";

  const hubFull = resolve(rootDir, hubRelPath);
  if (!(await fileExists(hubFull))) {
    return `Hub file not found: ${hubRelPath}`;
  }

  const hub = await parseHubFile(hubFull);

  out.push(`Hub: ${hub.title}`);
  out.push(`Path: ${hubRelPath}`);
  out.push(`Links: ${hub.links.length}`);
  if (hub.crossLinks.length > 0) {
    out.push(`Cross-links: ${hub.crossLinks.map((c) => c.hubName).join(", ")}`);
  }
  out.push("");
  out.push("---");
  out.push("");

  const resolved: string[] = [];
  const missing: string[] = [];

  for (const link of hub.links) {
    const linkFull = resolve(rootDir, link.target);
    if (await fileExists(linkFull)) {
      resolved.push(link.target);
    } else {
      missing.push(link.target);
    }
  }

  for (const filePath of resolved) {
    const ext = extname(filePath);
    const desc = hub.links.find((l) => l.target === filePath)?.description;

    if (desc) out.push(`## ${filePath} - ${desc}`);
    else out.push(`## ${filePath}`);

    try {
      const skeleton = await getFileSkeleton({ rootDir, filePath });
      out.push(skeleton);
    } catch {
      const content = await readFile(resolve(rootDir, filePath), "utf-8");
      out.push(content.split("\n").slice(0, 20).join("\n"));
    }
    out.push("");
  }

  if (missing.length > 0) {
    out.push("---");
    out.push(`Missing Links (${missing.length}):`);
    for (const m of missing) out.push(`  ✗ ${m}`);
  }

  return out.join("\n");
}
