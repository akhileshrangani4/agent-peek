// src/adapters/claude-code/index.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { SessionEntry, RawMessage, Cursor } from "../../core/types.js";
import { encodeCursor, decodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { parseJsonlSlice, parseRecord } from "./parse.js";

const ADAPTER_NAME = "claude-code";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    const root = join(process.env.HOME ?? homedir(), ".claude", "projects");
    if (!existsSync(root)) return [];
    const out: SessionEntry[] = [];
    let projects: string[];
    try {
      projects = await readdir(root);
    } catch {
      return [];
    }
    for (const p of projects) {
      const projDir = join(root, p);
      let files: string[];
      try {
        files = await readdir(projDir);
      } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fpath = join(projDir, f);
        let st;
        try { st = await stat(fpath); } catch { continue; }
        let sessionId = f.replace(/\.jsonl$/, "");
        let cwd: string | undefined;
        try {
          const head = await readFirstLine(fpath);
          if (head) {
            try {
              const rec = JSON.parse(head);
              if (typeof rec?.sessionId === "string") sessionId = rec.sessionId;
              if (typeof rec?.cwd === "string") cwd = rec.cwd;
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        const ageMs = Date.now() - st.mtimeMs;
        const status = ageMs < 5 * 60 * 1000 ? "active"
                     : ageMs < 24 * 3600 * 1000 ? "idle"
                     : "ended";
        out.push({
          id: `${ADAPTER_NAME}:${sessionId}`,
          adapter: ADAPTER_NAME,
          transcriptPath: fpath,
          cwd,
          lastSeen: new Date(st.mtimeMs).toISOString(),
          status,
        });
      }
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
    let from = 0;
    let priorIndex = 0;
    if (cursor) {
      const c = decodeCursor(cursor, ADAPTER_NAME);
      from = Math.min(c.byteOffset, buf.length);
      priorIndex = c.msgIndex;
    }
    const { records, nextOffset } = parseJsonlSlice(buf, from);
    const messages: RawMessage[] = records.map(parseRecord);
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: nextOffset,
      msgIndex: priorIndex + messages.length,
    });
    return { messages, nextCursor, eof: nextOffset === buf.length };
  },
};

async function readFirstLine(path: string): Promise<string | null> {
  const buf = await readFile(path);
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return buf.length ? buf.toString("utf8") : null;
  return buf.subarray(0, nl).toString("utf8");
}

export default adapter;
