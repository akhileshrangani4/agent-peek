import { dirname, normalize, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import type {
  CoordinationCursor, CoordinationDigest, CoordinationOverlap, CoordinationSession, CoordinationWritingFileEvent,
  Cursor, FileClaim, RawMessage, SessionEntry, StructuredSnapshot, ToolCall,
} from "./types.js";
import { InvalidCursorError } from "./errors.js";
import { writtenPathOf } from "./shell.js";
import { commandInput, isRelevantTouchedPath, isWriteTool, toolCallFileOps, toolCallPaths } from "./tool-paths.js";

export interface CoordinationCursorData {
  version: 1;
  sessions: Record<string, Cursor | CoordinationCursorSessionState>;
}

export interface CoordinationCursorSessionSnapshot {
  currentTask?: string;
  lastAssistantMessage?: string;
  intent?: CoordinationSession["intent"];
  knownFiles?: string[];
  activeWritingFiles?: string[];
  recentWritingFiles?: string[];
  writingFileEvents?: CoordinationWritingFileEvent[];
  writingFiles?: string[];
  writingFilesLastSeen?: string;
  touchedFiles?: string[];
}

export interface CoordinationCursorSessionState {
  cursor: Cursor;
  session: CoordinationCursorSessionSnapshot;
}

export function encodeCoordinationCursor(data: CoordinationCursorData): CoordinationCursor {
  return `gz.${gzipSync(JSON.stringify(data)).toString("base64url")}`;
}

export function decodeCoordinationCursor(cursor: CoordinationCursor | undefined): CoordinationCursorData {
  if (!cursor) return { version: 1, sessions: {} };
  try {
    const raw = cursor.startsWith("gz.")
      ? gunzipSync(Buffer.from(cursor.slice(3), "base64url")).toString("utf8")
      : Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
      return { version: 1, sessions: parsed.sessions as Record<string, Cursor | CoordinationCursorSessionState> };
    }
  } catch {
    // handled below
  }
  throw new InvalidCursorError("bad coordination cursor");
}

export function buildCoordinationSession(opts: {
  entry: SessionEntry;
  displayName: string;
  structured?: StructuredSnapshot;
  deltaMessages?: RawMessage[];
  touchedMessages?: RawMessage[];
  error?: string;
}): CoordinationSession {
  const pendingTools = opts.structured?.pendingToolCalls.map((tool) => tool.name) ?? [];
  const recentTools = opts.structured?.lastToolCalls.map((tool) => tool.name) ?? [];
  const recentFiles = inferTouchedFiles(opts.touchedMessages ?? [], opts.entry.cwd);
  const writingFileEvents = inferWritingFileEvents(opts.touchedMessages ?? [], opts.entry.cwd, opts.entry.lastSeen);
  const activeWritingFiles = activeWritingFilesFor(writingFileEvents, opts.entry, opts.structured);
  const recentWritingFiles = writingFileEvents.map((event) => event.file).sort();
  const writingFiles = activeWritingFiles;
  return {
    id: opts.entry.id,
    displayName: opts.displayName,
    ...(opts.entry.parentSessionId ? { parentSessionId: opts.entry.parentSessionId } : {}),
    adapter: opts.entry.adapter,
    status: opts.entry.status,
    activity: opts.structured?.activity,
    cwd: opts.entry.cwd,
    sourceType: opts.entry.sourceType,
    lastSeen: opts.entry.lastSeen,
    messageCount: opts.structured?.messageCount,
    changedMessageCount: opts.deltaMessages?.length,
    currentTask: opts.structured?.currentTask,
    lastAssistantMessage: opts.structured?.lastAssistantMessage,
    pendingTools,
    recentTools,
    intent: coordinationIntent(opts.touchedMessages ?? [], recentFiles, activeWritingFiles),
    recentFiles,
    knownFiles: [...new Set([...recentFiles, ...recentWritingFiles])].sort(),
    hotFiles: hotFiles(recentFiles, opts.structured?.activity),
    activeWritingFiles,
    recentWritingFiles,
    writingFileEvents: writingFileEvents.map(({ file, lastWritingAt, active }) => ({ file, lastWritingAt, active })),
    writingFiles,
    writingFilesLastSeen: latestWritingAt(writingFileEvents),
    touchedFiles: recentFiles,
    error: opts.error,
  };
}

