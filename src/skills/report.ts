// src/skills/report.ts
//
// Ticket 07. The screen that will actually delete a user's skills, so segmentation
// carries the honesty rather than a caveat column: a skill is offered for archiving only
// when every one of its rows can be rendered honestly, and is excluded otherwise.
//
// Validated by prototype (branch `prototype/07-skills-screen`), which caught two traps
// this module exists to make impossible:
//
//   1. Keeping only invocation names that resolve *uniquely* manufactures false zeros.
//      Of 61 invoked names on the source machine, 26 resolved uniquely, 24 matched no
//      installed skill and 3 were ambiguous. Dropping the rest rendered avi-voice (12
//      uses) as "0 uses" and offered it for archiving.
//   2. Checking usage and coverage but not `mutable` offered read-only plugin skills for
//      archiving. Being unable to act on a row is not the same as it being safe to act
//      on. Fixing both moved "safe to archive" from 489 skills / ~21,620 tokens to
//      161 / ~5,669 — a threefold over-offer.

import type { InstallationCoverage } from "../usage/coverage.js";
import { renderCount } from "../usage/coverage.js";
import type { Skill, SkillInstallation } from "./types.js";

export type SegmentId = "archivable" | "unknown-usage" | "read-only" | "in-use";

export interface SkillRow {
  key: string;
  name: string;
  /** Tokens charged across every installation. */
  tokens: number;
  agents: string[];
  /** Total recorded invocations, or null when no installation can be attributed. */
  uses: number | null;
  /** What the count column shows: a number, "unknown", or "ambiguous". */
  usesLabel: string;
  lastSeen?: string;
  /** Why this row sits in its segment. Shown for every non-archivable segment. */
  reason: string;
}

export interface InstallationRow {
  agent: string;
  path: string;
  /** Unlinking a symlink is a different act from moving a real directory (ticket 05). */
  action: "unlink" | "move" | "refuse";
  symlink: boolean;
  mutable: boolean;
  coverage: InstallationCoverage["state"];
  usesLabel: string;
  tokens: number;
  /**
   * True when peek cannot confirm this agent is installed. Shown at the confirm step: if
   * the agent *is* installed and the user relies on the skill there, this line is the
   * only thing standing between the relaxed verdict and a wrong deletion.
   */
  unconfirmedAgent?: boolean;
}

export interface Segment {
  id: SegmentId;
  title: string;
  note: string;
  rows: SkillRow[];
  tokens: number;
}

export interface SkillsReport {
  segments: Segment[];
  /**
   * Recorded invocations naming no installed skill: uninstalled since, or living in a
   * project-local root peek has not surveyed (ticket 14). Real usage, not noise, and
   * never archivable — so it is reported beside the segments rather than inside them.
   */
  unmatched: UnmatchedName[];
  costBasis: string;
  totalSkills: number;
  totalTokens: number;
}

/**
 * A recorded invocation naming no installed skill, and what peek can say about why.
 *
 * These are not one fact. "You invoked pre-pr-duplication 9 times and it is not
 * installed" is actionable; "you invoked loop 6 times and it ships inside Claude Code"
 * is not, and telling the user both in one voice repeats this effort's core mistake one
 * level up. Where peek cannot tell the two apart it says so rather than picking.
 */
export interface UnmatchedName {
  name: string;
  uses: number;
  /**
   * - `not-on-disk`: no root peek surveyed holds it. Either the agent ships it (loop,
   *   run, security-review, update-config, artifact-design all live inside Claude Code
   *   and exist in no user skill root on this machine) or it was uninstalled since.
   *   peek cannot distinguish those two from disk, and says so.
   * - `plugin-absent`: the name carries a plugin prefix whose plugin is not installed,
   *   which is a narrower and more actionable statement.
   */
  reason: "not-on-disk" | "plugin-absent";
  note: string;
}

