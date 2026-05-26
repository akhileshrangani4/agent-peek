// src/core/types.ts

export type SessionStatus = "active" | "idle" | "ended";
export type Activity = "idle" | "thinking" | "tool-running";
export type SessionSourceType = "file" | "directory" | "database" | "terminal" | "manual";

export interface SessionEntry {
  id: string;             // adapter-prefixed, e.g. "claude-code:abc-123"
  adapter: string;        // "claude-code" | "codex" | ...
  transcriptPath: string; // adapter read target: absolute path, DB path, or local terminal URI
  name?: string;          // human-oriented selector/display name
  cwd?: string;
  tag?: string;
  pid?: number;
  sourceType?: SessionSourceType;
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

export type SnapshotMode = "raw" | "structured" | "brief" | "summary" | "handoff";
export type RawWindowFrom = "start" | "end";
export type RawOrder = "oldest-first" | "newest-first";

export interface RawSnapshot {
  mode: "raw";
  sessionId: string;
  messages: RawMessage[];
  totalMessageCount: number;
  window: {
    start: number;
    end: number;
    order: RawOrder;
  };
}

export interface StructuredSnapshot {
  mode: "structured";
  sessionId: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  currentTask?: string;
  touchedFiles: string[];
  writingFiles: string[];
  pendingToolCalls: ToolCall[];
  lastToolCalls: ToolCall[];
  activity: Activity;
}

export interface SummarySnapshot {
  mode: "summary";
  sessionId: string;
  summary: string;
  deltaMessageCount: number;
  fallback?: boolean; // true if hosted summary failed and local structured context was returned
  structured?: StructuredSnapshot;
}

export interface BriefSnapshot {
  mode: "brief";
  sessionId: string;
  messageCount: number;
  activity: Activity;
  brief: string;
  currentTask?: string;
  lastAssistantMessage?: string;
  pendingTools: string[];
  recentTools: string[];
}

export interface HandoffSnapshot {
  mode: "handoff";
  sessionId: string;
  messageCount: number;
  activity: Activity;
  currentTask?: string;
  lastAssistantMessage?: string;
  decisions: string[];
  openQuestions: string[];
  nextActions: string[];
  touchedFiles: string[];
  pendingTools: string[];
  recentTools: string[];
}

export type Snapshot = RawSnapshot | StructuredSnapshot | BriefSnapshot | SummarySnapshot | HandoffSnapshot;

export interface PeekResult {
  snapshot: Snapshot;
  nextCursor: Cursor;
  eof: boolean;
}

export type CoordinationCursor = string;

export interface CoordinationWritingFileEvent {
  file: string;
  lastWritingAt: string;
  active: boolean;
}

export interface CoordinationSession {
  id: string;
  displayName: string;
  adapter: string;
  status: SessionStatus;
  activity?: Activity;
  cwd?: string;
  sourceType?: SessionSourceType;
  lastSeen: string;
  messageCount?: number;
  changedMessageCount?: number;
  currentTask?: string;
  lastAssistantMessage?: string;
  pendingTools: string[];
  recentTools: string[];
  intent: "writing" | "reading" | "unknown";
  recentFiles: string[];
  knownFiles: string[];
  hotFiles: string[];
  activeWritingFiles: string[];
  recentWritingFiles: string[];
  writingFileEvents: CoordinationWritingFileEvent[];
  writingFiles: string[];
  writingFilesLastSeen?: string;
  touchedFiles: string[];
  error?: string;
}

export interface CoordinationOverlapParticipant {
  id: string;
  displayName: string;
  lastSeen: string;
  activeWriting: boolean;
  lastWritingAt?: string;
}

export interface CoordinationOverlap {
  kind: "cwd" | "file";
  severity: "high" | "medium" | "low";
  message: string;
  sessionIds: string[];
  participants: CoordinationOverlapParticipant[];
  cwd?: string;
  file?: string;
  lastActivityAt?: string;
  lastWritingAt?: string;
}

export interface CoordinationDigest {
  mode: "coordination";
  generatedAt: string;
  cwd?: string;
  firstSnapshot: boolean;
  sessionCount: number;
  shownSessionCount: number;
  totalSessionCount: number;
  filteredSessionCount?: number;
  newSessionCount?: number;
  hiddenSessionCount?: number;
  hiddenLowSignalSessionCount?: number;
  hiddenUnchangedSessionCount?: number;
  changedSessionCount: number;
  sessions: CoordinationSession[];
  overlapHints: CoordinationOverlap[];
  nextCursor: CoordinationCursor;
}
