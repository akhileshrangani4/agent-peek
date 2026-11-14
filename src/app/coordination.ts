// src/app/coordination.ts
//
// Coordination: who is working where, and whether a file you are about to write is
// being written by someone else. The conflict rule (which writers count, whose claims
// are yours, how subagents roll up to their parent) lives here so `check`, the MCP
// digest and a future HTTP route all answer the same question the same way.
import type { CoordinationOpts, Engine } from "../core/engine.js";
import type { CoordinationDigest } from "../core/types.js";
import { resolveSelf } from "./identity.js";
import { includesTerminals, type SessionStatus } from "./sessions.js";

type CoordinationSession = CoordinationDigest["sessions"][number];

export interface FileConflict {
  id: string;
  displayName: string;
  creator?: string;
  adapter: string;
  status: string;
  currentTask?: string;
  lastWritingAt?: string;
}

export interface CheckResult {
  ok: boolean;
  files: { file: string; conflicts: FileConflict[] }[];
  conflictCount: number;
}

/** Whose writes and claims a conflict check leaves out. */
export interface CheckIdentity {
  /** Claims made by (or displayed as) this owner are not conflicts. */
  ignoredOwner?: string;
  /** Writes from these sessions, or their subagents, are not conflicts. */
  ignoredSessions: string[];
  /** Why the ignored owner is a guess, when peek fell back from a tracked session. */
  ownerNote?: string;
}

export interface CheckIdentityRequest {
  cwd: string;
  /** Ignore claims owned by this name. Wins over the resolved self. */
  as?: string;
  /** Report your own claims as conflicts too. */
  includeSelf?: boolean;
  /** Ignore your own session's writes as well as your own claims. */
  ignoreSelf?: boolean;
  /** Ignore writes from this session name or id. */
  ignoreSession?: string;
}

export interface CheckRequest {
  cwd: string;
  /** Absolute paths, as `resolveTargets` returns them. */
  targets: readonly string[];
  identity: CheckIdentity;
  adapter?: string;
  includeTerminal?: boolean;
}

export interface DigestRequest {
  cwd?: string;
  adapter?: string;
  status?: SessionStatus;
  since?: string;
  includeEnded?: boolean;
  includeLowSignal?: boolean;
  includeTerminal?: boolean;
  writingOnly?: boolean;
}

/** A subagent's writes count as its parent's: the parent asked for them. */
export function isIgnoredSession(
  session: { id: string; displayName: string; parentSessionId?: string },
  ignored: ReadonlySet<string>,
): boolean {
  if (!ignored.size) return false;
  if (ignored.has(session.id) || ignored.has(session.displayName)) return true;
  return session.parentSessionId !== undefined && ignored.has(session.parentSessionId);
}

/** Sessions actively writing `target`, minus your own claims and ignored sessions. */
export function activeFileConflicts(
  digest: CoordinationDigest,
  target: string,
  ignoredOwner?: string,
  ignoredSessions: ReadonlySet<string> = new Set(),
): FileConflict[] {
  return digest.sessions
    .filter((session) => session.activeWritingFiles.includes(target))
    .filter((session) => !ignoredOwner || session.adapter !== "claim"
      || (session.displayName !== `claim-${ignoredOwner}` && session.creator !== ignoredOwner))
    .filter((session) => !isIgnoredSession(session, ignoredSessions))
    .map((session) => ({
      id: session.id,
      displayName: session.displayName,
      ...(session.creator ? { creator: session.creator } : {}),
      adapter: session.adapter,
      status: session.status,
      currentTask: session.currentTask,
      lastWritingAt: session.writingFileEvents.find((event) => event.file === target && event.active)?.lastWritingAt,
    }));
}

/** Fields every projected session keeps, so a row can still be addressed. */
export const COORDINATION_IDENTITY_FIELDS = ["id", "displayName", "adapter", "status", "lastSeen"] as const;

