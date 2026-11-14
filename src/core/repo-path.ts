// src/core/repo-path.ts
//
// A file's path relative to its git checkout, so the same file in two clones (or two
// worktrees) at different absolute paths has one name. Handoff file roles use it now;
// the per-project claims store (D2.5) keys claim paths by it.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export type PathExists = (path: string) => boolean;

/**
 * The nearest directory at or above `path` that holds a `.git` entry: a repo root,
 * a linked worktree (where `.git` is a file) or a submodule. Read from disk without
 * running git, so a missing `git` binary changes nothing.
 */
export function gitToplevel(path: string, exists: PathExists = existsSync): string | undefined {
  if (!isAbsolute(path)) return undefined;
  let dir = normalize(path);
  for (;;) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `path` relative to its git toplevel with POSIX separators, or undefined outside a repo. */
export function toRepoRelative(path: string, exists: PathExists = existsSync): string | undefined {
  const toplevel = gitToplevel(path, exists);
  if (!toplevel) return undefined;
  const rel = relative(toplevel, normalize(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}
