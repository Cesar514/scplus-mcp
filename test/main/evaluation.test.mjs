// Deterministic evaluation suite tests for full-engine quality reporting
// FEATURE: Benchmark coverage for retrieval, navigation, freshness, and research output

import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.CONTEXTPLUS_EMBED_PROVIDER = "mock";

describe("evaluation", () => {
  it("runs the default benchmark suite and reports passing metrics", async () => {
    const { formatEvaluationReport, runEvaluationSuite } = await import("../../build/tools/evaluation.js");
    const report = await runEvaluationSuite();
    const rendered = formatEvaluationReport(report);

    assert.equal(report.ok, true);
    assert.equal(report.validation.initialOk, true);
    assert.equal(report.validation.refreshOk, true);
    assert.equal(report.retrievalQuality.passed, report.retrievalQuality.total);
    assert.equal(report.navigationQuality.passed, report.navigationQuality.total);
    assert.equal(report.answerQuality.passed, report.answerQuality.total);
    assert.equal(report.hybridEfficiency.passed, report.hybridEfficiency.total);
    assert.equal(report.artifactFreshness.passed, report.artifactFreshness.total);
    assert.equal(Number.isFinite(report.timings.initialIndexMs), true);
    assert.equal(Number.isFinite(report.timings.refreshIndexMs), true);
    assert.equal(Number.isFinite(report.timings.hotExactSearchMs), true);
    assert.equal(Number.isFinite(report.timings.relatedSearchMs), true);
    assert.equal(Number.isFinite(report.timings.broadResearchMs), true);
    assert.equal(report.tokenCost.exactSearchEstimatedTokens < report.tokenCost.relatedSearchEstimatedTokens, true);
    assert.match(rendered, /^Evaluation suite: default/m);
    assert.match(rendered, /Retrieval quality: 3\/3/);
    assert.match(rendered, /Hybrid efficiency: 4\/4/);
    assert.match(rendered, /Artifact freshness: 3\/3/);
    assert.match(rendered, /Token cost: exact=/);
  });
});
