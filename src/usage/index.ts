// src/usage/index.ts
export { UsageStore, usageDbPath } from "./store.js";
export { SCHEMA_VERSION, SOURCE_KINDS } from "./schema.js";
export type { Invocation, SourceKind, Watermark } from "./schema.js";
export { scanAdapter, scanAll } from "./scan.js";
export type { ScanResult, ScanOptions } from "./scan.js";
export { queryUsage, coverage, GROUP_BY_DIMENSIONS } from "./query.js";
export type { UsageQuery, UsageFilter, UsageRow, GroupBy, CoverageReport } from "./query.js";
export { extractorFor, registerExtractor, whitelistedArgument, claudeCodeExtractor, defaultExtractor } from "./extract.js";
export type { Extractor, ExtractContext } from "./extract.js";
export {
  coverageFor, zeroMeansUnused, renderCount, eligibleForBulkUnused, explainCoverage,
} from "./coverage.js";
export type { CoverageState, InstallationCoverage } from "./coverage.js";
export { buildUsageReport } from "./report.js";
export type { UsageReport, BlindSpot, PartiallyObserved, AdapterWindow, UsageWindow } from "./report.js";
