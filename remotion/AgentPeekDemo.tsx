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
const mono =
  '"SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace';

const question =
  "what was i doing yesterday with codex?";

const sessions = [
  {
    at: 188,
    name: "dashboard-codex",
    status: "yesterday - 4:18 PM",
    cwd: "~/work/dashboard",
  },
  {
    at: 212,
    name: "api-codex",
    status: "yesterday - 11:02 AM",
    cwd: "~/work/api",
  },
  {
    at: 236,
    name: "mobile-codex",
    status: "2 days ago",
    cwd: "~/work/mobile",
  },
];

const handoff = [
  {
    at: 322,
    label: "current task",
    value: "debugging slow dashboard filters after the metrics refactor",
  },
  {
    at: 348,
    label: "last decision",
    value: "cache the account list and leave chart rendering untouched",
  },
  {
    at: 374,
    label: "next step",
    value: "add a regression test for filtered dashboard loads",
  },
  {
    at: 400,
    label: "files",
    value: "src/dashboard/filters.ts  test/dashboard/filters.test.ts",
  },
];

export const AgentPeekDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const headerIn = progress(frame, 0, 22);
  const promptIn = progress(frame, 34, 16);
  const typedQuestion = Math.floor(question.length * progress(frame, 52, 46));
  const thoughtIn = progress(frame, 112, 16);
  const listIn = progress(frame, 150, 16);
  const handoffIn = progress(frame, 286, 18);
  const finalIn = progress(frame, 438, 24);
  const workOpacity = interpolate(frame, [424, 456], [1, 0], clamp);

  return (
    <AbsoluteFill style={styles.root}>
      <div
        style={{
          ...styles.stage,
          opacity: headerIn,
          transform: `translateY(${interpolate(headerIn, [0, 1], [20, 0])}px)`,
        }}
      >
        <Header />
        <div style={styles.rule} />

        <div
          style={{
            ...styles.prompt,
            opacity: promptIn,
            transform: `translateY(${interpolate(promptIn, [0, 1], [8, 0])}px)`,
          }}
        >
          <span style={styles.chevron}>›</span>
          <span style={styles.question}>{question.slice(0, typedQuestion)}</span>
          {frame < 108 ? <span style={styles.cursor}>█</span> : null}
        </div>

        <div style={{ opacity: workOpacity }}>
          <AssistantThought opacity={thoughtIn} />
          <SessionList frame={frame} opacity={listIn} />
          <Handoff frame={frame} opacity={handoffIn} />
        </div>

        <FinalState frame={frame} opacity={finalIn} />
      </div>
    </AbsoluteFill>
  );
};

const Header: React.FC = () => (
  <div style={styles.header}>
    <ClaudeMark />
    <div>
      <div style={styles.product}>Claude Code</div>
      <div style={styles.cwd}>/work/dashboard</div>
    </div>
  </div>
);

