// src/cli/skills-ui.ts
//
// `peek skills --interactive`. Deliberately thin: every rule about what may be offered
// lives in the tested model (src/skills/report.ts), and this file renders it. The ship
// bar puts no tests on the ink screen, so the screen must not be where a safety rule
// is decided.
//
// Three properties survive from ticket 05 and 07 and are enforced here structurally:
//   - only rows in the `archivable` segment can be marked at all; the other segments
//     are rendered but not selectable, so an unattributable, ambiguous or immutable row
//     cannot be reached by a select-all or by the cursor;
//   - nothing mutates without an explicit confirm step;
//   - the confirm names what will happen per installation, because unlinking one agent
//     is a different act from retiring a skill everywhere.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { buildInventory } from "../skills/inventory.js";
import { buildSkillsReport, expandSkill, selectableForArchive } from "../skills/report.js";
import { joinUsage } from "../skills/assemble.js";
import { planArchive, executeArchive } from "../skills/archive.js";
import type { ReportInput, SkillRow, SkillsReport, InstallationRow } from "../skills/report.js";
import type { Inventory } from "../skills/types.js";
import { listAgents } from "../agents/index.js";
import { UsageStore } from "../usage/store.js";

type Phase = "loading" | "browse" | "confirm" | "done" | "error";

export async function runSkillsUi(opts: { projects?: string[] } = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error([
      "error: ui_requires_tty",
      "message: `peek skills --interactive` needs an interactive terminal.",
      "hint: Use `peek skills` for the printed report, or `--json` for a machine-readable one.",
      "next:",
      "  - peek skills",
      "  - peek skills --json",
      "exitCode: 5",
    ].join("\n"));
    return 5;
  }
  const app = render(React.createElement(SkillsUi, { projects: opts.projects ?? [] }));
  await app.waitUntilExit();
  return 0;
}

const h = React.createElement;

