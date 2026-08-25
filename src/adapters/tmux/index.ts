// src/adapters/tmux/index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { SessionEntry, Cursor, RawMessage } from "../../core/types.js";
import { encodeCursor, decodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";

const execFileAsync = promisify(execFile);
const ADAPTER_NAME = "tmux";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    let output: string;
    try {
      output = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_activity}\t#{session_attached}"]);
    } catch {
      return [];
    }
    return output.split(/\r?\n/)
      .filter(Boolean)
      .map(parseSessionLine)
      .filter((entry): entry is SessionEntry => entry !== undefined);
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    const sessionName = sessionNameFromEntry(entry);
    let priorLine = 0;
    if (cursor) {
      const c = decodeCursor(cursor, ADAPTER_NAME);
      priorLine = c.msgIndex;
    }

    let output: string;
    try {
      output = await tmux(["capture-pane", "-p", "-t", sessionName, "-S", "-"]);
    } catch (e) {
      throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot capture tmux session ${sessionName}`, e);
    }

    const lines = output.length ? output.replace(/\r\n/g, "\n").split("\n") : [];
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const fromLine = priorLine > lines.length ? 0 : priorLine;
    const delta = lines.slice(fromLine).join("\n");
    const messages: RawMessage[] = delta
      ? [{
          role: "system",
          text: delta,
          raw: { source: "tmux", session: sessionName, fromLine, lineCount: lines.length - fromLine },
        }]
      : [];
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: Buffer.byteLength(output, "utf8"),
      msgIndex: lines.length,
    });
    return { messages, nextCursor, eof: true };
  },
};

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function parseSessionLine(line: string): SessionEntry | undefined {
  const [name, activityRaw, attachedRaw] = line.split("\t");
  if (!name) return undefined;
  const activitySeconds = Number(activityRaw);
  const lastSeenMs = Number.isFinite(activitySeconds) && activitySeconds > 0
    ? activitySeconds * 1000
    : Date.now();
  const ageMs = Date.now() - lastSeenMs;
  // session_attached is a client count, not a flag; >0 means attached.
  const attached = Number(attachedRaw) > 0;
  const status = attached || ageMs < 5 * 60 * 1000 ? "active"
               : ageMs < 24 * 3600 * 1000 ? "idle"
               : "ended";
  return {
    id: `${ADAPTER_NAME}:${encodeURIComponent(name)}`,
    adapter: ADAPTER_NAME,
    transcriptPath: `tmux://${encodeURIComponent(name)}`,
    name,
    sourceType: "terminal",
    lastSeen: new Date(lastSeenMs).toISOString(),
    status,
  };
}

function sessionNameFromEntry(entry: SessionEntry): string {
  if (entry.transcriptPath.startsWith("tmux://")) {
    return decodeURIComponent(entry.transcriptPath.slice("tmux://".length));
  }
  if (entry.id.startsWith(`${ADAPTER_NAME}:`)) {
    return decodeURIComponent(entry.id.slice(ADAPTER_NAME.length + 1));
  }
  return entry.transcriptPath;
}

export default adapter;