const ClaudeMark: React.FC = () => {
  const blocks = [
    [1, 0],
    [2, 0],
    [3, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
    [1, 2],
    [2, 2],
    [3, 2],
    [1, 3],
    [3, 3],
  ];

  return (
    <div style={styles.mark}>
      {blocks.map(([x, y]) => (
        <span
          key={`${x}-${y}`}
          style={{
            ...styles.markBlock,
            left: x * 24,
            top: y * 24,
          }}
        />
      ))}
    </div>
  );
};

const AssistantThought: React.FC<{ opacity: number }> = ({ opacity }) => (
  <div
    style={{
      ...styles.thought,
      opacity,
      transform: `translateY(${interpolate(opacity, [0, 1], [8, 0])}px)`,
    }}
  >
    <span style={styles.thoughtPrefix}>Claude</span>
    <span>I need yesterday's Codex history for this repo. I will use </span>
    <span style={styles.inlineCode}>peek</span>
    <span> to inspect it read-only.</span>
  </div>
);

const SessionList: React.FC<{ frame: number; opacity: number }> = ({
  frame,
  opacity,
}) => (
  <div
    style={{
      ...styles.block,
      opacity,
      transform: `translateY(${interpolate(opacity, [0, 1], [10, 0])}px)`,
    }}
  >
    <Line frame={frame} at={154} color="#f6c200" text="$ peek list --adapter codex --all" />
    <Line frame={frame} at={170} color="#e07b5f" text=":: found Codex sessions" />
    {sessions.map((session) => (
      <SessionRow key={session.name} frame={frame} session={session} />
    ))}
  </div>
);

const SessionRow: React.FC<{
  frame: number;
  session: (typeof sessions)[number];
}> = ({ frame, session }) => {
  const enter = progress(frame, session.at, 12);
  const selected = session.name === "dashboard-codex";
  const select = selected ? progress(frame, 252, 18) : 0;

  return (
    <div
      style={{
        ...styles.sessionRow,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [8, 0])}px)`,
      }}
    >
      <div
        style={{
          ...styles.selector,
          opacity: selected ? 1 : 0,
          transform: `scaleX(${interpolate(select, [0, 1], [0.2, 1])})`,
        }}
      />
      <span style={styles.check}>✓</span>
      <span style={selected ? styles.sessionNameActive : styles.sessionName}>
        {session.name}
      </span>
      <span style={styles.sessionStatus}>{session.status}</span>
      <div style={styles.sessionCwd}>{session.cwd}</div>
    </div>
  );
};

const Handoff: React.FC<{ frame: number; opacity: number }> = ({
  frame,
  opacity,
}) => (
  <div
    style={{
      ...styles.handoff,
      opacity,
      transform: `translateY(${interpolate(opacity, [0, 1], [12, 0])}px)`,
    }}
  >
    <Line
      frame={frame}
      at={292}
      color="#f6c200"
      text="$ peek at dashboard-codex --mode handoff"
    />
    <div style={styles.handoffRows}>
      {handoff.map((item) => (
        <HandoffRow key={item.label} frame={frame} item={item} />
      ))}
    </div>
  </div>
);

const HandoffRow: React.FC<{
  frame: number;
  item: (typeof handoff)[number];
}> = ({ frame, item }) => {
  const enter = progress(frame, item.at, 12);

  return (
    <div
      style={{
        ...styles.handoffRow,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [8, 0])}px)`,
      }}
    >
      <span style={styles.handoffLabel}>{item.label}</span>
      <span style={styles.handoffValue}>{item.value}</span>
    </div>
  );
};

const FinalState: React.FC<{ frame: number; opacity: number }> = ({
  frame,
  opacity,
}) => {
  const bar = interpolate(frame, [462, 500], [0, 1], clamp);
  const sub = progress(frame, 488, 16);

  return (
    <div
      style={{
        ...styles.final,
        opacity,
        transform: `translateY(${interpolate(opacity, [0, 1], [24, 0])}px)`,
      }}
    >
      <div style={styles.finalTitle}>✓ Found your session</div>
      <div style={styles.finalCopy}>
        Claude Code used Agent Peek to recover yesterday's Codex context for the current project.
      </div>
      <div style={styles.meter}>
        <div style={{ ...styles.meterFill, width: `${bar * 100}%` }} />
      </div>
      <div
        style={{
          ...styles.finalTags,
          opacity: sub,
          transform: `translateY(${interpolate(sub, [0, 1], [8, 0])}px)`,
        }}
      >
        <span>natural question</span>
        <span>peek CLI</span>
        <span>yesterday's Codex context</span>
      </div>
    </div>
  );
};

