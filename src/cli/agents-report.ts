// src/cli/agents-report.ts
//
// The `peek agents` static report, rendered through the shared module (ticket 15).
// Layout decisions and their reasons live in render.ts; this file only says what to show.

import React from "react";
import { Box, Text } from "ink";
import { Row, Rows, Rule, num, renderStatic, terminalWidth } from "./render.js";
import type { Role } from "./render.js";
import type { ResolvedAgent } from "../agents/types.js";

const h = React.createElement;

type Presence = ResolvedAgent["presence"];

/** Presence is the structure of this report, so it drives both order and colour. */
const ORDER: Presence[] = ["present", "unconfirmed", "absent", "no-convention"];
const LABEL: Record<Presence, string> = {
  present: "present",
  unconfirmed: "unconfirmed",
  absent: "absent",
  "no-convention": "no convention",
};
const ROLE: Record<Presence, Role> = {
  present: "ok",
  // Not muted: unconfirmed exists because peek refuses to claim what it cannot support,
  // and a reader who skims past it learns the opposite of what it means.
  unconfirmed: "unknown",
  absent: "muted",
  "no-convention": "muted",
};
const NOTE: Record<Presence, string> = {
  present: "peek has resolved a root here",
  unconfirmed: "a skill root exists but nothing else does",
  absent: "known to peek, not installed here",
  "no-convention": "no skill root convention known",
};

export interface AgentsViewOptions {
  width?: number;
  color?: boolean;
  source?: { package: string; version: string };
  /** Rows per presence group before the overflow line. */
  limit?: number;
  /** Presence groups to list. The summary always covers every agent. */
  groups?: Presence[];
}

/** What peek can see of this agent's usage, in one short token rather than a kind list. */
function usage(agent: ResolvedAgent): string {
  if (!agent.observable) return "none";
  const tool = agent.observes.includes("tool_call");
  const slash = agent.observes.includes("slash_command");
  if (tool && slash) return "both";
  return tool ? "tool calls" : "slash only";
}

/** "1 root" reads as a fact; "1 roots" reads as a bug in a report about correctness. */
function rootLabel(agent: ResolvedAgent): string {
  const n = agent.roots.filter((r) => r.present).length;
  return `${num(n)} root${n === 1 ? "" : "s"}`;
}

function Summary({ agents, source }: {
  agents: ResolvedAgent[];
  source?: { package: string; version: string };
}): React.JSX.Element {
  const counts = ORDER
    .map((p) => [p, agents.filter((a) => a.presence === p).length] as const)
    .filter(([, n]) => n > 0);
  const labelW = Math.max(...counts.map(([p]) => LABEL[p].length));
  const countW = Math.max(...counts.map(([, n]) => num(n).length));
  const verified = agents.filter((a) => a.tier === "verified").length;
  return h(Box, { flexDirection: "column", marginTop: 1 },
    ...counts.map(([p, n]) => h(Row, {
      key: p,
      cells: [
        { text: LABEL[p], role: ROLE[p], width: labelW },
        { text: num(n), role: "muted", width: countW, align: "right" },
        { text: `${Math.round((n / agents.length) * 100)}%`, role: "muted", width: 4, align: "right" },
        { text: NOTE[p], role: "muted" },
      ],
    })),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true },
        `     ${verified} verified locally, ${agents.length - verified} sourced`
        + (source ? ` from ${source.package}@${source.version}` : ""))));
}

function Group({ presence, agents, width, limit }: {
  presence: Presence; agents: ResolvedAgent[]; width: number; limit: number;
}): React.JSX.Element | null {
  if (agents.length === 0) return null;
  const shown = agents.slice(0, limit);
  const slugW = Math.max(...shown.map((a) => a.slug.length));
  const adapterW = Math.max(7, ...shown.map((a) => (a.adapter ?? "-").length));
  return h(Box, { flexDirection: "column" },
    h(Rule, { title: LABEL[presence], trailing: `${num(agents.length)} agents`, role: ROLE[presence], width }),
    h(Rows, {
      children: shown.map((a) => h(Row, {
        key: a.slug,
        cells: [
          { text: a.slug, width: slugW },
          { text: a.adapter ?? "-", role: "muted", width: adapterW },
          { text: usage(a), role: a.observable ? "plain" : "unknown", width: 10 },
          { text: a.manageable ? "manageable" : "read-only", role: a.manageable ? "muted" : "unknown", width: 10 },
          { text: rootLabel(a), role: "muted" },
        ],
      })),
    }),
    agents.length > shown.length
      ? h(Box, { marginTop: 1 },
        h(Text, { dimColor: true },
          `     ${num(agents.length - shown.length)} more · peek agents --all`))
      : null);
}

export async function renderAgents(
  agents: ResolvedAgent[],
  opts: AgentsViewOptions = {},
): Promise<void> {
  // The summary counts every agent peek knows; the listing is filtered. Reporting the
  // filtered count as "known to peek" would say peek knows 18 agents when it knows 78.
  const groups = opts.groups ?? ["present", "unconfirmed"];
  const width = terminalWidth(opts.width);
  const limit = opts.limit ?? 12;
  const view = h(Box, { flexDirection: "column" },
    h(Box, null,
      h(Text, { bold: true }, "  peek agents"),
      h(Text, { dimColor: true }, `   ${num(agents.length)} agents known to peek`)),
    h(Summary, { agents, source: opts.source }),
    ...ORDER.filter((p) => groups.includes(p)).map((p) => h(Group, {
      key: p, presence: p, width, limit,
      agents: agents.filter((a) => a.presence === p),
    })),
    h(Box, { marginTop: 2 },
      h(Text, { dimColor: true }, "     peek agents --all   --json")));
  await renderStatic(view, { forceColor: opts.color, width: opts.width });
}
