// src/cli/usage-report.ts
//
// The `peek usage` static report, rendered through the shared module (ticket 15).
// Layout rules and their reasons live in render.ts; this file says what to show.

import React from "react";
import { Box, Text } from "ink";
import { Row, Rows, Rule, num, renderStatic, sparkline, sparklineBlank, terminalWidth } from "./render.js";
import type { Role } from "./render.js";
import type { UsageReport } from "../usage/report.js";
import type { GroupBy, UsageRow } from "../usage/query.js";

const h = React.createElement;

export interface UsageViewOptions {
  width?: number;
  color?: boolean;
  verbose?: boolean;
  /** Per-bucket counts keyed by the first grouping dimension's value. */
  series?: Map<string, number[]>;
  seriesDays?: number;
  seriesCells?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function dimensionText(row: UsageRow, dim: GroupBy): string {
  switch (dim) {
    case "sidechain": return row.sidechain ? "subagent" : "main-loop";
    case "attributionAgent": return row.attributionAgent ?? "(main loop)";
    case "sourceKind": return row.sourceKind ?? "—";
    case "day": return row.day ?? "—";
    case "tool": return row.tool ?? "—";
    default: {
      const value = (row as unknown as Record<string, unknown>)[dim];
      return value === null || value === undefined ? "(none)" : String(value);
    }
  }
}

/**
 * Per-adapter windows as their own group. claude-code at 33 days beside codex at 334 is
 * genuinely two different facts about one corpus — Claude Code deletes transcripts at 30
 * days and Codex never does — and a single combined span overstates coverage for exactly
 * the agent whose history is capped.
 */
function Windows({ report, width }: { report: UsageReport; width: number }): React.JSX.Element | null {
  if (report.windows.length === 0) return null;
  const nameW = Math.max(...report.windows.map((w) => w.adapter.length));
  return h(Box, { flexDirection: "column" },
    h(Rule, { title: "observed", trailing: `${num(report.sources.total)} ${plural(report.sources.total, "source")}`, role: "muted", width }),
    h(Rows, null, ...report.windows.map((w) => h(Row, {
      key: w.adapter,
      cells: [
        { text: w.adapter, width: nameW },
        { text: `${num(w.days)}d`, role: "muted", width: 6, align: "right" },
        { text: `${w.earliest.slice(0, 10)} → ${w.latest.slice(0, 10)}`, role: "muted", width: 23 },
        { text: `${num(w.invocations)} ${plural(w.invocations, "invocation")}`, role: "muted" },
      ],
    }))));
}

/**
 * Coverage stays a summarised count with `--verbose` to expand. Thirty-one lines of
 * "usage unknown for X" above every report buries the report, and the count cannot
 * honestly be shrunk — those agents are present and genuinely unobservable.
 */
function Coverage({ report, width, verbose }: {
  report: UsageReport; width: number; verbose: boolean;
}): React.JSX.Element | null {
  const blind = report.blindSpots;
  const partial = report.partiallyObserved;
  if (blind.length === 0 && partial.length === 0) return null;
  const lines: React.JSX.Element[] = [];
  if (blind.length > 0) {
    if (verbose || blind.length <= 3) {
      for (const spot of blind) {
        lines.push(h(Row, {
          key: spot.agent,
          cells: [
            { text: spot.displayName, width: 18 },
            {
              text: spot.reason === "no-adapter"
                ? "no transcript adapter"
                : `${spot.adapter} adapter extracts no invocations`,
              role: "muted" as Role,
            },
          ],
        }));
      }
    } else {
      const names = blind.slice(0, 3).map((s) => s.displayName).join(", ");
      lines.push(h(Row, {
        key: "blind",
        cells: [
          { text: `${num(blind.length)} ${plural(blind.length, "agent")}`, role: "unknown", width: 18 },
          { text: `${names}, … — --verbose to list`, role: "muted" as Role },
        ],
      }));
    }
  }
  for (const p of partial) {
    lines.push(h(Row, {
      key: p.agent,
      cells: [
        { text: p.agent, width: 18 },
        { text: `${p.missing.join(", ")} not observable`, role: "muted" as Role },
      ],
    }));
  }
  return h(Box, { flexDirection: "column" },
    h(Rule, { title: "usage not attributable", role: "unknown", width }),
    h(Rows, null, ...lines));
}

function View({ report, groupBy, width, limit, verbose, series, seriesDays, seriesCells }: {
  report: UsageReport; groupBy: GroupBy[]; width: number; limit: number; verbose: boolean;
  series: Map<string, number[]>; seriesDays: number; seriesCells: number;
}): React.JSX.Element {
  // A sparkline only means something when a row is an entity observed over time. When
  // the grouping IS time, every row is one bucket and a per-row shape would be a single
  // bar — so `--by day` gets one wide sparkline of the whole corpus instead, which is
  // the one view where the shape over time is itself the answer.
  const byDay = groupBy.length === 1 && groupBy[0] === "day";
  const showSpark = series.size > 0 && groupBy.length === 1 && !byDay && width >= 84;
  const cells = showSpark ? seriesCells : 0;
  const dimW = Math.min(34, Math.max(16, width - 44 - cells));
  // The heading counts the whole corpus, never the visible slice: a header describing a
  // limited row list as if it were everything is how a report overstates what it knows.
  const headRight = `${num(report.sources.total)} ${plural(report.sources.total, "source")}`;

  return h(Box, { flexDirection: "column", width },
    h(Box, null,
      h(Text, { dimColor: true }, "  peek usage"),
      h(Text, { dimColor: true }, " ".repeat(Math.max(1, width - 14 - headRight.length))),
      h(Text, { dimColor: true }, headRight)),

    // Counts the whole index, never the visible slice. Summing the shown rows reported
    // "54 skill invocations" for a --limit 6 view of a corpus with far more — a header
    // describing a limited list as if it were everything, in a report whose entire
    // selling point is not overstating what it knows.
    h(Box, { marginTop: 1 },
      h(Text, null, "  "),
      h(Text, { bold: true }, num(report.totalInvocations)),
      h(Text, { dimColor: true }, ` ${plural(report.totalInvocations, "invocation")} indexed over ${num(report.window.days)} ${plural(report.window.days, "day")}`)),

    byDay && report.rows.length > 1
      ? h(Box, { flexDirection: "column" },
        h(Rule, { title: "shape over time", role: "live", width }),
        h(DayShape, { report }))
      : null,

    report.rows.length === 0
      ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "     no invocations match those filters"))
      : h(Box, { flexDirection: "column" },
        h(Rule, {
          title: groupBy.join(" · "),
          trailing: `${num(report.groupsReturned)} ${plural(report.groupsReturned, "row")}`,
          role: "live",
          width,
        }),
        h(Rows, null, ...report.rows.slice(0, limit).map((r, i) => h(Row, {
          key: `${i}`,
          cells: [
            ...groupBy.map((d, j) => ({
              text: dimensionText(r, d),
              width: j === 0 ? dimW : 14,
            })),
            ...(showSpark
              ? [{
                text: series.has(dimensionText(r, groupBy[0]!))
                  ? sparkline(series.get(dimensionText(r, groupBy[0]!))!)
                  : sparklineBlank(cells),
                role: (series.has(dimensionText(r, groupBy[0]!)) ? "live" : "muted") as Role,
                width: cells,
              }]
              : []),
            { text: num(r.count), role: "muted" as Role, width: 7, align: "right" as const },
            { text: relative(r.lastSeen), role: "muted" as Role, width: 9, align: "right" as const },
          ],
        }))),
        report.truncated
          // The report knows more rows exist but not how many; stating a number here
          // would be inventing one.
          ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true },
            "     more rows · --limit to widen"))
          : null),

    showSpark
      ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, `     last ${seriesDays} days`))
      : null,

    h(Windows, { report, width }),
    h(Coverage, { report, width, verbose }),
  );
}