export function buildClaimCoordinationSession(claim: FileClaim): CoordinationSession {
  return {
    id: `claim:${claim.id}`,
    displayName: `claim-${claim.owner}`,
    ...(claim.creator ? { creator: claim.creator } : {}),
    adapter: "claim",
    status: "active",
    activity: "tool-running",
    cwd: claim.cwd,
    sourceType: "manual",
    lastSeen: claim.createdAt,
    messageCount: 0,
    changedMessageCount: 0,
    currentTask: `Claimed ${claim.files.length} file${claim.files.length === 1 ? "" : "s"} until ${claim.expiresAt}`,
    pendingTools: [],
    recentTools: [],
    intent: "writing",
    recentFiles: [],
    knownFiles: claim.files,
    hotFiles: claim.files,
    activeWritingFiles: claim.files,
    recentWritingFiles: claim.files,
    writingFileEvents: claim.files.map((file) => ({
      file,
      lastWritingAt: claim.createdAt,
      active: true,
    })),
    writingFiles: claim.files,
    writingFilesLastSeen: claim.createdAt,
    touchedFiles: claim.files,
  };
}

export function coordinationCursorFor(value: Cursor | CoordinationCursorSessionState | undefined): Cursor | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.cursor;
}

export function coordinationSessionFor(
  value: Cursor | CoordinationCursorSessionState | undefined,
  entry: SessionEntry,
  displayName: string,
): CoordinationSession | undefined {
  if (!value || typeof value === "string") return undefined;
  return {
    currentTask: value.session.currentTask,
    lastAssistantMessage: value.session.lastAssistantMessage,
    id: entry.id,
    displayName,
    ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
    adapter: entry.adapter,
    status: entry.status,
    cwd: entry.cwd,
    sourceType: entry.sourceType,
    lastSeen: entry.lastSeen,
    changedMessageCount: 0,
    pendingTools: [],
    recentTools: [],
    recentFiles: [],
    knownFiles: value.session.knownFiles ?? [],
    hotFiles: [],
    activeWritingFiles: value.session.activeWritingFiles ?? value.session.writingFiles ?? [],
    recentWritingFiles: value.session.recentWritingFiles ?? value.session.writingFiles ?? [],
    writingFileEvents: value.session.writingFileEvents ?? legacyWritingFileEvents(
      value.session.writingFiles,
      value.session.writingFilesLastSeen,
    ),
    writingFiles: value.session.activeWritingFiles ?? value.session.writingFiles ?? [],
    writingFilesLastSeen: value.session.writingFilesLastSeen,
    touchedFiles: value.session.touchedFiles ?? value.session.knownFiles ?? [],
    intent: value.session.intent ?? "unknown",
  };
}

export function compactCoordinationSessionForCursor(session: CoordinationSession): CoordinationCursorSessionSnapshot {
  return {
    currentTask: truncateCursorText(session.currentTask),
    lastAssistantMessage: truncateCursorText(session.lastAssistantMessage),
    intent: session.intent,
    knownFiles: session.knownFiles,
    activeWritingFiles: session.activeWritingFiles,
    recentWritingFiles: session.recentWritingFiles,
    writingFileEvents: session.writingFileEvents,
    writingFiles: session.writingFiles,
    writingFilesLastSeen: session.writingFilesLastSeen,
    touchedFiles: session.touchedFiles,
  };
}