const Line: React.FC<{
  frame: number;
  at: number;
  text: string;
  color: string;
}> = ({ frame, at, text, color }) => {
  const enter = progress(frame, at, 10);

  return (
    <div
      style={{
        ...styles.line,
        color,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [7, 0])}px)`,
      }}
    >
      {text}
    </div>
  );
};

function progress(frame: number, from: number, duration: number) {
  return interpolate(frame, [from, from + duration], [0, 1], {
    ...clamp,
    easing: easeOut,
  });
}

const styles: Record<string, CSSProperties> = {
  root: {
    background: "#050505",
    color: "#f2f2ed",
    fontFamily: mono,
  },
  stage: {
    position: "absolute",
    inset: "74px 88px",
  },
  header: {
    height: 180,
    display: "flex",
    alignItems: "center",
    gap: 48,
  },
  mark: {
    position: "relative",
    width: 120,
    height: 96,
    flex: "0 0 auto",
  },
  markBlock: {
    position: "absolute",
    width: 24,
    height: 24,
    background: "#dd7657",
  },
  product: {
    color: "#f4f4f0",
    fontSize: 39,
    fontWeight: 800,
    lineHeight: 1.18,
    letterSpacing: 0,
  },
  cwd: {
    color: "#686868",
    fontSize: 38,
    lineHeight: 1.18,
    letterSpacing: 0,
    marginTop: 14,
  },
  rule: {
    height: 1,
    background: "#242424",
  },
  prompt: {
    height: 104,
    borderBottom: "1px solid #1c1c1c",
    display: "flex",
    alignItems: "center",
    fontSize: 50,
    lineHeight: 1,
  },
  chevron: {
    color: "#777777",
    fontSize: 68,
    marginRight: 28,
    transform: "translateY(-4px)",
  },
  question: {
    color: "#f2f2ed",
  },
  cursor: {
    color: "#d9d9d4",
    fontSize: 52,
    marginLeft: 8,
  },
  thought: {
    marginTop: 24,
    minHeight: 42,
    color: "#d8d8d1",
    fontSize: 25,
    lineHeight: 1.34,
  },
  thoughtPrefix: {
    color: "#7b7b7b",
    marginRight: 22,
  },
  inlineCode: {
    color: "#f6c200",
  },
  block: {
    marginTop: 18,
  },
  line: {
    minHeight: 34,
    fontSize: 24,
    lineHeight: 1.34,
    letterSpacing: 0,
    whiteSpace: "pre",
  },
  sessionRow: {
    position: "relative",
    minHeight: 62,
    fontSize: 28,
    lineHeight: 1.24,
    letterSpacing: 0,
  },
  selector: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 1,
    height: 58,
    background:
      "linear-gradient(90deg, rgba(80,217,122,0.17), rgba(80,217,122,0.04) 58%, rgba(80,217,122,0))",
    transformOrigin: "left center",
  },
  check: {
    position: "relative",
    display: "inline-block",
    width: 48,
    color: "#64e58c",
  },
  sessionName: {
    position: "relative",
    color: "#45a765",
  },
  sessionNameActive: {
    position: "relative",
    color: "#65e38d",
    fontWeight: 800,
  },
  sessionStatus: {
    position: "absolute",
    right: 22,
    color: "#777777",
  },
  sessionCwd: {
    position: "relative",
    color: "#777777",
    fontSize: 22,
    marginTop: 4,
    paddingLeft: 74,
  },
  handoff: {
    marginTop: 16,
  },
  handoffRows: {
    marginTop: 10,
  },
  handoffRow: {
    display: "grid",
    gridTemplateColumns: "220px 1fr",
    alignItems: "baseline",
    minHeight: 40,
    fontSize: 25,
    lineHeight: 1.32,
  },
  handoffLabel: {
    color: "#797979",
  },
  handoffValue: {
    color: "#f0f0e8",
  },
  final: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 490,
  },
  finalTitle: {
    color: "#65e38d",
    fontSize: 56,
    fontWeight: 800,
    lineHeight: 1.12,
    letterSpacing: 0,
  },
  finalCopy: {
    color: "#f2f2ed",
    fontSize: 30,
    lineHeight: 1.3,
    marginTop: 16,
    maxWidth: 1480,
  },
  meter: {
    width: 940,
    height: 30,
    background: "#1d1d1d",
    marginTop: 32,
  },
  meterFill: {
    height: "100%",
    background: "#50d97a",
  },
  finalTags: {
    display: "flex",
    gap: 42,
    marginTop: 22,
    color: "#8a8a8a",
    fontSize: 25,
    lineHeight: 1.2,
  },
};
