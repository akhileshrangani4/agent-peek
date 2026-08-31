// src/usage/extract.ts
//
// Extraction lives here rather than on the Adapter interface: adapters are ticket 02's
// territory, and if that model later wants extraction as an adapter capability, moving
// a registry entry onto the adapter is a mechanical change.
//
// Only claude-code ships an extractor. Every other adapter falls back to tool calls
// only — codex is the proof this matters: its rollouts carry `exec` records and no
// `Skill` tool at all, so its extractor will be a genuinely different function.

import type { RawMessage } from "../core/types.js";
import type { Invocation, SourceKind } from "./schema.js";

export interface ExtractContext {
  sourcePath: string;
  adapter: string;
  agent: string | null;
  sessionId: string | null;
  cwd: string | null;
  /** Index of `messages[0]` within the whole transcript. */
  baseMsgIndex: number;
}

export type Extractor = (messages: RawMessage[], ctx: ExtractContext) => Invocation[];

/**
 * Whitelisted argument extraction. Never the raw input blob — see ADR 0001.
 * Adding an entry here is a deliberate act, and only recovers the last 30 days.
 */
export function whitelistedArgument(tool: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (tool === "Skill" && typeof obj.skill === "string") return obj.skill;
  return null;
}

/** A user message holds at most one command, so callIndex is always 0 for one. */
const SLASH_CALL_INDEX = 0;

// Matched against the structured command block, not scanned for across prose: a regex
// literal sitting in transcript text produced a false `<command-name>` hit during the
// ticket-01 survey.
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s][^<]*?)\s*<\/command-name>/;

