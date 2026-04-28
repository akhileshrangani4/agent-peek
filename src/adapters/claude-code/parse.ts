// src/adapters/claude-code/parse.ts
import type { RawMessage, ToolCall } from "../../core/types.js";

/**
 * Claude Code transcript format (verified 2026-04-28 against ~/.claude/projects/*\/*.jsonl):
 *   One JSON object per line.
 *   Top-level type is "user" | "assistant" (other meta types may appear; we treat them
 *   as "system" for normalization).
 *   Tool calls live inside an ASSISTANT record's `message.content[]` as
 *     { type: "tool_use", id, name, input }.
 *   Tool RESULTS appear as a top-level `type: "user"` record whose `message.content`
 *   is an array containing `{ type: "tool_result", tool_use_id, content }` blocks.
 *   The normalized role is detected by content shape, not by the top-level `type`.
 */

export interface RawClaudeRecord {
  type: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    tool_use_id?: string;
    [k: string]: unknown;
  };
  toolUseResult?: unknown;
  [k: string]: unknown;
}

export function parseRecord(rec: RawClaudeRecord): RawMessage {
  const content = rec.message?.content;
  const hasToolResultBlock = Array.isArray(content)
    && content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result");

  let role: RawMessage["role"];
  if (hasToolResultBlock) role = "tool";
  else if (rec.message?.role === "assistant" || rec.type === "assistant") role = "assistant";
  else if (rec.message?.role === "user" || rec.type === "user") role = "user";
  else role = "system";

  const text = extractText(content);
  const toolCalls = extractToolCalls(content);
  return {
    role,
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: rec,
    timestamp: rec.timestamp,
  };
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && (b as { type?: unknown }).type === "text"
          && typeof (b as { text?: unknown }).text === "string") {
        parts.push((b as { text: string }).text);
      }
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function extractToolCalls(content: unknown): ToolCall[] {
  const out: ToolCall[] = [];
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const obj = b as { type?: unknown; name?: unknown; input?: unknown; content?: unknown };
    if (obj.type === "tool_use") {
      out.push({
        name: typeof obj.name === "string" ? obj.name : "?",
        input: obj.input,
        status: "pending",
      });
    } else if (obj.type === "tool_result") {
      out.push({
        name: "(result)",
        output: obj.content,
        status: "completed",
      });
    }
  }
  return out;
}

/**
 * Parse a JSONL byte buffer starting at byteOffset, returning parsed records
 * and the byte offset of the last complete line + newline.
 * Lines that fail JSON.parse are skipped (counted in `skipped`).
 * Trailing partial line (no \n) is NOT consumed: nextOffset stops at last \n.
 */
export function parseJsonlSlice(buf: Buffer, fromOffset: number): {
  records: RawClaudeRecord[];
  nextOffset: number;
  skipped: number;
} {
  const records: RawClaudeRecord[] = [];
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
