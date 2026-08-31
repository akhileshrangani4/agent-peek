// src/skills/resolve.ts
import type { Inventory, NameResolution, Skill } from "./types.js";

/**
 * Slash commands that are not skills. The usage index records invocation names exactly
 * as typed, and a Claude Code transcript's slash commands include built-ins; without
 * this list they would surface as unknown skills the user cannot find.
 */
export const CLI_BUILTINS = new Set([
  "add-dir", "agents", "bashes", "bug", "clear", "compact", "config", "context", "cost",
  "cd", "doctor", "exit", "export", "help", "hooks", "ide", "init", "install-github-app",
  "login", "logout", "mcp", "memory", "migrate-installer", "model", "output-style",
  "permissions", "pr-comments", "privacy-settings", "release-notes", "reload-skills",
  "resume", "review", "rewind", "status", "statusline", "terminal-setup", "todos",
  "upgrade", "usage", "vim",
]);

/** Strips the leading slash a slash-command invocation carries. Nothing else: the name
 * is never rewritten, only looked up under the spellings a skill answers to. */
export function invocationName(raw: string): string {
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

export interface NameIndex {
  bySpelling: Map<string, Skill[]>;
}

/**
 * Every spelling a skill answers to: its bare name, and `<plugin>:<name>` for a plugin
 * skill. Built from the inventory so a name that was ambiguous last month resolves
 * correctly once the inventory changes — no rewrite of an index whose sources are gone.
 */
export function buildNameIndex(inventory: Inventory): NameIndex {
  const bySpelling = new Map<string, Skill[]>();
  const add = (spelling: string, skill: Skill) => {
    const list = bySpelling.get(spelling);
    if (list) {
      if (!list.includes(skill)) list.push(skill);
    } else bySpelling.set(spelling, [skill]);
  };
  for (const skill of inventory.skills) {
    add(skill.name, skill);
    if (skill.qualifiedName) add(skill.qualifiedName, skill);
  }
  return { bySpelling };
}

/**
 * Resolve one recorded invocation name. Three outcomes matter and must stay distinct:
 * a unique skill, several skills answering to one name (never silently merged, never
 * split), and a name matching nothing — which is a CLI built-in or genuinely unknown.
 */
export function resolveName(index: NameIndex, raw: string): NameResolution {
  const name = invocationName(raw);
  const matches = index.bySpelling.get(name) ?? [];
  if (matches.length === 1) return { name: raw, outcome: "unique", keys: [matches[0]!.key] };
  if (matches.length > 1) {
    return { name: raw, outcome: "ambiguous", keys: matches.map((s) => s.key) };
  }
  if (raw.startsWith("/") && CLI_BUILTINS.has(name)) {
    return { name: raw, outcome: "not-a-skill", keys: [] };
  }
  return { name: raw, outcome: "unmatched", keys: [] };
}

export function resolveNames(inventory: Inventory, names: string[]): NameResolution[] {
  const index = buildNameIndex(inventory);
  return names.map((name) => resolveName(index, name));
}

/**
 * Row predicate that drops CLI built-ins from a usage report grouped by skill or tool.
 *
 * Shared by `peek usage` and the MCP surface so the rule exists once: a second copy of a
 * coverage rule is how the two drift and one of them starts reporting `/clear` as a
 * skill. Returns undefined when the grouping has no name column to test.
 */
export function builtinRowFilter<Row extends { skill?: string | null; tool?: string }>(
  index: NameIndex,
  dimension: string | undefined,
): ((row: Row) => boolean) | undefined {
  if (dimension !== "skill" && dimension !== "tool") return undefined;
  return (row: Row) => {
    const raw = dimension === "skill" ? row.skill : row.tool;
    if (!raw) return true;
    // resolveName classifies a built-in only when the name carries its leading slash, and
    // the index stores it stripped. Testing the slash spelling unconditionally is safe
    // because resolveName matches the inventory first: a real skill named `clear` still
    // resolves to itself rather than to the built-in.
    return resolveName(index, `/${raw}`).outcome !== "not-a-skill";
  };
}
