import React from "react";
import type { CSSProperties } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

const timeline = [
  { at: 18, kind: "cmd", text: "peek claim src/payments/reconcile.ts --ttl 2m --as demo-agent" },
  { at: 58, kind: "ok", text: "claimed 1 file until 2026-05-27T19:20:59.265Z" },
  { at: 68, kind: "text", text: "  id: 95ef9f0d-39e2-443d-a582-2b8fe51d79e7" },
  { at: 78, kind: "text", text: "  ~/work/ledgerforge/src/payments/reconcile.ts" },

  { at: 104, kind: "cmd", text: "peek coord . --writing" },
  { at: 134, kind: "text", text: "coordination: 1 sessions, first snapshot, 1 new" },
  { at: 144, kind: "dim", text: "cwd: ~/work/ledgerforge" },
  { at: 154, kind: "text", text: "" },
  { at: 164, kind: "table", text: "sessions:" },
  { at: 174, kind: "text", text: "claim-demo-agent (claim, active, tool-running, recent-writing)" },
  { at: 184, kind: "text", text: "  task: Claimed 1 file until 2026-05-27T19:20:59.265Z" },
  { at: 194, kind: "text", text: "  active writing files: ~/work/ledgerforge/src/payments/reconcile.ts" },
  { at: 204, kind: "text", text: "  hot files: ~/work/ledgerforge/src/payments/reconcile.ts" },

  { at: 230, kind: "cmd", text: "peek check src/payments/reconcile.ts --as other-agent" },
  { at: 266, kind: "warn", text: "conflict: 1 active file conflict" },
  { at: 276, kind: "warn", text: "  ~/work/ledgerforge/src/payments/reconcile.ts claimed/written by claim-demo-agent (claim, active) 0s ago" },
  { at: 286, kind: "warn", text: "    task: Claimed 1 file until 2026-05-27T19:20:59.265Z" },

  { at: 310, kind: "cmd", text: "peek release 95ef9f0d-39e2-443d-a582-2b8fe51d79e7 --claim-id" },
  { at: 342, kind: "ok", text: "released 1 claim" },
  { at: 352, kind: "text", text: "  95ef9f0d-39e2-443d-a582-2b8fe51d79e7 (demo-agent) 1 file" },
];

export const AgentPeekDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const boot = progress(frame, 0, 28);

  return (
    <AbsoluteFill style={styles.root}>
      <div
        style={{
          ...styles.terminal,
          opacity: boot,
          transform: `translateY(${interpolate(boot, [0, 1], [18, 0])}px)`,
        }}
      >
        <div style={styles.titlebar}>
          <div style={styles.lights}>
            <span style={{ ...styles.light, background: "#ff5f57" }} />
            <span style={{ ...styles.light, background: "#ffbd2e" }} />
            <span style={{ ...styles.light, background: "#28c840" }} />
          </div>
          <div style={styles.title}>agent-peek — zsh — 160x48</div>
        </div>

        <div style={styles.body}>
          <div style={styles.banner}>agent-peek</div>
          <div style={styles.explainer}>
            Read-only visibility into your other AI agent sessions.
          </div>
          <div style={styles.workflow}>
            {"tool calls for agents: claim intent -> coord reads sessions -> check catches overlap -> release clears claim"}
          </div>
          {timeline.map((line) => (
            <TerminalLine key={`${line.at}-${line.text}`} frame={frame} line={line} />
          ))}
          <Cursor frame={frame} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const TerminalLine: React.FC<{
  frame: number;
  line: (typeof timeline)[number];
}> = ({ frame, line }) => {
  const enter = progress(frame, line.at, 10);
  const typed =
    line.kind === "cmd"
      ? Math.floor(line.text.length * progress(frame, line.at, 30))
      : line.text.length;

  return (
    <div
      style={{
        ...styles.line,
        ...styleForKind(line.kind),
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [7, 0])}px)`,
      }}
    >
      {line.kind === "cmd" ? (
        <>
          <span style={styles.dollar}>$ </span>
          <span>{line.text.slice(0, typed)}</span>
          {frame >= line.at && frame < line.at + 36 ? <span style={styles.cursor}>_</span> : null}
        </>
      ) : (
        <span>{line.text}</span>
      )}
    </div>
  );
};

const Cursor: React.FC<{ frame: number }> = ({ frame }) => {
  const show = progress(frame, 344, 12);

  return (
    <div style={{ ...styles.line, opacity: show }}>
      <span style={styles.dollar}>$ </span>
      <span style={{ opacity: Math.sin(frame / 5) > 0 ? 1 : 0 }}>_</span>
    </div>
  );
};

function styleForKind(kind: string): CSSProperties {
  if (kind === "cmd") return { color: "#f3f4e8", marginTop: 18 };
  if (kind === "warn") return { color: "#ffb86c" };
  if (kind === "exit") return { color: "#ff6b6b" };
  if (kind === "ok") return { color: "#78d8a4" };
  if (kind === "json") return { color: "#9cdcfe" };
  if (kind === "table") return { color: "#a9b7c6", marginTop: 8 };
  if (kind === "dim") return { color: "#7f8c8d" };
  return { color: "#d7dac8" };
}

function progress(frame: number, from: number, duration: number) {
  return interpolate(frame, [from, from + duration], [0, 1], {
    ...clamp,
    easing: easeOut,
  });
}

const mono =
  '"SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace';

const styles: Record<string, CSSProperties> = {
  root: {
    background: "#111111",
    fontFamily: mono,
  },
  terminal: {
    position: "absolute",
    inset: 46,
    borderRadius: 18,
    background: "#0b0d0e",
    border: "1px solid #2a2f31",
    boxShadow: "0 26px 90px rgba(0, 0, 0, 0.55)",
    overflow: "hidden",
  },
  titlebar: {
    height: 58,
    display: "grid",
    gridTemplateColumns: "160px 1fr 160px",
    alignItems: "center",
    background: "#171a1c",
    borderBottom: "1px solid #2a2f31",
  },
  lights: {
    display: "flex",
    gap: 10,
    paddingLeft: 22,
  },
  light: {
    width: 15,
    height: 15,
    borderRadius: 999,
  },
  title: {
    color: "#b8b8b8",
    textAlign: "center",
    fontSize: 18,
    letterSpacing: 0,
  },
  body: {
    padding: "30px 34px",
  },
  banner: {
    color: "#f3f4e8",
    fontSize: 28,
    lineHeight: 1.2,
    marginBottom: 4,
  },
  explainer: {
    color: "#d7dac8",
    fontSize: 20,
    lineHeight: 1.28,
  },
  workflow: {
    color: "#7f8c8d",
    fontSize: 18,
    lineHeight: 1.28,
    marginTop: 4,
    marginBottom: 18,
  },
  line: {
    minHeight: 30,
    whiteSpace: "pre",
    fontSize: 21,
    lineHeight: 1.28,
    letterSpacing: 0,
  },
  prompt: {
    color: "#78d8a4",
    fontWeight: 700,
  },
  cwd: {
    color: "#9cdcfe",
  },
  dollar: {
    color: "#c586c0",
  },
  cursor: {
    color: "#f3f4e8",
  },
};
