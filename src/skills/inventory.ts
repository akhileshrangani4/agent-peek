// src/skills/inventory.ts
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { listAgents, sharedLibraryRoots, type AgentRegistryOptions } from "../agents/index.js";
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
  /** Skip the shared trees. Tests only. */
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
 * Roots to walk: every present root of every agent, the shared trees, and any
 * project-local root under a known project directory. Project roots are read-only here:
 * a repo file belongs to git and its collaborators, not to peek.
 */
export async function inventoryRoots(
  agents: ResolvedAgent[],
  opts: InventoryOptions = {},
): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = [];
  for (const agent of agents) {
    // An agent peek cannot show is installed contributes no installations: its "root" is
    // usually the shared tree, and attributing that content to it would invent
    // installations for agents the user does not have.
    if (agent.presence !== "present") continue;
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
    for (const shared of sharedLibraryRoots(opts)) {
      if (await isDir(shared) && !roots.some((r) => r.path === shared)) {
        roots.push({ path: shared, kind: "shared", mutable: false, maxDepth: AGENT_ROOT_DEPTH });
      }
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
export function pluginKeyFor(
  found: FoundSkill,
): { key: string; qualifiedName: string; version?: string } | undefined {
  if (found.root.kind !== "plugin") return undefined;
  const parts = found.relPath.split(sep).filter(Boolean);
  const start = parts[0] === "cache" ? 1 : 0;
  const marketplace = parts[start];
  const plugin = parts[start + 1];
  if (!marketplace || !plugin) return undefined;
  return {
    key: `plugin:${marketplace}/${plugin}/${found.name}`,
    qualifiedName: `${plugin}:${found.name}`,
    version: parts[start + 2],
  };
}

function keyFor(found: FoundSkill): { key: string; qualifiedName?: string; version?: string } {
  const plugin = pluginKeyFor(found);
  if (plugin) return plugin;
  return { key: found.realDir };
}

const DOTTED_NUMBER = /^\d+(\.\d+)*$/;

/**
 * Numeric-aware compare, so 1.10.0 sorts above 1.9.0. Returns 0 when either side is not
 * a dotted number: plugin version directories are sometimes content hashes, or the
 * literal "unknown", and those cannot be ordered by name at all.
 */
export function compareVersions(a = "", b = ""): number {
  if (!DOTTED_NUMBER.test(a) || !DOTTED_NUMBER.test(b)) return 0;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * The plugin cache keeps old versions beside the current one: posthog has 2 here, figma
 * 3, frontend-design 4. The agent loads one, so counting each version as an installation
 * charges the same skill several times over for the same agent. Keep the newest per
 * (agent, root).
 */
export function dedupeInstallations(installations: SkillInstallation[]): SkillInstallation[] {
  const best = new Map<string, SkillInstallation>();
  const out: SkillInstallation[] = [];
  for (const install of installations) {
    if (install.version === undefined) { out.push(install); continue; }
    const slot = `${install.agent ?? ""}\u0000${install.rootPath}`;
    const current = best.get(slot);
    if (!current || isNewer(install, current)) best.set(slot, install);
  }
  return [...out, ...best.values()];
}

/** Version order where the names allow it; otherwise the directory touched most recently. */
function isNewer(candidate: SkillInstallation, current: SkillInstallation): boolean {
  const byVersion = compareVersions(candidate.version, current.version);
  if (byVersion !== 0) return byVersion > 0;
  return (candidate.mtimeMs ?? 0) > (current.mtimeMs ?? 0);
}

export async function buildInventory(opts: InventoryOptions = {}): Promise<Inventory> {
  const agents = await listAgents(opts);
  const roots = await inventoryRoots(agents, opts);
  const honours = new Map(agents.map((a) => [a.slug, Boolean(a.honoursDisableModelInvocation)]));

  const skills = new Map<string, Skill>();
  for (const root of roots) {
    for (const found of await scanRoot(root)) {
      const { key, qualifiedName, version } = keyFor(found);
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
        version,
        mtimeMs: found.mtimeMs,
        chargedTokens: charged,
      };
      skill.installations.push(installation);
      skills.set(key, skill);
    }
  }

  const all = Array.from(skills.values());
  for (const skill of all) {
    skill.installations = dedupeInstallations(skill.installations);
    skill.chargedTokens = skill.installations.reduce((sum, i) => sum + i.chargedTokens, 0);
  }
  applyFlags(all, new Set(agents.filter((a) => a.tier === "verified").map((a) => a.slug)));
  all.sort((a, b) => b.chargedTokens - a.chargedTokens || a.name.localeCompare(b.name));
  return {
    skills: all,
    rootsScanned: roots.map((r) => ({ path: r.path, agent: r.agent, kind: r.kind, present: true })),
    costBasis: COST_BASIS,
  };
}

/**
 * Conditions the report and the MCP surface both read, rather than re-deriving.
 *
 * `verifiedAgents` gates `unreferenced`: several sourced-tier agents are rooted in the
 * shared tree, so counting their installations as references would let a third-party
 * table's claim suppress a real finding. "Nothing links to this" stays true until an
 * agent peek has actually verified reads it.
 */
export function applyFlags(skills: Skill[], verifiedAgents: Set<string> = new Set()): void {
  const byName = new Map<string, number>();
  for (const skill of skills) byName.set(skill.name, (byName.get(skill.name) ?? 0) + 1);
  for (const skill of skills) {
    const flags: SkillFlag[] = [];
    if ((byName.get(skill.name) ?? 0) > 1) flags.push("duplicate-name");
    if (!skill.description) flags.push("no-description");
    if (skill.installations.every((i) => !i.mutable)) flags.push("immutable");
    if (!skill.modelInvocable) flags.push("not-model-invocable");
    if (skill.installations.every((i) => i.agent === undefined || !verifiedAgents.has(i.agent))) {
      flags.push("unreferenced");
    }
    skill.flags = flags;
  }
}
