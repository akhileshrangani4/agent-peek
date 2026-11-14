// src/adapters/opencode/index.ts
//
// OpenCode keeps sessions in one of two stores, depending on the version that wrote them:
//   - V2: one SQLite database, opencode.db (session_v2, session_message);
//   - pre-V2: filesystem storage under storage/{session,message,part}, read by
//     ../opencode-legacy-v1 exactly as 0.6.0 read it.
// Both are listed under one adapter and one id namespace, `opencode:<id>`, so a selector
// or cursor saved against 0.6.0 keeps working. A session id present in both stores is
// listed once, from V2, which is where OpenCode writes after migrating. Which V2 file
// to read follows OpenCode's own resolution: see opencodeDatabases().
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { Cursor, RawMessage, SessionEntry, SessionExecution, SessionOutcome, ToolCall } from "../../core/types.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { extractText, homeDir, statusFromMtime, toolCallFromPart } from "../common.js";
import { queryReadOnly } from "../sqlite.js";
import { readLegacyStorage, scanLegacyStorage } from "../opencode-legacy-v1/index.js";

const ADAPTER_NAME = "opencode";
const DB_FILE = "opencode.db";

// node:sqlite returns SQL NULL as `null`, so every optional column admits it.
interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
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

type JsonRecord = Record<string, unknown>;

/**
 * Every V2 session with its latest message sequence and its latest `idle` message, which
 * carries the turn's outcome. The message type is bound like any other value: no query
 * in this adapter is assembled from strings.
 */
const SESSIONS_SQL = `
  SELECT
    s.id,
    s.parent_id,
    s.title,
    s.directory,
    s.time_created,
    s.time_updated,
    (SELECT seq FROM session_message WHERE session_id = s.id ORDER BY seq DESC LIMIT 1) AS last_sequence,
    (SELECT seq FROM session_message WHERE session_id = s.id AND type = ? ORDER BY seq DESC LIMIT 1) AS idle_seq,
    (SELECT data FROM session_message WHERE session_id = s.id AND type = ? ORDER BY seq DESC LIMIT 1) AS idle_data
  FROM session_v2 s
  ORDER BY s.time_updated DESC
`;

const MESSAGES_SQL = `
  SELECT id, type, seq, time_created, data
  FROM session_message
  WHERE session_id = ?
  ORDER BY seq ASC
`;

const OUTCOMES: readonly SessionOutcome[] = ["succeeded", "failed", "interrupted"];

const adapter: Adapter = {
  name: ADAPTER_NAME,

  observes: ["tool_call"],

  async scan(): Promise<SessionEntry[]> {
    const v2 = opencodeDatabases().existing.flatMap(scanDatabase);
    return mergeStores(v2, await scanLegacyStorage());
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    return isDatabaseEntry(entry) ? readDatabase(entry, cursor) : readLegacyStorage(entry, cursor);
  },
};

/**
 * One entry per session id. V2 wins over legacy storage for the same id: OpenCode
 * migrates sessions into opencode.db and keeps writing there, so the legacy copy is stale.
 */