function SkillsUi({ projects }: { projects: string[] }): React.JSX.Element {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string>();
  const [inventory, setInventory] = useState<Inventory>();
  const [input, setInput] = useState<ReportInput>();
  const [report, setReport] = useState<SkillsReport>();
  const [cursor, setCursor] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<string[]>([]);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const inv = await buildInventory({ projects });
      const agents = await listAgents();
      const store = new UsageStore({});
      let joined;
      try { joined = joinUsage(store, inv, agents); } finally { store.close(); }
      const reportInput: ReportInput = { ...joined, skills: inv.skills, costBasis: inv.costBasis };
      setInventory(inv);
      setInput(reportInput);
      setReport(buildSkillsReport(reportInput));
      setPhase("browse");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [projects]);

  useEffect(() => { void load(); }, [load]);

  // Only the archivable segment is selectable. Everything else is shown for context and
  // cannot be reached by the cursor, so no keystroke can mark a row the model excluded.
  const selectable: SkillRow[] = useMemo(
    () => (report ? selectableForArchive(report) : []),
    [report],
  );
  const current = selectable[cursor];

  const installations: InstallationRow[] = useMemo(() => {
    if (!expanded || !current || !input || !inventory) return [];
    const skill = inventory.skills.find((s) => s.key === current.key);
    return skill ? expandSkill(input, skill) : [];
  }, [expanded, current, input, inventory]);

  const confirmPlans = useMemo(() => {
    if (!inventory || marked.size === 0) return [];
    return [...marked].map((key) => {
      const skill = inventory.skills.find((s) => s.key === key);
      try {
        return skill ? planArchive(inventory, skill.name, { allAgents: true }) : undefined;
      } catch {
        return undefined;
      }
    }).filter((p): p is NonNullable<typeof p> => p !== undefined);
  }, [inventory, marked]);

  useInput((key, meta) => {
    if (meta.ctrl && key === "c") { exit(); return; }
    if (phase === "confirm") {
      // Two deliberate keys, and the destructive one is not Enter: a confirm reached by
      // the same keystroke that navigates is a confirm nobody read.
      if (key === "y") { void runArchive(); return; }
      if (key === "n" || meta.escape) { setPhase("browse"); return; }
      return;
    }
    if (key === "q" || meta.escape) { exit(); return; }
    if (phase !== "browse") return;
    if (meta.upArrow || key === "k") { setCursor((c) => clamp(c - 1, selectable.length)); return; }
    if (meta.downArrow || key === "j") { setCursor((c) => clamp(c + 1, selectable.length)); return; }
    if (key === " " && current) {
      setMarked((prev) => {
        const next = new Set(prev);
        if (next.has(current.key)) next.delete(current.key); else next.add(current.key);
        return next;
      });
      return;
    }
    if (key === "a") {
      // Select-all spans `selectable` only, which is the archivable segment: it cannot
      // reach an unattributable, ambiguous or immutable row by construction.
      setMarked((prev) => (prev.size === selectable.length
        ? new Set()
        : new Set(selectable.map((r) => r.key))));
      return;
    }
    if (meta.return || key === "e") { setExpanded((v) => !v); return; }
    if (key === "A" && marked.size > 0) { setPhase("confirm"); return; }
  });

  const runArchive = async (): Promise<void> => {
    const lines: string[] = [];
    for (const plan of confirmPlans) {
      try {
        const record = await executeArchive(plan);
        lines.push(`archived ${plan.skillName} (${record.actions.length} installation(s))`);
      } catch (err) {
        lines.push(`refused ${plan.skillName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setResult(lines);
    setMarked(new Set());
    setPhase("done");
    await load();
    setPhase("done");
  };

  if (phase === "loading") return h(Box, null, h(Text, { dimColor: true }, "reading skill roots and usage index..."));
  if (phase === "error") return h(Box, null, h(Text, { color: "red" }, `error: ${error}`));
  if (!report) return h(Box, null, h(Text, null, "no data"));

  if (phase === "confirm") return h(ConfirmView, { plans: confirmPlans });
  if (phase === "done") {
    return h(Box, { flexDirection: "column" },
      ...result.map((line, i) => h(Text, { key: i }, line)),
      h(Text, { dimColor: true }, "q to quit"));
  }

  return h(BrowseView, { report, selectable, cursor, marked, expanded, installations });
}

function BrowseView({ report, selectable, cursor, marked, expanded, installations }: {
  report: SkillsReport; selectable: SkillRow[]; cursor: number;
  marked: Set<string>; expanded: boolean; installations: InstallationRow[];
}): React.JSX.Element {
  const archivable = report.segments.find((s) => s.id === "archivable");
  const others = report.segments.filter((s) => s.id !== "archivable" && s.rows.length > 0);
  const window = selectable.slice(Math.max(0, cursor - 6), Math.max(0, cursor - 6) + 14);
  const offset = Math.max(0, cursor - 6);
  const markedTokens = selectable.filter((r) => marked.has(r.key)).reduce((n, r) => n + r.tokens, 0);

  return h(Box, { flexDirection: "column" },
    h(Text, null, `${report.totalSkills} skills, ~${report.totalTokens.toLocaleString()} tokens charged`),
    h(Text, { color: "green" },
      `SAFE TO ARCHIVE — ${archivable?.rows.length ?? 0} skills, ~${(archivable?.tokens ?? 0).toLocaleString()} tokens`),
    h(Text, { dimColor: true }, `  ${archivable?.note ?? ""}`),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...window.map((row, i) => {
        const index = offset + i;
        const active = index === cursor;
        return h(Text, { key: row.key, inverse: active },
          `${marked.has(row.key) ? "[x]" : "[ ]"} ${row.name.padEnd(38).slice(0, 38)} ${String(row.tokens).padStart(5)}  ${row.agents.join(",")}`);
      })),
    expanded && installations.length > 0
      ? h(Box, { flexDirection: "column", marginTop: 1, borderStyle: "round", paddingX: 1 },
        h(Text, { bold: true }, "installations — archiving acts on each separately"),
        ...installations.map((inst, i) => h(Text, { key: i },
          `  ${inst.agent.padEnd(12)} used ${inst.usesLabel.padEnd(9)} ${inst.coverage.padEnd(11)} would ${inst.action}`)))
      : null,
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...others.map((segment) => h(Text, { key: segment.id, dimColor: true },
        `${segment.title}: ${segment.rows.length} skills, ~${segment.tokens.toLocaleString()} tokens — not offered (${segment.note})`)),
      report.unmatched.length > 0
        ? h(Text, { dimColor: true },
          `Invoked but not installed: ${report.unmatched.length} names — usage peek recorded for no installed skill`)
        : null),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true },
        `j/k move · space mark · a mark all · e expand · A archive ${marked.size} marked (~${markedTokens.toLocaleString()} tokens) · q quit`)));
}

function ConfirmView({ plans }: { plans: ReturnType<typeof planArchive>[] }): React.JSX.Element {
  const total = plans.reduce((n, p) => n + p.actions.length, 0);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, `Archive ${plans.length} skill(s), ${total} installation(s)?`),
    h(Text, { dimColor: true }, "Nothing has been changed yet."),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...plans.flatMap((plan) => [
        h(Text, { key: plan.skillKey, bold: true }, plan.skillName),
        // Per installation, because unlinking one agent is not retiring a skill.
        ...plan.actions.map((action, i) => h(Text, { key: `${plan.skillKey}-${i}` },
          `  ${action.kind} ${action.agent ?? "-"} ${action.path}`)),
        ...plan.skipped.map((skip, i) => h(Text, { key: `${plan.skillKey}-s${i}`, dimColor: true },
          `  skipped ${skip.agent ?? "-"}: ${skip.reason}`)),
      ])),
    h(Box, { marginTop: 1 }, h(Text, { color: "yellow" }, "y to execute · n to go back")));
}

function clamp(value: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(value, length - 1));
}
