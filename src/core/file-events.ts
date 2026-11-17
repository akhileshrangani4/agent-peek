// src/core/file-events.ts
//
// What a session did to each file, as a resuming agent needs it: which files it wrote
// and which it only read, and where each written file ended up. `touchedFiles` keeps
// its 0.6 meaning (every path any call touched, reads and writes alike) because `coord`
// builds `recentFiles` from it; this is the per-file view the handoff renders (#1, #7).

import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { toRepoRelative, type PathExists } from "./repo-path.js";
import type { FileOp } from "./shell.js";
import { commandInput, isRelevantTouchedPath, isWriteTool, toolCallFileOps, toolCallPaths } from "./tool-paths.js";
import type { RawMessage } from "./types.js";

/** Where a written file ended up. */
export type WrittenFileState = "created" | "modified" | "moved" | "deleted";

interface FileFields {
  /** Absolute when the session cwd is known; otherwise as the transcript named it. */
  path: string;
  /** Relative to the file's git toplevel with POSIX separators; absent outside a repo. */
  relPath?: string;
}

export interface WrittenFile extends FileFields {
  role: "wrote";
  state: WrittenFileState;
  /** Set when `state` is `moved`: where the file went, following later moves. */
  movedTo?: string;
}

export interface ReadFile extends FileFields {
  role: "read";
}

export type SessionFile = WrittenFile | ReadFile;

export interface ClassifyFileEventsOptions {
  /** The on-disk check run at classification (handoff) time. */
  exists?: PathExists;
}

type Fold = Map<string, { role: "read" } | { role: "wrote"; state: WrittenFileState; movedTo?: string }>;

/**
 * Fold a session's file events in order. A write makes a path `created` if the session
 * had not seen it before and `modified` otherwise; `mv`/`git mv` marks the source
 * `moved` and carries its state to the destination; `rm`/`git rm` marks it `deleted`.
 * A path the session only named is `read`. The disk then has the last word: a
 * created or modified file that is gone is `deleted`, and a deleted one that is back
 * is `modified`.
 */
export function classifyFileEvents(
  messages: RawMessage[],
  cwd: string | undefined,
  opts: ClassifyFileEventsOptions = {},
): SessionFile[] {
  const exists = opts.exists ?? existsSync;
  const fold: Fold = new Map();
  const seen = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      const fromCommand = commandInput(tool.input) !== undefined;
      // The same evidence rules as `touchedFiles` and `writingFiles`: a path scraped out
      // of command text counts only when it (or, for a write, its directory) is on disk.
      const isEvidence = (path: string, written: boolean) => isRelevantTouchedPath(path, cwd)
        && (!fromCommand || exists(path) || (written && exists(dirname(path))));
      if (isWriteTool(tool)) {
        for (const op of toolCallFileOps(tool, cwd)) applyOp(fold, seen, op, isEvidence);
      }
      for (const path of toolCallPaths(tool, cwd)) {
        if (!fold.has(path) && isEvidence(path, false)) fold.set(path, { role: "read" });
        seen.add(path);
      }
    }
  }
  const files: SessionFile[] = [];
  for (const [path, entry] of fold) {
    const relPath = repoRelative(path, exists);
    const base = relPath === undefined ? { path } : { path, relPath };
    if (entry.role === "read") {
      files.push({ ...base, role: "read" });
      continue;
    }
    const state = settledState(entry.state, path, exists);
    files.push({ ...base, role: "wrote", state, ...(state === "moved" && entry.movedTo ? { movedTo: entry.movedTo } : {}) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function applyOp(fold: Fold, seen: Set<string>, op: FileOp, isEvidence: (path: string, written: boolean) => boolean): void {
  // A path the session already wrote or read is known, even if the command that moves or
  // removes it now leaves neither the file nor its directory on disk.
  const known = (path: string) => fold.has(path) || isEvidence(path, true);
  if (op.op === "write") {
    if (!known(op.path)) return;
    const previous = fold.get(op.path);
    fold.set(op.path, { role: "wrote", state: writeState(op.mode, previous, seen.has(op.path)) });
    seen.add(op.path);
    return;
  }
  if (op.op === "delete") {
    if (!known(op.path)) return;
    fold.set(op.path, { role: "wrote", state: "deleted" });
    seen.add(op.path);
    return;
  }
  const fromKnown = known(op.from);
  const toKnown = known(op.to);
  // A move out of the checkout reads as a delete here; a move in, as a new file.
  if (fromKnown && !toKnown) return applyOp(fold, seen, { op: "delete", path: op.from }, isEvidence);
  if (!fromKnown && toKnown) return applyOp(fold, seen, { op: "write", path: op.to, mode: "create" }, isEvidence);
  if (!fromKnown) return;
  const source = fold.get(op.from);
  const carried = source?.role === "wrote" && (source.state === "created" || source.state === "modified") ? source.state : "created";
  fold.set(op.from, { role: "wrote", state: "moved", movedTo: op.to });
  // An earlier move into `from` now ends at `to`.
  for (const entry of fold.values()) {
    if (entry.role === "wrote" && entry.movedTo === op.from) entry.movedTo = op.to;
  }
  fold.set(op.to, { role: "wrote", state: carried });
  seen.add(op.from);
  seen.add(op.to);
}

function writeState(
  mode: "create" | "modify" | "write",
  previous: { role: "read" } | { role: "wrote"; state: WrittenFileState } | undefined,
  seenBefore: boolean,
): WrittenFileState {
  if (previous?.role === "wrote") {
    // Writing again keeps the first verdict; writing where a file was removed makes a new one.
    return previous.state === "created" || previous.state === "modified" ? previous.state : "created";
  }
  if (mode === "create") return "created";
  if (mode === "modify") return "modified";
  return seenBefore ? "modified" : "created";
}

/** The disk at handoff time overrides the fold where they disagree. */
function settledState(state: WrittenFileState, path: string, exists: PathExists): WrittenFileState {
  if (!isAbsolute(path)) return state;
  if ((state === "created" || state === "modified") && !exists(path)) return "deleted";
  if (state === "deleted" && exists(path)) return "modified";
  return state;
}

function repoRelative(path: string, exists: PathExists): string | undefined {
  return isAbsolute(path) ? toRepoRelative(path, exists) : undefined;
}
