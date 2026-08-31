// src/adapters/claude-code/index.ts
import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
        const entry = await entryFor(join(projDir, f), p, { sessionIdFallback: f.replace(/\.jsonl$/, "") });
        if (entry) out.push(entry);
      }
      out.push(...await scanSubagents(projDir, p));
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

/**
 * Subagent transcripts sit in a sidecar directory beside their parent's transcript:
 *
 *     <project>/<session-uuid>.jsonl              the parent, a direct child
 *     <project>/<session-uuid>/subagents/agent-<agentId>.jsonl
 *
 * Discovery targets that exact pattern rather than walking recursively. A recursive
 * walk would need a denylist, and a denylist that falls behind Claude Code does not
 * error — it feeds a non-transcript to the transcript parser. Two other things nest
 * under a project directory today and neither is a session: `vercel-plugin/`
 * (hook telemetry, 120 files on the machine this was written against) and `memory/`.
 */
async function scanSubagents(projDir: string, projectDirName: string): Promise<SessionEntry[]> {
  const out: SessionEntry[] = [];
  let children: Dirent[];
  try {
    children = await readdir(projDir, { withFileTypes: true });
  } catch { return out; }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const subDir = join(projDir, child.name, "subagents");
    let files: string[];
    try {
      files = await readdir(subDir);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const entry = await entryFor(join(subDir, f), projectDirName, {
        // A subagent transcript's `sessionId` field holds its PARENT's id, so keying on
        // it would collide every subagent onto the session that spawned it.
        sessionIdFallback: f.replace(/\.jsonl$/, ""),
        preferAgentId: true,
        parentSessionId: child.name,
      });
      if (entry) out.push(entry);
    }
  }
  return out;
}

async function entryFor(
  fpath: string,
  projectDirName: string,
  opts: { sessionIdFallback: string; preferAgentId?: boolean; parentSessionId?: string },
): Promise<SessionEntry | undefined> {
  let st;
  try { st = await stat(fpath); } catch { return undefined; }
  let sessionId = opts.sessionIdFallback;
  let cwd: string | undefined;
  try {
    const metadata = await readSessionMetadata(fpath);
    if (opts.preferAgentId) {
      if (metadata.agentId) sessionId = metadata.agentId;
    } else if (metadata.sessionId) {
      sessionId = metadata.sessionId;
    }
    if (metadata.cwd) cwd = metadata.cwd;
  } catch { /* skip */ }
  const base = cwd ? basename(cwd) : projectNameFromDir(projectDirName);
  return {
    id: `${ADAPTER_NAME}:${sessionId}`,
    name: opts.parentSessionId ? `${base}-claude-sub` : `${base}-claude`,
    adapter: ADAPTER_NAME,
    transcriptPath: fpath,
    cwd,
    sourceType: "file",
    lastSeen: new Date(st.mtimeMs).toISOString(),
    status: statusFromMtime(st.mtimeMs),
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
  };
}

async function readSessionMetadata(path: string): Promise<{ sessionId?: string; cwd?: string; agentId?: string }> {
  const lines = await readHeadLines(path, 50);
  const metadata: { sessionId?: string; cwd?: string; agentId?: string } = {};

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
    if (!metadata.agentId && typeof (rec as { agentId?: unknown }).agentId === "string") {
      metadata.agentId = (rec as { agentId: string }).agentId;
    }
    if (metadata.sessionId && metadata.cwd && metadata.agentId) break;
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
