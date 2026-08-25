import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { Engine } from "../core/engine.js";
import type { PeekResult, SessionEntry, SnapshotMode } from "../core/types.js";
import { displayNames } from "../core/names.js";
import { createEngine } from "../index.js";

interface UiOpts {
  adapter?: string;
  all?: boolean;
  terminals?: boolean;
}

type NamedSession = SessionEntry & { displayName: string };
type LoadState = "loading" | "ready" | "error";
type UiMode = SnapshotMode | "timeline";

export async function runUi(opts: UiOpts = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error([
      "error: ui_requires_tty",
      "message: `peek ui` needs an interactive terminal.",
      "hint: Use `peek list` and `peek at <selector>` for pipes, scripts, and agent harnesses.",
      "next:",
      "  - peek list",
      "  - peek at <selector> --mode structured",
      "exitCode: 5",
    ].join("\n"));
    return 5;
  }

  const engine = await createEngine({ withExternal: true });
  const app = render(React.createElement(PeekUi, { engine, opts }));
  await app.waitUntilExit();
  return 0;
}

function PeekUi({ engine, opts }: { engine: Engine; opts: UiOpts }): React.JSX.Element {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<NamedSession[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<UiMode>("structured");
  const [result, setResult] = useState<PeekResult | undefined>();
  const [listState, setListState] = useState<LoadState>("loading");
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | undefined>();

  const selectedSession = sessions[selected];

  const loadList = useCallback(async () => {
    setListState("loading");
    setError(undefined);
    try {
      let list = await engine.list({
        adapter: opts.adapter,
        includeTerminal: Boolean(opts.terminals || isTerminalAdapter(opts.adapter)),
      });
      if (!opts.all) list = list.filter((entry) => entry.status !== "ended");
      const named = withDisplayNames(list);
      setSessions(named);
      setSelected((current) => clamp(current, 0, Math.max(0, named.length - 1)));
      setListState("ready");
    } catch (e) {
      setError(errorMessage(e));
      setListState("error");
    }
  }, [engine, opts.adapter, opts.all, opts.terminals]);

  const loadDetail = useCallback(async (session: NamedSession | undefined, nextMode = mode) => {
    if (!session) {
      setResult(undefined);
      setDetailState("ready");
      return;
    }
    setDetailState("loading");
    setError(undefined);
    try {
      const peek = await engine.peek(session.id, {
        mode: nextMode === "timeline" ? "raw" : nextMode,
        limit: nextMode === "timeline" ? 20 : 40,
      });
      setResult(peek);
      setDetailState("ready");
    } catch (e) {
      setError(errorMessage(e));
      setDetailState("error");
    }
  }, [engine, mode]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadDetail(selectedSession);
  }, [loadDetail, selectedSession]);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((current) => clamp(current - 1, 0, Math.max(0, sessions.length - 1)));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((current) => clamp(current + 1, 0, Math.max(0, sessions.length - 1)));
      return;
    }
    if (input === "r") {
      void loadList();
      return;
    }
    if (input === "m" || key.tab) {
      setMode((current) => cycleMode(current));
      return;
    }
    if (key.return || input === " ") {
      void loadDetail(selectedSession);
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Header, { mode, opts }),
    error ? React.createElement(Text, { color: "red" }, error) : null,
    React.createElement(
      Box,
      { gap: 1 },
      React.createElement(SessionList, { sessions, selected, state: listState }),
      React.createElement(DetailPane, { session: selectedSession, result, state: detailState, mode }),
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true },
        "up/down or j/k select  enter refresh detail  m mode  r rescan  q quit"),
    ),
  );
}

function Header({ mode, opts }: { mode: UiMode; opts: UiOpts }): React.JSX.Element {
  const filters = [
    opts.adapter ? `adapter=${opts.adapter}` : undefined,
    opts.all ? "all" : undefined,
    opts.terminals ? "terminals" : undefined,
  ].filter(Boolean).join(" ");
  return React.createElement(
    Box,
    { justifyContent: "space-between", marginBottom: 1 },
    React.createElement(Text, { bold: true }, "agent-peek"),
    React.createElement(Text, { color: "cyan" }, `mode=${mode}${filters ? `  ${filters}` : ""}`),
  );
}

