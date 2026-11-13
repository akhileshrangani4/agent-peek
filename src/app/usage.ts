// src/app/usage.ts
//
// The usage index as a service: whether it exists, how a front end refreshes it, and the
// one report every front end serves. Two rules live here so the CLI and MCP cannot drift:
// which grouping dimensions exist, and that CLI built-ins (`/clear`) are dropped from a
// skills report before its limit is applied, never after.
import { existsSync } from "node:fs";
import { listAgents } from "../agents/index.js";
import type { Adapter } from "../core/types.js";
import { buildInventory } from "../skills/inventory.js";
import { buildNameIndex, builtinRowFilter } from "../skills/resolve.js";
import { GROUP_BY_DIMENSIONS, type GroupBy, type UsageFilter, type UsageRow } from "../usage/query.js";
import { buildUsageReport, type UsageReport } from "../usage/report.js";
import { scanAll, type ScanResult } from "../usage/scan.js";
import { usageDbPath, type UsageStore } from "../usage/store.js";

export type GroupByList =
  | { ok: true; dims: GroupBy[] }
  | { ok: false; invalid: string[] };

/** A comma-separated list of grouping dimensions; only names the query API declares. */
export function parseGroupByList(raw: string): GroupByList {
  const dims = raw.split(",").map((d) => d.trim()).filter(Boolean);
  const invalid = dims.filter((d) => !GROUP_BY_DIMENSIONS.includes(d as GroupBy));
  return invalid.length ? { ok: false, invalid } : { ok: true, dims: dims as GroupBy[] };
}

/**
 * The index is built by a person running `peek usage`, never implicitly. Opening a
 * `UsageStore` creates `~/.agent-peek/` and a first run writes tens of megabytes after
 * scanning every transcript.
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

export interface UsageReportRequest {
  filter: UsageFilter;
  groupBy: GroupBy[];
  limit: number;
  /** Keep CLI built-ins such as `/clear` in a skills report. */
  includeBuiltins?: boolean;
}

/**
 * Operations over one open index. The caller owns the store's lifetime: the CLI scans
 * and reports through one handle, and MCP refuses to open one that does not exist yet.
 */
export class UsageService {
  constructor(private readonly deps: { store: UsageStore; home?: string }) {}

  isEmpty(): boolean {
    return this.deps.store.isEmpty();
  }

  /**
   * Index new transcript content. Adapters and agents are orthogonal: an adapter may
   * belong to no agent, so an unmapped adapter records a null agent rather than a guess.
   */
  async scan(adapters: Adapter[]): Promise<ScanResult> {
    const agentByAdapter = new Map<string, string>();
    for (const agent of await listAgents(this.homeOpts())) {
      if (agent.adapter) agentByAdapter.set(agent.adapter, agent.slug);
    }
    return scanAll(adapters, this.deps.store, {
      agentFor: (entry) => agentByAdapter.get(entry.adapter) ?? null,
    });
  }

  /**
   * The report envelope, whole: rows plus window, blind spots and truncation. Built-ins
   * are resolved as a row predicate handed to the report, so they are dropped before the
   * limit and the tail is never trimmed twice.
   */
  async report(req: UsageReportRequest): Promise<UsageReport> {
    const keepRow = req.filter.skillsOnly && !req.includeBuiltins
      ? builtinRowFilter<UsageRow>(
        buildNameIndex(await buildInventory(this.homeOpts())),
        req.groupBy.length === 1 ? req.groupBy[0] : undefined,
      )
      : undefined;
    return buildUsageReport(
      this.deps.store,
      { ...req.filter, groupBy: req.groupBy, limit: req.limit },
      { ...this.homeOpts(), ...(keepRow ? { keepRow } : {}) },
    );
  }

  private homeOpts(): { home?: string } {
    return this.deps.home ? { home: this.deps.home } : {};
  }
}
