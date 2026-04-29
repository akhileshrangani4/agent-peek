// src/adapters/goose/index.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { Cursor, RawMessage, SessionEntry } from "../../core/types.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { extractText, normalizeRole, statusFromMtime } from "../common.js";
import { sqliteJson } from "../sqlite.js";

const ADAPTER_NAME = "goose";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    const out: SessionEntry[] = [];
    const db = gooseDbPath();
    if (existsSync(db)) {
      const rows = await sqliteJson<GooseSessionRow>(db,
        "SELECT id, name, description, working_dir, COALESCE(updated_at, created_at) AS updated_at FROM sessions ORDER BY updated_at DESC");
      if (rows) {
        for (const row of rows) {
          if (!row.id) continue;
          const lastSeen = parseTime(row.updated_at);
          out.push({
            id: `${ADAPTER_NAME}:${row.id}`,
            adapter: ADAPTER_NAME,
            transcriptPath: db,
            name: sanitizeName(row.name || row.description),
            cwd: typeof row.working_dir === "string" ? row.working_dir : undefined,
            sourceType: "database",
            lastSeen: new Date(lastSeen).toISOString(),
            status: statusFromMtime(lastSeen),
          });
        }
      }
    }
    out.push(...await scanLegacyJsonl());
    return dedupe(out);
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    let priorIndex = 0;
    if (cursor) priorIndex = decodeCursor(cursor, ADAPTER_NAME).msgIndex;
    const messages = entry.transcriptPath.endsWith(".jsonl")
      ? await readLegacyJsonl(entry.transcriptPath)
      : await readDb(entry.transcriptPath, entry.id.slice(ADAPTER_NAME.length + 1));
    return sliceMessages(messages, priorIndex);
  },
};

interface GooseSessionRow {
  id?: string;
  name?: string;
  description?: string;
  working_dir?: string;
  updated_at?: string | number;
}

interface GooseMessageRow {
  role?: string;
  content_json?: string;
  timestamp?: string | number;
  created_timestamp?: number;
}

async function readDb(db: string, sessionId: string): Promise<RawMessage[]> {
  const escaped = sessionId.replaceAll("'", "''");
  const rows = await sqliteJson<GooseMessageRow>(db,
    `SELECT role, content_json, timestamp, created_timestamp FROM messages WHERE session_id = '${escaped}' ORDER BY created_timestamp, id`);
  if (!rows) throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot query ${db}; sqlite3 is required`);
  return rows.map((row) => {
    const content = parseJson(row.content_json);
    return {
      role: normalizeRole(row.role),
      text: extractText(content),
      raw: row,
      timestamp: timestampString(row.timestamp, row.created_timestamp),
    };
  });
}

async function scanLegacyJsonl(): Promise<SessionEntry[]> {
  const dir = gooseSessionsDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }
  const out: SessionEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    let st;
    try { st = await stat(path); } catch { continue; }
    const id = basename(file, ".jsonl");
    let cwd: string | undefined;
    try {
      const first = (await readFile(path, "utf8")).split(/\r?\n/, 1)[0];
      const meta = parseJson(first);
      if (meta && typeof meta === "object" && typeof (meta as { working_dir?: unknown }).working_dir === "string") {
        cwd = (meta as { working_dir: string }).working_dir;
      }
    } catch { /* ignore */ }
    out.push({
      id: `${ADAPTER_NAME}:${id}`,
      adapter: ADAPTER_NAME,
      transcriptPath: path,
      name: sanitizeName(id),
      cwd,
      sourceType: "file",
      lastSeen: new Date(st.mtimeMs).toISOString(),
      status: statusFromMtime(st.mtimeMs),
    });
  }
  return out;
}

async function readLegacyJsonl(path: string): Promise<RawMessage[]> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (e) {
    throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot read ${path}`, e);
  }
  return text.split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => parseJson(line))
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    .map((msg) => ({
      role: normalizeRole(msg.role),
      text: extractText(msg.content),
      raw: msg,
      timestamp: timestampString(msg.created),
    }));
}

function sliceMessages(messages: RawMessage[], priorIndex: number): AdapterReadResult {
  const nextCursor = encodeCursor({ adapter: ADAPTER_NAME, byteOffset: messages.length, msgIndex: messages.length });
  return { messages: messages.slice(Math.min(priorIndex, messages.length)), nextCursor, eof: true };
}

function gooseDbPath(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "Block", "goose", "data", "sessions", "sessions.db");
  }
  return join(process.env.HOME ?? homedir(), ".local", "share", "goose", "sessions", "sessions.db");
}

function gooseSessionsDir(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "Block", "goose", "data", "sessions");
  }
  return join(process.env.HOME ?? homedir(), ".local", "share", "goose", "sessions");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function parseTime(value: unknown): number {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const n = Date.parse(value);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function timestampString(value: unknown, fallback?: unknown): string | undefined {
  const t = parseTime(value ?? fallback);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function dedupe(entries: SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function sanitizeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

export default adapter;
