// src/usage/query.ts
//
// The narrow typed query API — the only public way to read the index. Ticket 03 calls
// this and never writes SQL, which keeps the schema an implementation detail behind one
// seam: a forward migration that also had to keep another ticket's hand-written SQL
// working is a migration nobody performs.
//
// It is also the single enforcement point for the ADR 0001 retention boundary. Any MCP
// surface built over usage data goes through here, so it cannot re-expose what the
// schema declined to store.

import type { UsageStore } from "./store.js";
import type { SourceKind } from "./schema.js";

/**
 * Dimension names are camelCase, matching the filter keys and the fields on UsageRow.
 * `source_kind` is accepted as an alias for `sourceKind` so a caller writing the column
 * name gets the dimension rather than a throw.
 */
export type GroupBy =
  | "tool" | "skill" | "agent" | "adapter" | "day" | "cwd"
  | "sourceKind" | "sidechain" | "attributionAgent"
  | "source_kind";

export interface UsageFilter {
  /**
   * Skill invocations only, by either path: a `Skill` tool call or a slash command.
   * NOT the same as `tool: "Skill"` — a slash invocation stores the command name in
   * `tool`, so filtering on the tool name silently drops every slash-only skill, which
   * is the blindness the source_kind split exists to prevent.
   */
  skillsOnly?: boolean;
  tool?: string;
  skill?: string;
  agent?: string;
  adapter?: string;
  sourceKind?: SourceKind;
  sidechain?: boolean;
  attributionAgent?: string;
  cwd?: string;
  /** Inclusive ISO instant. */
  since?: string;
  /** Exclusive ISO instant. */
  until?: string;
}

export interface UsageQuery extends UsageFilter {
  groupBy?: GroupBy[];
  limit?: number;
  /** IANA offset for local-day bucketing, e.g. "-07:00". Defaults to UTC. */
  tzOffset?: string;
}

export interface UsageRow {
  count: number;
  firstSeen: string;
  lastSeen: string;
  tool?: string;
  skill?: string | null;
  agent?: string | null;
  adapter?: string | null;
  day?: string;
  cwd?: string | null;
  sourceKind?: SourceKind;
  sidechain?: boolean;
  /** Subagent type that made the call, where the adapter records one. */
  attributionAgent?: string | null;
}

/**
 * Every discrete filter dimension is also groupable. A filter without a matching
 * grouping can only answer questions whose answer you already know — you must name the
 * value to ask about it — so `attributionAgent` as a filter alone could not produce
 * "which subagent types reach for this skill", the question the column exists for.
 */
export const GROUP_BY_DIMENSIONS: readonly GroupBy[] = [
  "tool", "skill", "agent", "adapter", "day", "cwd",
  "sourceKind", "sidechain", "attributionAgent",
];

const COLUMNS: Record<Exclude<GroupBy, "day">, string> = {
  tool: "tool",
  skill: "skill",
  agent: "agent",
  adapter: "adapter",
  cwd: "cwd",
  sourceKind: "source_kind",
  sidechain: "sidechain",
  attributionAgent: "attribution_agent",
  source_kind: "source_kind",
};

/** Alias resolution, so both spellings name the same dimension and the same output key. */
function canonicalGroup(g: GroupBy): Exclude<GroupBy, "source_kind"> {
  return g === "source_kind" ? "sourceKind" : g;
}

/** Column alias used in SELECT ... AS, since SQLite results are keyed by it. */
function selectAlias(g: GroupBy): string {
  const key = canonicalGroup(g);
  if (key === "sourceKind") return "source_kind";
  if (key === "attributionAgent") return "attribution_agent";
  return key;
}

const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

/**
 * The instant is stored in UTC and bucketed here, never at write time: a precomputed
 * local-day column would freeze the machine's timezone into rows that outlive their
 * transcripts and cannot be recomputed if the user moves.
 */
