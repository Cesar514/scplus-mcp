// Deterministic benchmark suite for full-engine retrieval and freshness quality
// FEATURE: Evaluation and benchmarking for retrieval, navigation, speed, and research output

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";
import { getFeatureHub } from "./feature-hub.js";
import { indexCodebase } from "./index-codebase.js";
import { validatePreparedIndex } from "./index-reliability.js";
import { runSearchByIntent } from "./query-intent.js";
import { runResearch } from "./research.js";
import { semanticNavigate } from "./semantic-navigate.js";
import { rankUnifiedSearch, type UnifiedRankedHit } from "./unified-ranking.js";
import { getTreeSitterRuntimeStats, resetTreeSitterRuntimeStats, type TreeSitterRuntimeStats } from "../core/tree-sitter.js";
import { clusterVectors } from "../core/clustering.js";

interface EvaluationCheck {
  name: string;
  passed: boolean;
  details: string;
}

interface EvaluationCategory {
  passed: number;
  total: number;
  checks: EvaluationCheck[];
}

interface EvaluationTiming {
  initialIndexMs: number;
  refreshIndexMs: number;
  hotExactSearchMs: number;
  relatedSearchMs: number;
  broadResearchMs: number;
}

interface EvaluationTokenCost {
  exactSearchChars: number;
  exactSearchEstimatedTokens: number;
  relatedSearchChars: number;
  relatedSearchEstimatedTokens: number;
  broadResearchChars: number;
  broadResearchEstimatedTokens: number;
}

interface ClusteringBenchmarkSample {
  vectorCount: number;
  clusterCount: number;
  durationMs: number;
}

export interface EvaluationReport {
  suite: "default";
  generatedAt: string;
  ok: boolean;
  timings: EvaluationTiming;
  validation: {
    initialOk: boolean;
    refreshOk: boolean;
  };
  retrievalQuality: EvaluationCategory;
  navigationQuality: EvaluationCategory;
  answerQuality: EvaluationCategory;
  hybridEfficiency: EvaluationCategory;
  artifactFreshness: EvaluationCategory;
  tokenCost: EvaluationTokenCost;
  clusteringBenchmarks: {
    medium: ClusteringBenchmarkSample;
    large: ClusteringBenchmarkSample;
  };
  treeSitter: TreeSitterRuntimeStats;
}

function buildClusterBenchmarkVectors(vectorCount: number, groupCount: number = 8): number[][] {
  return Array.from({ length: vectorCount }, (_, index) => {
    const group = index % groupCount;
    const angle = (index + 1) * 0.03125;
    const vector = new Array(12).fill(0);
    vector[group % vector.length] = 1;
    vector[(group + 5) % vector.length] = 0.35;
    return vector.map((value, dimension) => value + (Math.sin(angle + dimension) * 0.018));
  });
}

async function runClusteringBenchmark(vectorCount: number, maxClusters: number): Promise<ClusteringBenchmarkSample> {
  const vectors = buildClusterBenchmarkVectors(vectorCount);
  const timed = await timeOperation(async () => clusterVectors(vectors, maxClusters));
  return {
    vectorCount,
    clusterCount: timed.value.length,
    durationMs: timed.durationMs,
  };
}