export const COORDINATION_SESSION_FIELDS: ReadonlySet<string> = new Set([
  ...COORDINATION_IDENTITY_FIELDS,
  "activity",
  "cwd",
  "sourceType",
  "messageCount",
  "changedMessageCount",
  "currentTask",
  "lastAssistantMessage",
  "pendingTools",
  "recentTools",
  "intent",
  "recentFiles",
  "knownFiles",
  "hotFiles",
  "activeWritingFiles",
  "recentWritingFiles",
  "writingFileEvents",
  "writingFiles",
  "writingFilesLastSeen",
  "touchedFiles",
  "error",
]);

export type CoordinationFields =
  | { ok: true; fields: string[] }
  | { ok: false; invalid: string[] };

/** A comma-separated field list, with the identity fields always added. */
export function parseCoordinationFields(text: string): CoordinationFields {
  const fields = text.split(",").map((field) => field.trim()).filter(Boolean);
  const invalid = fields.filter((field) => !COORDINATION_SESSION_FIELDS.has(field));
  if (fields.length === 0 || invalid.length) return { ok: false, invalid };
  return { ok: true, fields: [...new Set([...COORDINATION_IDENTITY_FIELDS, ...fields])] };
}

export function projectCoordinationSession(session: CoordinationSession, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const record = session as unknown as Record<string, unknown>;
  for (const field of fields) {
    if (record[field] !== undefined) projected[field] = record[field];
  }
  return projected;
}

/**
 * The digest as a polling client receives it: sessions narrowed to `fields`, and the
 * cursor dropped when it was delivered elsewhere (a cursor file or stderr).
 */
export function projectCoordinationDigest(
  digest: CoordinationDigest,
  opts: { fields?: readonly string[]; omitCursor?: boolean; cursorLocation?: string },
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...digest };
  if (opts.fields !== undefined) {
    const fields = opts.fields;
    projected.sessions = digest.sessions.map((session) => projectCoordinationSession(session, fields));
  }
  if (opts.omitCursor) delete projected.nextCursor;
  if (opts.cursorLocation) projected.cursorFile = opts.cursorLocation;
  return projected;
}

export class CoordinationService {
  constructor(private readonly engine: Engine) {}

  digest(req: DigestRequest = {}): Promise<CoordinationDigest> {
    const opts: CoordinationOpts = {
      cwd: req.cwd,
      adapter: req.adapter,
      status: req.status,
      since: req.since,
      includeEnded: req.includeEnded,
      includeLowSignal: req.includeLowSignal,
      includeTerminal: includesTerminals(req),
      writingOnly: req.writingOnly,
    };
    return this.engine.coordinate(opts);
  }

  /**
   * Your own claim is not a conflict with you, so by default `check` ignores claims made
   * by the resolved self; `includeSelf` turns that off and `as` names the owner outright.
   * `ignoreSelf` also drops your session's writes (and its subagents').
   */
  async identity(req: CheckIdentityRequest): Promise<CheckIdentity> {
    const wantsOwner = !req.as && !req.includeSelf;
    const self = wantsOwner || req.ignoreSelf ? await resolveSelf(this.engine, req.cwd) : undefined;
    const ignoredSessions: string[] = [];
    if (req.ignoreSession) ignoredSessions.push(req.ignoreSession);
    if (req.ignoreSelf && self?.session) ignoredSessions.push(self.session);
    if (req.as) return { ignoredOwner: req.as, ignoredSessions };
    if (!wantsOwner || !self) return { ignoredSessions };
    return self.note
      ? { ignoredOwner: self.owner, ignoredSessions, ownerNote: self.note }
      : { ignoredOwner: self.owner, ignoredSessions };
  }

  async check(req: CheckRequest): Promise<CheckResult> {
    const digest = await this.digest({ cwd: req.cwd, adapter: req.adapter, includeTerminal: req.includeTerminal });
    const ignoredSessions = new Set(req.identity.ignoredSessions);
    const files = req.targets.map((target) => ({
      file: target,
      conflicts: activeFileConflicts(digest, target, req.identity.ignoredOwner, ignoredSessions),
    }));
    const conflictCount = files.reduce((count, item) => count + item.conflicts.length, 0);
    return { ok: conflictCount === 0, files, conflictCount };
  }
}
