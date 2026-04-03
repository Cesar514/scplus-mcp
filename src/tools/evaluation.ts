// summary: Runs the prepared-index benchmark harness across scenario-based repository fixtures.
// FEATURE: Multi-scenario evaluation for retrieval, validation, freshness, and latency quality.
// inputs: Benchmark scenarios, prepared-index fixtures, and evaluation configuration.
// outputs: Retrieval quality, freshness, validation, and latency benchmark reports.

import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, extname, join } from "path";
import { performance } from "perf_hooks";
import { listRestorePoints, restorePoint } from "../git/shadow.js";
import { clusterVectors } from "../core/clustering.js";
import { deleteIndexArtifact, loadIndexArtifact } from "../core/index-database.js";
import { getTreeSitterRuntimeStats, resetTreeSitterRuntimeStats, type TreeSitterRuntimeStats } from "../core/tree-sitter.js";
import { getFeatureHub } from "./feature-hub.js";
import { getDependencyInfo, type DependencyInfo, type ExactSymbolHit } from "./exact-query.js";
import { indexCodebase } from "./index-codebase.js";
import { validatePreparedIndex, type IndexValidationReport } from "./index-reliability.js";
import { buildCheckpointReport } from "./propose-commit.js";
import { buildSearchByIntentReport, type SearchEntityType } from "./query-intent.js";
import { buildResearchReport } from "./research.js";
import { rankUnifiedSearch, type UnifiedRankedHit } from "./unified-ranking.js";

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

