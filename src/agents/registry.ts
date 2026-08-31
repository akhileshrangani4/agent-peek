// src/agents/registry.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { adapterAttributes, adapterObserves, builtinAgents, type HomeEnv } from "./builtin.js";
import type { Agent, ResolvedAgent, ResolvedSkillRoot, SkillRoot } from "./types.js";

interface AgentsFile {
  version: 1;
  agents: Agent[];
}

export interface AgentRegistryOptions extends HomeEnv {
  /** Override the ~/.agent-peek directory. Tests only. */
  stateDir?: string;
}

function stateDirFor(opts: AgentRegistryOptions): string {
  if (opts.stateDir) return opts.stateDir;
  return join(opts.home ?? process.env.HOME ?? homedir(), ".agent-peek");
}

function userFilePath(opts: AgentRegistryOptions): string {
  return join(stateDirFor(opts), "agents.json");
}

export async function readUserAgents(opts: AgentRegistryOptions = {}): Promise<Agent[]> {
  let text: string;
  try {
    text = await readFile(userFilePath(opts), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as AgentsFile;
    if (!parsed || !Array.isArray(parsed.agents)) return [];
    return parsed.agents.filter((a) => typeof a?.slug === "string" && Array.isArray(a.roots));
  } catch {
    return [];
  }
}

async function writeUserAgents(agents: Agent[], opts: AgentRegistryOptions): Promise<void> {
  const dir = stateDirFor(opts);
  await mkdir(dir, { recursive: true });
  const path = userFilePath(opts);
  const tmp = `${path}.tmp-${process.pid}`;
  const body: AgentsFile = { version: 1, agents };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function mergeRoots(base: SkillRoot[], extra: SkillRoot[]): SkillRoot[] {
  const out = [...base];
  for (const root of extra) {
    const existing = out.findIndex((r) => r.path === root.path);
    if (existing >= 0) out[existing] = root;
    else out.push(root);
  }
  return out;
}

/**
 * Builtin table plus user entries. A user entry sharing a builtin's slug extends it:
 * roots are merged by path, and adapter/displayName override when given.
 */
export function mergeAgents(builtin: Agent[], user: Agent[]): Agent[] {
  const bySlug = new Map(builtin.map((a) => [a.slug, { ...a, roots: [...a.roots] }]));
  for (const entry of user) {
    const base = bySlug.get(entry.slug);
    if (!base) {
      bySlug.set(entry.slug, { ...entry, userDefined: true });
      continue;
    }
    bySlug.set(entry.slug, {
      ...base,
      displayName: entry.displayName ?? base.displayName,
      adapter: entry.adapter ?? base.adapter,
      roots: mergeRoots(base.roots, entry.roots),
      userDefined: true,
    });
  }
  return Array.from(bySlug.values());
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Check each candidate root against disk and derive capabilities. Never stored. */
export async function resolveAgent(agent: Agent): Promise<ResolvedAgent> {
  const roots: ResolvedSkillRoot[] = [];
  for (const root of agent.roots) {
    roots.push({ ...root, present: await isDir(root.path) });
  }
  const observes = adapterObserves(agent.adapter);
  let installed = false;
  for (const path of agent.detectPaths ?? []) {
    if (await isDir(path)) { installed = true; break; }
  }
  // A root that resolves is evidence the agent is here — unless that root is the shared
  // tree, which exists for anyone who has ever used the installer and says nothing about
  // whether this particular agent is installed. Those agents need their own directory.
  const ownRootPresent = roots.some((r) => r.present && r.kind !== "shared");
  const attributes = adapterAttributes(agent.adapter);
  return {
    ...agent,
    roots,
    observes,
    observable: observes.length > 0,
    attributes,
    attributable: attributes.length > 0,
    manageable: roots.some((r) => r.present && r.mutable),
    installed,
    presence: ownRootPresent || installed ? "present"
      : roots.length === 0 ? "no-convention"
      : "absent",
  };
}

export async function listAgents(opts: AgentRegistryOptions = {}): Promise<ResolvedAgent[]> {
  const merged = mergeAgents(builtinAgents(opts), await readUserAgents(opts));
  return Promise.all(merged.map(resolveAgent));
}

/**
 * An agent with no root on disk and no readable sessions is noise on this machine:
 * hidden by default, shown under `--all`, so `peek agents` distinguishes what peek
 * could support from what is actually installed here.
 */
export function isPresent(agent: ResolvedAgent, adaptersWithSessions: Set<string> = new Set()): boolean {
  if (agent.presence === "present") return true;
  return Boolean(agent.adapter && adaptersWithSessions.has(agent.adapter));
}

export async function addAgent(agent: Agent, opts: AgentRegistryOptions = {}): Promise<void> {
  const user = await readUserAgents(opts);
  const next = user.filter((a) => a.slug !== agent.slug);
  next.push({ ...agent, userDefined: true });
  await writeUserAgents(next, opts);
}

/** Removes the user entry only. A builtin agent reverts to its shipped definition. */
export async function removeAgent(slug: string, opts: AgentRegistryOptions = {}): Promise<boolean> {
  const user = await readUserAgents(opts);
  const next = user.filter((a) => a.slug !== slug);
  if (next.length === user.length) return false;
  await writeUserAgents(next, opts);
  return true;
}
