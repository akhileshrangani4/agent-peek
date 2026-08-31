// src/usage/report.ts
//
// The `peek usage` output contract. Rows travel inside an envelope rather than as a
// bare array, because a bare array cannot say "these counts cover 554 sources over 32
// days and three of your agents are unobservable" — and a consumer that cannot see
// that will present partial counts as complete.

import { listAgents } from "../agents/index.js";
import { coverageFor, explainCoverage } from "./coverage.js";
import type { InstallationCoverage } from "./coverage.js";
import type { InvocationKind } from "../agents/index.js";
import { coverage, queryUsage } from "./query.js";
import type { GroupBy, UsageQuery, UsageRow } from "./query.js";
import type { UsageStore } from "./store.js";

/** An agent peek cannot see usage for, and the reason it cannot. */
export interface BlindSpot {
  agent: string;
  displayName: string;
  /** The agent's adapter, when it has one at all. */
  adapter?: string;
  /**
   * "no-adapter"  — peek cannot read this agent's transcripts (cursor, continue,
   *                 factory). Its skills are inventoried; its usage is unknown.
   * "sees-nothing" — the agent has an adapter, but that adapter extracts no invocation
   *                 kind at all (goose surfaces role/text/timestamp, no tool calls).
   */
  reason: "no-adapter" | "sees-nothing";
}

/**
 * Invocation kinds an observable agent can and cannot see. `codex` records tool calls
 * but has no slash-command syntax peek reads, so a codex skill invoked only by the user
 * is invisible even though the agent is observable.
 */
export interface PartiallyObserved {
  agent: string;
  observes: InvocationKind[];
  missing: InvocationKind[];
}

/** Observed span for one adapter. Retention is per-agent, so one global span misleads. */
export interface AdapterWindow {
  adapter: string;
  earliest: string;
  latest: string;
  days: number;
  invocations: number;
}

export interface UsageWindow {
  /** Earliest indexed invocation. Not "when you started using skills". */
  earliest?: string;
  latest?: string;
  /** Whole days spanned, or 0 when the index is empty. */
  days: number;
}

export interface UsageReport {
  rows: UsageRow[];
  /** True when `limit` cut the tail, so a top-N is never mistaken for the whole set. */
  truncated: boolean;
  /** Groups actually returned. When `truncated`, more exist than this. */
  groupsReturned: number;
  window: UsageWindow;
  /**
   * Per-adapter spans. Claude Code deletes transcripts at 30 days while Codex keeps
   * them indefinitely, so a single global window overstates coverage for exactly the
   * agent whose history is capped.
   */
  windows: AdapterWindow[];
  sources: { live: number; tombstoned: number; total: number };
  totalInvocations: number;
  observedAdapters: string[];
  blindSpots: BlindSpot[];
  /**
   * Agents whose adapter cannot *see* every invocation kind. Distinct from
   * `coverage[].state === "partial"`, which is about *attribution*: codex observes both
   * kinds but attributes only slash commands, so it is partial there and not here.
   * Named apart because the two were both called "partial" and disagreed about codex.
   */
  partiallyObserved: PartiallyObserved[];
  /**
   * Ticket 06: per-agent coverage for every agent installed on this machine, so a
   * consumer can tell a zero that means "not used" from a zero that means "peek could
   * not see". Keyed by agent slug; the unit is the installation, not the skill.
   */
  coverage: (InstallationCoverage & { displayName: string; explanation: string })[];
  /** True when nothing has ever been scanned. */
  empty: boolean;
}

const ALL_KINDS: readonly InvocationKind[] = ["tool_call", "slash_command"];

