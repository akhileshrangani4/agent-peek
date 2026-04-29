// src/adapters/gemini/index.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { SessionEntry, RawMessage, Cursor } from "../../core/types.js";
import { encodeCursor, decodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { parseSession, type RawGeminiSession } from "./parse.js";

const ADAPTER_NAME = "gemini";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    // Gemini CLI stores sessions at ~/.gemini/tmp/<project>/chats/session-*.json.
    const root = join(process.env.HOME ?? homedir(), ".gemini", "tmp");
    if (!existsSync(root)) return [];
    const out: SessionEntry[] = [];
    const projectMap = await readProjectsMap(root);
    const files = await collectSessionFiles(root);
    for (const fpath of files) {
      let st;
      try { st = await stat(fpath); } catch { continue; }
      let sessionId = deriveIdFromPath(fpath);
      try {
        const raw = JSON.parse(await readFile(fpath, "utf8")) as RawGeminiSession;
        if (typeof raw.sessionId === "string" && raw.sessionId.trim()) sessionId = raw.sessionId;
      } catch { /* session may be mid-write; keep path-derived id */ }
      const projectDir = dirname(dirname(fpath));
      const ageMs = Date.now() - st.mtimeMs;
      const status = ageMs < 5 * 60 * 1000 ? "active"
                   : ageMs < 24 * 3600 * 1000 ? "idle"
                   : "ended";
      out.push({
        id: `${ADAPTER_NAME}:${sessionId}`,
        adapter: ADAPTER_NAME,
        transcriptPath: fpath,
        cwd: await resolveProjectRoot(projectDir, projectMap),
        sourceType: "file",
        lastSeen: new Date(st.mtimeMs).toISOString(),
        status,
      });
    }
    return out;
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    let buf: Buffer;
    try {
      buf = await readFile(entry.transcriptPath);
    } catch (e) {
      throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot read ${entry.transcriptPath}`, e);
    }

    let priorIndex = 0;
    if (cursor) {
      const c = decodeCursor(cursor, ADAPTER_NAME);
      priorIndex = c.byteOffset > buf.length ? 0 : c.msgIndex;
    }

    let raw: RawGeminiSession;
    try {
      raw = JSON.parse(buf.toString("utf8")) as RawGeminiSession;
    } catch (e) {
      if (cursor) {
        return { messages: [], nextCursor: cursor, eof: false };
      }
      throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot parse ${entry.transcriptPath}`, e);
    }

    const all: RawMessage[] = parseSession(raw);
    const messages = all.slice(Math.min(priorIndex, all.length));
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: buf.length,
      msgIndex: all.length,
    });
    return { messages, nextCursor, eof: true };
  },
};

async function collectSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const candidates = [root];
  let entries: string[];
  try { entries = await readdir(root); } catch { return out; }
  for (const entry of entries) candidates.push(join(root, entry));
  for (const dir of candidates) {
    const chatsDir = join(dir, "chats");
    let files: string[];
    try { files = await readdir(chatsDir); } catch { continue; }
    for (const file of files) {
      if (file.startsWith("session-") && file.endsWith(".json")) out.push(join(chatsDir, file));
    }
  }
  return out;
}

async function readProjectsMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = JSON.parse(await readFile(join(dirname(root), "projects.json"), "utf8"));
    const projects = raw?.projects;
    if (!projects || typeof projects !== "object") return map;
    for (const [cwd, dirName] of Object.entries(projects)) {
      if (typeof cwd === "string" && typeof dirName === "string") map.set(dirName, cwd);
    }
  } catch { /* optional Gemini metadata */ }
  return map;
}

async function resolveProjectRoot(projectDir: string, projectsMap: Map<string, string>): Promise<string | undefined> {
  try {
    const root = (await readFile(join(projectDir, ".project_root"), "utf8")).trim();
    if (root) return root;
  } catch { /* optional Gemini metadata */ }
  return projectsMap.get(basename(projectDir));
}

function deriveIdFromPath(fpath: string): string {
  const base = basename(fpath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export default adapter;
