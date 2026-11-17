// test/unit/handoff-signal.test.ts
//
// D9.3 (issues #1, #2): the handoff's decisions, next actions and open questions are
// read by shape and by the turns around them, never by a bare keyword. The table below
// is the spec's classification table (at least 20 lines, 100% expected); a new
// transcript shape that misclassifies is a one-row fix here.
import { describe, expect, it } from "vitest";
import {
  classifySignalLine,
  extractDecisions,
  extractNextActions,
  extractOpenQuestions,
  signalTurns,
  splitSignalLines,
  type SignalKind,
  type SignalTurn,
} from "../../src/core/handoff-signal.js";

const TABLE: ReadonlyArray<readonly [line: string, kind: SignalKind, why: string]> = [
  // Research E §2, verbatim.
  ["Using peek to capture session context, then I'll write the handoff.", "narration", "§2: progress narration is not a decision"],
  ["I added the handoff file.", "outcome", "§2: a bare outcome is not a decision"],
  ["can you not use peek to create a handoff?", "question", "§2: question-shaped; openness is decided by the turns after it"],
  ["Would you like me to also commit it?", "question", "§2: a trailing offer is a question (owner decision)"],
  ["Anything else?", "closer", "§2: stock closer"],
  // Narration.
  ["Let me run peek at first.", "narration", "first-person step"],
  ["Now I'll check the tests.", "narration", "first-person step"],
  ["I'm going to read the config next.", "narration", "narration wins over 'next'"],
  ["I'm looking at the uploader now.", "narration", "present progressive"],
  ["Right — let me use peek's own capability instead of hand-authoring.", "decision", "interjection stripped; a step that names the rejected alternative is a choice (issue #6 objected to it as the task, not as a decision)"],
  ["Let me rerun it because it flaked.", "narration", "a reason for a step is not a decision"],
  // Real decisions.
  ["Decided to keep the JSON store for now because the migration is risky.", "decision", "decided + because"],
  ["We chose SQLite over a graph database.", "decision", "chose"],
  ["Going with the bearer-token approach.", "decision", "going with"],
  ["Using SQLite rather than Postgres, since it ships with Node.", "decision", "contrastive rescues a narration opener"],
  ["The cursor stays opaque because clients must not parse it.", "decision", "a reason attached to a choice"],
  // Next actions.
  ["Will rewrite next.", "next-action", "pinned by the handoff goldens"],
  ["Next: wire the backoff into the uploader.", "next-action", "next"],
  ["We still need to update the docs.", "next-action", "need to"],
  ["Remaining: the Windows path case.", "next-action", "remaining"],
  // Outcomes.
  ["Fixed the flaky upload test.", "outcome", "bare outcome"],
  ["Done.", "outcome", "bare outcome"],
  // Questions and blockers.
  ["Should I put the plan under docs/superpowers/plans or docs/plans?", "question", "asks for a decision"],
  ["Blocked on the staging credentials.", "question", "a stated blocker counts"],
  ["Do you want me to also add jitter?", "question", "an offer"],
  // Closers.
  ["Let me know if you want any changes.", "closer", "stock closer that opens like narration"],
  ["Does that help?", "closer", "stock closer"],
  ["Hope this helps!", "closer", "stock closer"],
  // Neither.
  ["Why does this matter?", "other", "rhetorical: addresses nobody, asks no choice"],
  ["Is `a ?? b` or `a || b` right here?", "other", "code in the line"],
  ["The function returns early on empty input.", "other", "plain description"],
];

describe("classifySignalLine (D9.3 table)", () => {
  it("has at least 20 rows", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(20);
  });

  it.each(TABLE)("%s -> %s", (line, kind) => {
    expect(classifySignalLine(line)).toBe(kind);
  });

  it("classifies the whole table at 100%", () => {
    const wrong = TABLE.filter(([line, kind]) => classifySignalLine(line) !== kind).map(([line]) => line);
    expect(wrong).toEqual([]);
  });
});

describe("extractDecisions / extractNextActions", () => {
  const texts = [
    "Using peek to capture session context, then I'll write the handoff. I added the handoff file.",
    "Going with the bearer-token approach. Let me run the tests first. Will rewrite next.",
  ];

  it("keep decisions and next actions and drop narration and outcomes", () => {
    expect(extractDecisions(texts)).toEqual(["Going with the bearer-token approach."]);
    expect(extractNextActions(texts)).toEqual(["Will rewrite next."]);
  });

  it("dedupe and keep the newest max lines", () => {
    const many = ["Decided A because x.", "Decided B because y.", "Decided A because x.", "Decided C because z."];
    expect(extractDecisions(many, 2)).toEqual(["Decided B because y.", "Decided C because z."]);
  });

  it("split list items and sentences into candidate lines", () => {
    expect(splitSignalLines("- Will do X.\n* Chose Y because Z. Done.")).toEqual(["Will do X.", "Chose Y because Z.", "Done."]);
  });
});

describe("extractOpenQuestions", () => {
  const turn = (speaker: SignalTurn["speaker"], text?: string): SignalTurn => ({ speaker, text });

  it("drops a question the other party replied to after", () => {
    expect(extractOpenQuestions([
      turn("assistant", "Should I put the plan under docs/superpowers/plans or docs/plans?"),
      turn("human", "docs/plans"),
    ])).toEqual([]);
  });

  it("drops the user's request once the assistant has acted on it, even with tools only", () => {
    expect(extractOpenQuestions([
      turn("human", "can you not use peek to create a handoff?"),
      turn("assistant"),
    ])).toEqual([]);
  });

  it("keeps a trailing unanswered offer and drops the closer beside it", () => {
    expect(extractOpenQuestions([
      turn("human", "Write the handoff."),
      turn("assistant", "I added the handoff file. Anything else? Would you like me to also commit it?"),
    ])).toEqual(["Would you like me to also commit it?"]);
  });

  it("keeps an unanswered question while the same party keeps talking", () => {
    expect(extractOpenQuestions([
      turn("assistant", "Should we keep the old flag or remove it?"),
      turn("assistant", "Meanwhile I'm running the tests."),
    ])).toEqual(["Should we keep the old flag or remove it?"]);
  });
});

describe("signalTurns", () => {
  it("ignores harness-only user records and keeps tool-only assistant turns", () => {
    const turns = signalTurns([
      { role: "user", text: "Fix it.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "ls" }, status: "completed" }], raw: {} },
      { role: "user", text: "<system-reminder>todo list changed</system-reminder>", raw: {} },
      { role: "user", toolCalls: [{ name: "(result)", status: "completed" }], text: "ok", raw: {} },
      { role: "assistant", text: "  ", raw: {} },
    ]);
    expect(turns).toEqual([{ speaker: "human", text: "Fix it." }, { speaker: "assistant", text: undefined }]);
  });

  it("a harness reminder after a question does not answer it", () => {
    const turns = signalTurns([
      { role: "assistant", text: "Do you want me to also add jitter?", raw: {} },
      { role: "user", text: "<system-reminder>noise</system-reminder>", raw: {} },
    ]);
    expect(extractOpenQuestions(turns)).toEqual(["Do you want me to also add jitter?"]);
  });
});
