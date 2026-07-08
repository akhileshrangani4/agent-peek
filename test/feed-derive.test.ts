import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deriveOverlapWarnings, deriveStatusPosts } from "../src/feed/derive.js";
import type { Engine } from "../src/core/engine.js";

const roots: string[] = [];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: GIT_ENV });
}
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

function repoWithConflictingWorktrees(): string {
  const dir = mkdtempSync(join(tmpdir(), "peek-feed-derive-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "shared.ts"), "export const x = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  for (const branch of ["feat-a", "feat-b"]) {
    const wt = join(dir, `.wt-${branch}`);
    git(dir, "worktree", "add", "-q", wt, "-b", branch);
    writeFileSync(join(wt, "shared.ts"), `export const x = "${branch}";\n`);
    git(wt, "commit", "-qam", `change on ${branch}`);
  }
  return dir;
}

function trunkRepoWithConflictingWorktrees(): string {
  const dir = mkdtempSync(join(tmpdir(), "peek-feed-derive-trunk-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "trunk");
  writeFileSync(join(dir, "shared.ts"), "export const x = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  for (const branch of ["feat-a", "feat-b"]) {
    const wt = join(dir, `.wt-${branch}`);
    git(dir, "worktree", "add", "-q", wt, "-b", branch);
    writeFileSync(join(wt, "shared.ts"), `export const x = "${branch}";\n`);
    git(wt, "commit", "-qam", `change on ${branch}`);
  }
  return dir;
}

describe("deriveOverlapWarnings", () => {
  it("emits one warning for two branches touching the same file", async () => {
    const dir = repoWithConflictingWorktrees();
    const result = await deriveOverlapWarnings(dir, "test-project");
    expect(result.errors).toEqual([]);
    expect(result.posts).toHaveLength(1);
    const warning = result.posts[0]!;
    expect(warning.type).toBe("warning");
    expect(warning.origin).toBe("derived");
    expect(warning.id).toMatch(/^drv-[0-9a-f]{16}$/);
    expect(warning.scope.paths).toEqual(["shared.ts"]);
    expect(warning.body.title).toContain("feat-a");
    expect(warning.body.title).toContain("feat-b");
  });

  it("is deterministic: same repo state yields the same id", async () => {
    const dir = repoWithConflictingWorktrees();
    const a = await deriveOverlapWarnings(dir, "p");
    const b = await deriveOverlapWarnings(dir, "p");
    expect(a.posts[0]!.id).toBe(b.posts[0]!.id);
  });

  it("reports errors instead of throwing for non-git dirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-feed-derive-plain-"));
    roots.push(dir);
    const result = await deriveOverlapWarnings(dir, "p");
    expect(result.posts).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("resolves the default branch to the main worktree's branch in trunk-only repos (no origin/main/master)", async () => {
    const dir = trunkRepoWithConflictingWorktrees();
    const result = await deriveOverlapWarnings(dir, "test-project");
    expect(result.errors).toEqual([]);
    expect(result.posts).toHaveLength(1);
    const warning = result.posts[0]!;
    expect(warning.body.title).toContain("feat-a");
    expect(warning.body.title).toContain("feat-b");
    expect(warning.body.title).not.toContain("trunk");
  });
});

describe("deriveStatusPosts", () => {
  it("emits a status post per active session under dir", async () => {
    const fakeEngine = {
      list: async () => [
        { id: "claude-code:1", adapter: "claude-code", transcriptPath: "x", cwd: "/proj", lastSeen: new Date().toISOString(), status: "active" },
        { id: "codex:2", adapter: "codex", transcriptPath: "y", cwd: "/elsewhere", lastSeen: new Date().toISOString(), status: "active" },
      ],
      peek: async () => ({
        snapshot: { mode: "structured", sessionId: "claude-code:1", messageCount: 5, currentTask: "refactoring auth", touchedFiles: [], writingFiles: [], pendingToolCalls: [], lastToolCalls: [], activity: "thinking" },
        nextCursor: "c", eof: true,
      }),
    } as unknown as Engine;
    const result = await deriveStatusPosts(fakeEngine, "/proj", "p");
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]!.type).toBe("status");
    expect(result.posts[0]!.body.text).toContain("refactoring auth");
  });
});