export function mergeCoordinationSession(
  previous: CoordinationSession | undefined,
  next: CoordinationSession,
): CoordinationSession {
  if (!previous) return next;
  const mergedWritingEvents = mergeWritingFileEvents(previous.writingFileEvents, next.writingFileEvents);
  const hasChangedMessages = (next.changedMessageCount ?? 0) > 0;
  const activeWritingFiles = next.activeWritingFiles.length
    ? next.activeWritingFiles
    : hasChangedMessages
      ? []
      : previous.activeWritingFiles;
  const activeWritingSet = new Set(activeWritingFiles);
  const writingFileEvents = mergedWritingEvents.map((event) => ({
    ...event,
    active: activeWritingSet.has(event.file),
  }));
  const recentWritingFiles = writingFileEvents.map((event) => event.file).sort();
  const writingFiles = activeWritingFiles;
  const writingFilesLastSeen = latestWritingAt(writingFileEvents);
  const intent = next.intent === "unknown" && previous.intent !== "unknown"
    ? previous.intent
    : activeWritingFiles.length ? "writing" : next.intent;
  return {
    ...next,
    intent,
    knownFiles: [...new Set([...previous.knownFiles, ...next.recentFiles, ...next.knownFiles, ...recentWritingFiles])].sort(),
    activeWritingFiles,
    recentWritingFiles,
    writingFileEvents,
    writingFiles,
    writingFilesLastSeen,
    touchedFiles: [...new Set([...previous.touchedFiles, ...next.touchedFiles])].sort(),
  };
}

const ACTIVE_WRITING_MS = 5 * 60 * 1000;
const RECENT_WRITING_MS = 30 * 60 * 1000;

export function expireStaleWritingState(
  session: CoordinationSession,
  now: Date = new Date(),
): CoordinationSession {
  if (!session.writingFileEvents.length && !session.writingFiles.length) return session;
  const events = session.writingFileEvents.length
    ? session.writingFileEvents
    : legacyWritingFileEvents(session.writingFiles, session.writingFilesLastSeen);
  const recentEvents = events
    .filter((event) => isFreshAt(event.lastWritingAt, now, RECENT_WRITING_MS))
    .map((event) => ({
      ...event,
      active: event.active && isFreshAt(event.lastWritingAt, now, ACTIVE_WRITING_MS),
    }));
  const activeWritingFiles = recentEvents
    .filter((event) => event.active)
    .map((event) => event.file)
    .sort();
  const recentWritingFiles = recentEvents.map((event) => event.file).sort();
  return {
    ...session,
    activeWritingFiles,
    recentWritingFiles,
    writingFileEvents: recentEvents,
    writingFiles: activeWritingFiles,
    writingFilesLastSeen: latestWritingAt(recentEvents),
    intent: activeWritingFiles.length
      ? "writing"
      : session.intent === "writing"
        ? session.recentFiles.length || session.knownFiles.length || recentWritingFiles.length ? "reading" : "unknown"
        : session.intent,
  };
}

