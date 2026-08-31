// src/skills/index.ts
export type {
  Inventory, NameResolution, NameResolutionOutcome, Skill, SkillFlag, SkillInstallation,
} from "./types.js";
export { parseFrontmatter, estimateListingTokens } from "./parse.js";
export type { SkillFrontmatter } from "./parse.js";
export { scanRoot, AGENT_ROOT_DEPTH, PLUGIN_ROOT_DEPTH } from "./scan.js";
export type { FoundSkill, ScanRoot } from "./scan.js";
export { buildInventory, inventoryRoots, applyFlags, pluginKeyFor, COST_BASIS } from "./inventory.js";
export type { InventoryOptions } from "./inventory.js";
export {
  buildNameIndex, resolveName, resolveNames, invocationName, CLI_BUILTINS,
} from "./resolve.js";
export type { NameIndex } from "./resolve.js";