function dayExpr(tzOffset?: string): string {
  if (!tzOffset || tzOffset === "+00:00") return "substr(timestamp, 1, 10)";
  if (!OFFSET_RE.test(tzOffset)) throw new Error(`invalid tzOffset: ${tzOffset}`);
  const sign = tzOffset[0] === "-" ? "-" : "+";
  const hours = Number(tzOffset.slice(1, 3));
  const minutes = Number(tzOffset.slice(4, 6));
  return `substr(datetime(timestamp, '${sign}${hours} hours', '${sign}${minutes} minutes'), 1, 10)`;
}

function whereClause(filter: UsageFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const eq = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  eq("tool", filter.tool);
  eq("skill", filter.skill);
  eq("agent", filter.agent);
  eq("adapter", filter.adapter);
  eq("source_kind", filter.sourceKind);
  eq("attribution_agent", filter.attributionAgent);
  eq("cwd", filter.cwd);
  if (filter.skillsOnly) clauses.push("skill IS NOT NULL");
  if (filter.sidechain !== undefined) {
    clauses.push("sidechain = ?");
    params.push(filter.sidechain ? 1 : 0);
  }
  if (filter.since !== undefined) { clauses.push("timestamp >= ?"); params.push(filter.since); }
  if (filter.until !== undefined) { clauses.push("timestamp < ?"); params.push(filter.until); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Aggregate over invocations. The result is usage; the rows are invocations. */
export function queryUsage(store: UsageStore, query: UsageQuery = {}): UsageRow[] {
  const groupBy = query.groupBy ?? ["tool"];
  const selects: string[] = [];
  const groups: string[] = [];
  for (const g of groupBy) {
    const expr = g === "day" ? dayExpr(query.tzOffset) : COLUMNS[g];
    if (!expr) throw new Error(`invalid groupBy: ${g}`);
    selects.push(`${expr} AS ${selectAlias(g)}`);
    groups.push(expr);
  }
  const where = whereClause(query);
  let sql = `SELECT ${selects.join(", ")}, COUNT(*) AS count,`
    + " MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen"
    + ` FROM invocations${where.sql}`;
  if (groups.length) sql += ` GROUP BY ${groups.join(", ")}`;
  sql += " ORDER BY count DESC";
  const params = [...where.params];
  if (query.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(query.limit);
  }

  const rows = store.handle().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => {
    const out: UsageRow = {
      count: row.count as number,
      firstSeen: row.first_seen as string,
      lastSeen: row.last_seen as string,
    };
    for (const g of groupBy) {
      const key = canonicalGroup(g);
      const value = row[selectAlias(g)] ?? null;
      if (key === "sourceKind") out.sourceKind = (value ?? undefined) as SourceKind | undefined;
      else if (key === "day") out.day = (value as string | null) ?? undefined;
      else if (key === "tool") out.tool = (value as string | null) ?? undefined;
      // SQLite has no boolean type: the column round-trips as 0/1.
      else if (key === "sidechain") out.sidechain = value === 1 || value === true;
      else (out as unknown as Record<string, unknown>)[key] = value;
    }
    return out;
  });
}

export interface CoverageReport {
  /** Adapters the index has ever scanned. */
  observedAdapters: string[];
  /** Sources scanned once whose transcript has since been deleted. */
  tombstonedSources: number;
  /** Sources currently readable. */
  liveSources: number;
  totalInvocations: number;
  earliest?: string;
  latest?: string;
}

/**
 * What ticket 06 needs to tell "never used" apart from "never observed": a tombstone
 * proves a session was counted even though its transcript is gone.
 */
export function coverage(store: UsageStore): CoverageReport {
  const db = store.handle();
  const counts = db.prepare(
    "SELECT COUNT(*) AS total, SUM(deleted) AS tombstoned FROM watermarks",
  ).get() as { total: number; tombstoned: number | null };
  const span = db.prepare(
    "SELECT COUNT(*) AS n, MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM invocations",
  ).get() as { n: number; earliest: string | null; latest: string | null };
  const tombstoned = counts.tombstoned ?? 0;
  return {
    observedAdapters: store.observedAdapters(),
    tombstonedSources: tombstoned,
    liveSources: counts.total - tombstoned,
    totalInvocations: span.n,
    earliest: span.earliest ?? undefined,
    latest: span.latest ?? undefined,
  };
}
