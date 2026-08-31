// src/mcp/skills.ts
//
// The MCP surface over usage and skills (ticket 08).
//
// Three rules shape everything here:
//
// 1. ADR 0001 — the index stores whitelisted arguments only, so peek does not become the
//    durable copy of material Claude Code deletes at 30 days. No tool returns transcript
//    text or a raw invocation row, and none takes SQL or an arbitrary path. The CLI is
//    run by someone who already has the files; an MCP tool is a channel into a session
//    that may not, so "mirror what the CLI prints" is the wrong test.
// 2. Coverage travels with the numbers. An agent is exactly the consumer that presents
//    partial counts as complete and cannot notice a missing caveat, so the envelope is
//    returned whole rather than trimmed to rows.
// 3. Nothing here mutates. `archive_plan` computes the plan and hands back the literal
//    command, because dry-run-by-default works by a person reading the plan — and an
//    argument named `confirm` is set by the model, not the user.
import { existsSync } from "node:fs";
import { listAgents } from "../agents/index.js";
import { buildInventory } from "../skills/inventory.js";
import { joinUsage } from "../skills/assemble.js";
import { buildSkillsReport, expandSkill } from "../skills/report.js";
import type { SegmentId, SkillsReport } from "../skills/report.js";
import { planArchive, selectSkill, ArchiveRefusedError } from "../skills/archive.js";
import { buildUsageReport } from "../usage/report.js";
import { UsageStore, usageDbPath } from "../usage/store.js";
import { buildNameIndex, builtinRowFilter } from "../skills/resolve.js";
import { GROUP_BY_DIMENSIONS } from "../usage/query.js";
import type { UsageFilter, GroupBy, UsageRow } from "../usage/query.js";

/** Only the dimensions the query API declares; an unknown name is a caller error. */
export function parseGroupBy(raw: unknown): GroupBy[] {
  const dims = String(raw ?? "skill").split(",").map((d) => d.trim()).filter(Boolean);
  const invalid = dims.filter((d) => !GROUP_BY_DIMENSIONS.includes(d as GroupBy));
  if (invalid.length) {
    throw new Error(
      `Unknown groupBy dimension: ${invalid.join(", ")}. Valid: ${GROUP_BY_DIMENSIONS.join(", ")}`,
    );
  }
  return dims as GroupBy[];
}

/** Rows returned when a caller does not ask. Kept small: the subject is context cost. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function clampLimit(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/**
 * The index is built by the CLI, never by this surface. Opening a `UsageStore` creates
 * `~/.agent-peek/` and a first run writes tens of megabytes after scanning every
 * transcript — not something a tool call should trigger inside someone else's session
 * without saying so.
 */
export interface IndexState {
  state: "ready" | "missing";
  path: string;
  hint?: string;
}

export function indexState(home?: string): IndexState {
  const path = usageDbPath(home);
  if (existsSync(path)) return { state: "ready", path };
  return {
    state: "missing",
    path,
    hint: "No usage index yet. Run `peek usage` once in a terminal to build it; the first "
      + "run scans every transcript and writes this file. peek will not build it from an "
      + "MCP call.",
  };
}

function openStore(home?: string): UsageStore {
  return new UsageStore(home ? { home } : {});
}

export interface UsageToolArgs {
  groupBy?: string;
  skill?: string;
  agent?: string;
  adapter?: string;
  tool?: string;
  allTools?: boolean;
  sourceKind?: string;
  sidechain?: boolean;
  attributionAgent?: string;
  since?: string;
  until?: string;
  limit?: number;
  includeBuiltins?: boolean;
  home?: string;
}

/**
 * 03's `UsageReport` verbatim: rows plus window, per-adapter windows, blindSpots,
 * partial, truncated. Trimming it to rows is what turns "these counts cover 33 days on
 * claude-code and three agents are unreadable" into a confident wrong answer.
 */
export async function usageTool(args: UsageToolArgs) {
  const index = indexState(args.home);
  if (index.state === "missing") return { index, report: null };

  const store = openStore(args.home);
  try {
    const filter: UsageFilter = {
      skillsOnly: !args.allTools && !args.tool,
      tool: args.tool,
      skill: args.skill,
      agent: args.agent,
      adapter: args.adapter,
      sourceKind: args.sourceKind === "tool_call" || args.sourceKind === "slash_command"
        ? args.sourceKind : undefined,
      sidechain: typeof args.sidechain === "boolean" ? args.sidechain : undefined,
      attributionAgent: args.attributionAgent,
      since: args.since,
      until: args.until,
    };
    const groupBy = parseGroupBy(args.groupBy);
    // Built-ins are recorded because the index stores names verbatim; they are not skills,
    // and a caller asking about skills should not be told it runs /clear a lot. Predicate
    // shared with the CLI, and handed to the report so it applies before the limit.
    const keepRow = args.includeBuiltins || !filter.skillsOnly
      ? undefined
      : builtinRowFilter<UsageRow>(
        buildNameIndex(await buildInventory(args.home ? { home: args.home } : {})),
        groupBy.length === 1 ? groupBy[0] : undefined,
      );
    const report = await buildUsageReport(
      store,
      { ...filter, groupBy, limit: clampLimit(args.limit) },
      { home: args.home, ...(keepRow ? { keepRow } : {}) },
    );
    return { index, report };
  } finally {
    store.close?.();
  }
}

export interface SkillsToolArgs {
  segment?: string;
  limit?: number;
  home?: string;
}