function dayCount(earliest?: string, latest?: string): number {
  if (!earliest || !latest) return 0;
  const ms = Date.parse(latest) - Date.parse(earliest);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

/**
 * Build the report. Coverage comes from ticket 02's `observes`, never from a second
 * test of our own: an agent that peek can list but not read must read as "cannot see
 * usage", never as "never used".
 */
export async function buildUsageReport(
  store: UsageStore,
  query: UsageQuery = {},
  opts: { home?: string; keepRow?: (row: UsageRow) => boolean } = {},
): Promise<UsageReport> {
  const limit = query.limit;
  // The limit is applied AFTER `keepRow`, never in SQL alongside it. Limiting first and
  // filtering second trims the tail twice: a request for the top 8 came back with 5 and
  // a claim that more existed, which is exactly the ambiguity `truncated` exists to
  // remove. Aggregate row counts are small (skills, tools, days), so fetching the full
  // grouped set and slicing here is cheap.
  const all = queryUsage(store, { ...query, limit: undefined });
  const kept = opts.keepRow ? all.filter(opts.keepRow) : all;
  const truncated = limit !== undefined && kept.length > limit;
  const visible = truncated ? kept.slice(0, limit) : kept;

  const cov = coverage(store);
  const agents = await listAgents(opts.home ? { home: opts.home } : {});

  // An agent with no roots present on this machine is not installed; saying peek
  // cannot observe it would be noise, not honesty.
  const installed = agents.filter((agent) => agent.roots.some((root) => root.present));

  const blindSpots: BlindSpot[] = [];
  const partiallyObserved: PartiallyObserved[] = [];
  for (const agent of installed) {
    if (!agent.observable) {
      blindSpots.push({
        agent: agent.slug,
        displayName: agent.displayName,
        ...(agent.adapter ? { adapter: agent.adapter } : {}),
        reason: agent.adapter ? "sees-nothing" : "no-adapter",
      });
      continue;
    }
    const missing = ALL_KINDS.filter((kind) => !agent.observes.includes(kind));
    if (missing.length > 0) {
      partiallyObserved.push({ agent: agent.slug, observes: agent.observes, missing });
    }
  }

  const windows = (store.handle().prepare(
    "SELECT adapter, COUNT(*) AS n, MIN(timestamp) AS lo, MAX(timestamp) AS hi"
    + " FROM invocations WHERE adapter IS NOT NULL GROUP BY adapter ORDER BY adapter",
  ).all() as { adapter: string; n: number; lo: string; hi: string }[]).map((row) => ({
    adapter: row.adapter,
    earliest: row.lo,
    latest: row.hi,
    days: dayCount(row.lo, row.hi),
    invocations: row.n,
  }));

  return {
    rows: visible,
    truncated,
    groupsReturned: visible.length,
    window: { earliest: cov.earliest, latest: cov.latest, days: dayCount(cov.earliest, cov.latest) },
    windows,
    sources: {
      live: cov.liveSources,
      tombstoned: cov.tombstonedSources,
      total: cov.liveSources + cov.tombstonedSources,
    },
    totalInvocations: cov.totalInvocations,
    observedAdapters: cov.observedAdapters,
    blindSpots,
    partiallyObserved,
    coverage: installed.map((agent) => {
      const c = coverageFor(agent);
      return { ...c, displayName: agent.displayName, explanation: explainCoverage(c, agent.displayName) };
    }),
    empty: cov.liveSources + cov.tombstonedSources === 0,
  };
}

/**
 * Per-bucket counts for one grouping dimension, for the sparkline column.
 *
 * Keyed by the dimension's own value, which is what `peek usage` rows display — unlike
 * the skills report, whose rows carry a resolved bare name and so need a name map.
 *
 * The window is sized by the caller against the observed span rather than a round
 * number: a window shorter than the data renders empty for almost every row and reads
 * as broken rather than as "no recent use".
 */
export function usageSeriesFor(
  store: UsageStore,
  query: UsageQuery,
  dimension: GroupBy,
  opts: { days?: number; cells?: number; now?: number } = {},
): { series: Map<string, number[]>; days: number; cells: number } {
  const days = opts.days ?? 30;
  const cells = opts.cells ?? 15;
  const now = opts.now ?? Date.now();
  const start = now - days * 86_400_000;

  const bucketOf = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    bucketOf.set(
      new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      Math.min(cells - 1, Math.floor(i / (days / cells))),
    );
  }

  const series = new Map<string, number[]>();
  const rows = queryUsage(store, { ...query, groupBy: [dimension, "day"], limit: undefined });
  for (const row of rows) {
    const key = String((row as unknown as Record<string, unknown>)[dimension] ?? "");
    const bucket = row.day ? bucketOf.get(row.day) : undefined;
    if (!key || bucket === undefined) continue;
    let counts = series.get(key);
    if (!counts) { counts = Array<number>(cells).fill(0); series.set(key, counts); }
    counts[bucket] = (counts[bucket] ?? 0) + row.count;
  }
  return { series, days, cells };
}
