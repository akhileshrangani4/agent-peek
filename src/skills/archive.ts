// src/skills/archive.ts
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Inventory, Skill, SkillInstallation } from "./types.js";

/**
 * Archiving a skill is two different acts on disk, and which one applies is derived from
 * the installation, never configured:
 *
 * - `unlink`: the installation is a symlink, so the content lives somewhere else (the
 *   shared tree, for all 57 multi-agent skills on the author's machine). Removing
 *   the link retires the skill for that agent and leaves every other agent's link intact.
 * - `move`: the installation *is* the content, so it has to go somewhere recoverable.
 *
 * Confusing the two is the failure mode this module exists to prevent: resolving a
 * symlink and moving its target relocates the shared content and breaks the skill for
 * every other agent pointing at it at once.
 */
export type ArchiveActionKind = "unlink" | "move";

export interface ArchiveAction {
  kind: ArchiveActionKind;
  skillKey: string;
  skillName: string;
  agent?: string;
  /** The path inside the skill root. Never the symlink's target. */
  path: string;
  rootPath: string;
  /** Where content is moved to. Absent for an unlink. */
  destination?: string;
  /** The link target, recorded so a restore can recreate it. */
  linkTarget?: string;
}

export interface ArchivePlan {
  skillKey: string;
  skillName: string;
  actions: ArchiveAction[];
  /** Installations deliberately left alone, with the reason. */
  skipped: { path: string; agent?: string; reason: string }[];
  warnings: string[];
}

export class ArchiveRefusedError extends Error {
  constructor(readonly reason: string, message: string, readonly detail: string[] = []) {
    super(message);
    this.name = "ArchiveRefusedError";
  }
}

export interface ArchiveRecord {
  id: string;
  skillKey: string;
  skillName: string;
  archivedAt: string;
  actions: ArchiveAction[];
  /** True when the plan stopped part way: `actions` holds only what actually happened. */
  partial?: true;
  /** Why the plan stopped, for a partial record. */
  failure?: string;
}

export interface ArchiveOptions {
  /** Overrides ~/.agent-peek. Tests only. */
  stateDir?: string;
  home?: string;
}

export interface PlanArchiveOptions extends ArchiveOptions {
  /** Restrict to one agent's installation. */
  agent?: string;
  /** Retire the skill from every mutable root it is installed in. */
  allAgents?: boolean;
  /** Roots peek will still hold after the operation; content under one survives an unlink. */
  survivingRoots?: string[];
}

export function archiveDir(opts: ArchiveOptions = {}): string {
  return join(opts.stateDir ?? join(opts.home ?? process.env.HOME ?? homedir(), ".agent-peek"), "archive");
}

function logPath(opts: ArchiveOptions): string {
  return join(archiveDir(opts), "log.json");
}

function isUnder(path: string, parent: string): boolean {
  const p = resolve(path);
  const base = resolve(parent);
  return p === base || p.startsWith(base + sep);
}

/** Selects the skill an operation names: by key, or by name when that is unambiguous. */
export function selectSkill(inventory: Inventory, selector: string): Skill {
  const byKey = inventory.skills.find((s) => s.key === selector);
  if (byKey) return byKey;
  const byName = inventory.skills.filter((s) => s.name === selector || s.qualifiedName === selector);
  if (byName.length === 1) return byName[0]!;
  if (byName.length === 0) {
    throw new ArchiveRefusedError("unknown_skill", `No skill named ${selector}.`);
  }
  throw new ArchiveRefusedError(
    "ambiguous_skill",
    `${selector} names ${byName.length} skills. Re-run with one of these keys.`,
    byName.map((s) => s.key),
  );
}

/**
 * Builds the plan without touching the filesystem. Every refusal happens here, before any
 * mutation is possible.
 */
