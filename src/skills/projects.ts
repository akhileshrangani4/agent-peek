// src/skills/projects.ts
//
// Which repositories peek surveys for project-local skills.
//
// peek already records the directories you work in, so discovery reads that rather than
// crawling the filesystem: a crawl is slow and reaches into directories peek has no
// reason to touch. 143 recorded cwds collapse to far fewer repositories, because 133 of
// them are worktree or subdirectory paths that would otherwise each present as a project.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Most recent repositories to survey. Stated in output when it bites, like `truncated`. */
export const PROJECT_SCAN_LIMIT = 50;

/**
 * The repository a path belongs to, resolving a linked worktree to its *main* checkout.
 *
 * A worktree's `.git` is a file holding `gitdir: <main>/.git/worktrees/<name>`, so
 * stopping at the first `.git` finds the worktree and presents every worktree of one
 * repo as a separate project — which is exactly the duplication the git-root collapse
 * exists to prevent. Five worktrees of one repo counted its skill root five times.
 */
export function gitRootFor(path: string): string | undefined {
  let current = resolve(path);
  for (;;) {
    const dotGit = `${current}${sep}.git`;
    if (existsSync(dotGit)) return mainCheckoutOf(dotGit) ?? current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Main checkout behind a linked worktree's `.git` file, or undefined for a normal repo. */
function mainCheckoutOf(dotGit: string): string | undefined {
  try {
    if (statSync(dotGit).isDirectory()) return undefined;
    const match = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!match) return undefined;
    // `<main>/.git/worktrees/<name>` — everything before `/.git/` is the main checkout.
    const marker = `${sep}.git${sep}worktrees${sep}`;
    const gitDir = match[1]!.trim();
    const at = gitDir.indexOf(marker);
    return at === -1 ? undefined : gitDir.slice(0, at);
  } catch {
    return undefined;
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