function SessionList(
  { sessions, selected, state }: { sessions: NamedSession[]; selected: number; state: LoadState },
): React.JSX.Element {
  if (state === "loading" && sessions.length === 0) {
    return panel("Sessions", React.createElement(Text, { dimColor: true }, "Scanning..."));
  }
  if (sessions.length === 0) {
    return panel("Sessions", React.createElement(Text, { dimColor: true }, "No sessions"));
  }
  return panel(`Sessions ${selected + 1}/${sessions.length}`, ...sessions.slice(0, 18).map((session, index) => {
    const active = index === selected;
    return React.createElement(
      Box,
      { key: session.id, flexDirection: "column" },
      React.createElement(Text, { color: active ? "cyan" : undefined, bold: active },
        `${active ? ">" : " "} ${session.displayName}`),
      React.createElement(Text, { dimColor: true },
        `  ${session.adapter} ${session.status} ${relativeTime(session.lastSeen)} ${sourceLabel(session)}`),
      session.cwd ? React.createElement(Text, { dimColor: true }, `  ${compact(formatPath(session.cwd), 28)}`) : null,
    );
  }));
}

function DetailPane(
  { session, result, state, mode }: {
    session?: NamedSession;
    result?: PeekResult;
    state: LoadState;
    mode: UiMode;
  },
): React.JSX.Element {
  if (!session) {
    return panel("Detail", React.createElement(Text, { dimColor: true }, "Select a session"));
  }
  if (state === "loading" && !result) {
    return panel("Detail", React.createElement(Text, { dimColor: true }, "Loading..."));
  }
  if (!result) {
    return panel("Detail", React.createElement(Text, { color: "red" }, "Unable to load session"));
  }

  const title = `${session.displayName} (${mode})`;
  const snapshot = result.snapshot;
  const meta = sessionMeta(session);
  if (mode === "timeline" && snapshot.mode === "raw") {
    const shown = snapshot.messages.slice(-12);
    const hidden = snapshot.messages.length - shown.length;
    return panel(
      title,
      ...meta,
      ...shown.map((message, index) => line(
        `${snapshot.window.start + hidden + index + 1}`,
        `${message.role}: ${compact(message.text || toolSummary(message), 130)}`,
      )),
    );
  }
  if (snapshot.mode === "structured") {
    return panel(
      title,
      ...meta,
      line("messages", String(snapshot.messageCount)),
      line("activity", snapshot.activity),
      snapshot.currentTask ? line("task", compact(snapshot.currentTask, 140)) : null,
      snapshot.lastUserMessage ? line("last user", compact(snapshot.lastUserMessage, 140)) : null,
      snapshot.lastAssistantMessage ? line("last assistant", compact(snapshot.lastAssistantMessage, 140)) : null,
      snapshot.pendingToolCalls.length
        ? line("pending tools", snapshot.pendingToolCalls.map((tool) => tool.name).join(", "))
        : null,
      snapshot.lastToolCalls.length
        ? line("recent tools", snapshot.lastToolCalls.map((tool) => tool.name).join(", "))
        : null,
    );
  }
  if (snapshot.mode === "summary") {
    return panel(
      title,
      ...meta,
      React.createElement(Text, null, snapshot.summary),
      React.createElement(Text, { dimColor: true }, `delta messages ${snapshot.deltaMessageCount}`),
      snapshot.fallback ? React.createElement(Text, { color: "yellow" }, "summary unavailable; showing fallback") : null,
    );
  }
  if (snapshot.mode === "brief") {
    return panel(
      title,
      ...meta,
      React.createElement(Text, null, snapshot.brief),
      line("activity", snapshot.activity),
      line("messages", String(snapshot.messageCount)),
      snapshot.pendingTools.length ? line("pending tools", snapshot.pendingTools.join(", ")) : null,
      snapshot.recentTools.length ? line("recent tools", snapshot.recentTools.join(", ")) : null,
    );
  }
  if (snapshot.mode === "handoff") {
    return panel(
      title,
      ...meta,
      line("messages", String(snapshot.messageCount)),
      line("activity", snapshot.activity),
      snapshot.currentTask ? line("task", compact(snapshot.currentTask, 140)) : null,
      listLines("decisions", snapshot.decisions),
      listLines("open questions", snapshot.openQuestions),
      listLines("next actions", snapshot.nextActions),
      snapshot.touchedFiles.length ? line("files", snapshot.touchedFiles.map(formatPath).join(", ")) : null,
      snapshot.pendingTools.length ? line("pending tools", snapshot.pendingTools.join(", ")) : null,
      snapshot.recentTools.length ? line("recent tools", snapshot.recentTools.join(", ")) : null,
    );
  }
  const messages = snapshot.messages.slice(-8);
  return panel(
    title,
    ...meta,
    ...messages.map((message, index) => React.createElement(
      Box,
      { key: `${message.role}-${index}`, flexDirection: "column", marginBottom: 1 },
      React.createElement(Text, { color: roleColor(message.role), bold: true },
        `[${message.role}]${message.timestamp ? ` ${message.timestamp}` : ""}`),
      message.text ? React.createElement(Text, { wrap: "wrap" }, compact(message.text, 260)) : null,
      message.toolCalls?.length
        ? React.createElement(Text, { dimColor: true },
          message.toolCalls.map((tool) => `tool=${tool.name} status=${tool.status ?? "?"}`).join("  "))
        : null,
    )),
  );
}