interface ClaudeRecord {
  type?: unknown;
  isSidechain?: unknown;
  attributionAgent?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function baseFields(rec: ClaudeRecord, ctx: ExtractContext, msgIndex: number, ts: string) {
  return {
    sourcePath: ctx.sourcePath,
    msgIndex,
    adapter: ctx.adapter,
    agent: ctx.agent,
    sessionId: str(rec.sessionId) ?? ctx.sessionId,
    timestamp: ts,
    cwd: str(rec.cwd) ?? ctx.cwd,
    sidechain: rec.isSidechain === true,
    attributionAgent: str(rec.attributionAgent),
  };
}

/**
 * Reads both invocation paths a Claude Code transcript records: the `Skill` tool and
 * friends (agent-initiated), and slash commands in user messages (user-initiated).
 * A tool-call-only extractor reports every slash-only skill as never used, and skills
 * carrying `disable-model-invocation` can *only* be slash-invoked.
 */
export const claudeCodeExtractor: Extractor = (messages, ctx) => {
  const out: Invocation[] = [];
  messages.forEach((msg, i) => {
    const msgIndex = ctx.baseMsgIndex + i;
    const rec = (msg.raw ?? {}) as ClaudeRecord;
    const ts = msg.timestamp ?? str(rec.timestamp) ?? new Date(0).toISOString();
    const base = baseFields(rec, ctx, msgIndex, ts);

    const toolCalls = msg.toolCalls ?? [];
    toolCalls.forEach((call, callIndex) => {
      out.push({
        ...base,
        callIndex,
        sourceKind: "tool_call" as SourceKind,
        tool: call.name,
        skill: whitelistedArgument(call.name, call.input),
        status: call.status ?? null,
        nativeCallId: nativeIdFor(rec, callIndex),
      });
    });

    const command = userCommandName(rec);
    if (command !== null) {
      out.push({
        ...base,
        callIndex: SLASH_CALL_INDEX,
        sourceKind: "slash_command" as SourceKind,
        // Verbatim as typed: `/wayfinder` and `/mattpocock-skills:wayfinder` stay
        // distinct rows. Reconciling them is the inventory's job, not the index's.
        tool: command,
        skill: command,
        status: null,
        nativeCallId: null,
      });
    }
  });
  return out;
};

/**
 * A slash invocation is a *user* message whose content is the command block. Measured
 * across the whole corpus: all 79 genuine invocations are `type: "user"` with string
 * content and exactly one tag. The only record that breaks that shape is an assistant
 * message quoting the tag while discussing it — which must not count as an invocation,
 * or writing about a command inflates its usage.
 *
 * Only the first tag in a message is taken, so a record echoing the tag many times
 * still yields one invocation.
 *
 * If Claude Code ever moves user messages to structured content this stops matching;
 * that shows up as slash_command counts collapsing in `peek usage sourceKind`, which is
 * the reason that breakdown is worth having.
 */
function userCommandName(rec: ClaudeRecord): string | null {
  if (rec.type !== "user") return null;
  const content = rec.message?.content;
  if (typeof content !== "string") return null;
  const m = COMMAND_NAME_RE.exec(content);
  return m && m[1] !== undefined ? m[1] : null;
}

function nativeIdFor(rec: ClaudeRecord, callIndex: number): string | null {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  const uses = content.filter((b) =>
    !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_use");
  const block = uses[callIndex] as { id?: unknown } | undefined;
  return block ? str(block.id) : null;
}

/**
 * Codex records slash commands with the same `<command-name>` markup Claude Code uses,
 * but writes **every user turn twice**: once as `event_msg/user_message` and once as
 * `response_item/message` with `role: "user"`. Verified on a single rollout — lines 2
 * and 3 are the same invocation in the two shapes — so an extractor reading both
 * doubles every count.
 *
 * This keys on `response_item/message` + `role: "user"`, which carries an explicit role
 * field. The adapter already normalises `event_msg` records to role "system", so the
 * duplicate never reaches here; keying structurally means that stays true even if it
 * did. `response_item/custom_tool_call_output` tags are echoes of a command inside tool
 * output, not invocations, and are excluded for the same reason assistant quotes are on
 * claude-code.
 *
 * Codex tool calls stay unattributable: a skill invocation there is an `exec` like any
 * other, which is why codex's `attributes` is slash-only.
 */
export const codexExtractor: Extractor = (messages, ctx) => {
  const out: Invocation[] = [...defaultExtractor(messages, ctx)];
  messages.forEach((msg, i) => {
    const rec = (msg.raw ?? {}) as CodexRecord;
    if (rec.type !== "response_item") return;
    const payload = rec.payload;
    if (!payload || payload.type !== "message" || payload.role !== "user") return;
    const command = firstCommandName(codexText(payload.content));
    if (command === null) return;
    out.push({
      sourcePath: ctx.sourcePath,
      msgIndex: ctx.baseMsgIndex + i,
      callIndex: SLASH_CALL_INDEX,
      sourceKind: "slash_command",
      adapter: ctx.adapter,
      agent: ctx.agent,
      sessionId: ctx.sessionId,
      timestamp: msg.timestamp ?? str(rec.timestamp) ?? new Date(0).toISOString(),
      tool: command,
      skill: command,
      cwd: ctx.cwd,
      status: null,
      sidechain: false,
      attributionAgent: null,
      nativeCallId: null,
    });
  });
  return out;
};

interface CodexRecord {
  type?: unknown;
  timestamp?: unknown;
  payload?: { type?: unknown; role?: unknown; content?: unknown };
}

function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { text: string } =>
      !!b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** First tag only, so a turn echoing the command many times still yields one invocation. */
function firstCommandName(text: string): string | null {
  const m = COMMAND_NAME_RE.exec(text);
  return m && m[1] !== undefined ? m[1] : null;
}

/** Tool calls only. The documented default for adapters with no extractor. */
export const defaultExtractor: Extractor = (messages, ctx) => {
  const out: Invocation[] = [];
  messages.forEach((msg, i) => {
    const msgIndex = ctx.baseMsgIndex + i;
    (msg.toolCalls ?? []).forEach((call, callIndex) => {
      out.push({
        sourcePath: ctx.sourcePath,
        msgIndex,
        callIndex,
        sourceKind: "tool_call",
        adapter: ctx.adapter,
        agent: ctx.agent,
        sessionId: ctx.sessionId,
        timestamp: msg.timestamp ?? new Date(0).toISOString(),
        tool: call.name,
        skill: whitelistedArgument(call.name, call.input),
        cwd: ctx.cwd,
        status: call.status ?? null,
        sidechain: false,
        attributionAgent: null,
        nativeCallId: null,
      });
    });
  });
  return out;
};

const EXTRACTORS = new Map<string, Extractor>([
  ["claude-code", claudeCodeExtractor],
  ["codex", codexExtractor],
]);

export function extractorFor(adapter: string): Extractor {
  return EXTRACTORS.get(adapter) ?? defaultExtractor;
}

export function registerExtractor(adapter: string, extractor: Extractor): void {
  EXTRACTORS.set(adapter, extractor);
}
