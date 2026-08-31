// src/skills/index.ts
export type {
  Inventory, NameResolution, NameResolutionOutcome, Skill, SkillFlag, SkillInstallation,
} from "./types.js";
export { parseFrontmatter, estimateListingTokens } from "./parse.js";
export type { SkillFrontmatter } from "./parse.js";
export { scanRoot, AGENT_ROOT_DEPTH, PLUGIN_ROOT_DEPTH } from "./scan.js";
export type { FoundSkill, ScanRoot } from "./scan.js";
export {
  buildInventory, inventoryRoots, applyFlags, pluginKeyFor, compareVersions,
  dedupeInstallations, COST_BASIS,
} from "./inventory.js";
export type { InventoryOptions } from "./inventory.js";
export {
  buildNameIndex, resolveName, resolveNames, invocationName, CLI_BUILTINS,
} from "./resolve.js";
export type { NameIndex } from "./resolve.js";
export {
  planArchive, executeArchive, executeRestore, readArchiveLog, findArchive, selectSkill,
  archiveDir, manifestDivergence, ArchiveRefusedError,
} from "./archive.js";
export type {
  ArchiveAction, ArchiveActionKind, ArchiveOptions, ArchivePlan, ArchiveRecord,
  ManifestDivergence, PlanArchiveOptions,
} from "./archive.js";
export { buildSkillsReport, expandSkill, selectableForArchive } from "./report.js";
export type { SkillsReport, Segment, SegmentId, SkillRow, InstallationRow, ReportInput } from "./report.js";
export { joinUsage } from "./assemble.js";