export function planArchive(
  inventory: Inventory,
  selector: string,
  opts: PlanArchiveOptions = {},
): ArchivePlan {
  const skill = selectSkill(inventory, selector);
  const skipped: ArchivePlan["skipped"] = [];
  const warnings: string[] = [];

  const candidates: SkillInstallation[] = [];
  for (const install of skill.installations) {
    if (!install.agent) {
      skipped.push({ path: install.path, reason: "shared tree: not an agent's installation" });
      continue;
    }
    if (!install.mutable) {
      skipped.push({
        path: install.path,
        agent: install.agent,
        reason: install.rootKind === "shared"
          ? "shared tree: its content backs every other agent's links"
          : `${install.rootKind} root is read-only`,
      });
      continue;
    }
    if (opts.agent && install.agent !== opts.agent) continue;
    candidates.push(install);
  }

  if (opts.agent && candidates.length === 0) {
    throw new ArchiveRefusedError(
      "not_installed_for_agent",
      `${skill.name} has no mutable installation for ${opts.agent}.`,
      skill.installations.filter((i) => i.agent).map((i) => `${i.agent}: ${i.path}`),
    );
  }
  if (candidates.length === 0) {
    throw new ArchiveRefusedError(
      "nothing_mutable",
      `${skill.name} has no installation peek may modify.`,
      skipped.map((s) => `${s.agent ?? "-"}: ${s.reason}`),
    );
  }
  // The scope is never guessed: 56 skills here reach four agents each.
  if (candidates.length > 1 && !opts.allAgents && !opts.agent) {
    throw new ArchiveRefusedError(
      "scope_required",
      `${skill.name} is installed for ${candidates.length} agents. Choose --agent <slug> or --all-agents.`,
      candidates.map((i) => `${i.agent}: ${i.path}`),
    );
  }

  const surviving = opts.survivingRoots
    ?? inventory.rootsScanned.map((r) => r.path);
  const actions: ArchiveAction[] = [];
  for (const install of candidates) {
    const common = {
      skillKey: skill.key,
      skillName: skill.name,
      agent: install.agent,
      path: install.path,
      rootPath: install.rootPath,
    };
    if (install.symlink) {
      actions.push({ ...common, kind: "unlink" });
      continue;
    }
    actions.push({ ...common, kind: "move" });
  }

  const removedRoots = new Set(actions.map((a) => a.rootPath));
  const contentSurvives = skill.installations.some((i) =>
    !i.symlink && (!removedRoots.has(i.rootPath) || i.agent === undefined)
    && surviving.some((root) => isUnder(i.path, root)));
  if (actions.some((a) => a.kind === "unlink") && !contentSurvives) {
    warnings.push(
      `${skill.name} is unlinked from its agent(s); peek did not verify the link target survives.`,
    );
  }
  return { skillKey: skill.key, skillName: skill.name, actions, skipped, warnings };
}

/**
 * Runs a plan. `move` never resolves the symlink first — it refuses outright if the path
 * it was told to move turns out to be a link, because moving a link's target relocates
 * shared content and breaks every other agent pointing at it.
 */
export async function executeArchive(
  plan: ArchivePlan,
  opts: ArchiveOptions = {},
): Promise<ArchiveRecord> {
  const id = `${Date.now().toString(36)}-${plan.skillName.replace(/[^\w.-]/g, "_")}`;
  const dir = join(archiveDir(opts), id);
  const done: ArchiveAction[] = [];
  try {
    await runActions(plan, dir, done);
  } catch (e) {
    // A refusal mid-plan is expected: execution re-checks the filesystem rather than
    // trusting a plan computed earlier. What must never happen is the earlier actions
    // being applied with no record, leaving the user unlinked and unable to restore.
    if (done.length > 0) {
      await appendRecord({
        id,
        skillKey: plan.skillKey,
        skillName: plan.skillName,
        archivedAt: new Date().toISOString(),
        actions: done,
        partial: true,
        failure: (e as Error).message,
      }, opts);
    }
    throw e;
  }
  const record: ArchiveRecord = {
    id,
    skillKey: plan.skillKey,
    skillName: plan.skillName,
    archivedAt: new Date().toISOString(),
    actions: done,
  };
  await appendRecord(record, opts);
  return record;
}