interface LatencyDistribution {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

interface ClusteringBenchmarkSample {
  vectorCount: number;
  clusterCount: number;
  durationMs: number;
}

interface ScenarioSummary {
  name: string;
  kind: "small-smoke" | "medium" | "large-monorepo" | "polyglot" | "ignored-generated" | "broken-state" | "rename-freshness";
  fileCount: number;
  languages: string[];
  indexMs: number;
  validationOk: boolean;
  notes: string[];
}

interface ValidationQuality {
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  checks: EvaluationCheck[];
}

interface FreshnessReliability {
  staleAfterWriteAttempts: number;
  staleAfterWriteFailures: number;
  staleAfterWriteFailureRate: number;
  restoreAttempts: number;
  restoreFailures: number;
  restoreFailureRate: number;
  checks: EvaluationCheck[];
}

export interface EvaluationReport {
  suite: "real-benchmark";
  generatedAt: string;
  ok: boolean;
  goldenQuestionCount: number;
  scenarios: ScenarioSummary[];
  scenarioCoverage: EvaluationCategory;
  smokeTest: EvaluationCategory;
  exactLookupAccuracy: EvaluationCategory;
  relatedSearchRelevance: EvaluationCategory;
  symbolResolutionAccuracy: EvaluationCategory;
  dependencyGraphAccuracy: EvaluationCategory;
  hubSuggestionQuality: EvaluationCategory;
  researchQuality: EvaluationCategory;
  freshnessReliability: FreshnessReliability;
  validationQuality: ValidationQuality;
  latencies: {
    exact: LatencyDistribution;
    related: LatencyDistribution;
    research: LatencyDistribution;
  };
  clusteringBenchmarks: {
    medium: ClusteringBenchmarkSample;
    large: ClusteringBenchmarkSample;
  };
  treeSitter: TreeSitterRuntimeStats;
}

interface PersistedFileManifest {
  files: string[];
}

interface ScenarioIndexResult {
  rootDir: string;
  summary: ScenarioSummary;
  validation: IndexValidationReport;
}

interface ExactGolden {
  name: string;
  rootDir: string;
  searchType: SearchEntityType;
  query: string;
  expectedPath: string;
  expectedTitle?: string;
  includeKinds?: string[];
}

interface RelatedGolden {
  name: string;
  rootDir: string;
  searchType: SearchEntityType;
  query: string;
  expectedPath: string;
  expectedTitle?: string;
  includeKinds?: string[];
}

interface DependencyGolden {
  name: string;
  rootDir: string;
  target: string;
  expectedDirectDependencies?: string[];
  expectedReverseDependencies?: string[];
}

interface HubGolden {
  name: string;
  rootDir: string;
  featureName?: string;
  query?: string;
  rankingMode?: "keyword" | "semantic" | "both";
  expectedIncludes: string;
}

interface ResearchGolden {
  name: string;
  rootDir: string;
  query: string;
  expectedPaths: string[];
}

interface ValidationObservation {
  name: string;
  expectedValid: boolean;
  report: IndexValidationReport;
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

function formatCheckResult(check: EvaluationCheck): string {
  return `${check.passed ? "PASS" : "FAIL"} | ${check.name} | ${check.details}`;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) {
    throw new Error("Latency distribution requires at least one sample.");
  }
  const position = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return Number(sortedValues[position].toFixed(2));
}

function buildLatencyDistribution(samples: number[]): LatencyDistribution {
  if (samples.length === 0) {
    throw new Error("Latency distribution requires at least one sample.");
  }
  const sorted = samples.slice().sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
  };
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

async function timeOperation<T>(operation: () => Promise<T>): Promise<{ durationMs: number; value: T }> {
  const started = performance.now();
  const value = await operation();
  return { durationMs: Number((performance.now() - started).toFixed(2)), value };
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

function estimateLanguage(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx") return "typescript";
  if (extension === ".py") return "python";
  if (extension === ".rs") return "rust";
  if (extension === ".go") return "go";
  if (extension === ".md") return "markdown";
  return extension || "unknown";
}

function buildFile(prefix: string, description: string, feature: string, body: string[]): string {
  return [`${prefix} ${description}`, `${prefix} FEATURE: ${feature}`, "", ...body, ""].join("\n");
}

async function writeRepoFiles(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(rootDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }
}

async function writeSmallSmokeRepo(rootDir: string): Promise<void> {
  await writeRepoFiles(rootDir, {
    "src/auth/jwt.ts": buildFile("//", "JWT verification helpers for the smoke benchmark", "Authentication", [
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
      "export function issueRefreshToken(userId: string): string {",
      "  return `refresh:${userId}`;",
      "}",
    ]),
    "src/auth/session.ts": buildFile("//", "Session helpers for the smoke benchmark", "Authentication", [
      "import { verifyToken } from './jwt';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
    ]),
    "src/ui/button.ts": buildFile("//", "UI helpers for the smoke benchmark", "UI", [
      "export function renderPrimaryButton(label: string): string {",
      "  return `<button>${label}</button>`;",
      "}",
    ]),
    "src/api/search.ts": buildFile("//", "Search API helpers for the smoke benchmark", "Catalog", [
      "import { createSession } from '../auth/session';",
      "",
      "export function searchCatalog(query: string): string {",
      "  return `${query}:${createSession(query)}`;",
      "}",
    ]),
    "docs/authentication.md": [
      "# Authentication",
      "",
      "- [[src/auth/jwt.ts|JWT verification]]",
      "- [[src/auth/session.ts|Session lifecycle]]",
      "",
    ].join("\n"),
  });
}

async function writeMediumRepo(rootDir: string): Promise<void> {
  await writeRepoFiles(rootDir, {
    "src/auth/jwt.ts": buildFile("//", "Auth token verification for the medium benchmark", "Authentication", [
      "export function verifyToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
    ]),
    "src/auth/session.ts": buildFile("//", "Session orchestration for the medium benchmark", "Authentication", [
      "import { verifyToken } from './jwt';",
      "",
      "export function createSession(token: string): string {",
      "  return `session:${verifyToken(token)}`;",
      "}",
    ]),
    "src/catalog/search.ts": buildFile("//", "Catalog search helpers for the medium benchmark", "Catalog", [
      "export function searchCatalog(query: string): string {",
      "  return query.trim().toLowerCase();",
      "}",
    ]),
    "src/catalog/filters.ts": buildFile("//", "Catalog filter helpers for the medium benchmark", "Catalog", [
      "export function buildCatalogFilters(tags: string[]): string {",
      "  return tags.join(',');",
      "}",
    ]),
    "src/orders/cart.ts": buildFile("//", "Cart summary helpers for the medium benchmark", "Orders", [
      "export function buildCartSummary(items: string[]): string {",
      "  return items.join('|');",
      "}",
    ]),
    "src/billing/invoice.ts": buildFile("//", "Invoice math helpers for the medium benchmark", "Billing", [
      "export function calculateInvoiceTotal(subtotal: number, taxRate: number): number {",
      "  return subtotal + (subtotal * taxRate);",
      "}",
    ]),
    "src/orders/checkout.ts": buildFile("//", "Checkout orchestration for the medium benchmark", "Orders", [
      "import { calculateInvoiceTotal } from '../billing/invoice';",
      "import { searchCatalog } from '../catalog/search';",
      "import { buildCartSummary } from './cart';",
      "",
      "export function buildCheckout(query: string, subtotal: number, taxRate: number): string {",
      "  const cart = buildCartSummary([searchCatalog(query)]);",
      "  return `${cart}:${calculateInvoiceTotal(subtotal, taxRate)}`;",
      "}",
    ]),
    "docs/billing.md": [
      "# Billing",
      "",
      "- [[src/billing/invoice.ts|Invoice calculations]]",
      "- [[src/orders/checkout.ts|Checkout orchestration]]",
      "",
    ].join("\n"),
  });
}

async function writeLargeMonorepo(rootDir: string): Promise<void> {
  const files: Record<string, string> = {
    "apps/web/src/auth/login.ts": buildFile("//", "Web login flow for the monorepo benchmark", "Authentication", [
      "import { buildSessionToken, normalizeAccessToken } from '../../../../packages/session/src/token';",
      "import { renderButton } from '../../../../packages/ui/src/button';",
      "",
      "export function loginWithToken(token: string): string {",
      "  const normalized = normalizeAccessToken(token);",
      "  return `${renderButton('login')}:${buildSessionToken(normalized)}`;",
      "}",
    ]),
    "apps/admin/src/audit/report.ts": buildFile("//", "Admin audit report view for the monorepo benchmark", "Audit", [
      "import { trackSessionAudit } from '../../../../packages/session/src/audit';",
      "import { renderTable } from '../../../../packages/ui/src/table';",
      "",
      "export function renderAuditReport(sessionId: string): string {",
      "  return `${renderTable(['audit'])}:${trackSessionAudit(sessionId)}`;",
      "}",
    ]),
    "services/auth/src/verify.ts": buildFile("//", "Service-side token verification for the monorepo benchmark", "Authentication", [
      "import { normalizeAccessToken } from '../../../../packages/session/src/token';",
      "",
      "export function verifyAccessToken(token: string): string {",
      "  return normalizeAccessToken(token);",
      "}",
    ]),
    "services/search/src/catalog.ts": buildFile("//", "Catalog analytics entrypoint for the monorepo benchmark", "Analytics", [
      "import { buildCatalogQuery } from '../../../../packages/catalog/src/query';",
      "",
      "export function runCatalogSearch(query: string): string {",
      "  return buildCatalogQuery(query);",
      "}",
    ]),
    "packages/session/src/token.ts": buildFile("//", "Session token helpers for the monorepo benchmark", "Authentication", [
      "export function normalizeAccessToken(token: string): string {",
      "  return token.trim().toLowerCase();",
      "}",
      "",
      "export function buildSessionToken(token: string): string {",
      "  return `session:${normalizeAccessToken(token)}`;",
      "}",
    ]),
    "packages/session/src/audit.ts": buildFile("//", "Session audit helpers for the monorepo benchmark", "Audit", [
      "export function trackSessionAudit(sessionId: string): string {",
      "  return `audit:${sessionId}`;",
      "}",
    ]),
    "packages/ui/src/button.ts": buildFile("//", "Button rendering for the monorepo benchmark", "UI", [
      "export function renderButton(label: string): string {",
      "  return `<button>${label}</button>`;",
      "}",
    ]),
    "packages/ui/src/table.ts": buildFile("//", "Table rendering for the monorepo benchmark", "UI", [
      "export function renderTable(columns: string[]): string {",
      "  return columns.join('|');",
      "}",
    ]),
    "packages/catalog/src/query.ts": buildFile("//", "Catalog query helpers for the monorepo benchmark", "Analytics", [
      "export function buildCatalogQuery(query: string): string {",
      "  return query.trim().toLowerCase();",
      "}",
    ]),
    "docs/auth-console.md": [
      "# Auth Console",
      "",
      "- [[apps/web/src/auth/login.ts|Web login flow]]",
      "- [[services/auth/src/verify.ts|Auth verification service]]",
      "- [[packages/session/src/token.ts|Session token helpers]]",
      "",
    ].join("\n"),
  };

  for (const packageName of ["catalog", "pricing", "analytics"]) {
    for (let index = 1; index <= 4; index++) {
      files[`packages/${packageName}/src/helper-${index}.ts`] = buildFile(
        "//",
        `${packageName} helper ${index} for the monorepo benchmark`,
        packageName === "analytics" ? "Analytics" : packageName === "pricing" ? "Billing" : "Catalog",
        [
          `export function ${packageName}Helper${index}(value: string): string {`,
          "  return value;",
          "}",
        ],
      );
    }
  }

  await writeRepoFiles(rootDir, files);
}

async function writePolyglotRepo(rootDir: string): Promise<void> {
  await writeRepoFiles(rootDir, {
    "src/web/auth.ts": buildFile("//", "TypeScript auth facade for the polyglot benchmark", "Authentication", [
      "export function verifyWebToken(token: string): string {",
      "  return token.trim();",
      "}",
    ]),
    "python/jobs/reconcile.py": buildFile("#", "Python invoice reconciliation for the polyglot benchmark", "Billing", [
      "def reconcile_invoices(batch_id: str) -> str:",
      "    return f\"reconcile:{batch_id}\"",
    ]),
    "rust/crypto/src/lib.rs": buildFile("//", "Rust payload signing for the polyglot benchmark", "Crypto", [
      "pub fn sign_payload(payload: &str) -> String {",
      "    format!(\"sig:{}\", payload.trim())",
      "}",
    ]),
    "go/gateway/main.go": buildFile("//", "Go gateway bootstrap for the polyglot benchmark", "Gateway", [
      "package main",
      "",
      "func StartGateway(address string) string {",
      "    return \"gateway:\" + address",
      "}",
    ]),
    "docs/crypto.md": [
      "# Crypto",
      "",
      "- [[rust/crypto/src/lib.rs|Rust signing helpers]]",
      "- [[go/gateway/main.go|Gateway bootstrap]]",
      "",
    ].join("\n"),
  });
}

async function writeIgnoredGeneratedRepo(rootDir: string): Promise<void> {
  const generatedNoise = Array.from({ length: 200 }, (_, index) => `export const GENERATED_${index} = "generated-${index}";`).join("\n");
  await writeRepoFiles(rootDir, {
    ".gitignore": [
      "generated/",
      "",
    ].join("\n"),
    "src/runtime/handler.ts": buildFile("//", "Runtime handler for ignored-tree benchmark", "Runtime", [
      "export function handleRuntimeEvent(eventName: string): string {",
      "  return `event:${eventName}`;",
      "}",
    ]),
    "src/runtime/router.ts": buildFile("//", "Runtime router for ignored-tree benchmark", "Runtime", [
      "import { handleRuntimeEvent } from './handler';",
      "",
      "export function routeRuntimeEvent(eventName: string): string {",
      "  return handleRuntimeEvent(eventName);",
      "}",
    ]),
    "generated/swagger-client.ts": buildFile("//", "Ignored generated client for ignored-tree benchmark", "Generated", [
      "export function dangerouslySpecificGeneratedToken(): string {",
      "  return 'generated-only';",
      "}",
    ]),
    "generated/bundle.ts": generatedNoise,
  });
}

async function writeBrokenBaseRepo(rootDir: string): Promise<void> {
  await writeRepoFiles(rootDir, {
    "src/auth/login.ts": buildFile("//", "Auth login flow for broken-state benchmark", "Authentication", [
      "export function loginUser(email: string): string {",
      "  return email.trim().toLowerCase();",
      "}",
    ]),
    "src/auth/session.ts": buildFile("//", "Auth session flow for broken-state benchmark", "Authentication", [
      "import { loginUser } from './login';",
      "",
      "export function startSession(email: string): string {",
      "  return `session:${loginUser(email)}`;",
      "}",
    ]),
  });
}

async function writeRenameFreshnessRepo(rootDir: string): Promise<void> {
  await writeRepoFiles(rootDir, {
    "src/billing/invoice.ts": buildFile("//", "Invoice helpers for freshness benchmark", "Billing", [
      "export function calculateInvoiceTotal(subtotal: number, taxRate: number): number {",
      "  return subtotal + (subtotal * taxRate);",
      "}",
    ]),
    "src/orders/checkout.ts": buildFile("//", "Checkout orchestration for freshness benchmark", "Orders", [
      "import { calculateInvoiceTotal } from '../billing/invoice';",
      "",
      "export function buildCheckoutTotal(subtotal: number, taxRate: number): number {",
      "  return calculateInvoiceTotal(subtotal, taxRate);",
      "}",
    ]),
  });
}

async function indexScenario(
  rootDir: string,
  name: ScenarioSummary["name"],
  kind: ScenarioSummary["kind"],
  notes: string[] = [],
): Promise<ScenarioIndexResult> {
  const indexTiming = await timeOperation(() => indexCodebase({ rootDir, mode: "full" }));
  const validation = await validatePreparedIndex({ rootDir, mode: "full" });
  const fileManifest = await loadIndexArtifact<PersistedFileManifest>(rootDir, "file-manifest", () => {
    throw new Error(`file-manifest is required for scenario "${name}".`);
  });
  const languages = Array.from(new Set(fileManifest.files.map(estimateLanguage))).sort();
  return {
    rootDir,
    validation,
    summary: {
      name,
      kind,
      fileCount: fileManifest.files.length,
      languages,
      indexMs: indexTiming.durationMs,
      validationOk: validation.ok,
      notes,
    },
  };
}

function hasExpectedHit(hits: UnifiedRankedHit[], expectedPath: string, expectedTitle?: string): UnifiedRankedHit | undefined {
  return hits.find((hit) => hit.path === expectedPath && (expectedTitle === undefined || hit.title === expectedTitle));
}

function hasExpectedExactSymbol(hits: ExactSymbolHit[], expectedPath: string, expectedTitle?: string): ExactSymbolHit | undefined {
  return hits.find((hit) => hit.path === expectedPath && (expectedTitle === undefined || hit.name === expectedTitle));
}

async function evaluateExactGoldens(goldens: ExactGolden[], latencySamples: number[]): Promise<EvaluationCategory> {
  const checks: EvaluationCheck[] = [];
  for (const golden of goldens) {
    const timed = await timeOperation(() => buildSearchByIntentReport({
      rootDir: golden.rootDir,
      intent: "exact",
      searchType: golden.searchType,
      query: golden.query,
      topK: 5,
      includeKinds: golden.includeKinds,
    }));
    latencySamples.push(timed.durationMs);
    const report = timed.value;
    if (report.intent !== "exact") {
      throw new Error(`Exact evaluation for "${golden.name}" unexpectedly returned a related-search report.`);
    }
    const passed = golden.searchType === "file"
      ? report.pathHits.includes(golden.expectedPath)
      : Boolean(hasExpectedExactSymbol(report.symbolHits, golden.expectedPath, golden.expectedTitle))
        || report.pathHits.includes(golden.expectedPath);
    const detail = report.intent === "exact"
      ? report.text.split("\n").slice(0, 3).join(" | ")
      : "unexpected report type";
    checks.push(buildCheck(golden.name, passed, detail));
  }
  return summarizeChecks(checks);
}

async function evaluateRelatedGoldens(goldens: RelatedGolden[], latencySamples: number[]): Promise<EvaluationCategory> {
  const checks: EvaluationCheck[] = [];
  for (const golden of goldens) {
    const timed = await timeOperation(() => buildSearchByIntentReport({
      rootDir: golden.rootDir,
      intent: "related",
      searchType: golden.searchType,
      query: golden.query,
      topK: 5,
      includeKinds: golden.includeKinds,
    }));
    latencySamples.push(timed.durationMs);
    const report = timed.value;
    if (report.intent !== "related") {
      throw new Error(`Related evaluation for "${golden.name}" unexpectedly returned an exact-search report.`);
    }
    const hit = hasExpectedHit(report.hits, golden.expectedPath, golden.expectedTitle);
    checks.push(buildCheck(
      golden.name,
      Boolean(hit),
      hit ? `${hit.path} :: ${hit.title}` : report.hits.map((entry) => `${entry.path} :: ${entry.title}`).join(", ") || "no hits",
    ));
  }
  return summarizeChecks(checks);
}

async function evaluateDependencyGoldens(goldens: DependencyGolden[]): Promise<EvaluationCategory> {
  const checks: EvaluationCheck[] = [];
  for (const golden of goldens) {
    const info = await getDependencyInfo(golden.rootDir, golden.target);
    const directPass = golden.expectedDirectDependencies
      ? golden.expectedDirectDependencies.every((dependency) => info.directDependencies.includes(dependency))
      : true;
    const reversePass = golden.expectedReverseDependencies
      ? golden.expectedReverseDependencies.every((dependency) => info.reverseDependencies.includes(dependency))
      : true;
    checks.push(buildCheck(
      golden.name,
      directPass && reversePass,
      formatDependencySummary(info),
    ));
  }
  return summarizeChecks(checks);
}

function formatDependencySummary(info: DependencyInfo): string {
  return `direct=${info.directDependencies.join(", ") || "none"} | reverse=${info.reverseDependencies.join(", ") || "none"}`;
}

async function evaluateHubGoldens(goldens: HubGolden[]): Promise<EvaluationCategory> {
  const checks: EvaluationCheck[] = [];
  for (const golden of goldens) {
    const output = await getFeatureHub({
      rootDir: golden.rootDir,
      featureName: golden.featureName,
      query: golden.query,
      rankingMode: golden.rankingMode,
    });
    checks.push(buildCheck(
      golden.name,
      output.includes(golden.expectedIncludes),
      output.split("\n").slice(0, 5).join(" | "),
    ));
  }
  return summarizeChecks(checks);
}

async function evaluateResearchGoldens(goldens: ResearchGolden[], latencySamples: number[]): Promise<EvaluationCategory> {
  const checks: EvaluationCheck[] = [];
  for (const golden of goldens) {
    const timed = await timeOperation(() => buildResearchReport({
      rootDir: golden.rootDir,
      query: golden.query,
      topK: 5,
      maxRelated: 5,
      maxSubsystems: 4,
      maxHubs: 4,
    }));
    latencySamples.push(timed.durationMs);
    const visiblePaths = new Set<string>([
      ...timed.value.codeHits.map((hit) => hit.path),
      ...timed.value.fileCards.map((hit) => hit.path),
      ...timed.value.relatedHits.map((hit) => hit.path),
    ]);
    const passed = golden.expectedPaths.every((path) => visiblePaths.has(path));
    checks.push(buildCheck(
      golden.name,
      passed,
      Array.from(visiblePaths).slice(0, 6).join(", ") || "no visible paths",
    ));
  }
  return summarizeChecks(checks);
}

function buildValidationQuality(observations: ValidationObservation[]): ValidationQuality {
  const checks: EvaluationCheck[] = [];
  let truePositives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const observation of observations) {
    const passed = observation.report.ok === observation.expectedValid;
    checks.push(buildCheck(
      observation.name,
      passed,
      `expected=${observation.expectedValid ? "valid" : "invalid"} actual=${observation.report.ok ? "valid" : "invalid"} issues=${observation.report.issues.length}`,
    ));
    if (observation.expectedValid) {
      if (observation.report.ok) truePositives += 1;
      else falsePositives += 1;
    } else if (observation.report.ok) {
      falseNegatives += 1;
    } else {
      trueNegatives += 1;
    }
  }

  const positiveDenominator = truePositives + falsePositives;
  const negativeDenominator = trueNegatives + falseNegatives;
  return {
    truePositives,
    trueNegatives,
    falsePositives,
    falseNegatives,
    falsePositiveRate: positiveDenominator === 0 ? 0 : Number((falsePositives / positiveDenominator).toFixed(4)),
    falseNegativeRate: negativeDenominator === 0 ? 0 : Number((falseNegatives / negativeDenominator).toFixed(4)),
    checks,
  };
}

function buildFreshnessReliability(
  checks: EvaluationCheck[],
  staleAfterWriteAttempts: number,
  staleAfterWriteFailures: number,
  restoreAttempts: number,
  restoreFailures: number,
): FreshnessReliability {
  return {
    staleAfterWriteAttempts,
    staleAfterWriteFailures,
    staleAfterWriteFailureRate: staleAfterWriteAttempts === 0 ? 0 : Number((staleAfterWriteFailures / staleAfterWriteAttempts).toFixed(4)),
    restoreAttempts,
    restoreFailures,
    restoreFailureRate: restoreAttempts === 0 ? 0 : Number((restoreFailures / restoreAttempts).toFixed(4)),
    checks,
  };
}

function buildScenarioCoverage(scenarios: ScenarioSummary[]): EvaluationCategory {
  const lookup = new Map(scenarios.map((scenario) => [scenario.kind, scenario]));
  const requiredKinds: ScenarioSummary["kind"][] = [
    "small-smoke",
    "medium",
    "large-monorepo",
    "polyglot",
    "ignored-generated",
    "broken-state",
    "rename-freshness",
  ];
  const checks = requiredKinds.map((kind) => {
    const scenario = lookup.get(kind);
    return buildCheck(
      `scenario ${kind} is present`,
      Boolean(scenario),
      scenario ? `${scenario.fileCount} files | validation=${scenario.validationOk}` : "missing scenario summary",
    );
  });
  return summarizeChecks(checks);
}

function buildSmokeChecks(smoke: ScenarioIndexResult): EvaluationCategory {
  const checks = [
    buildCheck("small smoke repo validates", smoke.validation.ok, `issues=${smoke.validation.issues.length}`),
    buildCheck("small smoke repo indexes auth files", smoke.summary.fileCount >= 4, `fileCount=${smoke.summary.fileCount}`),
    buildCheck("small smoke repo stays small", smoke.summary.fileCount <= 8, `fileCount=${smoke.summary.fileCount}`),
  ];
  return summarizeChecks(checks);
}

async function buildBrokenScenario(rootDir: string): Promise<{
  summary: ScenarioSummary;
  validation: IndexValidationReport;
  validationChecks: ValidationObservation[];
  researchCheck: EvaluationCheck;
}> {
  await writeBrokenBaseRepo(rootDir);
  const indexed = await indexScenario(rootDir, "broken-state", "broken-state", ["delete query-explanation-index after indexing"]);
  await deleteIndexArtifact(rootDir, "query-explanation-index");
  const brokenValidation = await validatePreparedIndex({ rootDir, mode: "full" });
  let researchThrew = false;
  let researchMessage = "";
  try {
    await buildResearchReport({
      rootDir,
      query: "how does authentication session startup work",
      topK: 3,
      maxRelated: 3,
      maxSubsystems: 2,
      maxHubs: 2,
    });
  } catch (error) {
    researchThrew = true;
    researchMessage = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  return {
    summary: {
      ...indexed.summary,
      validationOk: brokenValidation.ok,
    },
    validation: brokenValidation,
    validationChecks: [
      { name: "broken-state validation detects missing query explanation index", expectedValid: false, report: brokenValidation },
    ],
    researchCheck: buildCheck(
      "broken-state research fails loudly",
      researchThrew,
      researchThrew ? researchMessage : "research unexpectedly succeeded",
    ),
  };
}

async function runRenameFreshnessScenario(rootDir: string): Promise<{
  summary: ScenarioSummary;
  validation: IndexValidationReport;
  freshness: FreshnessReliability;
  validationObservations: ValidationObservation[];
}> {
  await writeRenameFreshnessRepo(rootDir);
  const initial = await indexScenario(rootDir, "rename-freshness", "rename-freshness", ["rename invoice.ts to pricing.ts and restore through checkpoint history"]);

  let staleAfterWriteAttempts = 0;
  let staleAfterWriteFailures = 0;
  let restoreAttempts = 0;
  let restoreFailures = 0;
  const checks: EvaluationCheck[] = [];
  const validationObservations: ValidationObservation[] = [{
    name: "rename-freshness initial validation stays valid",
    expectedValid: true,
    report: initial.validation,
  }];

  const oldInvoicePath = join(rootDir, "src", "billing", "invoice.ts");
  const newPricingPath = join(rootDir, "src", "billing", "pricing.ts");
  await rename(oldInvoicePath, newPricingPath);
  await writeRepoFiles(rootDir, {
    "src/billing/pricing.ts": buildFile("//", "Pricing helpers for freshness benchmark after rename", "Billing", [
      "export function calculatePricingPlan(subtotal: number, taxRate: number): number {",
      "  return subtotal + (subtotal * taxRate);",
      "}",
    ]),
    "src/orders/checkout.ts": buildFile("//", "Checkout orchestration for freshness benchmark after rename", "Orders", [
      "import { calculatePricingPlan } from '../billing/pricing';",
      "",
      "export function buildCheckoutTotal(subtotal: number, taxRate: number): number {",
      "  return calculatePricingPlan(subtotal, taxRate);",
      "}",
    ]),
  });

  await indexCodebase({ rootDir, mode: "full" });
  const renameValidation = await validatePreparedIndex({ rootDir, mode: "full" });
  validationObservations.push({
    name: "rename-freshness validation stays valid after file rename",
    expectedValid: true,
    report: renameValidation,
  });

  const renamedHits = await buildSearchByIntentReport({
    rootDir,
    intent: "exact",
    searchType: "symbol",
    query: "calculatePricingPlan",
    topK: 3,
  });
  if (renamedHits.intent !== "exact") {
    throw new Error("rename-freshness renamed symbol check expected an exact-search report.");
  }
  staleAfterWriteAttempts += 1;
  const renamedPass = Boolean(hasExpectedExactSymbol(renamedHits.symbolHits, "src/billing/pricing.ts", "calculatePricingPlan"));
  if (!renamedPass) staleAfterWriteFailures += 1;
  checks.push(buildCheck(
    "renamed symbol becomes searchable after reindex",
    renamedPass,
    renamedHits.text.split("\n").slice(0, 3).join(" | "),
  ));

  const oldSymbolHits = await buildSearchByIntentReport({
    rootDir,
    intent: "exact",
    searchType: "symbol",
    query: "calculateInvoiceTotal",
    topK: 3,
  });
  if (oldSymbolHits.intent !== "exact") {
    throw new Error("rename-freshness old symbol removal check expected an exact-search report.");
  }
  staleAfterWriteAttempts += 1;
  const oldSymbolPass = oldSymbolHits.symbolHits.length === 0;
  if (!oldSymbolPass) staleAfterWriteFailures += 1;
  checks.push(buildCheck(
    "old renamed symbol disappears after reindex",
    oldSymbolPass,
    oldSymbolHits.text.split("\n").slice(0, 3).join(" | "),
  ));

  const checkpointContent = buildFile("//", "Pricing helpers for freshness checkpoint mutation", "Billing", [
    "export function buildPricingPlan(subtotal: number, taxRate: number): number {",
    "  return subtotal + (subtotal * taxRate);",
    "}",
  ]);
  await buildCheckpointReport({
    rootDir,
    filePath: "src/billing/pricing.ts",
    newContent: checkpointContent,
  });
  const checkpointValidation = await validatePreparedIndex({ rootDir, mode: "full" });
  validationObservations.push({
    name: "rename-freshness validation stays valid after checkpoint write",
    expectedValid: true,
    report: checkpointValidation,
  });

  const checkpointHits = await buildSearchByIntentReport({
    rootDir,
    intent: "exact",
    searchType: "symbol",
    query: "buildPricingPlan",
    topK: 3,
  });
  if (checkpointHits.intent !== "exact") {
    throw new Error("rename-freshness checkpoint symbol check expected an exact-search report.");
  }
  staleAfterWriteAttempts += 1;
  const checkpointPass = Boolean(hasExpectedExactSymbol(checkpointHits.symbolHits, "src/billing/pricing.ts", "buildPricingPlan"));
  if (!checkpointPass) staleAfterWriteFailures += 1;
  checks.push(buildCheck(
    "checkpoint mutation becomes searchable immediately",
    checkpointPass,
    checkpointHits.text.split("\n").slice(0, 3).join(" | "),
  ));

  const oldPricingHits = await buildSearchByIntentReport({
    rootDir,
    intent: "exact",
    searchType: "symbol",
    query: "calculatePricingPlan",
    topK: 3,
  });
  if (oldPricingHits.intent !== "exact") {
    throw new Error("rename-freshness replaced symbol removal check expected an exact-search report.");
  }
  staleAfterWriteAttempts += 1;
  const oldPricingPass = oldPricingHits.symbolHits.length === 0;
  if (!oldPricingPass) staleAfterWriteFailures += 1;
  checks.push(buildCheck(
    "replaced pricing symbol disappears after checkpoint mutation",
    oldPricingPass,
    oldPricingHits.text.split("\n").slice(0, 3).join(" | "),
  ));

  const restorePoints = await listRestorePoints(rootDir);
  if (restorePoints.length === 0) {
    throw new Error("rename-freshness scenario expected at least one restore point.");
  }
  const latestRestorePoint = restorePoints[restorePoints.length - 1];
  await restorePoint(rootDir, latestRestorePoint.id);
  const restoreValidation = await validatePreparedIndex({ rootDir, mode: "full" });
  validationObservations.push({
    name: "rename-freshness validation stays valid after restore",
    expectedValid: true,
    report: restoreValidation,
  });

  const restoredHits = await buildSearchByIntentReport({
    rootDir,
    intent: "exact",
    searchType: "symbol",
    query: "calculatePricingPlan",
    topK: 3,
  });
  if (restoredHits.intent !== "exact") {
    throw new Error("rename-freshness restore symbol check expected an exact-search report.");
  }
  restoreAttempts += 1;
  const restoredPass = Boolean(hasExpectedExactSymbol(restoredHits.symbolHits, "src/billing/pricing.ts", "calculatePricingPlan"));
  if (!restoredPass) restoreFailures += 1;
  checks.push(buildCheck(
    "restore reintroduces the pre-checkpoint pricing symbol",
    restoredPass,
    restoredHits.text.split("\n").slice(0, 3).join(" | "),
  ));

  const restoredFileContent = await readFile(newPricingPath, "utf8");
  restoreAttempts += 1;
  const restoredContentPass = restoredFileContent.includes("calculatePricingPlan") && !restoredFileContent.includes("buildPricingPlan");
  if (!restoredContentPass) restoreFailures += 1;
  checks.push(buildCheck(
    "restore resets file content to the last known good pricing implementation",
    restoredContentPass,
    restoredFileContent.split("\n").slice(0, 4).join(" | "),
  ));

  const finalManifest = await loadIndexArtifact<PersistedFileManifest>(rootDir, "file-manifest", () => {
    throw new Error("file-manifest is required for rename-freshness summary.");
  });
  const languages = Array.from(new Set(finalManifest.files.map(estimateLanguage))).sort();

  return {
    summary: {
      name: "rename-freshness",
      kind: "rename-freshness",
      fileCount: finalManifest.files.length,
      languages,
      indexMs: initial.summary.indexMs,
      validationOk: restoreValidation.ok,
      notes: [
        "renamed billing/invoice.ts to billing/pricing.ts",
        "mutated pricing symbol through checkpoint",
        "restored latest checkpoint state",
      ],
    },
    validation: restoreValidation,
    freshness: buildFreshnessReliability(
      checks,
      staleAfterWriteAttempts,
      staleAfterWriteFailures,
      restoreAttempts,
      restoreFailures,
    ),
    validationObservations,
  };
}

function buildReportOk(report: EvaluationReport): boolean {
  return report.scenarioCoverage.passed === report.scenarioCoverage.total
    && report.smokeTest.passed === report.smokeTest.total
    && report.exactLookupAccuracy.passed === report.exactLookupAccuracy.total
    && report.relatedSearchRelevance.passed === report.relatedSearchRelevance.total
    && report.symbolResolutionAccuracy.passed === report.symbolResolutionAccuracy.total
    && report.dependencyGraphAccuracy.passed === report.dependencyGraphAccuracy.total
    && report.hubSuggestionQuality.passed === report.hubSuggestionQuality.total
    && report.researchQuality.passed === report.researchQuality.total
    && report.freshnessReliability.staleAfterWriteFailures === 0
    && report.freshnessReliability.restoreFailures === 0
    && report.validationQuality.falsePositiveRate === 0
    && report.validationQuality.falseNegativeRate === 0;
}

export async function runEvaluationSuite(): Promise<EvaluationReport> {
  const roots: string[] = [];
  const exactLatencySamples: number[] = [];
  const relatedLatencySamples: number[] = [];
  const researchLatencySamples: number[] = [];

  try {
    resetTreeSitterRuntimeStats();

    const smallRoot = await mkdtemp(join(tmpdir(), "scplus-eval-small-"));
    roots.push(smallRoot);
    await writeSmallSmokeRepo(smallRoot);
    const small = await indexScenario(smallRoot, "small-smoke", "small-smoke", ["tiny synthetic repo kept only as smoke test"]);

    const mediumRoot = await mkdtemp(join(tmpdir(), "scplus-eval-medium-"));
    roots.push(mediumRoot);
    await writeMediumRepo(mediumRoot);
    const medium = await indexScenario(mediumRoot, "medium", "medium", ["multi-feature TypeScript service repo"]);

    const largeRoot = await mkdtemp(join(tmpdir(), "scplus-eval-large-"));
    roots.push(largeRoot);
    await writeLargeMonorepo(largeRoot);
    const large = await indexScenario(largeRoot, "large-monorepo", "large-monorepo", ["multi-app monorepo with shared packages and suggested hubs"]);

    const polyglotRoot = await mkdtemp(join(tmpdir(), "scplus-eval-polyglot-"));
    roots.push(polyglotRoot);
    await writePolyglotRepo(polyglotRoot);
    const polyglot = await indexScenario(polyglotRoot, "polyglot", "polyglot", ["TypeScript, Python, Rust, Go, and Markdown indexed together"]);

    const ignoredRoot = await mkdtemp(join(tmpdir(), "scplus-eval-ignored-"));
    roots.push(ignoredRoot);
    await writeIgnoredGeneratedRepo(ignoredRoot);
    const ignored = await indexScenario(ignoredRoot, "ignored-generated", "ignored-generated", ["generated/ is ignored through .gitignore"]);
    const ignoredManifest = await loadIndexArtifact<PersistedFileManifest>(ignoredRoot, "file-manifest", () => {
      throw new Error("file-manifest is required for ignored-generated validation.");
    });
    const ignoredExcluded = ignoredManifest.files.every((filePath) => !filePath.startsWith("generated/"));
    ignored.summary.notes.push(ignoredExcluded ? "generated/ excluded from file manifest" : "generated/ unexpectedly indexed");

    const brokenRoot = await mkdtemp(join(tmpdir(), "scplus-eval-broken-"));
    roots.push(brokenRoot);
    const broken = await buildBrokenScenario(brokenRoot);

    const renameRoot = await mkdtemp(join(tmpdir(), "scplus-eval-rename-"));
    roots.push(renameRoot);
    const renameFreshness = await runRenameFreshnessScenario(renameRoot);

    const exactGoldens: ExactGolden[] = [
      {
        name: "small smoke exact symbol resolves verifyToken",
        rootDir: smallRoot,
        searchType: "symbol",
        query: "verifyToken",
        expectedPath: "src/auth/jwt.ts",
        expectedTitle: "verifyToken",
      },
      {
        name: "medium exact symbol resolves calculateInvoiceTotal",
        rootDir: mediumRoot,
        searchType: "symbol",
        query: "calculateInvoiceTotal",
        expectedPath: "src/billing/invoice.ts",
        expectedTitle: "calculateInvoiceTotal",
      },
      {
        name: "large monorepo exact symbol resolves buildSessionToken",
        rootDir: largeRoot,
        searchType: "symbol",
        query: "buildSessionToken",
        expectedPath: "packages/session/src/token.ts",
        expectedTitle: "buildSessionToken",
      },
      {
        name: "polyglot exact symbol resolves sign_payload",
        rootDir: polyglotRoot,
        searchType: "symbol",
        query: "sign_payload",
        expectedPath: "rust/crypto/src/lib.rs",
        expectedTitle: "sign_payload",
      },
      {
        name: "ignored-generated exact symbol resolves runtime handler instead of generated noise",
        rootDir: ignoredRoot,
        searchType: "symbol",
        query: "handleRuntimeEvent",
        expectedPath: "src/runtime/handler.ts",
        expectedTitle: "handleRuntimeEvent",
      },
    ];

    const relatedGoldens: RelatedGolden[] = [
      {
        name: "medium related search finds checkout orchestration",
        rootDir: mediumRoot,
        searchType: "file",
        query: "checkout invoice total",
        expectedPath: "src/orders/checkout.ts",
      },
      {
        name: "large monorepo related search finds session token helpers",
        rootDir: largeRoot,
        searchType: "file",
        query: "login session normalization",
        expectedPath: "packages/session/src/token.ts",
      },
      {
        name: "polyglot related search finds rust signing implementation",
        rootDir: polyglotRoot,
        searchType: "file",
        query: "payload signing digest",
        expectedPath: "rust/crypto/src/lib.rs",
      },
      {
        name: "ignored-generated related search stays on runtime router instead of ignored bundle",
        rootDir: ignoredRoot,
        searchType: "file",
        query: "runtime event routing",
        expectedPath: "src/runtime/router.ts",
      },
    ];

    const symbolGoldens: RelatedGolden[] = [
      {
        name: "medium symbol resolution finds calculateInvoiceTotal from natural language",
        rootDir: mediumRoot,
        searchType: "symbol",
        query: "calculate invoice total",
        expectedPath: "src/billing/invoice.ts",
        expectedTitle: "calculateInvoiceTotal",
        includeKinds: ["function"],
      },
      {
        name: "large monorepo symbol resolution finds verifyAccessToken",
        rootDir: largeRoot,
        searchType: "symbol",
        query: "verify access token",
        expectedPath: "services/auth/src/verify.ts",
        expectedTitle: "verifyAccessToken",
        includeKinds: ["function"],
      },
      {
        name: "polyglot symbol resolution finds reconcile_invoices",
        rootDir: polyglotRoot,
        searchType: "symbol",
        query: "reconcile invoices",
        expectedPath: "python/jobs/reconcile.py",
        expectedTitle: "reconcile_invoices",
        includeKinds: ["function"],
      },
    ];

    const dependencyGoldens: DependencyGolden[] = [
      {
        name: "medium dependency graph keeps checkout imports accurate",
        rootDir: mediumRoot,
        target: "src/orders/checkout.ts",
        expectedDirectDependencies: [
          "src/billing/invoice.ts",
          "src/catalog/search.ts",
          "src/orders/cart.ts",
        ],
      },
      {
        name: "large monorepo dependency graph keeps web login imports accurate",
        rootDir: largeRoot,
        target: "apps/web/src/auth/login.ts",
        expectedDirectDependencies: [
          "packages/session/src/token.ts",
          "packages/ui/src/button.ts",
        ],
      },
      {
        name: "small smoke reverse dependencies include session.ts for jwt.ts",
        rootDir: smallRoot,
        target: "src/auth/jwt.ts",
        expectedReverseDependencies: [
          "src/auth/session.ts",
        ],
      },
    ];

    const hubGoldens: HubGolden[] = [
      {
        name: "small smoke manual auth hub resolves by feature name",
        rootDir: smallRoot,
        featureName: "Authentication",
        expectedIncludes: "docs/authentication.md",
      },
      {
        name: "medium manual billing hub resolves by feature name",
        rootDir: mediumRoot,
        featureName: "Billing",
        expectedIncludes: "docs/billing.md",
      },
      {
        name: "large monorepo suggested analytics hub resolves by feature name",
        rootDir: largeRoot,
        featureName: "Analytics",
        expectedIncludes: ".scplus/hubs/suggested/analytics.md",
      },
      {
        name: "polyglot crypto hub ranks correctly for query mode",
        rootDir: polyglotRoot,
        query: "crypto signing payload gateway",
        rankingMode: "both",
        expectedIncludes: "docs/crypto.md",
      },
    ];

    const researchGoldens: ResearchGolden[] = [
      {
        name: "medium research joins checkout and billing context",
        rootDir: mediumRoot,
        query: "how does checkout compute invoice totals",
        expectedPaths: [
          "src/orders/checkout.ts",
          "src/billing/invoice.ts",
        ],
      },
      {
        name: "large monorepo research joins login, verify, and session packages",
        rootDir: largeRoot,
        query: "how do web login and session token helpers work",
        expectedPaths: [
          "apps/web/src/auth/login.ts",
          "packages/session/src/token.ts",
        ],
      },
      {
        name: "polyglot research joins signing and gateway flow",
        rootDir: polyglotRoot,
        query: "how are payloads signed before gateway delivery",
        expectedPaths: [
          "rust/crypto/src/lib.rs",
          "go/gateway/main.go",
        ],
      },
    ];

    const exactLookupAccuracy = await evaluateExactGoldens(exactGoldens, exactLatencySamples);
    const relatedSearchRelevance = await evaluateRelatedGoldens(relatedGoldens, relatedLatencySamples);
    const symbolResolutionAccuracy = await evaluateRelatedGoldens(symbolGoldens, relatedLatencySamples);
    const dependencyGraphAccuracy = await evaluateDependencyGoldens(dependencyGoldens);
    const hubSuggestionQuality = await evaluateHubGoldens(hubGoldens);
    const researchQuality = await evaluateResearchGoldens(researchGoldens, researchLatencySamples);

    const validationObservations: ValidationObservation[] = [
      { name: "small smoke validation stays valid", expectedValid: true, report: small.validation },
      { name: "medium validation stays valid", expectedValid: true, report: medium.validation },
      { name: "large monorepo validation stays valid", expectedValid: true, report: large.validation },
      { name: "polyglot validation stays valid", expectedValid: true, report: polyglot.validation },
      { name: "ignored-generated validation stays valid", expectedValid: true, report: ignored.validation },
      ...broken.validationChecks,
      ...renameFreshness.validationObservations,
    ];

    const validationQuality = buildValidationQuality(validationObservations);

    const ignoredChecks = summarizeChecks([
      buildCheck(
        "ignored-generated scenario excludes generated files from the prepared manifest",
        ignoredExcluded,
        ignoredManifest.files.join(", "),
      ),
      buildCheck(
        "broken-state validation reports invalid prepared state",
        broken.validation.ok === false,
        `issues=${broken.validation.issues.length}`,
      ),
      broken.researchCheck,
    ]);

    const scenarioCoverage = summarizeChecks([
      ...buildScenarioCoverage([
        small.summary,
        medium.summary,
        large.summary,
        polyglot.summary,
        ignored.summary,
        broken.summary,
        renameFreshness.summary,
      ]).checks,
      ...ignoredChecks.checks,
    ]);

    const smokeTest = buildSmokeChecks(small);

    const clusteringBenchmarks = {
      medium: await runClusteringBenchmark(400, 12),
      large: await runClusteringBenchmark(2400, 20),
    };

    const report: EvaluationReport = {
      suite: "real-benchmark",
      generatedAt: new Date().toISOString(),
      ok: false,
      goldenQuestionCount: exactGoldens.length
        + relatedGoldens.length
        + symbolGoldens.length
        + dependencyGoldens.length
        + hubGoldens.length
        + researchGoldens.length,
      scenarios: [
        small.summary,
        medium.summary,
        large.summary,
        polyglot.summary,
        ignored.summary,
        broken.summary,
        renameFreshness.summary,
      ],
      scenarioCoverage,
      smokeTest,
      exactLookupAccuracy,
      relatedSearchRelevance,
      symbolResolutionAccuracy,
      dependencyGraphAccuracy,
      hubSuggestionQuality,
      researchQuality,
      freshnessReliability: renameFreshness.freshness,
      validationQuality,
      latencies: {
        exact: buildLatencyDistribution(exactLatencySamples),
        related: buildLatencyDistribution(relatedLatencySamples),
        research: buildLatencyDistribution(researchLatencySamples),
      },
      clusteringBenchmarks,
      treeSitter: getTreeSitterRuntimeStats(),
    };
    report.ok = buildReportOk(report);
    return report;
  } finally {
    await Promise.all(roots.map(async (rootDir) => rm(rootDir, { recursive: true, force: true })));
  }
}

function formatCategory(lines: string[], title: string, category: EvaluationCategory): void {
  lines.push(`${title}: ${category.passed}/${category.total}`);
  for (const check of category.checks) {
    lines.push(`  - ${formatCheckResult(check)}`);
  }
  lines.push("");
}

function formatLatencyDistribution(label: string, distribution: LatencyDistribution): string {
  return `${label}: samples=${distribution.sampleCount} | p50=${distribution.p50Ms.toFixed(2)}ms | p95=${distribution.p95Ms.toFixed(2)}ms | p99=${distribution.p99Ms.toFixed(2)}ms | max=${distribution.maxMs.toFixed(2)}ms`;
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines = [
    `Evaluation suite: ${report.suite}`,
    `Generated at: ${report.generatedAt}`,
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
    `Golden operator questions: ${report.goldenQuestionCount}`,
    `Validation rates: falsePositiveRate=${report.validationQuality.falsePositiveRate.toFixed(4)} | falseNegativeRate=${report.validationQuality.falseNegativeRate.toFixed(4)} | truePositives=${report.validationQuality.truePositives} | trueNegatives=${report.validationQuality.trueNegatives}`,
    `Freshness rates: staleAfterWriteFailures=${report.freshnessReliability.staleAfterWriteFailures}/${report.freshnessReliability.staleAfterWriteAttempts} | restoreFailures=${report.freshnessReliability.restoreFailures}/${report.freshnessReliability.restoreAttempts}`,
    formatLatencyDistribution("Exact latency", report.latencies.exact),
    formatLatencyDistribution("Related latency", report.latencies.related),
    formatLatencyDistribution("Research latency", report.latencies.research),
    `Clustering benchmarks: medium=${report.clusteringBenchmarks.medium.vectorCount} vectors in ${report.clusteringBenchmarks.medium.durationMs.toFixed(2)}ms (${report.clusteringBenchmarks.medium.clusterCount} clusters) | large=${report.clusteringBenchmarks.large.vectorCount} vectors in ${report.clusteringBenchmarks.large.durationMs.toFixed(2)}ms (${report.clusteringBenchmarks.large.clusterCount} clusters)`,
    `Tree-sitter stats: parses=${report.treeSitter.totalParseCalls} | parseFailures=${report.treeSitter.totalParseFailures} | grammarLoadFailures=${report.treeSitter.totalGrammarLoadFailures} | parserReuses=${report.treeSitter.totalParserReuses}`,
    "",
    `Scenario summaries (${report.scenarios.length})`,
  ];

  for (const scenario of report.scenarios) {
    lines.push(`- ${scenario.name} [${scenario.kind}] files=${scenario.fileCount} languages=${scenario.languages.join(", ")} indexMs=${scenario.indexMs.toFixed(2)} validation=${scenario.validationOk ? "ok" : "failed"}`);
    for (const note of scenario.notes) {
      lines.push(`  note: ${note}`);
    }
  }
  lines.push("");

  formatCategory(lines, "Scenario coverage", report.scenarioCoverage);
  formatCategory(lines, "Smoke test", report.smokeTest);
  formatCategory(lines, "Exact lookup accuracy", report.exactLookupAccuracy);
  formatCategory(lines, "Related-search relevance", report.relatedSearchRelevance);
  formatCategory(lines, "Symbol resolution accuracy", report.symbolResolutionAccuracy);
  formatCategory(lines, "Dependency graph accuracy", report.dependencyGraphAccuracy);
  formatCategory(lines, "Hub suggestion quality", report.hubSuggestionQuality);
  formatCategory(lines, "Research quality", report.researchQuality);
  formatCategory(lines, "Validation quality", summarizeChecks(report.validationQuality.checks));
  formatCategory(lines, "Freshness reliability", summarizeChecks(report.freshnessReliability.checks));

  return lines.join("\n");
}

export async function runEvaluation(): Promise<string> {
  return formatEvaluationReport(await runEvaluationSuite());
}
