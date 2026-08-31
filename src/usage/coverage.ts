// src/usage/coverage.ts
//
// Ticket 06. The failure this prevents: "never used" and "cannot see usage" rendering
// identically, so the tool confidently recommends archiving a skill it was never able
// to observe.
//
// Coverage is a property of the **installation**, not the skill. Ticket 05 already made
// archiving per-installation with scope never defaulted, and 57 skills on the machine
// this was built against are installed across agents in differing states — `find-skills`
// is fully attributable on claude-code and invisible on cursor. One skill, two truths,
// and a skill-level verdict would lie exactly where the picker offers a destructive
// action.

import type { InvocationKind, ResolvedAgent } from "../agents/index.js";

/**
 * Why peek can or cannot turn "no invocations recorded" into "not used".
 *
 * Deliberately small: a state the user cannot act on differently is a column that
 * teaches nothing. `partial` exists because codex is real — attributable on one
 * invocation kind and blind on the other — not for symmetry.
 */
export type CoverageState =
  /** Every invocation kind is attributable. A zero here means not used. */
  | "attributed"
  /** Some kinds attributable, others not. A zero here is a lower bound, not a fact. */
  | "partial"
  /** The agent has an adapter, but nothing it extracts names a skill. */
  | "opaque"
  /** peek cannot read this agent's transcripts at all. */
  | "unreadable";

export interface InstallationCoverage {
  agent: string;
  state: CoverageState;
  attributes: InvocationKind[];
  /** Kinds this agent may use that peek cannot attribute. Empty when fully attributed. */
  blind: InvocationKind[];
}

const ALL_KINDS: readonly InvocationKind[] = ["tool_call", "slash_command"];

export function coverageFor(agent: ResolvedAgent): InstallationCoverage {
  const attributes = agent.attributes;
  const blind = ALL_KINDS.filter((kind) => !attributes.includes(kind));
  let state: CoverageState;
  if (attributes.length === ALL_KINDS.length) state = "attributed";
  else if (attributes.length > 0) state = "partial";
  else if (agent.adapter) state = "opaque";
  else state = "unreadable";
  return { agent: agent.slug, state, attributes, blind };
}

/** True when a zero count for this installation can honestly be called "not used". */
export function zeroMeansUnused(coverage: InstallationCoverage): boolean {
  return coverage.state === "attributed";
}

/**
 * What to show for a count on one installation.
 *
 * The caveat belongs exactly where the destructive action would land and nowhere else:
 * a count of 12 needs no coverage note whatever the agent, because the skill is
 * demonstrably used. It is the *zero* that is ambiguous — disuse, or blindness. So a
 * non-zero count always renders as itself, and only an unattributable zero becomes
 * `unknown`. On this machine that leaves 78% of rows unmarked.
 */
export function renderCount(count: number, coverage: InstallationCoverage): string {
  if (count > 0) return String(count);
  return zeroMeansUnused(coverage) ? "0" : "unknown";
}

/**
 * Whether a bulk action like "select all unused" may include this installation.
 * Excluded by default whenever a zero could mean blindness — this exclusion holds even
 * if a UI makes the coverage column optional.
 */
export function eligibleForBulkUnused(count: number, coverage: InstallationCoverage): boolean {
  return count === 0 && zeroMeansUnused(coverage);
}

/** One line explaining a non-attributed state, for the report footer. */
export function explainCoverage(coverage: InstallationCoverage, displayName: string): string {
  switch (coverage.state) {
    case "attributed":
      return `${displayName}: usage fully attributable`;
    case "partial":
      return `${displayName}: ${coverage.blind.join(", ")} invocations cannot be attributed to a skill`;
    case "opaque":
      return `${displayName}: transcripts readable, but no invocation names a skill`;
    case "unreadable":
      return `${displayName}: no transcript adapter, usage unknown`;
  }
}
