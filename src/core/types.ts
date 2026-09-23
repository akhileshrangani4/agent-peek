// src/core/types.ts

export type SessionStatus = "active" | "idle" | "ended";
export type Activity = "idle" | "thinking" | "tool-running";
export type SessionSourceType = "file" | "directory" | "database" | "terminal" | "manual";
export type SessionOutcome = "succeeded" | "failed" | "interrupted";

/** A provider's latest execution state, when its storage exposes one. */
export interface SessionExecution {
  state: "running" | "idle";
  outcome?: SessionOutcome;
  at?: string;
  sequence?: number;
}

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
  execution?: SessionExecution;
  /**
   * Set when this session is a subagent spawned by another: the id of the session that
   * spawned it. Absent for top-level sessions.
   *
   * Subagent transcripts live in a sidecar beside their parent's transcript, at
   * `<project>/<session-uuid>/subagents/agent-<agentId>.jsonl`. They are discovered and
   * tracked like any other session — coordination in particular needs them, because 158
   * of the 164 paths subagents write are never written by their parent — but the
   * default `peek list` view hides them behind `--include-subagents` so a machine's
   * session list does not triple.
   */
  parentSessionId?: string;
}

export interface FileClaim {
  id: string;
  files: string[];
  /** The name other agents see; --as sets it freely. */
  owner: string;
  /** The session identity peek resolved for whoever made the claim, so --ignore-self
   * still matches a claim that was given a display owner with --as. */
  creator?: string;
  cwd?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: "pending" | "completed" | "error";
  /** The call's id, or for a "(result)" entry the id of the call it answers. */
  id?: string;
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
  // Terminal adapters: last line of the previous capture. Used to detect
  // scrollback eviction when the pane's history-limit keeps line count flat.
  tail?: string;
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

/** Who the handoff document is written for. Only the shape matters:
 * CLI agents have a filesystem to point at, chat agents need excerpts inline. */
export type HandoffTarget = "generic" | "claude-code" | "codex" | "gemini" | "copilot" | "opencode" | "chatgpt" | "claude-chat";

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
  target: HandoffTarget;
  /** The handoff a new session can start from, as markdown. */
  document: string;
  /** "harness": a local agent CLI wrote `document`. "host": the caller is the
   * harness and should write it from `material`. "local": heuristic fallback. */
  provider: "harness" | "host" | "local";
  runner?: string;
  /** Full prompt (instructions + compressed transcript) when provider is "host". */
  material?: string;
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
  /**
   * Present when this is a subagent session. Carried through coordination so the
   * display name recompute keeps the subagent marker — a subagent shares its parent's
   * cwd, so without it the two render identically.
   */
  parentSessionId?: string;
  /** For claim rows: the resolved identity of the claimer, when it differs from the owner. */
  creator?: string;
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