/**
 * One value per calendar day between the first and last day present, zero where no
 * invocation was recorded. Without this a sparkline shows the days that HAVE data
 * side by side, which reads as continuous activity across a period with gaps in it.
 */
function dailySeries(rows: { day?: string; count: number }[]): number[] {
  const first = rows[0]?.day, last = rows.at(-1)?.day;
  if (!first || !last) return rows.map((r) => r.count);
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  const out: number[] = [];
  for (const d = new Date(`${first}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? 0);
    if (key >= last) break;
    // A malformed day would otherwise loop until the heap gives out.
    if (out.length > 4000) break;
  }
  return out;
}

/**
 * The corpus as one shape. Two traps, both of which shipped once.
 *
 * Rows arrive ordered by count, so the sparkline and its label must come from a
 * date-sorted copy — reading the ends of the count-ordered array reported a range that
 * was neither the earliest nor the latest day.
 *
 * And the view receives an ALREADY-LIMITED report, so a shape built from what it holds
 * describes the visible slice while sitting under a rule that says "shape over time".
 * At `--limit 3` that claimed a 3-day corpus for a 33-day one. The window is taken from
 * the report envelope, which covers the whole index, and the shape says plainly when it
 * is drawn from fewer days than the window spans.
 */
function DayShape({ report }: { report: UsageReport }): React.JSX.Element {
  const byDate = report.rows.slice().sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));
  const span = report.window;
  const from = span?.earliest?.slice(0, 10) ?? byDate[0]?.day ?? "";
  const to = span?.latest?.slice(0, 10) ?? byDate.at(-1)?.day ?? "";
  // A truncated report holds the highest-COUNT days, not a date range: at `--limit 3`
  // those were 2026-08-24, 2026-08-31 and 2026-08-05, and drawing them as three adjacent
  // cells asserts they are consecutive. There is no shape to draw from a non-contiguous
  // subset, so say what is missing instead of drawing something that reads as a trend.
  if (report.truncated) {
    return h(Box, { marginTop: 1 },
      h(Text, { dimColor: true },
        `     ${from} → ${to} · raise --limit past ${byDate.length} to draw the shape`));
  }
  // Days with no invocations have no row, so drawing one cell per row puts 2026-08-03
  // beside 2026-08-11 and asserts they are adjacent. A shape over time has to include
  // the days when nothing happened: gaps are filled with zero, and the label is the
  // range actually drawn rather than the index window, so the two cannot disagree.
  const counts = dailySeries(byDate);
  return h(Box, { marginTop: 1 },
    h(Text, null, "     "),
    h(Text, { color: "cyan" }, sparkline(counts)),
    h(Text, { dimColor: true },
      `  ${byDate[0]?.day ?? from} → ${byDate.at(-1)?.day ?? to}`
      + `  ${counts.length} days`));
}

function relative(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : `${days}d ago`;
}

export async function renderUsageReport(
  report: UsageReport,
  groupBy: GroupBy[],
  opts: UsageViewOptions = {},
): Promise<void> {
  const width = terminalWidth(opts.width);
  if (report.empty) {
    await renderStatic(h(Box, { flexDirection: "column", width },
      h(Text, null, "  No invocations indexed yet."),
      h(Text, { dimColor: true }, "  Run `peek usage` again once a session has been recorded, or check `peek doctor`.")),
    { forceColor: opts.color, width });
    return;
  }
  await renderStatic(
    h(View, {
      report, groupBy, width,
      limit: report.rows.length,
      verbose: Boolean(opts.verbose),
      series: opts.series ?? new Map(),
      seriesDays: opts.seriesDays ?? 30,
      seriesCells: opts.seriesCells ?? 15,
    }),
    { forceColor: opts.color, width },
  );
}
