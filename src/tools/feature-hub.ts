// Bundled skeleton view of all files linked from a hub map-of-content
// FEATURE: Hierarchical context management via feature hub graph

import { resolve, extname } from "path";
import { readFile, stat } from "fs/promises";
import { parseHubFile, discoverHubs, findOrphanedFiles } from "../core/hub.js";
import { getFileSkeleton } from "./file-skeleton.js";
import { walkDirectory } from "../core/walker.js";
import { loadHubSuggestionState, type HubSuggestion } from "./hub-suggestions.js";
import { validatePreparedIndex } from "./index-reliability.js";
import { fetchEmbedding } from "../core/embeddings.js";

export interface FeatureHubOptions {
  rootDir: string;
  hubPath?: string;
  featureName?: string;
  query?: string;
  rankingMode?: "keyword" | "semantic" | "both";
  showOrphans?: boolean;
}

interface RankedHubCandidate {
  hubPath: string;
  title: string;
  source: "manual" | "suggested";
  fileCount: number;
  featureTags: string[];
  summary: string;
  searchText: string;
  semanticScore: number;
  keywordScore: number;
  score: number;
  matchedTerms: string[];
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

function normalizeRankingMode(value: FeatureHubOptions["rankingMode"]): "keyword" | "semantic" | "both" {
  return value ?? "both";
}

function splitTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function scoreKeywordCoverage(query: string, text: string): { score: number; matchedTerms: string[] } {
  const queryTerms = Array.from(new Set(splitTerms(query)));
  if (queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const normalized = text.toLowerCase();
  const matchedTerms = queryTerms.filter((term) => normalized.includes(term));
  const coverage = matchedTerms.length / queryTerms.length;
  const phraseBoost = normalized.includes(query.trim().toLowerCase()) ? 0.2 : 0;
  return {
    score: clamp01(coverage * 0.8 + phraseBoost),
    matchedTerms,
  };
}

async function buildManualHubCandidates(rootDir: string): Promise<RankedHubCandidate[]> {
  const hubs = await discoverHubs(rootDir);
  const candidates: RankedHubCandidate[] = [];
  for (const hubPath of hubs) {
    const hub = await parseHubFile(resolve(rootDir, hubPath));
    const searchText = [
      hub.title,
      hubPath,
      hub.crossLinks.map((entry) => entry.hubName).join(" "),
      hub.links.map((entry) => `${entry.target} ${entry.description ?? ""}`).join(" "),
    ].join(" ").trim();
    candidates.push({
      hubPath,
      title: hub.title,
      source: "manual",
      fileCount: hub.links.length,
      featureTags: [],
      summary: `${hub.links.length} linked files${hub.crossLinks.length > 0 ? ` | cross-links: ${hub.crossLinks.map((entry) => entry.hubName).join(", ")}` : ""}`,
      searchText,
      semanticScore: 0,
      keywordScore: 0,
      score: 0,
      matchedTerms: [],
    });
  }
  return candidates;
}

function buildSuggestedHubCandidate(suggestion: HubSuggestion): RankedHubCandidate {
  return {
    hubPath: suggestion.markdownPath,
    title: suggestion.label,
    source: "suggested",
    fileCount: suggestion.filePaths.length,
    featureTags: suggestion.featureTags,
    summary: suggestion.rationale || suggestion.summary,
    searchText: [
      suggestion.label,
      suggestion.slug,
      suggestion.summary,
      suggestion.rationale,
      suggestion.markdownPath,
      suggestion.featureTags.join(" "),
      suggestion.modulePaths.join(" "),
      suggestion.filePaths.join(" "),
    ].join(" ").trim(),
    semanticScore: 0,
    keywordScore: 0,
    score: 0,
    matchedTerms: [],
  };
}

async function rankHubCandidates(
  rootDir: string,
  query: string,
  rankingMode: "keyword" | "semantic" | "both",
  includeSuggested: boolean,
): Promise<RankedHubCandidate[]> {
  const candidates = await buildManualHubCandidates(rootDir);
  if (includeSuggested) {
    const suggestions = await loadHubSuggestionState(rootDir);
    candidates.push(...Object.values(suggestions.suggestions).map(buildSuggestedHubCandidate));
  }
  if (candidates.length === 0) return [];

  for (const candidate of candidates) {
    const keyword = scoreKeywordCoverage(query, candidate.searchText);
    candidate.keywordScore = keyword.score;
    candidate.matchedTerms = keyword.matchedTerms;
  }

  if (rankingMode !== "keyword") {
    const embeddings = await fetchEmbedding([query, ...candidates.map((candidate) => candidate.searchText)]);
    const [queryVector, ...candidateVectors] = embeddings;
    for (let i = 0; i < candidates.length; i++) {
      candidates[i].semanticScore = Math.max(cosine(queryVector, candidateVectors[i]), 0);
    }
  }

  for (const candidate of candidates) {
    candidate.score = rankingMode === "semantic"
      ? candidate.semanticScore
      : rankingMode === "keyword"
        ? candidate.keywordScore
        : clamp01(candidate.semanticScore * 0.65 + candidate.keywordScore * 0.35);
  }

  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || right.keywordScore - left.keywordScore
      || right.semanticScore - left.semanticScore
      || left.hubPath.localeCompare(right.hubPath));
}

function formatRankedHubCandidates(query: string, rankingMode: "keyword" | "semantic" | "both", candidates: RankedHubCandidate[]): string {
  if (candidates.length === 0) {
    return [
      `Ranked hubs for: "${query}"`,
      `Ranking mode: ${rankingMode}`,
      "No ranked hub matches found.",
    ].join("\n");
  }

  const lines = [
    `Ranked hubs for: "${query}"`,
    `Ranking mode: ${rankingMode}`,
    `Candidates: ${candidates.length}`,
    "",
  ];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    lines.push(`${index + 1}. ${candidate.hubPath} [${candidate.source}] score=${candidate.score.toFixed(3)}`);
    lines.push(`   Title: ${candidate.title}`);
    lines.push(`   Keyword: ${candidate.keywordScore.toFixed(3)} | Semantic: ${candidate.semanticScore.toFixed(3)}`);
    lines.push(`   Files: ${candidate.fileCount}${candidate.featureTags.length > 0 ? ` | Feature tags: ${candidate.featureTags.join(", ")}` : ""}`);
    lines.push(`   Summary: ${candidate.summary}`);
    if (candidate.matchedTerms.length > 0) lines.push(`   Matched terms: ${candidate.matchedTerms.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export async function getFeatureHub(options: FeatureHubOptions): Promise<string> {
  const { rootDir, showOrphans } = options;
  const out: string[] = [];
  const hasHubQuery = Boolean(options.query?.trim());
  const rankingMode = normalizeRankingMode(options.rankingMode);

  if (!options.hubPath && !options.featureName && !showOrphans && !hasHubQuery) {
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

  if (hasHubQuery && !options.hubPath && !options.featureName && !showOrphans) {
    const validation = await validatePreparedIndex({ rootDir, mode: "full" });
    const ranked = await rankHubCandidates(rootDir, options.query!.trim(), rankingMode, validation.ok);
    return formatRankedHubCandidates(options.query!.trim(), rankingMode, ranked);
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

  if (!hubRelPath) return "Provide hub_path, feature_name, query, or set show_orphans=true.";

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
