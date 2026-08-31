// src/cli/skills-report.ts
//
// The `peek skills` static report, rendered through the shared module (ticket 15).
// Layout decisions and their reasons live in render.ts; this file only says what to show.

import React from "react";
import { Box, Text } from "ink";
import { Row, Rows, Rule, num, overflow, renderStatic, terminalWidth } from "./render.js";
import type { Role } from "./render.js";
import type { SkillsReport, SkillRow } from "../skills/report.js";

const h = React.createElement;

const LABEL: Record<string, string> = {
  archivable: "reclaimable",
  "unknown-usage": "unknown",
  "read-only": "read-only",
  "in-use": "in use",
};
const ROLE: Record<string, Role> = {
  archivable: "ok",
  "unknown-usage": "unknown",
  "read-only": "muted",
  "in-use": "live",
};

export interface SkillsViewOptions {
  width?: number;
  color?: boolean;
  /** Rows shown per segment before the overflow line. */
  limit?: number;
  blindAgents?: number;
}

/**
 * Segment totals as type rather than as a graphic. A graphic has to beat well-aligned
 * numbers to justify itself, and a proportion bar took a whole line to say what a
 * percentage column says in four characters.
 */
function Summary({ report, blindAgents }: {
  report: SkillsReport; blindAgents: number;
}): React.JSX.Element {
  const segs = report.segments.filter((s) => s.rows.length > 0);
  const total = report.totalTokens || 1;
  const labelW = Math.max(...segs.map((s) => LABEL[s.id]!.length));
  const countW = Math.max(...segs.map((s) => num(s.rows.length).length));
  const tokenW = Math.max(...segs.map((s) => num(s.tokens).length));
  const note: Record<string, string> = {
    archivable: "no recorded use, fully attributable",
    "unknown-usage": `not attributable on ${blindAgents} agents`,
    "read-only": "plugin sets · /plugin to disable",
    "in-use": "",
  };
  return h(Box, { flexDirection: "column", marginTop: 1 },
    ...segs.map((s) => h(Row, {
      key: s.id,
      cells: [
        { text: LABEL[s.id]!, role: ROLE[s.id], width: labelW },
        { text: num(s.rows.length), role: "muted", width: countW, align: "right" },
        { text: num(s.tokens), role: "muted", width: tokenW, align: "right" },
        { text: `${Math.round((s.tokens / total) * 100)}%`, role: "muted", width: 4, align: "right" },
        ...(note[s.id] ? [{ text: note[s.id]!, role: "muted" as Role }] : []),
      ],
    })));
}

function skillCells(row: SkillRow, nameW: number) {
  return [
    { text: row.name, width: nameW },
    { text: row.agents[0] ?? "", role: "muted" as Role, width: 14 },
    { text: num(row.tokens), role: "muted" as Role, width: 7, align: "right" as const },
  ];
}

function View({ report, width, limit, blindAgents }: {
  report: SkillsReport; width: number; limit: number; blindAgents: number;
}): React.JSX.Element {
  const arch = report.segments.find((s) => s.id === "archivable");
  const used = report.segments.find((s) => s.id === "in-use");
  const nameW = Math.min(32, Math.max(18, width - 48));
  const headRight = `${num(report.totalSkills)} skills`;

  return h(Box, { flexDirection: "column", width },
    h(Box, null,
      h(Text, { dimColor: true }, "  peek skills"),
      h(Text, { dimColor: true }, " ".repeat(Math.max(1, width - 15 - headRight.length))),
      h(Text, { dimColor: true }, headRight)),

    h(Box, { marginTop: 1 },
      h(Text, null, "  "),
      // Exactly one bold value per screen: the number the user came for.
      h(Text, { bold: true }, num(report.totalTokens)),
      h(Text, { dimColor: true }, " tokens load every session · "),
      h(Text, { color: "green" }, num(arch?.tokens ?? 0)),
      h(Text, { dimColor: true }, " reclaimable")),

    h(Summary, { report, blindAgents }),

    arch && arch.rows.length > 0
      ? h(Box, { flexDirection: "column" },
        h(Rule, { title: "reclaimable", trailing: `${num(arch.rows.length)} skills`, role: "ok", width }),
        h(Rows, null, ...arch.rows.slice(0, limit).map((r) =>
          h(Row, { key: r.key, cells: skillCells(r, nameW) }))),
        arch.rows.length > limit
          ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true },
            `     ${overflow(limit, arch.rows.length, "peek skills --segment archivable")}`))
          : null)
      : null,

    used && used.rows.length > 0
      ? h(Box, { flexDirection: "column" },
        h(Rule, { title: "what you use", trailing: `${num(used.rows.length)} skills`, role: "live", width }),
        h(Rows, null, ...[...used.rows]
          .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))
          .slice(0, limit)
          .map((r) => h(Row, {
            key: r.key,
            cells: [
              { text: r.name, width: nameW },
              { text: r.usesLabel, role: "muted" as Role, width: 8, align: "right" as const },
              { text: r.lastSeen ? relative(r.lastSeen) : "", role: "muted" as Role, width: 9, align: "right" as const },
            ],
          }))))
      : null,

    h(Box, { marginTop: 1 }, h(Text, { dimColor: true },
      `     peek skills --interactive   --segment <name>   --json`)),
  );
}

function relative(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : `${days}d ago`;
}

/** One segment in full. The overflow hint promises this, so it has to exist. */
function SegmentView({ report, width, segment }: {
  report: SkillsReport; width: number; segment: string;
}): React.JSX.Element {
  const seg = report.segments.find((s) => s.id === segment);
  const nameW = Math.min(32, Math.max(18, width - 48));
  if (!seg) {
    return h(Box, { flexDirection: "column", width },
      h(Text, null, `Unknown segment: ${segment}`),
      h(Text, { dimColor: true },
        `Valid: ${report.segments.map((s) => s.id).join(", ")}`));
  }
  return h(Box, { flexDirection: "column", width },
    h(Rule, {
      title: LABEL[seg.id] ?? seg.id,
      trailing: `${num(seg.rows.length)} skills · ${num(seg.tokens)} tokens`,
      role: ROLE[seg.id], width, marginTop: 1,
    }),
    h(Rows, null, ...seg.rows.map((r) => h(Row, { key: r.key, cells: skillCells(r, nameW) }))),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, `     ${seg.note}`)));
}

export async function renderSkillsSegment(
  report: SkillsReport,
  segment: string,
  opts: SkillsViewOptions = {},
): Promise<void> {
  const width = terminalWidth(opts.width);
  await renderStatic(h(SegmentView, { report, width, segment }), { forceColor: opts.color, width });
}

export async function renderSkillsReport(
  report: SkillsReport,
  opts: SkillsViewOptions = {},
): Promise<void> {
  const width = terminalWidth(opts.width);
  await renderStatic(
    h(View, { report, width, limit: opts.limit ?? 8, blindAgents: opts.blindAgents ?? 0 }),
    { forceColor: opts.color, width },
  );
}