function panel(title: string, ...children: Array<React.ReactNode>): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, width: title.startsWith("Sessions") ? 36 : 92 },
    React.createElement(Text, { bold: true }, title),
    ...children.filter(Boolean),
  );
}

function line(label: string, value: string): React.JSX.Element {
  return React.createElement(
    Box,
    null,
    React.createElement(Text, { color: "gray" }, `${label}: `),
    React.createElement(Text, null, value),
  );
}

function listLines(label: string, values: string[]): React.JSX.Element | null {
  if (!values.length) return null;
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { color: "gray" }, `${label}:`),
    ...values.map((value, index) => React.createElement(Text, { key: `${label}-${index}` }, `  - ${compact(value, 130)}`)),
  );
}

function withDisplayNames(list: SessionEntry[]): NamedSession[] {
  const names = displayNames(list);
  return list.map((entry, index) => ({ ...entry, displayName: names[index]! }));
}

function sessionMeta(session: NamedSession): React.JSX.Element[] {
  const rows = [
    line("id", compact(session.id, 82)),
    line("status", `${session.status}  updated ${relativeTime(session.lastSeen)} ago`),
    line("adapter", `${session.adapter}  source ${sourceLabel(session)}`),
    session.tag ? line("tag", session.tag) : null,
    session.cwd ? line("cwd", compact(formatPath(session.cwd), 82)) : null,
    line("path", compact(formatPath(session.transcriptPath), 82)),
  ].filter((row): row is React.JSX.Element => row !== null);
  return [
    React.createElement(Box, { key: "meta", flexDirection: "column", marginBottom: 1 }, ...rows),
  ];
}

function cycleMode(mode: UiMode): UiMode {
  if (mode === "structured") return "brief";
  if (mode === "brief") return "timeline";
  if (mode === "timeline") return "raw";
  if (mode === "raw") return "handoff";
  if (mode === "handoff") return "summary";
  return "structured";
}

function isTerminalAdapter(adapter: unknown): boolean {
  return adapter === "tmux" || adapter === "screen";
}

function roleColor(role: string): string {
  if (role === "user") return "green";
  if (role === "assistant") return "cyan";
  if (role === "tool") return "yellow";
  return "gray";
}

function compact(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}...` : flat;
}

function toolSummary(message: { toolCalls?: { name: string; status?: string }[] }): string {
  if (!message.toolCalls?.length) return "(no text)";
  return message.toolCalls.map((tool) => `tool=${tool.name} ${tool.status ?? ""}`.trim()).join(", ");
}

function sourceLabel(entry: { adapter: string; sourceType?: string; transcriptPath: string }): string {
  if (entry.sourceType) return entry.sourceType;
  if (entry.transcriptPath.startsWith("tmux://") || entry.transcriptPath.startsWith("screen://")) return "terminal";
  if (entry.transcriptPath.endsWith(".db")) return "database";
  if (isTerminalAdapter(entry.adapter)) return "terminal";
  return "file";
}

function formatPath(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
