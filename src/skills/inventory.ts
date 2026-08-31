// src/skills/inventory.ts
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { listAgents, sharedLibraryRoot, type AgentRegistryOptions } from "../agents/index.js";
import type { ResolvedAgent } from "../agents/types.js";
import { estimateListingTokens, parseFrontmatter } from "./parse.js";
import { AGENT_ROOT_DEPTH, PLUGIN_ROOT_DEPTH, scanRoot, type FoundSkill, type ScanRoot } from "./scan.js";
import type { Inventory, Skill, SkillFlag, SkillInstallation } from "./types.js";

export const COST_BASIS =
  "estimated from SKILL.md frontmatter (name + description) at ~4 chars/token, charged " +
  "once per agent that lists the skill. An upper bound: some hosts list a name without " +
  "its description, and an agent honouring disable-model-invocation lists neither.";

export interface InventoryOptions extends AgentRegistryOptions {
  /** Project directories to check for project-local roots, e.g. session cwds. */
  projects?: string[];
  /** Skip the shared library root. Tests only. */
  includeShared?: boolean;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Roots to walk: every present root of every agent, the shared library root, and any
 * project-local root under a known project directory. Project roots are read-only here:
 * a repo file belongs to git and its collaborators, not to peek.
 */
export async function inventoryRoots(
  agents: ResolvedAgent[],
  opts: InventoryOptions = {},
): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = [];
  for (const agent of agents) {
    for (const root of agent.roots) {
      if (!root.present) continue;
      roots.push({
        path: root.path,
        agent: agent.slug,
        kind: root.kind,
        mutable: root.mutable,
        maxDepth: root.kind === "plugin" ? PLUGIN_ROOT_DEPTH : AGENT_ROOT_DEPTH,
      });
    }
  }
  if (opts.includeShared !== false) {
    const shared = sharedLibraryRoot(opts);
    if (await isDir(shared)) {
      roots.push({ path: shared, kind: "user", mutable: true, maxDepth: AGENT_ROOT_DEPTH });
    }
  }
  for (const project of opts.projects ?? []) {
    for (const agent of agents) {
      if (!agent.projectDir) continue;
      const path = join(project, agent.projectDir);
      if (!(await isDir(path))) continue;
      roots.push({
        path,
        agent: agent.slug,
        kind: "project",
        mutable: false,
        maxDepth: AGENT_ROOT_DEPTH,
      });
    }
  }
  return roots;
}

/**
 * Plugin skills key on `<marketplace>/<plugin>/<name>` with the version segment dropped:
 * their realpath carries a version, so keying on it would retire the skill and invent a
 * new one on every upgrade, destroying the usage history this effort accumulates.
 */
export function pluginKeyFor(found: FoundSkill): { key: string; qualifiedName: string } | undefined {
  if (found.root.kind !== "plugin") return undefined;
  const parts = found.relPath.split(sep).filter(Boolean);
  const start = parts[0] === "cache" ? 1 : 0;
  const marketplace = parts[start];
  const plugin = parts[start + 1];
  if (!marketplace || !plugin) return undefined;
  return {
    key: `plugin:${marketplace}/${plugin}/${found.name}`,
    qualifiedName: `${plugin}:${found.name}`,
  };
}

function keyFor(found: FoundSkill): { key: string; qualifiedName?: string } {
  const plugin = pluginKeyFor(found);
  if (plugin) return plugin;
  return { key: found.realDir };
}

export async function buildInventory(opts: InventoryOptions = {}): Promise<Inventory> {
  const agents = await listAgents(opts);
  const roots = await inventoryRoots(agents, opts);
  const honours = new Map(agents.map((a) => [a.slug, Boolean(a.honoursDisableModelInvocation)]));

  const skills = new Map<string, Skill>();
  for (const root of roots) {
    for (const found of await scanRoot(root)) {
      const { key, qualifiedName } = keyFor(found);
      const fm = parseFrontmatter(found.text);
      const estimatedTokens = estimateListingTokens(fm, found.name);
      const existing = skills.get(key);
      const skill: Skill = existing ?? {
        key,
        name: found.name,
        qualifiedName,
        description: fm.description,
        modelInvocable: !fm.disableModelInvocation,
        estimatedTokens,
        chargedTokens: 0,
        installations: [],
        flags: [],
      };
      const charged = !skill.modelInvocable && honours.get(root.agent ?? "") === true
        ? 0
        : root.agent === undefined ? 0 : estimatedTokens;
      const installation: SkillInstallation = {
        agent: root.agent,
        rootPath: root.path,
        rootKind: root.kind,
        mutable: root.mutable,
        path: found.dir,
        symlink: found.symlink,
        chargedTokens: charged,
      };
      skill.installations.push(installation);
      skill.chargedTokens += charged;
      skills.set(key, skill);
    }
  }

  const all = Array.from(skills.values());
  applyFlags(all);
  all.sort((a, b) => b.chargedTokens - a.chargedTokens || a.name.localeCompare(b.name));
  return {
    skills: all,
    rootsScanned: roots.map((r) => ({ path: r.path, agent: r.agent, kind: r.kind, present: true })),
    costBasis: COST_BASIS,
  };
}

/** Conditions the report and the MCP surface both read, rather than re-deriving. */
export function applyFlags(skills: Skill[]): void {
  const byName = new Map<string, number>();
  for (const skill of skills) byName.set(skill.name, (byName.get(skill.name) ?? 0) + 1);
  for (const skill of skills) {
    const flags: SkillFlag[] = [];
    if ((byName.get(skill.name) ?? 0) > 1) flags.push("duplicate-name");
    if (!skill.description) flags.push("no-description");
    if (skill.installations.every((i) => !i.mutable)) flags.push("immutable");
    if (!skill.modelInvocable) flags.push("not-model-invocable");
    if (skill.installations.every((i) => i.agent === undefined)) flags.push("unreferenced");
    skill.flags = flags;
  }
}
