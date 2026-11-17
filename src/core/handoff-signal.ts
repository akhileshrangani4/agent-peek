import type { RawMessage } from "./types.js";
import { humanUserText, oneLine, uniqueStrings } from "./snapshot.js";

// What a handoff reader can act on, separated from what an agent says while it
// works. Keyword matching alone filed progress narration ("Using peek to capture
// context, then I'll write the handoff.") as decisions and kept questions open long
// after the other party had replied. Each line gets exactly one kind, decided by its
// shape, and openness is decided by the turns around it, never by wording alone.

export type SignalKind =
  /** Records a choice and its reason or rejected alternative. */
  | "decision"
  /** Work still to do, stated for whoever picks the session up. */
  | "next-action"
  /** Asks the other party something, or reports being blocked on them. */
  | "question"
  /** A stock sign-off ("Anything else?"); it asks nothing specific. */
  | "closer"
  /** The agent describing the step it is taking right now. */
  | "narration"
  /** A bare report of something done, with no why. */
  | "outcome"
  | "other";

export type SignalSpeaker = "human" | "assistant";

export interface SignalTurn {
  speaker: SignalSpeaker;
  /** The turn's words; undefined for an assistant turn that only called tools. */
  text?: string;
}

const LINE_MAX = 220;

// "Anything else?", "Let me know if you want changes.", "Does that help?": a sign-off
// asks for nothing the next session could answer.
const CLOSER = /^(?:is there )?anything else\b|\blet me know if\b|\b(?:does|did) (?:that|this) (?:help|work|make sense)\b|^hope (?:that|this) helps\b|\bfeel free to\b|^(?:happy|glad) to help\b/i;

// A leading interjection ("Right —", "Okay,") says nothing about the line's shape.
const INTERJECTION = /^(?:ok(?:ay)?|alright|all right|right|great|good|sure|perfect|got it|understood)\b[\s,.!:;\u2013\u2014-]*/i;

// The agent describing what it is doing at this moment. True when written, stale by
// the time anyone reads the handoff.
const NARRATION = /^(?:using\b|let me\b|let's\b|now,? (?:i\b|let me\b|let's\b)|i(?:'ll|\u2019ll| will) now\b|i(?:'m|\u2019m| am) (?:going to|gonna|now)\b|first,? (?:i\b|let me\b|let's\b)|i(?:'m|\u2019m| am) [a-z]+ing\b)/i;

// A choice against something else. Only this rescues a line that opens like narration
// ("Using SQLite rather than Postgres ..."); a bare "because" does not, since narration
// gives reasons for its steps too ("Let me rerun it because it flaked").
const CONTRASTIVE = /\b(?:decided|chose|chosen|going with|instead of|rather than)\b/i;
const DECISION = /\b(?:decided|chose|chosen|going with|instead of|rather than|because)\b/i;

const NEXT_ACTION = /\b(?:next|todo|remaining|follow[- ]?up|need to|will)\b/i;

const OUTCOME = /^(?:(?:i|we)(?:'ve|\u2019ve| have)? )?(?:just )?(?:added|implemented|changed|fixed|removed|updated|created|wrote|ran|moved|deleted|renamed|refactored|pinned|committed|pushed|merged|installed)\b|^(?:all )?(?:done|finished)\b/i;

/** The kind of one candidate line, from its shape alone. */
export function classifySignalLine(line: string): SignalKind {
  const text = line.trim();
  if (!text) return "other";
  if (CLOSER.test(text)) return "closer";
  if (isQuestionShaped(text)) return "question";
  const body = text.replace(INTERJECTION, "");
  if (NARRATION.test(body) && !CONTRASTIVE.test(body)) return "narration";
  if (DECISION.test(body)) return "decision";
  if (NEXT_ACTION.test(body)) return "next-action";
  if (OUTCOME.test(body)) return "outcome";
  return "other";
}

/**
 * A question someone still needs answered, as opposed to a rhetorical one ("Why does
 * this matter? Because...") or a code fragment that happens to end in "?". It has to
 * address someone or ask for a decision, and carry no code. A stated blocker counts.
 */
function isQuestionShaped(line: string): boolean {
  if (/\b(blocked|need input|open question)\b/i.test(line)) return true;
  if (!line.endsWith("?") || line.includes("`") || line.length > 200) return false;
  if (line.split(/\s+/).length < 4) return false;
  return /\b(should|shall|want|do you|would you|could you|can you|ok(ay)? to|prefer|which|or)\b/i.test(line);
}

/** Sentences and list items of a message, each a candidate line. */
export function splitSignalLines(value: string): string[] {
  return value
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function linesOfKind(texts: string[], kind: SignalKind, max: number): string[] {
  const lines: string[] = [];
  for (const text of texts) {
    for (const line of splitSignalLines(text)) {
      if (classifySignalLine(line) === kind) lines.push(oneLine(line, LINE_MAX));
    }
  }
  return uniqueStrings(lines).slice(-max);
}

/** Lines that record a choice, newest last. */
export function extractDecisions(texts: string[], max = 5): string[] {
  return linesOfKind(texts, "decision", max);
}

/** Lines that state work still to do, newest last. */
export function extractNextActions(texts: string[], max = 5): string[] {
  return linesOfKind(texts, "next-action", max);
}

/**
 * The conversation as alternating parties. A user-role record that is all harness
 * (a reminder, a skill body, a tool result) is not the human speaking, so it can
 * neither ask nor answer. An assistant turn that only called tools still acted on
 * what it was asked, so it answers.
 */
export function signalTurns(messages: RawMessage[]): SignalTurn[] {
  const turns: SignalTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (!message.text || message.toolCalls?.length) continue;
      const human = humanUserText(message.text);
      if (human) turns.push({ speaker: "human", text: human });
    } else if (message.role === "assistant") {
      const acted = message.toolCalls?.some((call) => call.name !== "(result)") ?? false;
      if (message.text?.trim() || acted) turns.push({ speaker: "assistant", text: message.text?.trim() || undefined });
    }
  }
  return turns;
}

/**
 * Questions nobody has answered yet. A question is open only while no later turn from
 * the other party exists: the reply may not quote it, but the conversation moved on
 * past it. That keeps an early blocker the user never replied to, and a trailing offer
 * ("Would you like me to also commit it?"), while dropping everything already settled.
 */
export function extractOpenQuestions(turns: SignalTurn[], max = 5): string[] {
  const lastBy: Record<SignalSpeaker, number> = { human: -1, assistant: -1 };
  turns.forEach((turn, index) => { lastBy[turn.speaker] = index; });
  const questions: string[] = [];
  turns.forEach((turn, index) => {
    if (!turn.text) return;
    const other: SignalSpeaker = turn.speaker === "human" ? "assistant" : "human";
    if (lastBy[other] > index) return;
    for (const line of splitSignalLines(turn.text)) {
      if (classifySignalLine(line) === "question") questions.push(oneLine(line, LINE_MAX));
    }
  });
  return uniqueStrings(questions).slice(-max);
}
