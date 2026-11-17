// src/app/paths.ts
//
// How the paths a caller names become the paths claims and conflict checks compare.
// One rule for every front end: relative paths resolve against the caller's working
// directory, never the process's, and a target set is de-duplicated and sorted.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Absolute, de-duplicated and sorted: the form claims and `check` compare on. */
export function resolveTargets(values: readonly string[], cwd: string): string[] {
  return [...new Set(values.map((value) => resolve(cwd, value)))].sort();
}

export interface PathList {
  entries: string[];
  /** Entries with nothing on disk. Still checked: a typo there would otherwise pass as "ok". */
  missing: string[];
}

/**
 * A newline-delimited path list (`--files-from`). Blank lines and `#` comments are
 * skipped. The format is one path per line, but a line with whitespace that names no
 * file is several paths, not one: checking "a b" as a single path silently passes.
 */
export function parsePathList(raw: string, cwd: string): PathList {
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => (/\s/.test(line) && !existsSync(resolve(cwd, line)) ? line.split(/\s+/) : [line]));
  const missing = entries.filter((entry) => !existsSync(resolve(cwd, entry)));
  return { entries, missing };
}

const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/**
 * What `release <claim-id|file>` matches on: a claim id as given, or a file path
 * resolved against `cwd`. Anything shaped like a UUID is taken as an id.
 */
export function releaseSelector(raw: string, cwd: string, opts: { claimId?: boolean } = {}): string {
  return opts.claimId || CLAIM_ID.test(raw) ? raw : resolve(cwd, raw);
}
