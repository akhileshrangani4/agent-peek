// src/adapters/common.ts
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RawMessage, ToolCall } from "../core/types.js";

export function statusFromMtime(ms: number): "active" | "idle" | "ended" {
  const ageMs = Date.now() - ms;
  return ageMs < 5 * 60 * 1000 ? "active"
       : ageMs < 24 * 3600 * 1000 ? "idle"
       : "ended";
}

// Terminal adapters (tmux/screen) track progress by absolute line count, but a
// pane at its history-limit evicts old lines as new ones arrive — the count
// stays flat forever while content shifts up, which would silently drop all
// new output. The cursor therefore carries the previous capture's last line
// (`tail`) so eviction can be detected and the delta resumed after it.
export const TERMINAL_REPLAY_CAP = 50;

export interface TerminalCaptureState {
  msgIndex: number;
  byteOffset: number;
  tail?: string;
}

export function terminalDeltaFromLine(lines: string[], prior: TerminalCaptureState): number {
  // Pane shrank (clear/reset): replay everything.
  if (prior.msgIndex > lines.length) return 0;
  // Grew below the cap: plain append.
  if (lines.length > prior.msgIndex) return prior.msgIndex;
  const last = lines.length ? lines[lines.length - 1] : undefined;
  // Identical capture: nothing new. Byte equality alone is not enough —
  // evicted content can be exactly the size of the new content — so the
  // tail line must match too (or be absent, for legacy cursors).
  if (Buffer.byteLength(lines.join("\n"), "utf8") === prior.byteOffset
      && (!prior.tail || last === prior.tail)) {
    return lines.length;
  }
  // Flat count but changing content: eviction at history-limit (or an
  // in-place redraw). Resume after the previous tail where possible.
  const idx = prior.tail ? lines.lastIndexOf(prior.tail) : -1;
  if (idx >= 0) return idx + 1;
  // Anchor overwritten: bounded replay so output is delayed, never lost.
  return Math.max(0, lines.length - TERMINAL_REPLAY_CAP);
}

export function terminalCursorTail(lines: string[]): string | undefined {
  return lines.length ? lines[lines.length - 1]!.slice(-200) : undefined;
}

/**
 * Read only the bytes of `path` from `fromByte` to EOF. Cursors store an
 * absolute byte offset, so transcripts being tailed no longer pay a full-file
 * read on every poll. `effFrom` is clamped to the file's current size so
 * callers can rebase window-relative offsets back to absolute positions.
 */
export async function readFileWindow(
  path: string,
  fromByte: number,
): Promise<{ buf: Buffer; effFrom: number; size: number }> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const effFrom = Math.max(0, Math.min(fromByte, size));
    const len = size - effFrom;
    const buf = Buffer.alloc(len);
    let readTotal = 0;
    while (readTotal < len) {
      const { bytesRead } = await fh.read(buf, readTotal, len - readTotal, effFrom + readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    return { buf: buf.subarray(0, readTotal), effFrom, size };
  } finally {
    await fh.close();
  }
}

export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function newestMtime(paths: string[], fallback: number): Promise<number> {
  let newest = fallback;
  for (const path of paths) {
    try {
      const st = await stat(path);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* ignore unreadable file */ }
  }
  return newest;
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n") : undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "value", "body", "output", "summary"]) {
    const text = extractText(obj[key]);
    if (text) return text;
  }
  return undefined;
}

export function normalizeRole(value: unknown): RawMessage["role"] {
  if (value === "assistant" || value === "agent") return "assistant";
  if (value === "user" || value === "human") return "user";
  if (value === "tool" || value === "tool_result" || value === "function") return "tool";
  return "system";
}

export function toolCallFromPart(part: Record<string, unknown>): ToolCall | undefined {
  const type = part.type;
  if (type !== "tool" && type !== "tool_use" && type !== "tool_call" && type !== "function_call") return undefined;
  const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
  const status = state.status === "completed" ? "completed"
              : state.status === "error" ? "error"
              : "pending";
  return {
    name: typeof part.tool === "string" ? part.tool
      : typeof part.name === "string" ? part.name
      : "?",
    input: state.input ?? part.input ?? part.arguments,
    output: state.output ?? state.error ?? part.output,
    status,
  };
}