export interface ReportInput {
  skills: Skill[];
  /** skill key -> agent slug -> invocation count. */
  usage: Map<string, Map<string, number>>;
  /** skill key -> most recent invocation, where one is recorded. */
  lastSeen?: Map<string, string>;
  /** Keys of skills whose invoked name matches more than one skill. */
  ambiguousKeys: Set<string>;
  /** agent slug -> coverage. A slug absent here is treated as unreadable. */
  coverage: Map<string, InstallationCoverage>;
  /**
   * Agents whose installation exists but whose product peek cannot confirm is installed.
   * Their unobservability is evidence about peek, not about the user's behaviour, so it
   * does not withhold a verdict — see `classify`.
   */
  unconfirmedAgents?: Set<string>;
  unmatched: UnmatchedName[];
  costBasis: string;
}

const UNREADABLE: InstallationCoverage = {
  agent: "unknown", state: "unreadable", attributes: [], blind: ["tool_call", "slash_command"],
};

function agentInstallations(skill: Skill): SkillInstallation[] {
  // An installation with no agent is the shared library root, which no agent's system
  // prompt reads — it is not a place a skill is "installed for" anyone.
  return skill.installations.filter((i) => i.agent !== undefined);
}

function coverageOf(input: ReportInput, agent: string): InstallationCoverage {
  return input.coverage.get(agent) ?? UNREADABLE;
}

function usesOf(input: ReportInput, skill: Skill): number {
  const per = input.usage.get(skill.key);
  if (!per) return 0;
  let total = 0;
  for (const n of per.values()) total += n;
  return total;
}

/**
 * Which segment a skill belongs in. Order is precedence, and it is deliberate: any
 * recorded use settles it first, because a used skill must never appear under a
 * destructive action whatever else is true of it.
 */
function classify(input: ReportInput, skill: Skill): { id: SegmentId; reason: string } {
  const installs = agentInstallations(skill);
  const uses = usesOf(input, skill);
  if (uses > 0) return { id: "in-use", reason: `${uses} recorded invocation${uses === 1 ? "" : "s"}` };

  // A name two skills answer to cannot have its usage assigned to either, so a low
  // count is not evidence about this one.
  if (input.ambiguousKeys.has(skill.key)) {
    return { id: "unknown-usage", reason: "invoked name is ambiguous between two skills" };
  }
  if (installs.length === 0) {
    return { id: "read-only", reason: "shared library only, listed by no agent" };
  }
  if (!installs.some((i) => i.mutable)) {
    return { id: "read-only", reason: "plugin installation, reported but never mutated" };
  }
  const blind = installs.filter((i) => coverageOf(input, i.agent!).state !== "attributed");
  // "Every installation must be attributable" exists to stop peek recommending deletion
  // of a skill whose usage it cannot see. That rationale depends on the agent existing:
  // if peek cannot confirm the product is installed, its silence is evidence about peek,
  // not about the user, and withholding on that basis is being conservative about
  // nothing. The discount is disclosed in the row and again at the confirm step.
  const unconfirmed = input.unconfirmedAgents ?? new Set<string>();
  const blocking = blind.filter((i) => !unconfirmed.has(i.agent!));
  if (blocking.length > 0) {
    return {
      id: "unknown-usage",
      reason: `usage not attributable on ${blocking.map((i) => i.agent).join(", ")}`,
    };
  }
  if (blind.length > 0) {
    return {
      id: "archivable",
      reason: `no recorded use; unattributable only on ${blind.map((i) => i.agent).join(", ")}, `
        + "which peek cannot confirm are installed",
    };
  }
  return { id: "archivable", reason: "no recorded use, every installation attributable" };
}