async function runActions(plan: ArchivePlan, dir: string, done: ArchiveAction[]): Promise<void> {
  for (const action of plan.actions) {
    const link = await lstat(action.path).catch(() => undefined);
    if (!link) {
      throw new ArchiveRefusedError("path_missing", `${action.path} no longer exists.`);
    }
    if (action.kind === "unlink") {
      if (!link.isSymbolicLink()) {
        throw new ArchiveRefusedError(
          "not_a_symlink",
          `${action.path} is a real directory; it must be moved, not unlinked.`,
        );
      }
      const target = await readlinkSafe(action.path);
      await unlink(action.path);
      done.push({ ...action, linkTarget: target });
      continue;
    }
    if (link.isSymbolicLink()) {
      throw new ArchiveRefusedError(
        "refuse_move_symlink",
        `${action.path} is a symlink; moving it would relocate shared content and break every other agent linking to it.`,
      );
    }
    const destination = join(dir, action.agent ?? "shared", basename(action.path));
    await mkdir(dirname(destination), { recursive: true });
    await rename(action.path, destination);
    done.push({ ...action, destination });
  }
}

async function readlinkSafe(path: string): Promise<string | undefined> {
  try {
    const { readlink } = await import("node:fs/promises");
    return await readlink(path);
  } catch {
    return undefined;
  }
}

export async function readArchiveLog(opts: ArchiveOptions = {}): Promise<ArchiveRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(logPath(opts), "utf8")) as { records?: ArchiveRecord[] };
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

async function appendRecord(record: ArchiveRecord, opts: ArchiveOptions): Promise<void> {
  const records = await readArchiveLog(opts);
  records.push(record);
  await mkdir(archiveDir(opts), { recursive: true });
  const path = logPath(opts);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Most recent archive of a skill, by name or key or archive id. */
export function findArchive(records: ArchiveRecord[], selector: string): ArchiveRecord {
  const matches = records.filter((r) =>
    r.id === selector || r.skillName === selector || r.skillKey === selector);
  const last = matches[matches.length - 1];
  if (!last) throw new ArchiveRefusedError("no_archive", `Nothing archived under ${selector}.`);
  return last;
}

/** Puts every action of a record back: a moved directory returns, a link is recreated. */
export async function executeRestore(
  record: ArchiveRecord,
  opts: ArchiveOptions = {},
): Promise<ArchiveRecord> {
  for (const action of record.actions) {
    if (await lstat(action.path).catch(() => undefined)) {
      throw new ArchiveRefusedError(
        "restore_occupied",
        `${action.path} exists again; refusing to overwrite it.`,
      );
    }
    await mkdir(dirname(action.path), { recursive: true });
    if (action.kind === "move") {
      if (!action.destination) {
        throw new ArchiveRefusedError("no_destination", `Archive record for ${action.path} has no content.`);
      }
      await rename(action.destination, action.path);
    } else {
      if (!action.linkTarget) {
        throw new ArchiveRefusedError("no_link_target", `Archive record for ${action.path} has no link target.`);
      }
      await symlink(action.linkTarget, action.path);
    }
  }
  const remaining = (await readArchiveLog(opts)).filter((r) => r.id !== record.id);
  await mkdir(archiveDir(opts), { recursive: true });
  const path = logPath(opts);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, records: remaining }, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await rm(join(archiveDir(opts), record.id), { recursive: true, force: true });
  return record;
}

/**
 * `~/.agents/.skill-lock.json` belongs to a foreign installer. peek never writes it; it
 * reports where the two views disagree, because the manifest already describes only a
 * fraction of what is on disk and writing it would not make it authoritative.
 */
export interface ManifestDivergence {
  manifestPath: string;
  listedAndPresent: string[];
  listedButMissing: string[];
  presentButUnlisted: string[];
}

export async function manifestDivergence(sharedRoot: string): Promise<ManifestDivergence | undefined> {
  const manifestPath = join(dirname(sharedRoot), ".skill-lock.json");
  let listed: string[];
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { skills?: Record<string, unknown> };
    listed = Object.keys(parsed.skills ?? {});
  } catch {
    return undefined;
  }
  let present: string[];
  try {
    present = (await readdir(sharedRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    present = [];
  }
  const presentSet = new Set(present);
  const listedSet = new Set(listed);
  return {
    manifestPath,
    listedAndPresent: listed.filter((n) => presentSet.has(n)).sort(),
    listedButMissing: listed.filter((n) => !presentSet.has(n)).sort(),
    presentButUnlisted: present.filter((n) => !listedSet.has(n)).sort(),
  };
}