async function writeFixtureRepo(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, "src", "auth"), { recursive: true });
  await mkdir(join(rootDir, "src", "ui"), { recursive: true });
  await mkdir(join(rootDir, "src", "api"), { recursive: true });
  await mkdir(join(rootDir, "docs"), { recursive: true });

  await writeFile(
    join(rootDir, "src", "auth", "jwt.ts"),
    [
      "// JWT verification helpers for deterministic evaluation coverage fixtures",
      "// FEATURE: auth evaluation benchmark for retrieval and research",
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
      "export function issueRefreshToken(userId: string): string {",
      "  return `refresh:${userId}`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(rootDir, "src", "auth", "session.ts"),
    [
      "// Session helpers for deterministic evaluation coverage and freshness",
      "// FEATURE: auth evaluation benchmark for retrieval and research",
      "import { verifyToken } from './jwt';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(rootDir, "src", "ui", "button.ts"),
    [
      "// UI button helpers for deterministic evaluation navigation fixtures",
      "// FEATURE: ui evaluation benchmark for retrieval and navigation",
      "export function renderPrimaryButton(label: string): string {",
      "  return `<button>${label}</button>`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(rootDir, "src", "api", "search.ts"),
    [
      "// Search API helpers for deterministic evaluation repository fixtures",
      "// FEATURE: api evaluation benchmark for retrieval and navigation",
      "import { createSession } from '../auth/session';",
      "",
      "export function searchCatalog(query: string): string {",
      "  return `${query}:${createSession(query)}`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(rootDir, "docs", "auth.md"),
    [
      "# Auth Hub",
      "",
      "- [[src/auth/jwt.ts|JWT auth code]]",
      "- [[src/auth/session.ts|Session lifecycle code]]",
      "",
    ].join("\n"),
  );
}

async function timeOperation<T>(operation: () => Promise<T>): Promise<{ durationMs: number; value: T }> {
  const started = performance.now();
  const value = await operation();
  return { durationMs: Number((performance.now() - started).toFixed(2)), value };
}

function buildCheck(name: string, passed: boolean, details: string): EvaluationCheck {
  return { name, passed, details };
}

function summarizeChecks(checks: EvaluationCheck[]): EvaluationCategory {
  const passed = checks.filter((check) => check.passed).length;
  return {
    passed,
    total: checks.length,
    checks,
  };
}

function findMatchingHit(
  hits: UnifiedRankedHit[],
  matcher: (hit: UnifiedRankedHit) => boolean,
): UnifiedRankedHit | undefined {
  return hits.find(matcher);
}

function formatHit(hit: UnifiedRankedHit | undefined): string {
  if (!hit) return "no matching hit";
  return `${hit.path} :: ${hit.title}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function runEvaluationSuite(): Promise<EvaluationReport> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-evaluation-"));

  try {
    resetTreeSitterRuntimeStats();
    await writeFixtureRepo(fixtureRoot);

    const initialIndex = await timeOperation(() => indexCodebase({ rootDir: fixtureRoot, mode: "full" }));
    const initialValidation = await validatePreparedIndex({ rootDir: fixtureRoot, mode: "full" });

    const verifyTokenHits = await rankUnifiedSearch({
      rootDir: fixtureRoot,
      query: "verifyToken",
      entityTypes: ["symbol"],
      topK: 3,
    });
    const createSessionHits = await rankUnifiedSearch({
      rootDir: fixtureRoot,
      query: "createSession",
      entityTypes: ["symbol"],
      topK: 3,
    });
    const buttonHits = await rankUnifiedSearch({
      rootDir: fixtureRoot,
      query: "renderPrimaryButton",
      entityTypes: ["symbol"],
      topK: 3,
    });

    const retrievalChecks = summarizeChecks([
      buildCheck(
        "find verifyToken symbol",
        Boolean(findMatchingHit(verifyTokenHits, (hit) => hit.path === "src/auth/jwt.ts" && hit.title === "verifyToken")),
        formatHit(findMatchingHit(verifyTokenHits, (hit) => hit.path === "src/auth/jwt.ts" && hit.title === "verifyToken")),
      ),
      buildCheck(
        "find createSession symbol",
        Boolean(findMatchingHit(createSessionHits, (hit) => hit.path === "src/auth/session.ts" && hit.title === "createSession")),
        formatHit(findMatchingHit(createSessionHits, (hit) => hit.path === "src/auth/session.ts" && hit.title === "createSession")),
      ),
      buildCheck(
        "find renderPrimaryButton symbol",
        Boolean(findMatchingHit(buttonHits, (hit) => hit.path === "src/ui/button.ts" && hit.title === "renderPrimaryButton")),
        formatHit(findMatchingHit(buttonHits, (hit) => hit.path === "src/ui/button.ts" && hit.title === "renderPrimaryButton")),
      ),
    ]);

    const clusterOutput = await semanticNavigate({ rootDir: fixtureRoot, maxDepth: 2, maxClusters: 6 });
    const hubOverview = await getFeatureHub({ rootDir: fixtureRoot });
    const authHub = await getFeatureHub({ rootDir: fixtureRoot, featureName: "auth" });

    const navigationChecks = summarizeChecks([
      buildCheck(
        "cluster output includes auth files",
        clusterOutput.includes("src/auth/jwt.ts") && clusterOutput.includes("src/auth/session.ts"),
        "expected auth files in semantic cluster output",
      ),
      buildCheck(
        "hub overview lists manual auth hub",
        hubOverview.includes("docs/auth.md"),
        "expected docs/auth.md in hub overview",
      ),
      buildCheck(
        "feature hub lookup resolves auth hub",
        authHub.includes("Path: docs/auth.md") && authHub.includes("src/auth/jwt.ts"),
        "expected auth hub path and linked file",
      ),
    ]);

    const researchOutput = await runResearch({
      rootDir: fixtureRoot,
      query: "how are auth tokens verified and sessions created",
      topK: 4,
      maxRelated: 4,
      maxSubsystems: 3,
      maxHubs: 3,
    });

    const answerChecks = summarizeChecks([
      buildCheck("research output has code hits section", researchOutput.includes("Code hits:"), "expected Code hits section"),
      buildCheck("research output has related context section", researchOutput.includes("Related context:"), "expected Related context section"),
      buildCheck("research output has hub context section", researchOutput.includes("Hub context:"), "expected Hub context section"),
      buildCheck(
        "research output mentions auth files",
        researchOutput.includes("src/auth/jwt.ts") && researchOutput.includes("src/auth/session.ts"),
        "expected auth paths in research report",
      ),
    ]);

    await runSearchByIntent({
      rootDir: fixtureRoot,
      intent: "exact",
      searchType: "symbol",
      query: "verifyToken",
      topK: 3,
    });
    const exactSearch = await timeOperation(() => runSearchByIntent({
      rootDir: fixtureRoot,
      intent: "exact",
      searchType: "symbol",
      query: "verifyToken",
      topK: 3,
    }));
    const relatedSearch = await timeOperation(() => runSearchByIntent({
      rootDir: fixtureRoot,
      intent: "related",
      searchType: "symbol",
      query: "verifyToken",
      topK: 3,
    }));
    const broadResearch = await timeOperation(() => runResearch({
      rootDir: fixtureRoot,
      query: "How does auth token verification and session creation work in this repository?",
      topK: 4,
      maxRelated: 4,
      maxSubsystems: 3,
      maxHubs: 3,
    }));
    const tokenCost: EvaluationTokenCost = {
      exactSearchChars: exactSearch.value.length,
      exactSearchEstimatedTokens: estimateTokens(exactSearch.value),
      relatedSearchChars: relatedSearch.value.length,
      relatedSearchEstimatedTokens: estimateTokens(relatedSearch.value),
      broadResearchChars: broadResearch.value.length,
      broadResearchEstimatedTokens: estimateTokens(broadResearch.value),
    };
    const hybridChecks = summarizeChecks([
      buildCheck(
        "exact search stays on fast exact output",
        exactSearch.value.includes("Exact symbol matches for \"verifyToken\""),
        exactSearch.value.split("\n")[0] ?? "missing exact search output",
      ),
      buildCheck(
        "related search stays on ranked discovery output",
        relatedSearch.value.includes("Search: \"verifyToken\"") && relatedSearch.value.includes("[symbol]"),
        relatedSearch.value.split("\n")[0] ?? "missing related search output",
      ),
      buildCheck(
        "exact search uses fewer estimated tokens than related search for the same exact question",
        tokenCost.exactSearchEstimatedTokens < tokenCost.relatedSearchEstimatedTokens,
        `exact=${tokenCost.exactSearchEstimatedTokens} related=${tokenCost.relatedSearchEstimatedTokens}`,
      ),
      buildCheck(
        "broad research still returns auth context after intent routing",
        broadResearch.value.includes("src/auth/jwt.ts") && broadResearch.value.includes("Subsystem context:"),
        broadResearch.value.split("\n").slice(0, 4).join(" | "),
      ),
    ]);

    await writeFile(
      join(fixtureRoot, "src", "auth", "session.ts"),
      [
        "// Session helpers for deterministic evaluation coverage and freshness",
        "// FEATURE: auth evaluation benchmark for retrieval and research",
        "import { verifyToken } from './jwt';",
        "",
        "export function buildSessionToken(token: string): string {",
        "  return `session:${verifyToken(token)}`;",
        "}",
        "",
      ].join("\n"),
    );

    const refreshIndex = await timeOperation(() => indexCodebase({ rootDir: fixtureRoot, mode: "full" }));
    const refreshValidation = await validatePreparedIndex({ rootDir: fixtureRoot, mode: "full" });
    const newSymbolHits = await rankUnifiedSearch({
      rootDir: fixtureRoot,
      query: "buildSessionToken",
      entityTypes: ["symbol"],
      topK: 3,
    });
    const oldSymbolHits = await rankUnifiedSearch({
      rootDir: fixtureRoot,
      query: "createSession",
      entityTypes: ["symbol"],
      topK: 5,
    });

    const freshnessChecks = summarizeChecks([
      buildCheck(
        "reindex validates after mutation",
        refreshValidation.ok,
        `validation issues=${refreshValidation.issues.length}`,
      ),
      buildCheck(
        "new symbol becomes searchable after refresh",
        Boolean(findMatchingHit(newSymbolHits, (hit) => hit.path === "src/auth/session.ts" && hit.title === "buildSessionToken")),
        formatHit(findMatchingHit(newSymbolHits, (hit) => hit.path === "src/auth/session.ts" && hit.title === "buildSessionToken")),
      ),
      buildCheck(
        "removed symbol no longer appears in top symbol hits",
        oldSymbolHits.every((hit) => hit.title !== "createSession"),
        oldSymbolHits.map((hit) => `${hit.path} :: ${hit.title}`).join(", ") || "no symbol hits",
      ),
    ]);

    const clusteringBenchmarks = {
      medium: await runClusteringBenchmark(400, 12),
      large: await runClusteringBenchmark(2400, 20),
    };

    const report: EvaluationReport = {
      suite: "default",
      generatedAt: new Date().toISOString(),
      ok: initialValidation.ok
        && refreshValidation.ok
        && retrievalChecks.passed === retrievalChecks.total
        && navigationChecks.passed === navigationChecks.total
        && answerChecks.passed === answerChecks.total
        && hybridChecks.passed === hybridChecks.total
        && freshnessChecks.passed === freshnessChecks.total,
      timings: {
        initialIndexMs: initialIndex.durationMs,
        refreshIndexMs: refreshIndex.durationMs,
        hotExactSearchMs: exactSearch.durationMs,
        relatedSearchMs: relatedSearch.durationMs,
        broadResearchMs: broadResearch.durationMs,
      },
      validation: {
        initialOk: initialValidation.ok,
        refreshOk: refreshValidation.ok,
      },
      retrievalQuality: retrievalChecks,
      navigationQuality: navigationChecks,
      answerQuality: answerChecks,
      hybridEfficiency: hybridChecks,
      artifactFreshness: freshnessChecks,
      tokenCost,
      clusteringBenchmarks,
      treeSitter: getTreeSitterRuntimeStats(),
    };

    return report;
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function formatCategory(lines: string[], title: string, category: EvaluationCategory): void {
  lines.push(`${title}: ${category.passed}/${category.total}`);
  for (const check of category.checks) {
    lines.push(`  - ${check.passed ? "PASS" : "FAIL"} | ${check.name} | ${check.details}`);
  }
  lines.push("");
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines = [
    `Evaluation suite: ${report.suite}`,
    `Generated at: ${report.generatedAt}`,
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
    `Validation: initial=${report.validation.initialOk ? "ok" : "failed"} | refresh=${report.validation.refreshOk ? "ok" : "failed"}`,
    `Timings: initialIndexMs=${report.timings.initialIndexMs.toFixed(2)} | refreshIndexMs=${report.timings.refreshIndexMs.toFixed(2)} | hotExactSearchMs=${report.timings.hotExactSearchMs.toFixed(2)} | relatedSearchMs=${report.timings.relatedSearchMs.toFixed(2)} | broadResearchMs=${report.timings.broadResearchMs.toFixed(2)}`,
    `Token cost: exact=${report.tokenCost.exactSearchEstimatedTokens} (${report.tokenCost.exactSearchChars} chars) | related=${report.tokenCost.relatedSearchEstimatedTokens} (${report.tokenCost.relatedSearchChars} chars) | research=${report.tokenCost.broadResearchEstimatedTokens} (${report.tokenCost.broadResearchChars} chars)`,
    `Clustering benchmarks: medium=${report.clusteringBenchmarks.medium.vectorCount} vectors in ${report.clusteringBenchmarks.medium.durationMs.toFixed(2)}ms (${report.clusteringBenchmarks.medium.clusterCount} clusters) | large=${report.clusteringBenchmarks.large.vectorCount} vectors in ${report.clusteringBenchmarks.large.durationMs.toFixed(2)}ms (${report.clusteringBenchmarks.large.clusterCount} clusters)`,
    `Tree-sitter stats: parses=${report.treeSitter.totalParseCalls} | parseFailures=${report.treeSitter.totalParseFailures} | grammarLoadFailures=${report.treeSitter.totalGrammarLoadFailures} | parserReuses=${report.treeSitter.totalParserReuses}`,
    "",
  ];

  formatCategory(lines, "Retrieval quality", report.retrievalQuality);
  formatCategory(lines, "Navigation quality", report.navigationQuality);
  formatCategory(lines, "Answer quality", report.answerQuality);
  formatCategory(lines, "Hybrid efficiency", report.hybridEfficiency);
  formatCategory(lines, "Artifact freshness", report.artifactFreshness);

  return lines.join("\n");
}

export async function runEvaluation(): Promise<string> {
  return formatEvaluationReport(await runEvaluationSuite());
}
