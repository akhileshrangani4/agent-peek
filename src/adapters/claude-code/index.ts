// src/adapters/claude-code/index.ts
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { SessionEntry, RawMessage, Cursor } from "../../core/types.js";
import { encodeCursor, decodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { readFileWindow, statusFromMtime } from "../common.js";
import { parseJsonlSlice, parseRecord } from "./parse.js";

const ADAPTER_NAME = "claude-code";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  observes: ["tool_call", "slash_command"],

  async scan(): Promise<SessionEntry[]> {
    const root = join(process.env.HOME ?? homedir(), ".claude", "projects");
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
          const metadata = await readSessionMetadata(fpath);
          if (metadata.sessionId) sessionId = metadata.sessionId;
          if (metadata.cwd) cwd = metadata.cwd;
        } catch { /* skip */ }
        const status = statusFromMtime(st.mtimeMs);
        const inferredName = cwd ? `${basename(cwd)}-claude` : `${projectNameFromDir(p)}-claude`;
        out.push({
          id: `${ADAPTER_NAME}:${sessionId}`,
          name: inferredName,
          adapter: ADAPTER_NAME,
          transcriptPath: fpath,
          cwd,
          sourceType: "file",
          lastSeen: new Date(st.mtimeMs).toISOString(),
          status,
        });
      }
    }
    return out;
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    let from = 0;
    let priorIndex = 0;
    if (cursor) {
      const c = decodeCursor(cursor, ADAPTER_NAME);
      from = c.byteOffset;
      priorIndex = c.msgIndex;
    }
    let win: { buf: Buffer; effFrom: number; size: number };
    try {
      win = await readFileWindow(entry.transcriptPath, from);
    } catch (e) {
      throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot read ${entry.transcriptPath}`, e);
    }
    const { records, nextOffset } = parseJsonlSlice(win.buf, 0);
    const messages: RawMessage[] = records.map(parseRecord);
    const absNextOffset = win.effFrom + nextOffset;
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: absNextOffset,
      msgIndex: priorIndex + messages.length,
    });
    return { messages, nextCursor, eof: absNextOffset >= win.size };
  },
};

async function readSessionMetadata(path: string): Promise<{ sessionId?: string; cwd?: string }> {
  const lines = await readHeadLines(path, 50);
  const metadata: { sessionId?: string; cwd?: string } = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (!metadata.sessionId && typeof (rec as { sessionId?: unknown }).sessionId === "string") {
      metadata.sessionId = (rec as { sessionId: string }).sessionId;
    }
    if (!metadata.cwd && typeof (rec as { cwd?: unknown }).cwd === "string") {
      metadata.cwd = (rec as { cwd: string }).cwd;
    }
    if (metadata.sessionId && metadata.cwd) break;
  }

  return metadata;
}

async function readHeadLines(path: string, maxLines: number): Promise<string[]> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (!bytesRead) return [];
    return buf.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, maxLines);
  } finally {
    await fh.close();
  }
}

function projectNameFromDir(dir: string): string {
  const parts = dir.split("-").filter(Boolean);
  return parts.at(-1) || dir || "session";
}

export default adapter;
