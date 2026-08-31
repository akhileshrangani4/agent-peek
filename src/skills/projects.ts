// src/skills/projects.ts
//
// Which repositories peek surveys for project-local skills.
//
// peek already records the directories you work in, so discovery reads that rather than
// crawling the filesystem: a crawl is slow and reaches into directories peek has no
// reason to touch. 143 recorded cwds collapse to far fewer repositories, because 133 of
// them are worktree or subdirectory paths that would otherwise each present as a project.
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Most recent repositories to survey. Stated in output when it bites, like `truncated`. */
export const PROJECT_SCAN_LIMIT = 50;

/**
 * Nearest ancestor holding `.git`, or undefined. A worktree's `.git` is a file rather
 * than a directory, which is why this tests existence and not directory-ness.
 */
export function gitRootFor(path: string): string | undefined {
  let current = resolve(path);
  for (;;) {
    if (existsSync(`${current}${sep}.git`)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface ProjectDiscovery {
  /** Repositories to survey, most recently used first. */
  projects: string[];
  /** How many distinct repositories were found before the cap. */
  found: number;
  /** True when the cap dropped repositories from the survey. */
  capped: boolean;
}

/**
 * Collapse recorded working directories to repository roots, newest first.
 * `cwds` is expected in most-recent-first order; a directory inside no repository is
 * kept as itself, since a skill root can sit in a plain directory.
 */
export function projectRootsFromCwds(cwds: string[], limit = PROJECT_SCAN_LIMIT): ProjectDiscovery {
  const seen = new Set<string>();
  const projects: string[] = [];
  for (const cwd of cwds) {
    if (!cwd) continue;
    const root = gitRootFor(cwd) ?? resolve(cwd);
    if (seen.has(root)) continue;
    seen.add(root);
    projects.push(root);
  }
  return {
    projects: projects.slice(0, limit),
    found: projects.length,
    capped: projects.length > limit,
  };
}