export function mergeStores(v2: SessionEntry[], legacy: SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>();
  const out: SessionEntry[] = [];
  // V2 first, so the first copy kept is V2's (and the primary database's, among V2 files).
  for (const entry of [...v2, ...legacy]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function isDatabaseEntry(entry: SessionEntry): boolean {
  return entry.sourceType === "database" || entry.transcriptPath.endsWith(".db");
}

/**
 * V2 sessions, or none when the database can't be read. Scan must not fail the whole
 * adapter over one unreadable file (legacy sessions are still listable), so the cause
 * is surfaced as a warning rather than thrown.
 */
function scanDatabase(dbPath: string): SessionEntry[] {
  let rows: SessionRow[];
  try {
    rows = queryReadOnly<SessionRow>(dbPath, SESSIONS_SQL, ["idle", "idle"]);
  } catch (e) {
    console.warn(`[agent-peek] cannot read OpenCode sessions from ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  return rows.map((row) => sessionFromRow(row, dbPath));
}

function sessionFromRow(row: SessionRow, dbPath: string): SessionEntry {
  const updated = row.time_updated || row.time_created || Date.now();
  return {
    id: `${ADAPTER_NAME}:${row.id}`,
    adapter: ADAPTER_NAME,
    transcriptPath: dbPath,
    name: row.title ? sanitizeName(row.title) : undefined,
    cwd: row.directory || undefined,
    parentSessionId: row.parent_id ? `${ADAPTER_NAME}:${row.parent_id}` : undefined,
    sourceType: "database",
    lastSeen: new Date(updated).toISOString(),
    status: statusFromMtime(updated),
    execution: executionFromRow(row, updated),
  };
}

/**
 * The session is idle when its newest message is an `idle` marker; anything after the
 * marker means a new turn is running. `outcome` is the latest idle marker's outcome, so
 * while running it describes the previous turn: `sequence` against `at` tells them apart.
 */
export function executionFromRow(row: SessionRow, updated: number): SessionExecution {
  const idle = parseJson(row.idle_data);
  const outcome = idle?.outcome;
  return {
    state: idle && row.last_sequence === row.idle_seq ? "idle" : "running",
    outcome: OUTCOMES.find((value) => value === outcome),
    at: idle ? timestampValue(nested(idle, "time", "created"), updated) : undefined,
    sequence: row.last_sequence ?? undefined,
  };
}

async function readDatabase(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
  const priorIndex = cursor ? decodeCursor(cursor, ADAPTER_NAME).msgIndex : 0;
  const sessionId = entry.id.slice(ADAPTER_NAME.length + 1);
  let rows: MessageRow[];
  try {
    rows = queryReadOnly<MessageRow>(entry.transcriptPath, MESSAGES_SQL, [sessionId]);
  } catch (e) {
    throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot query ${entry.transcriptPath}`, e);
  }
  const messages = rows.map(messageFromRow);
  return {
    messages: messages.slice(Math.min(priorIndex, messages.length)),
    nextCursor: encodeCursor({ adapter: ADAPTER_NAME, byteOffset: messages.length, msgIndex: messages.length }),
    eof: true,
  };
}

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
    timestamp: timestampValue(nested(data, "time", "created") ?? nested(data, "time", "completed"), row.time_created),
  };
}

function systemText(type: string, data: JsonRecord): string | undefined {
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

/** OpenCode's data dir: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return xdg ? join(xdg, "opencode") : join(homeDir(), ".local", "share", "opencode");
}

/** A channel build's database: `opencode-<channel>.db`, with the channel already sanitised. */
const CHANNEL_DB = /^opencode-[A-Za-z0-9._-]+\.db$/;

export interface OpencodeDatabases {
  /** The database OpenCode opens by default: `OPENCODE_DB` when set, else opencode.db. */
  primary: string | undefined;
  /** Every database to list sessions from, primary first. Only existing files. */
  existing: string[];
}

/**
 * Resolve opencode.db the way OpenCode v2.3.0 does (packages/cli/src/database-path.ts):
 *   1. `OPENCODE_DB`, resolved against the data dir (so an absolute path wins). A blank
 *      value counts as unset, as CLAUDE_CONFIG_DIR and CODEX_HOME do here; `:memory:`
 *      has no file to read.
 *   2. Otherwise opencode.db, or opencode-<channel>.db for a non-release channel.
 * The channel is baked into the OpenCode binary at build time, so peek cannot ask which
 * one is installed: it reads opencode.db plus any opencode-<channel>.db beside it,
 * unless OPENCODE_DISABLE_CHANNEL_DB pins OpenCode to opencode.db.
 */
export function opencodeDatabases(): OpencodeDatabases {
  const data = opencodeDataDir();
  const override = process.env.OPENCODE_DB?.trim();
  if (override) {
    const primary = override === ":memory:" ? undefined : resolve(data, override);
    return { primary, existing: primary && existsSync(primary) ? [primary] : [] };
  }
  const primary = join(data, DB_FILE);
  const disableChannels = process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "true";
  const channels = disableChannels ? [] : channelDatabases(data);
  return { primary, existing: [primary, ...channels].filter((path) => existsSync(path)) };
}

function channelDatabases(data: string): string[] {
  let names: string[];
  try {
    names = readdirSync(data);
  } catch (e) {
    // No data dir means no OpenCode install; anything else is worth a warning.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[agent-peek] cannot list OpenCode databases in ${data}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return [];
  }
  return names.filter((name) => CHANNEL_DB.test(name)).sort().map((name) => join(data, name));
}

function parseJson(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nested(obj: JsonRecord, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function timestampValue(value: unknown, fallback: number): string {
  return new Date(typeof value === "number" ? value : fallback).toISOString();
}

function sanitizeName(value: string): string | undefined {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

export default adapter;