export function buildCoordinationDigest(opts: {
  sessions: CoordinationSession[];
  overlapSessions?: CoordinationSession[];
  totalSessionCount?: number;
  filteredSessionCount?: number;
  firstSnapshot?: boolean;
  hiddenLowSignalSessionCount?: number;
  hiddenUnchangedSessionCount?: number;
  cwd?: string;
  nextCursor: CoordinationCursor;
  generatedAt?: string;
}): CoordinationDigest {
  const firstSnapshot = opts.firstSnapshot === true;
  const hiddenLowSignalSessionCount = opts.hiddenLowSignalSessionCount ?? 0;
  const hiddenUnchangedSessionCount = opts.hiddenUnchangedSessionCount ?? 0;
  const hiddenSessionCount = hiddenLowSignalSessionCount + hiddenUnchangedSessionCount;
  const filteredSessionCount = opts.filteredSessionCount ?? 0;
  const shownSessionCount = opts.sessions.length;
  const totalSessionCount = opts.totalSessionCount ?? shownSessionCount + hiddenSessionCount + filteredSessionCount;
  const changedSessionCount = firstSnapshot
    ? 0
    : opts.sessions.filter((session) => (session.changedMessageCount ?? 0) > 0).length;
  return {
    mode: "coordination",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    cwd: opts.cwd,
    firstSnapshot,
    sessionCount: shownSessionCount,
    shownSessionCount,
    totalSessionCount,
    filteredSessionCount: filteredSessionCount || undefined,
    newSessionCount: firstSnapshot ? shownSessionCount : undefined,
    hiddenSessionCount: hiddenSessionCount || undefined,
    hiddenLowSignalSessionCount: hiddenLowSignalSessionCount || undefined,
    hiddenUnchangedSessionCount: hiddenUnchangedSessionCount || undefined,
    changedSessionCount,
    sessions: opts.sessions,
    overlapHints: buildOverlapHints(opts.overlapSessions ?? opts.sessions),
    nextCursor: opts.nextCursor,
  };
}

export function isTrivialCoordinationSession(session: CoordinationSession): boolean {
  if (session.error) return false;
  if (session.pendingTools.length || session.recentTools.length || session.recentFiles.length || session.knownFiles.length) return false;
  const task = `${session.currentTask ?? ""}\n${session.lastAssistantMessage ?? ""}`.trim();
  if (/^(say ok|ok|login interrupted|not logged in\b|please run \/login)$/i.test(task)) return true;
  if (/\bsay ok\b|\bnot logged in\b|\blogin interrupted\b|\bplease run \/login\b/i.test(task)) return true;
  return (session.messageCount ?? session.changedMessageCount ?? 0) < 10;
}

export function cwdMatches(entryCwd: string | undefined, requestedCwd: string | undefined): boolean {
  if (!requestedCwd) return true;
  if (!entryCwd) return false;
  const entry = normalize(resolve(entryCwd));
  const requested = normalize(resolve(requestedCwd));
  return entry === requested || entry.startsWith(`${requested}/`);
}

function buildOverlapHints(sessions: CoordinationSession[]): CoordinationOverlap[] {
  const hints: CoordinationOverlap[] = [];
  const recentFileSessions = new Map<string, CoordinationSession[]>();
  const knownFileSessions = new Map<string, CoordinationSession[]>();
  const writingFileSessions = new Map<string, CoordinationSession[]>();
  for (const session of sessions) {
    for (const file of session.knownFiles) addFileSession(knownFileSessions, file, session);
    for (const file of session.recentWritingFiles) addFileSession(knownFileSessions, file, session);
    for (const file of session.recentFiles) addFileSession(recentFileSessions, file, session);
    for (const file of session.activeWritingFiles) addFileSession(writingFileSessions, file, session);
  }

  for (const [file, grouped] of knownFileSessions) {
    const unique = uniqueBy(grouped, (session) => session.id);
    if (unique.length > 1) {
      const recentUnique = uniqueBy(recentFileSessions.get(file) ?? [], (session) => session.id);
      const writingUnique = uniqueBy(writingFileSessions.get(file) ?? [], (session) => session.id);
      if (recentUnique.length === 0 && writingUnique.length === 0) continue;
      const severity = fileSeverity(unique, writingUnique);
      if (severity === "low") continue;
      hints.push({
        kind: "file",
        severity,
        file,
        sessionIds: unique.map((session) => session.id),
        participants: unique.map((session) => overlapParticipant(session, file)),
        lastActivityAt: latestLastSeen(unique),
        lastWritingAt: latestWritingAt(writingUnique.flatMap((session) => fileWritingEvents(session, file, true))) ?? undefined,
        message: fileMessage(file, unique, recentUnique, writingUnique, severity),
      });
    }
  }
  return hints.sort(compareHints);
}

