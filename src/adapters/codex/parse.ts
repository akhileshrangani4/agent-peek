// src/adapters/codex/parse.ts
import type { RawMessage, ToolCall } from "../../core/types.js";

/**
 * Codex CLI transcript format (verified 2026-04-28 against ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl,
 * codex-cli 0.125.0, rollouts emitted by codex-cli 0.107.0):
 *   One JSON object per line. Top-level shape:
 *     { timestamp: string, type: "session_meta" | "response_item" | "event_msg" | "turn_context",
 *       payload: object }
 *   The first record is always `type: "session_meta"` carrying { id, cwd, ... }.
 *   Conversation records are `type: "response_item"` with payload variants:
 *     - { type: "message", role: "user"|"assistant"|"developer",
 *         content: [{ type: "input_text"|"output_text", text: string }, ...] }
 *     - { type: "function_call", name, arguments (JSON string), call_id }
 *     - { type: "function_call_output", call_id, output (string) }
 *     - { type: "reasoning", summary, content, encrypted_content }
 *   Other top-level types ("event_msg", "turn_context") are non-conversational metadata
 *   and are normalized to role:"system" with raw passed through (and no text/toolCalls).
 *   `developer` role messages are normalized to "system" (Codex injects sandbox/permission
 *   instructions as developer messages).
 */

export interface RawCodexRecord {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: unknown;
    summary?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function parseRecord(rec: RawCodexRecord): RawMessage {
  const topType = rec.type;
  const p = rec.payload ?? {};
  const ts = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

  // Non-conversational top-level types: passthrough as system, no text.
  if (topType !== "response_item") {
    return { role: "system", raw: rec, timestamp: ts };
  }

  const innerType = p.type;

  if (innerType === "function_call") {
    const args = parseArgs(p.arguments);
    const tc: ToolCall = {
      name: typeof p.name === "string" ? p.name : "?",
      input: args,
      status: "pending",
    };
    return { role: "assistant", toolCalls: [tc], raw: rec, timestamp: ts };
  }

  if (innerType === "function_call_output") {
    const tc: ToolCall = {
      name: "(result)",
      output: p.output,
      status: "completed",
    };
    return { role: "tool", toolCalls: [tc], raw: rec, timestamp: ts };
  }

  if (innerType === "reasoning") {
    // Reasoning summaries are assistant-side internal thoughts.
    const text = extractReasoningText(p.summary);
    return { role: "assistant", text, raw: rec, timestamp: ts };
  }

  if (innerType === "message") {
    const rawRole = p.role;
    let role: RawMessage["role"];
    if (rawRole === "assistant") role = "assistant";
    else if (rawRole === "user") role = "user";
    else role = "system"; // developer / tool / unknown
    const text = extractMessageText(p.content);
    return { role, text, raw: rec, timestamp: ts };
  }

  // Unknown response_item subtype; keep raw, mark as system.
  return { role: "system", raw: rec, timestamp: ts };
}

function parseArgs(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const obj = b as { type?: unknown; text?: unknown };
    if ((obj.type === "input_text" || obj.type === "output_text") && typeof obj.text === "string") {
      parts.push(obj.text);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

function extractReasoningText(summary: unknown): string | undefined {
  if (!Array.isArray(summary)) return undefined;
  const parts: string[] = [];
  for (const b of summary) {
    if (!b || typeof b !== "object") continue;
    const obj = b as { type?: unknown; text?: unknown };
    if (obj.type === "summary_text" && typeof obj.text === "string") {
      parts.push(obj.text);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * Parse a JSONL byte buffer starting at byteOffset, returning parsed records
 * and the byte offset of the last complete line + newline. Mirrors the
 * claude-code adapter's slice semantics: trailing partial line (no \n) is NOT
 * consumed; nextOffset stops at last \n. Lines that fail JSON.parse are skipped.
 */
export function parseJsonlSlice(buf: Buffer, fromOffset: number): {
  records: RawCodexRecord[];
  nextOffset: number;
  skipped: number;
} {
  const records: RawCodexRecord[] = [];
  let i = fromOffset;
  let skipped = 0;
  let lastNewline = fromOffset;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl === -1) break;
    const line = buf.subarray(i, nl).toString("utf8").trim();
    if (line.length > 0) {
      try {
        records.push(JSON.parse(line));
      } catch {
        skipped++;
      }
    }
    i = nl + 1;
    lastNewline = i;
  }
  return { records, nextOffset: lastNewline, skipped };
}
