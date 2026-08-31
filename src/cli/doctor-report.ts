// src/cli/doctor-report.ts
//
// The `peek doctor` static report, rendered through the shared module (ticket 15).
// Layout decisions and their reasons live in render.ts; this file only says what to show.

import React from "react";
import { Box, Text } from "ink";
import { Row, Rows, Rule, num, renderStatic, terminalWidth } from "./render.js";
import type { Role } from "./render.js";
import { shortenPath, wrapList } from "./paths.js";
import type { ResolvedAgent } from "../agents/types.js";

const h = React.createElement;

export interface DoctorRow {
  adapter: string;
  source: string;
  status: "ready" | "not found" | "needs command" | "opt-in";
  path?: string;
  command?: string;
  note?: string;
}

/** Status is the structure, as presence is in agents and session status is in list. */
const ORDER: DoctorRow["status"][] = ["ready", "opt-in", "needs command", "not found"];
const ROLE: Record<DoctorRow["status"], Role> = {
  ready: "ok",
  "opt-in": "plain",
  // Not muted: an adapter that needs a command is the one thing on this page a reader
  // can act on, and doctor exists to surface exactly that.
  "needs command": "unknown",
  "not found": "muted",
};
const NOTE: Record<DoctorRow["status"], string> = {
  ready: "peek can read this now",
  "opt-in": "available, not enabled by default",
  "needs command": "install the CLI to enable",
  "not found": "nothing to read on this machine",
};

export interface DoctorViewOptions {
  width?: number;
  color?: boolean;
  version: string;
}

function Group({ status, rows, width }: {
  status: DoctorRow["status"]; rows: DoctorRow[]; width: number;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  const adapterW = Math.max(...rows.map((r) => r.adapter.length));
  const sourceW = Math.max(...rows.map((r) => r.source.length));
  const INDENT = 5, GUTTER = 4;
  const targetW = Math.max(20, width - INDENT - adapterW - sourceW - GUTTER * 2);
  return h(Box, { flexDirection: "column" },
    h(Rule, {
      title: status,
      trailing: `${num(rows.length)} adapter${rows.length === 1 ? "" : "s"}`,
      role: ROLE[status],
      width,
    }),
    h(Rows, {
      children: rows.map((r) => h(Row, {
        key: r.adapter,
        cells: [
          { text: r.adapter, role: ROLE[status], width: adapterW },
          { text: r.source, role: "muted", width: sourceW },
          { text: r.path ? shortenPath(r.path, targetW) : r.command ?? "-", role: "muted" },
        ],
      })),
    }));
}

/**
 * Agent coverage as wrapped name lists rather than a table: the slugs are the content,
 * and a truncated list of names answers nothing.
 */
function Coverage({ agents, width }: {
  agents: ResolvedAgent[]; width: number;
}): React.JSX.Element {
  const budget = Math.min(width - 4, 96);
  const lists: [string, string[]][] = [
    ["usage not observable (no adapter)", agents.filter((a) => !a.adapter).map((a) => a.slug)],
    ["usage not observable (adapter parses no tool calls)",
      agents.filter((a) => a.adapter && !a.observable).map((a) => a.slug)],
    ["slash-command usage not observable",
      agents.filter((a) => a.observable && !a.observes.includes("slash_command")).map((a) => a.slug)],
  ];
  const observable = agents.filter((a) => a.observable).length;
  const manageable = agents.filter((a) => a.manageable).length;
  return h(Box, { flexDirection: "column" },
    h(Rule, { title: "agents", trailing: `${num(agents.length)} on this machine`, width }),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true },
        `     ${num(observable)} observable · ${num(manageable)} manageable`)),
    ...lists.filter(([, slugs]) => slugs.length > 0).map(([label, slugs], i) =>
      h(Box, { key: i, flexDirection: "column", marginTop: 1 },
        ...wrapList(label, slugs, budget).map((line, j) =>
          h(Text, { key: j, dimColor: true }, `  ${line}`)))));
}

export async function renderDoctor(
  rows: DoctorRow[],
  agents: ResolvedAgent[] | undefined,
  opts: DoctorViewOptions,
): Promise<void> {
  const width = terminalWidth(opts.width);
  const counts = ORDER
    .map((s) => [s, rows.filter((r) => r.status === s).length] as const)
    .filter(([, n]) => n > 0);
  const labelW = Math.max(...counts.map(([s]) => s.length));
  const notes = rows.filter((r) => r.note);
  const view = h(Box, { flexDirection: "column" },
    h(Box, null,
      h(Text, { bold: true }, `  agent-peek ${opts.version}`),
      h(Text, { dimColor: true }, `   ${num(rows.length)} adapters`)),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...counts.map(([s, n]) => h(Row, {
        key: s,
        cells: [
          { text: s, role: ROLE[s], width: labelW },
          { text: num(n), role: "muted", width: 4, align: "right" },
          { text: NOTE[s], role: "muted" },
        ],
      }))),
    ...ORDER.map((s) => h(Group, {
      key: s, status: s, width, rows: rows.filter((r) => r.status === s),
    })),
    notes.length > 0
      ? h(Box, { flexDirection: "column", marginTop: 2 },
        // Notes print once per adapter that has one. As a table column this ran the
        // output to 158 columns for a sentence repeated on every row.
        ...notes.map((r) => h(Text, { key: r.adapter, dimColor: true },
          `     ${r.adapter}: ${r.note}`)))
      : null,
    agents ? h(Coverage, { agents, width }) : null,
    h(Box, { flexDirection: "column", marginTop: 2 },
      h(Text, { dimColor: true }, "     peek agents      skill roots and observable usage"),
      h(Text, { dimColor: true }, "     peek list        ready file and database adapters"),
      h(Text, { dimColor: true }, "     peek list --terminals   opt into tmux/screen capture"),
      h(Text, { dimColor: true }, "     peek update      check whether this CLI is current")));
  await renderStatic(view, { forceColor: opts.color, width: opts.width });
}
