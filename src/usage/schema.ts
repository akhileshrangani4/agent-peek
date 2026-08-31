// src/usage/schema.ts
//
// The durable usage index. See docs/adr/0001 for why arguments are whitelisted.
//
// Vocabulary (ticket 01):
//   invocation — one recorded act of invoking something: an agent-initiated tool call,
//                or a user-initiated slash command. It is the row.
//   usage      — an aggregate over invocations. Always a count, never a record.
//   source     — one transcript file the scanner reads, keyed by absolute path.
//   watermark  — the persisted read position for a source. Makes re-scan idempotent.
//   tombstone  — a watermark row kept after its transcript is deleted. Proof that a
//                session was counted, as distinct from never having been observed.

/** How the invocation was initiated. `sidechain` is orthogonal to this, not a value. */
export type SourceKind = "tool_call" | "slash_command";

export const SOURCE_KINDS: readonly SourceKind[] = ["tool_call", "slash_command"];

export interface Invocation {
  /** Absolute path of the transcript this was read from. Part of the primary key. */
  sourcePath: string;
  /** Index of the message within the transcript. Part of the primary key. */
  msgIndex: number;
  /**
   * Index of the tool call within the message. Always 0 for a slash command, and
   * NOT NULL: a nullable primary-key column does not dedupe in SQLite, which would
   * break re-scan idempotency on the recovery path.
   */
  callIndex: number;
  /** Part of the primary key so a tool call and a slash command cannot collide. */
  sourceKind: SourceKind;

  /** Transcript adapter that read this. Orthogonal to `agent`. */
  adapter: string | null;
  /** Product whose session this is. Orthogonal to `adapter`; either may be absent. */
  agent: string | null;
  /** Session id, where the adapter surfaces one. */
  sessionId: string | null;

  /** UTC instant. Day bucketing happens at query time, never at write time. */
  timestamp: string;

  /** Tool name, or the command name for a slash invocation. Stored verbatim. */
  tool: string;
  /**
   * Whitelisted, named argument. Never the raw input blob — see ADR 0001.
   * For a `Skill` tool call, the skill argument. For a slash command, the command
   * name (so a skill invoked both ways groups together). Null where the whitelist
   * extracts nothing.
   */
  skill: string | null;

  /** Working directory, where the adapter surfaces one. */
  cwd: string | null;
  /** Tool call status, where known. */
  status: string | null;

  /** True when this happened inside a spawned subagent rather than the main loop. */
  sidechain: boolean;
  /** Subagent type, read straight off the record. No join, no pointer. */
  attributionAgent: string | null;
  /** The adapter's own tool-call id, where it emits one. */
  nativeCallId: string | null;
}

/** The persisted read position for one source. Kept forever, even once deleted. */
export interface Watermark {
  sourcePath: string;
  adapter: string;
  sessionId: string | null;
  /** Opaque adapter cursor. peek had no persisted read position before this. */
  cursor: string | null;
  msgIndex: number;
  /** Stored size. A shrink means truncation/rotation: re-scan from 0. */
  size: number;
  mtimeMs: number;
  scannedAt: string;
  /** True once the transcript is gone. The row survives as proof it was counted. */
  deleted: boolean;
}

/**
 * Bumped only for changes the migration list handles. A mismatch never drops rows:
 * rebuild is lossy for exactly the expired sessions the index exists to preserve.
 */
export const SCHEMA_VERSION = 1;

export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invocations (
  source_path TEXT NOT NULL,
  msg_index INTEGER NOT NULL,
  call_index INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  adapter TEXT,
  agent TEXT,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  tool TEXT NOT NULL,
  skill TEXT,
  cwd TEXT,
  status TEXT,
  sidechain INTEGER NOT NULL DEFAULT 0,
  attribution_agent TEXT,
  native_call_id TEXT,
  PRIMARY KEY (source_path, msg_index, call_index, source_kind)
);
CREATE INDEX IF NOT EXISTS invocations_tool ON invocations (tool);
CREATE INDEX IF NOT EXISTS invocations_skill ON invocations (skill);
CREATE INDEX IF NOT EXISTS invocations_ts ON invocations (timestamp);
CREATE TABLE IF NOT EXISTS watermarks (
  source_path TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  session_id TEXT,
  cursor TEXT,
  msg_index INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Forward migrations, applied in order for versions above the stored one. Additive
 * only: `ALTER TABLE ... ADD COLUMN`, never a drop. Dropping the invocation table can
 * never be automatic, because transcripts that have expired cannot be re-derived.
 */
export const MIGRATIONS: { to: number; sql: string }[] = [];
