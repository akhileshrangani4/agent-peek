// src/adapters/opencode/index.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { Cursor, RawMessage, SessionEntry, ToolCall } from "../../core/types.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import { extractText, statusFromMtime, toolCallFromPart } from "../common.js";
import { sqliteJson } from "../sqlite.js";

const ADAPTER_NAME = "opencode";

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string | null;
  directory: string;
  time_created: number;
  time_updated: number;
  last_sequence: number | null;
  idle_seq: number | null;
  idle_data: string | null;
}

interface MessageRow {
  id: string;
  type: string;
  seq: number;
  time_created: number;
  data: string;
}

const adapter: Adapter = {
  name: ADAPTER_NAME,

  observes: ["tool_call"],

  async scan(): Promise<SessionEntry[]> {
    const dbPath = opencodeDatabasePath();
    if (!existsSync(dbPath)) return [];
    const rows = await sqliteJson<SessionRow>(dbPath, `
      SELECT
        s.id,
        s.parent_id,
        s.title,
        s.directory,
        s.time_created,
        s.time_updated,
        (SELECT seq FROM session_message WHERE session_id = s.id ORDER BY seq DESC LIMIT 1) AS last_sequence,
        (SELECT seq FROM session_message WHERE session_id = s.id AND type = 'idle' ORDER BY seq DESC LIMIT 1) AS idle_seq,
        (SELECT data FROM session_message WHERE session_id = s.id AND type = 'idle' ORDER BY seq DESC LIMIT 1) AS idle_data
      FROM session_v2 s
      ORDER BY s.time_updated DESC
    `);
    if (!rows) return [];

    return rows.map((row) => {
      const idle = parseJson(row.idle_data);
      const outcome = stringValue(idle?.outcome);
      return {
        id: `${ADAPTER_NAME}:${row.id}`,
        adapter: ADAPTER_NAME,
        transcriptPath: dbPath,
        name: row.title ? sanitizeName(row.title) : undefined,
        cwd: row.directory || undefined,
        parentSessionId: row.parent_id ? `${ADAPTER_NAME}:${row.parent_id}` : undefined,
        sourceType: "database",
        lastSeen: new Date(row.time_updated || row.time_created || Date.now()).toISOString(),
        status: statusFromMtime(row.time_updated || row.time_created || Date.now()),
        execution: {
          state: idle && row.last_sequence === row.idle_seq ? "idle" : "running",
          outcome: outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? outcome : undefined,
          at: idle ? timestampValue(idle.time?.created, row.time_updated) : undefined,
          sequence: row.last_sequence ?? undefined,
        },
      };
    });
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    const dbPath = entry.transcriptPath;
    const sessionId = entry.id.slice(ADAPTER_NAME.length + 1);
    const rows = await sqliteJson<MessageRow>(dbPath, `
      SELECT id, type, seq, time_created, data
      FROM session_message
      WHERE session_id = ${sqlString(sessionId)}
      ORDER BY seq ASC
    `);
    if (!rows) return { messages: [], nextCursor: cursor ?? emptyCursor(), eof: true };

    const messages = rows.map(messageFromRow);
    const priorIndex = cursor ? decodeCursor(cursor, ADAPTER_NAME).msgIndex : 0;
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: messages.length,
      msgIndex: messages.length,
    });
    return {
      messages: messages.slice(Math.min(priorIndex, messages.length)),
      nextCursor,
      eof: true,
    };
  },
};

function messageFromRow(row: MessageRow): RawMessage {
  const data = parseJson(row.data) ?? {};
  const content = Array.isArray(data.content) ? data.content : [];
  const text = row.type === "user"
    ? extractText(data.text)
    : content.map(extractPartText).filter((value): value is string => Boolean(value)).join("\n")
      || extractText(data.text)
      || systemText(row.type, data);
  const toolCalls = content
    .map((part) => isRecord(part) ? toolCallFromPart(part) : undefined)
    .filter((call): call is ToolCall => Boolean(call));

  return {
    role: row.type === "assistant" ? "assistant" : row.type === "user" ? "user" : "system",
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: { type: row.type, seq: row.seq, data },
    timestamp: timestampValue(data.time?.created ?? data.time?.completed, row.time_created),
  };
}

function systemText(type: string, data: Record<string, any>): string | undefined {
  if (type === "compaction") return extractText(data.error);
  if (type === "idle" && typeof data.outcome === "string") return data.outcome;
  return undefined;
}

function extractPartText(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type === "text" || part.type === "reasoning") return extractText(part.text);
  if (part.type === "subtask") return extractText(part.prompt);
  if (part.type === "tool") {
    const state = isRecord(part.state) ? part.state : {};
    return extractText(state.output ?? state.error);
  }
  return undefined;
}

function opencodeDatabasePath(): string {
  const data = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode")
    : join(process.env.HOME ?? homedir(), ".local", "share", "opencode");
  return join(data, "opencode.db");
}

function emptyCursor(): Cursor {
  return encodeCursor({ adapter: ADAPTER_NAME, byteOffset: 0, msgIndex: 0 });
}

function parseJson(value: unknown): Record<string, any> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timestampValue(value: unknown, fallback: number): string {
  return new Date(typeof value === "number" ? value : fallback).toISOString();
}

function sanitizeName(value: string): string | undefined {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export default adapter;
