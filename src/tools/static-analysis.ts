// summary: Static-analysis entry surface.
// FEATURE: Public lint report exports.
// inputs: Repository lint options.
// outputs: Re-exported static-analysis helpers.

export type {
  NativeLintResult,
  RuleFinding,
  ScoreSummary,
  StaticAnalysisFileScore,
  StaticAnalysisOptions,
  StaticAnalysisReport,
} from "./static-analysis-core.js";
export {
  buildStaticAnalysisReport,
  formatStaticAnalysisReport,
  runStaticAnalysis,
} from "./static-analysis-core.js";
