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

const labelA = "agent A - finishing a task";
const labelB = "agent B - new session, same repo";

const postCommandLine1 =
  '$ peek post finding "Webhook dedup lives in middleware" \\';
const postCommandLine2 =
  '    --text "verify.ts owns retry dedup. Don\'t re-add checks in handlers." --paths src/middleware/verify.ts';
const postResponse = "posted finding 01k2xq-9f21ac34 (expires in 30d)";

const feedCommand = "$ peek feed --budget 500";

type FeedRowType = "warning" | "finding" | "status";

const feedRows: Array<{
  at: number;
  type: FeedRowType;
  title: string;
  body?: string;
  meta?: string;
}> = [
  {
    at: 306,
    type: "warning",
    title: "Branches feat-auth and feat-payments both modify src/shared/types.ts",
    meta: "derived - worktree overlap",
  },
  {
    at: 338,
    type: "finding",
    title: "Webhook dedup lives in middleware",
    body: "verify.ts owns retry dedup. Don't re-add checks in handlers.",
    meta: "agent A - 2m ago",
  },
  {
    at: 374,
    type: "status",
    title: "codex session active: refactoring auth",
  },
];

export const AgentPeekDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const headerIn = progress(frame, 0, 22);

  const labelAIn = progress(frame, 34, 20);
  const groupAOut = interpolate(frame, [196, 230], [1, 0], clamp);
  const labelBIn = progress(frame, 222, 20);

  const groupBOut = interpolate(frame, [440, 468], [1, 0], clamp);
  const thoughtIn = progress(frame, 404, 18);

  const finalIn = progress(frame, 478, 24);

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

        <div style={styles.prompt}>
          <span style={styles.chevron}>›</span>
          <span
            style={{
              ...styles.question,
              ...styles.promptLabel,
              opacity: labelAIn * groupAOut,
            }}
          >
            {labelA}
          </span>
          <span
            style={{
              ...styles.question,
              ...styles.promptLabel,
              opacity: labelBIn,
            }}
          >
            {labelB}
          </span>
        </div>

        <div style={styles.contentArea}>
          <div style={{ ...styles.layer, opacity: groupAOut }}>
            <Line frame={frame} at={72} color="#f6c200" text={postCommandLine1} />
            <Line frame={frame} at={88} color="#f6c200" text={postCommandLine2} />
            <Line frame={frame} at={146} color="#65e38d" text={postResponse} />
          </div>

          <div style={{ ...styles.layer, opacity: groupBOut }}>
            <Line frame={frame} at={266} color="#e07b5f" text=":: SessionStart hook" />
            <Line frame={frame} at={282} color="#f6c200" text={feedCommand} />
            <div style={styles.feedRows}>
              {feedRows.map((row) => (
                <FeedRow key={row.title} frame={frame} row={row} />
              ))}
            </div>
            <AssistantThought opacity={thoughtIn} />
          </div>
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
      <div style={styles.cwd}>~/work/payments</div>
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
    <span>Feed says dedup is handled in </span>
    <span style={styles.inlineCode}>verify.ts</span>
    <span>. Skipping rediscovery, starting directly on the handler.</span>
  </div>
);

const FeedRow: React.FC<{
  frame: number;
  row: (typeof feedRows)[number];
}> = ({ frame, row }) => {
  const enter = progress(frame, row.at, 14);
  const tagColor =
    row.type === "warning"
      ? "#ff8a5b"
      : row.type === "finding"
        ? "#65e38d"
        : "#8a8a8a";
  const titleColor = row.type === "status" ? "#8a8a8a" : "#f0f0e8";

  return (
    <div
      style={{
        ...styles.feedRow,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [8, 0])}px)`,
      }}
    >
      <span style={{ ...styles.feedTag, color: tagColor }}>
        [{row.type}]
      </span>
      <span style={{ color: titleColor }}>{row.title}</span>
      {row.body ? <div style={styles.feedBody}>{row.body}</div> : null}
      {row.meta ? <div style={styles.feedMeta}>{row.meta}</div> : null}
    </div>
  );
};

const FinalState: React.FC<{ frame: number; opacity: number }> = ({
  frame,
  opacity,
}) => {
  const bar = interpolate(frame, [502, 540], [0, 1], clamp);
  const sub = progress(frame, 528, 16);

  return (
    <div
      style={{
        ...styles.final,
        opacity,
        transform: `translateY(${interpolate(opacity, [0, 1], [24, 0])}px)`,
      }}
    >
      <div style={styles.finalTitle}>✓ Context ingested, not re-explored</div>
      <div style={styles.finalCopy}>
        Agent B started with agent A's knowledge for ~400 tokens instead of re-reading the repo.
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
        <span>peek post</span>
        <span>peek feed --budget 500</span>
        <span>npm i -g agent-peek</span>
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
    position: "relative",
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
  promptLabel: {
    position: "absolute",
    left: 96,
    right: 0,
    top: "50%",
    transform: "translateY(-50%)",
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
  contentArea: {
    position: "relative",
    marginTop: 18,
  },
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  line: {
    minHeight: 34,
    fontSize: 24,
    lineHeight: 1.34,
    letterSpacing: 0,
    whiteSpace: "pre",
  },
  feedRows: {
    marginTop: 12,
  },
  feedRow: {
    position: "relative",
    marginTop: 20,
    fontSize: 26,
    lineHeight: 1.3,
  },
  feedTag: {
    display: "inline-block",
    width: 150,
    fontWeight: 800,
  },
  feedBody: {
    color: "#c9c9c2",
    fontSize: 22,
    lineHeight: 1.3,
    marginTop: 6,
    paddingLeft: 150,
  },
  feedMeta: {
    color: "#777777",
    fontSize: 20,
    lineHeight: 1.3,
    marginTop: 4,
    paddingLeft: 150,
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
