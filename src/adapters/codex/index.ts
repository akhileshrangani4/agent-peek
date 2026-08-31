// src/adapters/codex/index.ts
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { SessionEntry, RawMessage, Cursor } from "../../core/types.js";
import { encodeCursor, decodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { readFileWindow, statusFromMtime } from "../common.js";
import { parseJsonlSlice, parseRecord } from "./parse.js";

const ADAPTER_NAME = "codex";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  observes: ["tool_call"],

  async scan(): Promise<SessionEntry[]> {
    // Codex CLI rollouts: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
    const root = join(process.env.HOME ?? homedir(), ".codex", "sessions");
    const out: SessionEntry[] = [];
    const files = await collectRolloutFiles(root);
    for (const fpath of files) {
      let st;
      try { st = await stat(fpath); } catch { continue; }
      let sessionId = deriveIdFromPath(fpath);
      let cwd: string | undefined;
      try {
        const head = await readFirstLine(fpath);
        if (head) {
          try {
            const rec = JSON.parse(head);
            const meta = rec?.payload;
            if (meta && typeof meta === "object") {
              if (typeof meta.id === "string") sessionId = meta.id;
              if (typeof meta.cwd === "string") cwd = meta.cwd;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      const status = statusFromMtime(st.mtimeMs);
      out.push({
        id: `${ADAPTER_NAME}:${sessionId}`,
        adapter: ADAPTER_NAME,
        transcriptPath: fpath,
        cwd,
        sourceType: "file",
        lastSeen: new Date(st.mtimeMs).toISOString(),
        status,
      });
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

async function collectRolloutFiles(root: string): Promise<string[]> {
  // Walks YYYY/MM/DD year/month/day layout. Cheap because Codex puts
  // bounded counts of files per leaf directory.
  const out: string[] = [];
  let years: string[];
  try { years = await readdir(root); } catch { return out; }
  for (const y of years) {
    const yDir = join(root, y);
    let months: string[];
    try { months = await readdir(yDir); } catch { continue; }
    for (const m of months) {
      const mDir = join(yDir, m);
      let days: string[];
      try { days = await readdir(mDir); } catch { continue; }
      for (const d of days) {
        const dDir = join(mDir, d);
        let files: string[];
        try { files = await readdir(dDir); } catch { continue; }
        for (const f of files) {
          if (f.endsWith(".jsonl")) out.push(join(dDir, f));
        }
      }
    }
  }
  return out;
}

function deriveIdFromPath(fpath: string): string {
  // rollout-<ISO>-<uuid>.jsonl  -> <uuid> if we can extract it; else basename
  const base = basename(fpath);
  const stripped = base.replace(/\.jsonl$/, "");
  // last 5 dash-separated tokens form the uuid
  const parts = stripped.split("-");
  if (parts.length >= 5) {
    const tail = parts.slice(-5).join("-");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail)) {
      return tail;
    }
  }
  return stripped;
}

async function readFirstLine(path: string): Promise<string | null> {
  // Rollouts can be tens of MB; scan() only needs the metadata header line.
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (!bytesRead) return null;
    const chunk = buf.subarray(0, bytesRead);
    const nl = chunk.indexOf(0x0a);
    if (nl === -1) return chunk.toString("utf8");
    return chunk.subarray(0, nl).toString("utf8");
  } finally {
    await fh.close();
  }
}

export default adapter;
