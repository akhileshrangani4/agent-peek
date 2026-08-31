// src/cli/list-report.ts
//
// The `peek list` static report, rendered through the shared module (ticket 15).
// Layout decisions and their reasons live in render.ts; this file only says what to show.

import React from "react";
import { Box, Text } from "ink";
import { Row, Rows, Rule, num, renderStatic, terminalWidth } from "./render.js";
import type { Role } from "./render.js";
import { fit, shortenPath } from "./paths.js";

const h = React.createElement;

export interface ListEntry {
  id: string;
  displayName: string;
  adapter: string;
  status: string;
  lastSeen: string;
  cwd?: string;
}

/** Status is the structure here, the way presence is in `peek agents`. */
const ORDER = ["active", "idle", "ended"] as const;
const ROLE: Record<string, Role> = { active: "live", idle: "plain", ended: "muted" };

export interface ListViewOptions {
  width?: number;
  color?: boolean;
  showIds?: boolean;
  limit?: number;
  relativeTime: (iso: string) => string;
}

function Group({ status, entries, width, opts }: {
  status: string; entries: ListEntry[]; width: number; opts: ListViewOptions;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  const limit = opts.limit ?? 12;
  const shown = entries.slice(0, limit);
  const nameW = Math.max(...shown.map((e) => Math.min(e.displayName.length, 24)));
  const adapterW = Math.max(...shown.map((e) => e.adapter.length));
  const whenW = Math.max(...shown.map((e) => opts.relativeTime(e.lastSeen).length));
  // The path gets whatever the fixed columns leave rather than a hardcoded 20: at 120
  // columns a fixed budget elides the segment that distinguishes two worktrees, which
  // is the only part of a 90-character path a reader is looking for.
  const INDENT = 5, GUTTER = 4;
  const idW = opts.showIds ? Math.max(...shown.map((e) => e.id.length)) + GUTTER : 0;
  const cwdW = Math.max(18, width - INDENT - nameW - adapterW - whenW - idW - GUTTER * 3);
  return h(Box, { flexDirection: "column" },
    h(Rule, {
      title: status,
      trailing: `${num(entries.length)} session${entries.length === 1 ? "" : "s"}`,
      role: ROLE[status] ?? "plain",
      width,
    }),
    h(Rows, {
      children: shown.map((e) => h(Row, {
        key: e.id,
        cells: [
          { text: fit(e.displayName, 24), role: ROLE[status], width: nameW },
          { text: e.adapter, role: "muted", width: adapterW },
          { text: opts.relativeTime(e.lastSeen), role: "muted", width: whenW, align: "right" },
          // The uuid segment identifies nothing a reader uses; the tail is the answer.
          { text: e.cwd ? shortenPath(e.cwd, cwdW) : "-", role: "muted" },
          // --ids exists so a caller can copy a selector; dropping it silently would
          // break every script that reads one out of this listing.
          ...(opts.showIds ? [{ text: e.id, role: "muted" as Role }] : []),
        ],
      })),
    }),
    entries.length > shown.length
      ? h(Box, { marginTop: 1 },
        h(Text, { dimColor: true }, `     ${num(entries.length - shown.length)} more · peek list --all`))
      : null);
}

export async function renderList(
  entries: ListEntry[],
  opts: ListViewOptions,
): Promise<void> {
  const width = terminalWidth(opts.width);
  if (entries.length === 0) {
    await renderStatic(
      h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "  no sessions. `peek list --all` includes ended ones.")),
      { forceColor: opts.color, width: opts.width });
    return;
  }
  const counts = ORDER
    .map((s) => [s, entries.filter((e) => e.status === s).length] as const)
    .filter(([, n]) => n > 0);
  const labelW = Math.max(...counts.map(([s]) => s.length));
  const other = entries.filter((e) => !ORDER.includes(e.status as typeof ORDER[number]));
  const view = h(Box, { flexDirection: "column" },
    h(Box, null,
      h(Text, { bold: true }, "  peek list"),
      h(Text, { dimColor: true }, `   ${num(entries.length)} session${entries.length === 1 ? "" : "s"}`)),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...counts.map(([s, n]) => h(Row, {
        key: s,
        cells: [
          { text: s, role: ROLE[s] ?? "plain", width: labelW },
          { text: num(n), role: "muted", width: 4, align: "right" },
        ],
      }))),
    ...ORDER.map((s) => h(Group, {
      key: s, status: s, width, opts,
      entries: entries.filter((e) => e.status === s),
    })),
    // A status the table does not know about must still appear, or a session vanishes
    // from a listing whose whole job is to say what is running.
    other.length > 0
      ? h(Group, { status: "other", width, opts, entries: other })
      : null);
  await renderStatic(view, { forceColor: opts.color, width: opts.width });
}
