// src/skills/scan.ts
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { SkillRootKind } from "../agents/types.js";

export interface ScanRoot {
  path: string;
  /** Undefined for the shared library root, which belongs to no agent. */
  agent?: string;
  kind: SkillRootKind;
  mutable: boolean;
  /** Walk depth below the root. Plugin caches nest marketplace/plugin/version/skills. */
  maxDepth: number;
}

export interface FoundSkill {
  root: ScanRoot;
  /** Directory holding SKILL.md, as reached through the root (symlinks unresolved). */
  dir: string;
  realDir: string;
  /** Path relative to the root. */
  relPath: string;
  name: string;
  symlink: boolean;
  /** Directory mtime. Breaks ties between plugin version dirs that are content hashes. */
  mtimeMs: number;
  text: string;
}

export const AGENT_ROOT_DEPTH = 4;
export const PLUGIN_ROOT_DEPTH = 8;

/**
 * A skill is any directory containing SKILL.md. The walk stops descending on a hit
 * (there are no skills inside skills) and skips directories without one — an empty
 * directory in a skill root is not a skill and not an error.
 */
export async function scanRoot(root: ScanRoot): Promise<FoundSkill[]> {
  const out: FoundSkill[] = [];
  await walk(root.path, 0);
  return out;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > root.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "SKILL.md" && !e.isDirectory())) {
      const found = await describe(root, dir);
      if (found) out.push(found);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
      } else if (entry.isSymbolicLink() && await isDirectory(child)) {
        await walk(child, depth + 1);
      }
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function describe(root: ScanRoot, dir: string): Promise<FoundSkill | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  let realDir = dir;
  try {
    realDir = await realpath(dir);
  } catch { /* a link we cannot resolve is still an installation */ }
  const rel = relative(root.path, dir);
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch { /* an unstattable dir simply loses every tie */ }
  return {
    root,
    dir,
    realDir,
    relPath: rel,
    name: basename(dir),
    symlink: await isSymlinkedPath(root.path, rel),
    mtimeMs,
    text,
  };
}

/** True when any segment between the root and the skill is a symlink. */
async function isSymlinkedPath(rootPath: string, rel: string): Promise<boolean> {
  const parts = rel.split(sep).filter(Boolean);
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
