// src/core/types.ts

export type SessionStatus = "active" | "idle" | "ended";
export type Activity = "idle" | "thinking" | "tool-running";

export interface SessionEntry {
  id: string;             // adapter-prefixed, e.g. "claude-code:abc-123"
  adapter: string;        // "claude-code" | "codex" | ...
  transcriptPath: string; // absolute path resolved by adapter
  cwd?: string;
  tag?: string;
  pid?: number;
  lastSeen: string;       // ISO timestamp
  status: SessionStatus;
}

export interface ToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: "pending" | "completed" | "error";
}

export interface RawMessage {
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  toolCalls?: ToolCall[];
  raw: unknown;           // adapter's original record
  timestamp?: string;
}

export interface CursorData {
  adapter: string;
  byteOffset: number;
  msgIndex: number;
}
export type Cursor = string; // opaque base64

export type SnapshotMode = "raw" | "structured" | "summary";

export interface RawSnapshot {
  mode: "raw";
  sessionId: string;
  messages: RawMessage[];
}

export interface StructuredSnapshot {
  mode: "structured";
  sessionId: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  currentTask?: string;
  pendingToolCalls: ToolCall[];
  lastToolCalls: ToolCall[];
  activity: Activity;
}

export interface SummarySnapshot {
  mode: "summary";
  sessionId: string;
  summary: string;
  deltaMessageCount: number;
  fallback?: boolean; // true if summary unavailable; structured returned instead
  structured?: StructuredSnapshot;
}

export type Snapshot = RawSnapshot | StructuredSnapshot | SummarySnapshot;

export interface PeekResult {
  snapshot: Snapshot;
  nextCursor: Cursor;
  eof: boolean;
}
