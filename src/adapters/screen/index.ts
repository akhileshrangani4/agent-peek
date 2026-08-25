// src/adapters/screen/index.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { Cursor, RawMessage, SessionEntry } from "../../core/types.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { terminalCursorTail, terminalDeltaFromLine } from "../common.js";

const execFileAsync = promisify(execFile);
const ADAPTER_NAME = "screen";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    let output: string;
    try {
      output = await screen(["-ls"]);
    } catch (e) {
      // GNU screen exits non-zero from `screen -ls` even when sessions exist
      // (exit 1 with a session list; exit 1 with "No Sockets found" when none).
      // Only bail when there is no usable listing at all.
      const stdout = (e as { stdout?: string })?.stdout;
      if (!stdout || !/\((Attached|Detached|Multi|Dead|Unknown)/i.test(stdout)) return [];
      output = stdout;
    }
    const now = new Date().toISOString();
    return output.split(/\r?\n/)
      .map(parseScreenLine)
      .filter((entry): entry is { name: string; attached: boolean } => entry !== undefined)
      .map(({ name, attached }) => ({
        id: `${ADAPTER_NAME}:${encodeURIComponent(name)}`,
        adapter: ADAPTER_NAME,
        transcriptPath: `screen://${encodeURIComponent(name)}`,
        name,
        sourceType: "terminal" as const,
        lastSeen: now,
        status: attached ? "active" : "idle",
      }));
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    const sessionName = sessionNameFromEntry(entry);
    let prior = { msgIndex: 0, byteOffset: -1, tail: undefined as string | undefined };
    if (cursor) {
      const c = decodeCursor(cursor, ADAPTER_NAME);
      prior = { msgIndex: c.msgIndex, byteOffset: c.byteOffset, tail: c.tail };
    }

    let output: string;
    try {
      output = await captureHardcopy(sessionName);
    } catch (e) {
      throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot capture screen session ${sessionName}`, e);
    }

    const lines = output.length ? output.replace(/\r\n/g, "\n").split("\n") : [];
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const fromLine = terminalDeltaFromLine(lines, prior);
    const delta = lines.slice(fromLine).join("\n");
    const messages: RawMessage[] = delta
      ? [{
          role: "system",
          text: delta,
          raw: { source: "screen", session: sessionName, fromLine, lineCount: lines.length - fromLine },
        }]
      : [];
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: Buffer.byteLength(output, "utf8"),
      msgIndex: lines.length,
      tail: terminalCursorTail(lines),
    });
    return { messages, nextCursor, eof: true };
  },
};

async function captureHardcopy(sessionName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peek-screen-"));
  const path = join(dir, "hardcopy.txt");
  try {
    await screen(["-S", sessionName, "-X", "hardcopy", "-h", path]);
    return await readFile(path, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function screen(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("screen", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function parseScreenLine(line: string): { name: string; attached: boolean } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^([^\s]+)\s+\((Attached|Detached|Multi|Dead|Unknown)[^)]*\)$/i);
  if (!match) return undefined;
  const name = match[1];
  if (!name) return undefined;
  return { name, attached: /\bAttached\b|\bMulti\b/i.test(match[2] ?? "") };
}

function sessionNameFromEntry(entry: SessionEntry): string {
  if (entry.transcriptPath.startsWith("screen://")) {
    return decodeURIComponent(entry.transcriptPath.slice("screen://".length));
  }
  if (entry.id.startsWith(`${ADAPTER_NAME}:`)) {
    return decodeURIComponent(entry.id.slice(ADAPTER_NAME.length + 1));
  }
  return entry.transcriptPath;
}

export default adapter;
