// src/index.ts
import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

export type {
  SessionEntry, SessionStatus, SessionExecution, SessionOutcome, Activity, FileClaim,
  RawMessage, ToolCall,
  Cursor, CursorData,
  Snapshot, RawSnapshot, StructuredSnapshot, BriefSnapshot, SummarySnapshot, HandoffSnapshot,
  SnapshotMode, RawWindowFrom, RawOrder,
  PeekResult,
  CoordinationCursor, CoordinationSession, CoordinationOverlap, CoordinationDigest,
} from "./core/types.js";

export {
  SessionNotFoundError, AmbiguousSelectorError, AdapterError,
  AdapterNotFoundError, CursorMismatchError, InvalidCursorError, RegistryLockTimeoutError,
  TranscriptUnreadableError, TranscriptCorruptError, SummaryUnavailableError,
  PostRejectedError, PostNotFoundError, NotAProjectError, NonExportableFieldError,
} from "./core/errors.js";

// ADR 0002: the one guard every outbound payload passes through.
export {
  assertExportable, containsHomePath, isRepoRelativePath, EXPORT_KINDS, EXPORTABLE_NODE_KINDS,
  EXPORTABLE_EDGE_KINDS, EXPORTABLE_EDGE_ORIGINS, STATUS_SUMMARY_MAX_CHARS, CLAIM_NOTE_MAX_CHARS,
  GRAPH_BATCH_MAX_ROWS,
} from "./export/assert-exportable.js";
export type {
  ExportKind, ExportPayload, ExportablePost, ExportableClaim, ExportableStatus,
  ExportableGraphBatch, ExportableGraphNode, ExportableGraphEdge,
} from "./export/assert-exportable.js";

export {
  addAgent, adapterObserves, builtinAgents, isPresent, listAgents, mergeAgents,
  readUserAgents, removeAgent, resolveAgent, sharedLibraryRoot, sharedLibraryRoots,
  AGENT_TABLE_SOURCE,
} from "./agents/index.js";
export type {
  Agent, AgentTier, GeneratedAgent, InvocationKind, ResolvedAgent, ResolvedSkillRoot,
  SkillRoot, SkillRootKind,
} from "./agents/index.js";

export {
  buildInventory, inventoryRoots, applyFlags, pluginKeyFor, compareVersions,
  dedupeInstallations, COST_BASIS,
  buildNameIndex, resolveName, resolveNames, invocationName, CLI_BUILTINS,
  parseFrontmatter, estimateListingTokens, scanRoot,
} from "./skills/index.js";
export type {
  Inventory, InventoryOptions, NameIndex, NameResolution, NameResolutionOutcome,
  Skill, SkillFlag, SkillInstallation, SkillFrontmatter, ScanRoot, FoundSkill,
} from "./skills/index.js";
export {
  planArchive, executeArchive, executeRestore, readArchiveLog, findArchive, selectSkill,
  archiveDir, manifestDivergence, ArchiveRefusedError,
} from "./skills/index.js";
export type {
  ArchiveAction, ArchiveActionKind, ArchiveOptions, ArchivePlan, ArchiveRecord,
  ManifestDivergence, PlanArchiveOptions,
} from "./skills/index.js";

export { Registry } from "./core/registry.js";
export { ClaimsStore } from "./core/claims.js";
export { Engine } from "./core/engine.js";
export { encodeCursor, decodeCursor, cursorAdapter } from "./core/cursor.js";

// The usage index. `queryUsage` is the only public way to read it: it is the seam
// that keeps the schema an implementation detail, and the single enforcement point for
// the ADR 0001 retention boundary.
export {
  UsageStore, usageDbPath, scanAdapter, scanAll, queryUsage, coverage, GROUP_BY_DIMENSIONS,
  extractorFor, registerExtractor, SCHEMA_VERSION as USAGE_SCHEMA_VERSION,
  coverageFor, zeroMeansUnused, renderCount, eligibleForBulkUnused, explainCoverage,
  buildUsageReport,
} from "./usage/index.js";
export { buildSkillsReport, expandSkill, selectableForArchive, joinUsage } from "./skills/index.js";
export type { SkillsReport, Segment, SkillRow, InstallationRow } from "./skills/index.js";
export type {
  Invocation, SourceKind, Watermark, ScanResult, ScanOptions,
  UsageQuery, UsageFilter, UsageRow, GroupBy, CoverageReport, Extractor,
  CoverageState, InstallationCoverage, UsageReport, BlindSpot, PartiallyObserved, AdapterWindow,
} from "./usage/index.js";
export { toRaw, toStructured, toBrief, toSummary } from "./core/snapshot.js";
export { toHandoff, buildHandoff, compressTranscript, renderHandoffPrompt, resolveHandoffRunner, parseHandoffTarget } from "./core/handoff.js";
export {
  encodeCoordinationCursor, decodeCoordinationCursor,
  buildCoordinationDigest, buildCoordinationSession,
} from "./core/coordination.js";

export {
  postToFeed, readFeed, expandPost, feedStats,
  validatePost, estimateTokens, DEFAULT_TTL_MS,
  FeedStore, feedDbPath, projectIdentity, resolveAuthor,
} from "./feed/index.js";
export type {
  FeedPost, PostInput, PostType, PostAuthor, PostEvidence, PostOrigin, PostValidity,
  PackedItem, PackedFeed, RankContext, FeedReadResult,
} from "./feed/index.js";

export { AdapterLoader, discoverExternal } from "./app/adapters.js";
export type { Adapter, AdapterReadResult, AdapterModule, AdapterCatalog } from "./core/types.js";

export { createEngine } from "./app/engine.js";
export type { CreateEngineOpts } from "./app/engine.js";
export { Row, Rows, Rule, state, num, overflow, padEnd, padStart, terminalWidth, colorEnabled, renderStatic, sparkline, sparklineBlank } from "./cli/render.js";
export type { Role, Cell } from "./cli/render.js";