/**
 * Summary first, then a capped slice. A cap alone truncates silently; a summary alone is
 * the bloat this whole effort exists to reduce.
 */
export async function skillsTool(args: SkillsToolArgs) {
  const index = indexState(args.home);
  const inventory = await buildInventory(args.home ? { home: args.home } : {});
  if (index.state === "missing") {
    // Without the index every skill would read as never used, which is precisely the
    // false confidence this effort exists to prevent. Report the inventory, refuse to
    // segment.
    return {
      index,
      totals: { skills: inventory.skills.length, tokens: totalTokens(inventory.skills) },
      costBasis: inventory.costBasis,
      segments: null,
      note: "Segments need the usage index: without it, every skill would read as unused.",
    };
  }

  const store = openStore(args.home);
  try {
    const agents = await listAgents(args.home ? { home: args.home } : {});
    const joined = joinUsage(store, inventory, agents);
    const report = buildSkillsReport({ ...joined, skills: inventory.skills, costBasis: inventory.costBasis });
    const limit = clampLimit(args.limit);
    return { index, ...summarize(report, limit, args.segment as SegmentId | undefined) };
  } finally {
    store.close?.();
  }
}

function totalTokens(skills: { chargedTokens: number }[]): number {
  return skills.reduce((n, s) => n + s.chargedTokens, 0);
}

/**
 * Every segment's totals always; rows only for the segment asked for, or the first `limit`
 * of each. Installation arrays never travel in a list row — that is `skill_detail`.
 */
export function summarize(report: SkillsReport, limit: number, segment?: SegmentId) {
  const segments = report.segments
    .filter((s) => !segment || s.id === segment)
    .map((s) => ({
      id: s.id,
      title: s.title,
      note: s.note,
      skills: s.rows.length,
      tokens: s.tokens,
      truncated: s.rows.length > limit,
      rows: s.rows.slice(0, limit),
    }));
  return {
    totals: {
      skills: report.totalSkills,
      tokens: report.totalTokens,
      bySegment: Object.fromEntries(report.segments.map((s) => [s.id, s.rows.length])),
    },
    segments,
    unmatched: report.unmatched.slice(0, limit),
    unmatchedTotal: report.unmatched.length,
    costBasis: report.costBasis,
  };
}

export interface SkillDetailArgs {
  skill: string;
  home?: string;
}

/** One skill: its installations, per-agent coverage, and what archiving each would do. */
export async function skillDetailTool(args: SkillDetailArgs) {
  const index = indexState(args.home);
  const inventory = await buildInventory(args.home ? { home: args.home } : {});
  const skill = selectSkill(inventory, args.skill);
  const base = {
    key: skill.key,
    name: skill.name,
    qualifiedName: skill.qualifiedName,
    description: skill.description,
    modelInvocable: skill.modelInvocable,
    estimatedTokens: skill.estimatedTokens,
    chargedTokens: skill.chargedTokens,
    flags: skill.flags,
    costBasis: inventory.costBasis,
  };
  if (index.state === "missing") return { index, skill: base, installations: null };

  const store = openStore(args.home);
  try {
    const agents = await listAgents(args.home ? { home: args.home } : {});
    const joined = joinUsage(store, inventory, agents);
    const installations = expandSkill(
      { ...joined, skills: inventory.skills, costBasis: inventory.costBasis },
      skill,
    );
    return { index, skill: base, installations };
  } finally {
    store.close?.();
  }
}

export interface ArchivePlanArgs {
  skill: string;
  agent?: string;
  allAgents?: boolean;
  home?: string;
}

/**
 * Read-only. Returns what archiving *would* do plus the literal command a human runs to
 * do it. No MCP tool executes an archive: the safeguard is a person reading the plan, and
 * an argument the model sets is not a person.
 */
export async function archivePlanTool(args: ArchivePlanArgs) {
  const inventory = await buildInventory(args.home ? { home: args.home } : {});
  try {
    const plan = planArchive(inventory, args.skill, {
      agent: args.agent,
      allAgents: Boolean(args.allAgents),
    });
    const scope = args.agent ? ` --agent ${args.agent}` : args.allAgents ? " --all-agents" : "";
    return {
      plan,
      command: `peek skills archive ${plan.skillName}${scope} --yes`,
      note: "peek did not change anything. Run the command above in a terminal to execute; "
        + "without --yes it prints this plan again.",
    };
  } catch (e) {
    if (e instanceof ArchiveRefusedError) {
      return { refused: { reason: e.reason, message: e.message, detail: e.detail } };
    }
    throw e;
  }
}

export interface AgentsToolArgs {
  all?: boolean;
  home?: string;
}

/** The agent registry: presence, tier, and what peek can observe and attribute. */
export async function agentsTool(args: AgentsToolArgs) {
  const agents = await listAgents(args.home ? { home: args.home } : {});
  const shown = args.all ? agents : agents.filter((a) => a.presence === "present");
  return {
    totals: {
      known: agents.length,
      present: agents.filter((a) => a.presence === "present").length,
      verified: agents.filter((a) => a.tier === "verified").length,
    },
    agents: shown.map((a) => ({
      slug: a.slug,
      displayName: a.displayName,
      presence: a.presence,
      tier: a.tier,
      adapter: a.adapter,
      observes: a.observes,
      attributes: a.attributes,
      observable: a.observable,
      manageable: a.manageable,
      roots: a.roots.filter((r) => r.present).map((r) => ({ path: r.path, kind: r.kind, mutable: r.mutable })),
    })),
  };
}
