// src/skills/assemble.ts
//
// Joins the usage index to the skill inventory. This join is where ticket 07's
// prototype found the effort's own trap rebuilt by accident, so the rules live in one
// place with the reasons attached.

import { queryUsage } from "../usage/query.js";
import type { UsageStore } from "../usage/store.js";
import { coverageFor } from "../usage/coverage.js";
import type { InstallationCoverage } from "../usage/coverage.js";
import type { ResolvedAgent } from "../agents/index.js";
import { buildNameIndex, resolveName } from "./resolve.js";
import type { Inventory } from "./types.js";
import type { ReportInput, UnmatchedName } from "./report.js";

/**
 * Resolve recorded invocation names against the inventory and bucket them.
 *
 * Invocation names are stored verbatim (ticket 01) and resolved at read time (ticket
 * 04), which yields four outcomes. Only one is a number, and keeping only that one —
 * the obvious implementation — silently discards 27 of 61 names and renders the most
 * used skills as zero.
 */
export function joinUsage(
  store: UsageStore,
  inventory: Inventory,
  agents: ResolvedAgent[],
): Omit<ReportInput, "skills" | "costBasis"> {
  const index = buildNameIndex(inventory);
  // Plugin names peek can see installed, so a `plugin:skill` spelling whose plugin is
  // gone gets the narrower explanation rather than the generic one.
  const installedPlugins = new Set(
    inventory.skills
      .map((s) => s.qualifiedName?.split(":")[0])
      .filter((p): p is string => Boolean(p)),
  );
  const usage = new Map<string, Map<string, number>>();
  const lastSeen = new Map<string, string>();
  const ambiguousKeys = new Set<string>();
  const unmatched = new Map<string, number>();

  for (const row of queryUsage(store, { skillsOnly: true, groupBy: ["skill", "agent"] })) {
    if (!row.skill) continue;
    // resolveName classifies a CLI built-in only when the name carries its leading
    // slash, and the index stores it stripped. Testing the slash spelling is safe
    // because the inventory is matched first.
    const resolution = resolveName(index, `/${row.skill}`);
    if (resolution.outcome === "not-a-skill") continue;
    if (resolution.outcome === "unmatched") {
      unmatched.set(row.skill, (unmatched.get(row.skill) ?? 0) + row.count);
      continue;
    }
    if (resolution.outcome === "ambiguous") {
      // Recorded under a name two skills answer to: the count is real but belongs to
      // neither, so both are marked and neither may be offered for archiving.
      for (const key of resolution.keys) ambiguousKeys.add(key);
      continue;
    }
    const key = resolution.keys[0]!;
    let per = usage.get(key);
    if (!per) { per = new Map(); usage.set(key, per); }
    const slug = row.agent ?? "unknown";
    per.set(slug, (per.get(slug) ?? 0) + row.count);
    const prior = lastSeen.get(key);
    if (!prior || row.lastSeen > prior) lastSeen.set(key, row.lastSeen);
  }

  const coverage = new Map<string, InstallationCoverage>();
  for (const agent of agents) coverage.set(agent.slug, coverageFor(agent));

  return {
    usage,
    lastSeen,
    ambiguousKeys,
    coverage,
    unmatched: [...unmatched].map(([name, uses]) => classifyUnmatched(name, uses, installedPlugins)),
    unconfirmedAgents: new Set(agents.filter((a) => a.presence === "unconfirmed").map((a) => a.slug)),
  };
}

/**
 * What peek can honestly say about a name nothing on disk answers to. It cannot tell an
 * agent-bundled skill from one uninstalled since — neither leaves a trace — so it reports
 * both possibilities rather than choosing one and sounding certain.
 */
function classifyUnmatched(name: string, uses: number, installedPlugins: Set<string>): UnmatchedName {
  const prefix = name.includes(":") ? name.split(":")[0]! : undefined;
  if (prefix && !installedPlugins.has(prefix)) {
    return {
      name,
      uses,
      reason: "plugin-absent",
      note: `plugin \`${prefix}\` is not installed here`,
    };
  }
  return {
    name,
    uses,
    reason: "not-on-disk",
    note: "in no skill root peek surveyed: either the agent ships it, or it was uninstalled since",
  };
}
