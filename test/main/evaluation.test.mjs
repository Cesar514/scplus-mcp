// Real benchmark evaluation suite tests for multi-scenario quality reporting
// FEATURE: Benchmark coverage for retrieval, validation, freshness, and latency distributions

import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

describe("evaluation", () => {
  it("runs the real benchmark suite and reports passing scenario metrics", async () => {
    const { formatEvaluationReport, runEvaluationSuite } = await import("../../build/tools/evaluation.js");
    const report = await runEvaluationSuite();
    const rendered = formatEvaluationReport(report);

    assert.equal(report.ok, true);
    assert.equal(report.suite, "real-benchmark");
    assert.equal(report.goldenQuestionCount >= 20, true);
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.kind),
      ["small-smoke", "medium", "large-monorepo", "polyglot", "ignored-generated", "broken-state", "rename-freshness"],
    );
    assert.equal(report.scenarioCoverage.passed, report.scenarioCoverage.total);
    assert.equal(report.smokeTest.passed, report.smokeTest.total);
    assert.equal(report.exactLookupAccuracy.passed, report.exactLookupAccuracy.total);
    assert.equal(report.relatedSearchRelevance.passed, report.relatedSearchRelevance.total);
    assert.equal(report.symbolResolutionAccuracy.passed, report.symbolResolutionAccuracy.total);
    assert.equal(report.dependencyGraphAccuracy.passed, report.dependencyGraphAccuracy.total);
    assert.equal(report.hubSuggestionQuality.passed, report.hubSuggestionQuality.total);
    assert.equal(report.researchQuality.passed, report.researchQuality.total);
    assert.equal(report.validationQuality.falsePositiveRate, 0);
    assert.equal(report.validationQuality.falseNegativeRate, 0);
    assert.equal(report.freshnessReliability.staleAfterWriteFailures, 0);
    assert.equal(report.freshnessReliability.restoreFailures, 0);
    assert.equal(report.latencies.exact.sampleCount >= 5, true);
    assert.equal(report.latencies.related.sampleCount >= 7, true);
    assert.equal(report.latencies.research.sampleCount >= 3, true);
    assert.equal(report.latencies.exact.p50Ms <= report.latencies.exact.p99Ms, true);
    assert.equal(report.latencies.related.p50Ms <= report.latencies.related.p99Ms, true);
    assert.equal(report.latencies.research.p50Ms <= report.latencies.research.p99Ms, true);
    assert.equal(Number.isFinite(report.clusteringBenchmarks.medium.durationMs), true);
    assert.equal(Number.isFinite(report.clusteringBenchmarks.large.durationMs), true);
    assert.equal(report.clusteringBenchmarks.medium.vectorCount, 400);
    assert.equal(report.clusteringBenchmarks.large.vectorCount, 2400);
    assert.equal(report.treeSitter.totalParseCalls > 0, true);
    assert.equal(report.treeSitter.totalParseFailures, 0);
    assert.match(rendered, /^Evaluation suite: real-benchmark/m);
    assert.match(rendered, /Scenario summaries \(7\)/);
    assert.match(rendered, /Validation rates: falsePositiveRate=0\.0000 \| falseNegativeRate=0\.0000/);
    assert.match(rendered, /Exact latency: samples=/);
    assert.match(rendered, /Related latency: samples=/);
    assert.match(rendered, /Research latency: samples=/);
    assert.match(rendered, /Scenario coverage: 10\/10/);
    assert.match(rendered, /Hub suggestion quality: 4\/4/);
    assert.match(rendered, /Research quality: 3\/3/);
    assert.match(rendered, /Freshness reliability: 6\/6/);
    assert.match(rendered, /Clustering benchmarks: medium=400 vectors in /);
    assert.match(rendered, /Tree-sitter stats: parses=/);
  });
});
