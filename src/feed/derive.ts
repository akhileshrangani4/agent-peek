// src/feed/derive.ts
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "../core/engine.js";
import type { StructuredSnapshot } from "../core/types.js";
import { hashKey } from "./identity.js";
import { validatePost, type FeedPost } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface DeriveResult { posts: FeedPost[]; errors: string[] }

const MAX_STATUS_SESSIONS = 8;

function within(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export async function deriveStatusPosts(engine: Engine, dir: string, projectLabel: string, now: Date = new Date()): Promise<DeriveResult> {
  const errors: string[] = [];
  const posts: FeedPost[] = [];
  let sessions;
  try {
    sessions = (await engine.list({ includeTerminal: false })).filter((s) => s.status !== "ended" && within(s.cwd, dir));
  } catch (error) {
    return { posts, errors: [`status: session scan failed: ${(error as Error).message}`] };
  }
  for (const session of sessions.slice(0, MAX_STATUS_SESSIONS)) {
    try {
      const result = await engine.peek(session.id, { mode: "structured" });
      const snap = result.snapshot as StructuredSnapshot;
      const task = snap.currentTask ?? "(task unknown)";
      const post = validatePost({
        type: "status",
        origin: "derived",
        title: clip(`${session.adapter} session: ${snap.activity}`, 80),
        text: clip(`Working on: ${task}`, 150),
        project: projectLabel,
        author: { session: session.id, adapter: session.adapter, name: session.tag },
        paths: snap.writingFiles.slice(0, 5),
      }, now);
      posts.push({ ...post, id: `drv-${hashKey(`status:${session.id}:${task}:${snap.activity}`)}` });
    } catch (error) {
      errors.push(`status: ${session.id}: ${(error as Error).message}`);
    }
  }
  return { posts, errors };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
  return stdout.trim();
}

interface Worktree { path: string; branch: string }

async function listWorktrees(dir: string): Promise<Worktree[]> {
  const out = await git(dir, ["worktree", "list", "--porcelain"]);
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
    else if (line === "" && current.path && current.branch) { worktrees.push(current as Worktree); current = {}; }
  }
  if (current.path && current.branch) worktrees.push(current as Worktree);
  return worktrees;
}

async function defaultBranch(dir: string, worktrees: Worktree[]): Promise<string> {
  try {
    const ref = await git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    try {
      await git(dir, ["rev-parse", "--verify", "main"]);
      return "main";
    } catch {
      return worktrees[0]?.branch ?? "master";
    }
  }
}

export async function deriveOverlapWarnings(dir: string, projectLabel: string, now: Date = new Date()): Promise<DeriveResult> {
  const errors: string[] = [];
  const posts: FeedPost[] = [];
  let worktrees: Worktree[];
  let base: string;
  try {
    worktrees = await listWorktrees(dir);
    base = await defaultBranch(dir, worktrees);
  } catch (error) {
    return { posts, errors: [`overlap: ${(error as Error).message}`] };
  }
  const branches = worktrees.filter((wt) => wt.branch !== base);
  const changed = new Map<string, string[]>();
  for (const wt of branches) {
    try {
      const mergeBase = await git(dir, ["merge-base", base, wt.branch]);
      const files = (await git(dir, ["diff", "--name-only", mergeBase, wt.branch])).split("\n").filter((f) => f.length > 0);
      changed.set(wt.branch, files);
    } catch (error) {
      errors.push(`overlap: ${wt.branch}: ${(error as Error).message}`);
    }
  }
  const names = [...changed.keys()].sort();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      const overlap = (changed.get(a) ?? []).filter((f) => (changed.get(b) ?? []).includes(f)).sort();
      if (overlap.length === 0) continue;
      try {
        const post = validatePost({
          type: "warning",
          origin: "derived",
          title: clip(`Branches ${a} and ${b} both modify ${overlap.length} file${overlap.length === 1 ? "" : "s"}`, 80),
          text: clip(`Overlapping vs merge-base: ${overlap.join(", ")}`, 150),
          project: projectLabel,
          author: { session: "agent-peek:derived" },
          paths: overlap.slice(0, 20),
        }, now);
        posts.push({ ...post, id: `drv-${hashKey(`overlap:${a}:${b}:${overlap.join(",")}`)}` });
      } catch (error) {
        errors.push(`overlap: ${a}/${b}: ${(error as Error).message}`);
      }
    }
  }
  return { posts, errors };
}