function rowFor(input: ReportInput, skill: Skill, reason: string): SkillRow {
  const installs = agentInstallations(skill);
  const uses = usesOf(input, skill);
  // ALL, not some: zero observed on an attributable agent plus unknown on another sums
  // to unknown, not to zero. Requiring only "some" reproduced the false zero in a
  // subtler place — `find-skills` rendered "0" inside the usage-unknown segment.
  const fullyAttributed = installs.length > 0
    && installs.every((i) => coverageOf(input, i.agent!).state === "attributed");
  const usesLabel = input.ambiguousKeys.has(skill.key)
    ? "ambiguous"
    : uses > 0
      // A non-zero count is never caveated: the skill is demonstrably used.
      ? String(uses)
      : fullyAttributed ? "0" : "unknown";
  return {
    key: skill.key,
    name: skill.name,
    tokens: skill.chargedTokens,
    agents: installs.map((i) => i.agent!),
    uses: input.ambiguousKeys.has(skill.key) || (uses === 0 && !fullyAttributed) ? null : uses,
    usesLabel,
    ...(input.lastSeen?.get(skill.key) ? { lastSeen: input.lastSeen.get(skill.key)! } : {}),
    reason,
  };
}

const TITLES: Record<SegmentId, { title: string; note: string }> = {
  archivable: {
    title: "Safe to archive",
    note: "no recorded use, and every installation sits on an agent peek can attribute",
  },
  "unknown-usage": {
    title: "Usage unknown",
    note: "peek cannot see usage here, so nothing recorded is not evidence of disuse",
  },
  "read-only": {
    title: "Read-only",
    note: "reported for cost and never mutated; disable a plugin with /plugin to stop paying for its set",
  },
  "in-use": { title: "In use", note: "recorded invocations; not offered" },
};

const ORDER: SegmentId[] = ["archivable", "unknown-usage", "read-only", "in-use"];

export function buildSkillsReport(input: ReportInput): SkillsReport {
  const buckets = new Map<SegmentId, SkillRow[]>(ORDER.map((id) => [id, []]));
  for (const skill of input.skills) {
    const { id, reason } = classify(input, skill);
    buckets.get(id)!.push(rowFor(input, skill, reason));
  }
  const segments = ORDER.map((id) => {
    // Sorted by cost, not staleness: rows in the archivable segment have no recorded
    // use by definition, so there is no last-seen to sort them by — and cost is the
    // lever, since context reduction is what the user came for.
    const rows = buckets.get(id)!.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    return { id, ...TITLES[id], rows, tokens: rows.reduce((n, r) => n + r.tokens, 0) };
  });
  return {
    segments,
    unmatched: [...input.unmatched].sort((a, b) => b.uses - a.uses),
    costBasis: input.costBasis,
    totalSkills: input.skills.length,
    totalTokens: input.skills.reduce((n, s) => n + s.chargedTokens, 0),
  };
}

/**
 * The per-installation view, shown when one skill is selected: C to decide, B to see
 * exactly what the decision does. This is where ticket 05's unlink-versus-retire
 * distinction has to be visible — 20 skills here are shared between claude-code and
 * codex and 47 across goose, continue and factory, and none of them can be actioned
 * without seeing the other installations.
 */
export function expandSkill(input: ReportInput, skill: Skill): InstallationRow[] {
  const per = input.usage.get(skill.key);
  return agentInstallations(skill).map((inst) => {
    const cov = coverageOf(input, inst.agent!);
    const n = per?.get(inst.agent!) ?? 0;
    return {
      agent: inst.agent!,
      path: inst.path,
      action: !inst.mutable ? "refuse" : inst.symlink ? "unlink" : "move",
      symlink: inst.symlink,
      mutable: inst.mutable,
      coverage: cov.state,
      usesLabel: input.ambiguousKeys.has(skill.key) ? "ambiguous" : renderCount(n, cov),
      tokens: inst.chargedTokens,
      ...(input.unconfirmedAgents?.has(inst.agent!) ? { unconfirmedAgent: true } : {}),
    };
  });
}

/** Rows a select-all may touch. Never the unknown, never the immutable, never the used. */
export function selectableForArchive(report: SkillsReport): SkillRow[] {
  return report.segments.find((s) => s.id === "archivable")?.rows ?? [];
}
