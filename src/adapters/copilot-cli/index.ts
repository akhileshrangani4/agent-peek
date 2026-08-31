// src/adapters/copilot-cli/index.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { Cursor, RawMessage, SessionEntry } from "../../core/types.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import { extractText, newestMtime, normalizeRole, statusFromMtime, walkFiles } from "../common.js";

const ADAPTER_NAME = "copilot-cli";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  observes: [],

  async scan(): Promise<SessionEntry[]> {
    const root = copilotStateRoot();
    if (!existsSync(root)) return [];
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
    const out: SessionEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const files = await walkFiles(dir);
      const st = await stat(dir).catch(() => undefined);
      const mtime = await newestMtime(files, st?.mtimeMs ?? Date.now());
      out.push({
        id: `${ADAPTER_NAME}:${entry.name}`,
        adapter: ADAPTER_NAME,
        transcriptPath: dir,
        name: `copilot-${entry.name}`,
        cwd: await inferCwd(files),
        sourceType: "directory",
        lastSeen: new Date(mtime).toISOString(),
        status: statusFromMtime(mtime),
      });
    }
    return out;
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    let priorIndex = 0;
    if (cursor) priorIndex = decodeCursor(cursor, ADAPTER_NAME).msgIndex;
    const messages = await readSessionDir(entry.transcriptPath);
    const nextCursor = encodeCursor({ adapter: ADAPTER_NAME, byteOffset: messages.length, msgIndex: messages.length });
    return { messages: messages.slice(Math.min(priorIndex, messages.length)), nextCursor, eof: true };
  },
};

async function readSessionDir(dir: string): Promise<RawMessage[]> {
  const files = (await walkFiles(dir))
    .filter((path) => /\.(jsonl?|md)$/i.test(path))
    .sort((a, b) => filePriority(a) - filePriority(b) || a.localeCompare(b));
  const out: RawMessage[] = [];
  for (const path of files) {
    if (path.endsWith(".md")) {
      const text = await readFile(path, "utf8").catch(() => "");
      if (text.trim()) out.push({ role: "system", text, raw: { path } });
      continue;
    }
    const text = await readFile(path, "utf8").catch(() => "");
    if (!text.trim()) continue;
    if (path.endsWith(".jsonl")) {
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const parsed = parseJson(line);
        if (parsed) out.push(...messagesFromUnknown(parsed));
      }
    } else {
      const parsed = parseJson(text);
      if (parsed) out.push(...messagesFromUnknown(parsed));
    }
  }
  return out;
}

function filePriority(path: string): number {
  if (path.endsWith(".json")) return 0;
  if (path.endsWith(".jsonl")) return 1;
  return 2;
}

function messagesFromUnknown(value: unknown): RawMessage[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(messagesFromUnknown);
  const obj = value as Record<string, unknown>;
  const nested = obj.messages ?? obj.turns ?? obj.entries ?? obj.events;
  if (Array.isArray(nested)) return nested.flatMap(messagesFromUnknown);
  const role = normalizeRole(obj.role ?? obj.type ?? obj.author);
  const text = extractText(obj.content ?? obj.message ?? obj.text ?? obj.response ?? obj.prompt);
  if (!text && role === "system") return [];
  return [{
    role,
    text,
    raw: obj,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp
      : typeof obj.createdAt === "string" ? obj.createdAt
      : undefined,
  }];
}

async function inferCwd(files: string[]): Promise<string | undefined> {
  for (const path of files.filter((file) => file.endsWith(".json") || file.endsWith(".jsonl")).sort()) {
    const text = await readFile(path, "utf8").catch(() => "");
    const first = path.endsWith(".jsonl") ? text.split(/\r?\n/, 1)[0] : text;
    const value = parseJson(first);
    const cwd = findStringKey(value, ["cwd", "workingDirectory", "working_dir", "directory"]);
    if (cwd) return cwd;
  }
  return undefined;
}

function findStringKey(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringKey(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const key of keys) if (typeof obj[key] === "string") return obj[key] as string;
  for (const child of Object.values(obj)) {
    const found = findStringKey(child, keys);
    if (found) return found;
  }
  return undefined;
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function copilotStateRoot(): string {
  return join(process.env.HOME ?? homedir(), ".copilot", "session-state");
}

export default adapter;