export function inferTouchedFiles(messages: RawMessage[], cwd: string | undefined): string[] {
  const files = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      const fromCommand = commandInput(tool.input) !== undefined;
      for (const path of toolCallPaths(tool, cwd)) {
        if (!isRelevantTouchedPath(path, cwd)) continue;
        // A path named as a tool argument was acted on. A path scraped out of a shell
        // command is a guess (an import specifier, a fixture in a heredoc, a quoted
        // example), so it counts only when the file is really there.
        if (fromCommand && !existsSync(path)) continue;
        files.add(path);
      }
    }
  }
  return [...files].sort();
}

export function inferWritingFiles(messages: RawMessage[], cwd: string | undefined): string[] {
  return inferWritingFileEvents(messages, cwd, new Date().toISOString()).map((event) => event.file);
}

function inferWritingFileEvents(
  messages: RawMessage[],
  cwd: string | undefined,
  fallbackTimestamp: string,
): (CoordinationWritingFileEvent & { messageIndex: number })[] {
  const events = new Map<string, CoordinationWritingFileEvent & { messageIndex: number }>();
  const lastMessageIndex = messages.length - 1;
  messages.forEach((message, messageIndex) => {
    for (const tool of message.toolCalls ?? []) {
      if (!isWriteTool(tool)) continue;
      const fromCommand = commandInput(tool.input) !== undefined;
      // Paths resolve against the directory each command ran in (`cd apps/server && …`,
      // Codex `workdir`), never the session cwd alone: that put real edits on a
      // same-named file elsewhere in the repo and reported it in `check` (#7).
      for (const path of new Set(toolCallFileOps(tool, cwd).map(writtenPathOf))) {
        if (!isRelevantTouchedPath(path, cwd)) continue;
        // Same rule as touched paths, except a command may create or delete the file it
        // writes, so its parent directory existing is the evidence instead.
        if (fromCommand && !existsSync(path) && !existsSync(dirname(path))) continue;
        const lastWritingAt = message.timestamp ?? fallbackTimestamp;
        const previous = events.get(path);
        if (previous && previous.lastWritingAt > lastWritingAt) continue;
        events.set(path, {
          file: path,
          lastWritingAt,
          active: isActiveWritingTool(tool, messageIndex, lastMessageIndex),
          messageIndex,
        });
      }
    }
  });
  return [...events.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function activeWritingFilesFor(
  events: (CoordinationWritingFileEvent & { messageIndex: number })[],
  entry: SessionEntry,
  structured: StructuredSnapshot | undefined,
): string[] {
  if (entry.status !== "active") return [];
  const hasPendingWrite = structured?.pendingToolCalls.some(isWriteTool) ?? false;
  const hasRunningWrite = structured?.activity === "tool-running" && events.some((event) => event.active);
  if (!hasPendingWrite && !hasRunningWrite) return [];
  return events
    .filter((event) => event.active || hasPendingWrite)
    .map((event) => event.file)
    .sort();
}

function isActiveWritingTool(tool: ToolCall, messageIndex: number, lastMessageIndex: number): boolean {
  return tool.status === "pending" || messageIndex === lastMessageIndex;
}

function fileWritingEvents(
  session: CoordinationSession,
  file: string,
  activeOnly = false,
): CoordinationWritingFileEvent[] {
  return session.writingFileEvents.filter((event) => event.file === file && (!activeOnly || event.active));
}

function overlapParticipant(session: CoordinationSession, file: string): CoordinationOverlap["participants"][number] {
  const events = fileWritingEvents(session, file);
  const active = events.some((event) => event.active);
  return {
    id: session.id,
    displayName: session.displayName,
    lastSeen: session.lastSeen,
    activeWriting: active,
    lastWritingAt: latestWritingAt(events),
  };
}

function latestWritingAt(events: { lastWritingAt?: string }[]): string | undefined {
  return events
    .map((event) => event.lastWritingAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.localeCompare(a))[0];
}

function legacyWritingFileEvents(
  files: string[] | undefined,
  lastWritingAt: string | undefined,
): CoordinationWritingFileEvent[] {
  if (!files?.length || !lastWritingAt) return [];
  return files.map((file) => ({ file, lastWritingAt, active: true }));
}

function mergeWritingFileEvents(
  previous: CoordinationWritingFileEvent[],
  next: CoordinationWritingFileEvent[],
): CoordinationWritingFileEvent[] {
  const events = new Map<string, CoordinationWritingFileEvent>();
  for (const event of previous) events.set(event.file, event);
  for (const event of next) {
    const previousEvent = events.get(event.file);
    if (!previousEvent || event.lastWritingAt >= previousEvent.lastWritingAt) {
      events.set(event.file, event);
    }
  }
  return [...events.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function isFreshAt(value: string | undefined, now: Date, maxAgeMs: number): boolean {
  const then = Date.parse(value ?? "");
  return Number.isFinite(then) && now.getTime() - then <= maxAgeMs;
}

function addFileSession(map: Map<string, CoordinationSession[]>, file: string, session: CoordinationSession): void {
  const list = map.get(file) ?? [];
  list.push(session);
  map.set(file, list);
}

function hotFiles(files: string[], activity: CoordinationSession["activity"]): string[] {
  return activity === "tool-running" ? files : [];
}

function coordinationIntent(
  messages: RawMessage[],
  recentFiles: string[],
  writingFiles: string[],
): CoordinationSession["intent"] {
  if (writingFiles.length) return "writing";
  if (recentFiles.length || messages.some((message) => message.toolCalls?.some(isWriteTool))) return "reading";
  return "unknown";
}

function fileSeverity(
  sessions: CoordinationSession[],
  writingSessions: CoordinationSession[],
): CoordinationOverlap["severity"] {
  if (writingSessions.length > 1) return "high";
  if (writingSessions.length === 1 && sessions.length - writingSessions.length >= 3) return "high";
  if (writingSessions.length > 0) return "medium";
  return "low";
}

function fileMessage(
  file: string,
  sessions: CoordinationSession[],
  recentSessions: CoordinationSession[],
  writingSessions: CoordinationSession[],
  severity: CoordinationOverlap["severity"],
): string {
  const names = sessions.map((session) => session.displayName).join(", ");
  const writers = writingSessions.map((session) => session.displayName).join(", ");
  const nonWriters = sessions.filter((session) => !writingSessions.some((writer) => writer.id === session.id));
  const seenBy = nonWriters.map((session) => session.displayName).join(", ");
  if (severity === "high" && writingSessions.length === 1) return `${file} has 1 writing session (${writers}), also seen by ${nonWriters.length} sessions: ${seenBy}.`;
  if (severity === "high") return `${file} has ${writingSessions.length} writing sessions: ${writers}.`;
  if (severity === "medium") {
    return seenBy
      ? `${file} has 1 writing session (${writers}), also seen by: ${seenBy}.`
      : `${file} has 1 writing session: ${writers}.`;
  }
  if (recentSessions.length > 0) return `${file} has read-only recent overlap across ${sessions.length} sessions: ${names}.`;
  return `${file} has historical overlap across ${sessions.length} sessions: ${names}.`;
}

function compareHints(a: CoordinationOverlap, b: CoordinationOverlap): number {
  const severity = severityRank(b.severity) - severityRank(a.severity);
  if (severity !== 0) return severity;
  if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
  return a.message.localeCompare(b.message);
}

function severityRank(severity: CoordinationOverlap["severity"]): number {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function latestLastSeen(sessions: CoordinationSession[]): string | undefined {
  return sessions
    .map((session) => session.lastSeen)
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0];
}

function truncateCursorText(value: string | undefined): string | undefined {
  if (!value || value.length <= 240) return value;
  return `${value.slice(0, 237)}...`;
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
