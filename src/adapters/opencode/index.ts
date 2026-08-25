// src/adapters/opencode/index.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { Cursor, RawMessage, SessionEntry, ToolCall } from "../../core/types.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import { extractText, statusFromMtime, toolCallFromPart, walkFiles } from "../common.js";

const ADAPTER_NAME = "opencode";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    const sessionRoot = join(opencodeStorageRoot(), "session");
    if (!existsSync(sessionRoot)) return [];
    const files = (await walkFiles(sessionRoot)).filter((path) => path.endsWith(".json"));
    const out: SessionEntry[] = [];
    for (const path of files) {
      let session: Record<string, unknown>;
      try { session = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
      const id = typeof session.id === "string" ? session.id : basename(path, ".json");
      const updated = timeFromSession(session);
      out.push({
        id: `${ADAPTER_NAME}:${id}`,
        adapter: ADAPTER_NAME,
        transcriptPath: path,
        name: typeof session.title === "string" ? sanitizeName(session.title) : undefined,
        cwd: typeof session.directory === "string" ? session.directory : undefined,
        sourceType: "directory",
        lastSeen: new Date(updated).toISOString(),
        status: statusFromMtime(updated),
      });
    }
    return out;
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    let priorIndex = 0;
    if (cursor) priorIndex = decodeCursor(cursor, ADAPTER_NAME).msgIndex;
    const sessionId = entry.id.slice(ADAPTER_NAME.length + 1);
    const messages = await readMessages(sessionId, dirname(dirname(entry.transcriptPath)));
    const nextCursor = encodeCursor({ adapter: ADAPTER_NAME, byteOffset: messages.length, msgIndex: messages.length });
    return { messages: messages.slice(Math.min(priorIndex, messages.length)), nextCursor, eof: true };
  },
};

async function readMessages(sessionId: string, sessionRoot: string): Promise<RawMessage[]> {
  const storageRoot = dirname(sessionRoot);
  const messageRoot = join(storageRoot, "message", sessionId);
  const partRoot = join(storageRoot, "part");
  if (!existsSync(messageRoot)) return [];
  const messageFiles = (await walkFiles(messageRoot)).filter((path) => path.endsWith(".json"));
  const items: { time: number; message: RawMessage }[] = [];
  for (const path of messageFiles) {
    let info: Record<string, unknown>;
    try { info = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    const messageId = typeof info.id === "string" ? info.id : basename(path, ".json");
    const parts = await readParts(join(partRoot, messageId));
    const text = parts.map((part) => extractPartText(part)).filter((v): v is string => Boolean(v)).join("\n") || undefined;
    const toolCalls = parts.map((part) => toolCallFromPart(part)).filter((v): v is ToolCall => Boolean(v));
    const time = readNestedNumber(info, ["time", "created"]) ?? 0;
    items.push({
      time,
      message: {
        role: info.role === "assistant" ? "assistant" : info.role === "user" ? "user" : "system",
        text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        raw: { info, parts },
        timestamp: time ? new Date(time).toISOString() : undefined,
      },
    });
  }
  return items.sort((a, b) => a.time - b.time).map((item) => item.message);
}

async function readParts(dir: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(dir)) return [];
  const files = (await walkFiles(dir)).filter((path) => path.endsWith(".json"));
  const out: Record<string, unknown>[] = [];
  for (const path of files.sort()) {
    try {
      const part = JSON.parse(await readFile(path, "utf8"));
      if (part && typeof part === "object") out.push(part);
    } catch { /* ignore */ }
  }
  return out;
}

function extractPartText(part: Record<string, unknown>): string | undefined {
  if (part.type === "text" || part.type === "reasoning") return extractText(part.text);
  if (part.type === "subtask") return extractText(part.prompt);
  if (part.type === "tool") {
    const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
    return extractText(state.output ?? state.error);
  }
  return undefined;
}

function opencodeStorageRoot(): string {
  const data = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode")
    : join(process.env.HOME ?? homedir(), ".local", "share", "opencode");
  return join(data, "storage");
}

function timeFromSession(session: Record<string, unknown>): number {
  return readNestedNumber(session, ["time", "updated"])
      ?? readNestedNumber(session, ["time", "created"])
      ?? Date.now();
}

function sanitizeName(value: string): string | undefined {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

function readNestedNumber(obj: Record<string, unknown>, path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" ? cur : undefined;
}

export default adapter;
