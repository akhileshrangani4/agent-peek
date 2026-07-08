import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { projectIdentity, resolveAuthor, hashKey } from "../src/feed/identity.js";
import { NotAProjectError } from "../src/core/errors.js";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "peek-feed-id-"));
  roots.push(dir);
  return dir;
}
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

describe("projectIdentity", () => {
  it("hashes the normalized remote URL so clones share an id", async () => {
    const a = tmp(); const b = tmp();
    for (const dir of [a, b]) {
      git(dir, "init", "-q");
      git(dir, "remote", "add", "origin", "https://github.com/example/repo.git");
    }
    const ia = await projectIdentity(a);
    const ib = await projectIdentity(b);
    expect(ia.id).toBe(ib.id);
    expect(ia.label).toBe("gh:example/repo");
  });

  it("normalizes ssh and https remotes to the same id", async () => {
    const a = tmp(); const b = tmp();
    git(a, "init", "-q");
    git(a, "remote", "add", "origin", "git@github.com:example/repo.git");
    git(b, "init", "-q");
    git(b, "remote", "add", "origin", "https://github.com/example/repo");
    expect((await projectIdentity(a)).id).toBe((await projectIdentity(b)).id);
  });

  it("shares an id across worktrees of a remote-less repo", async () => {
    const main = tmp();
    git(main, "init", "-q", "-b", "main");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: main, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const wt = join(main, ".wt-feature");
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    expect((await projectIdentity(main)).id).toBe((await projectIdentity(wt)).id);
  });

  it("falls back to a path hash for non-git dirs", async () => {
    const dir = tmp();
    const identity = await projectIdentity(dir);
    expect(identity.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("throws NotAProjectError for a missing dir", async () => {
    await expect(projectIdentity("/nonexistent/definitely-missing-xyz")).rejects.toThrowError(NotAProjectError);
  });
});

describe("resolveAuthor", () => {
  it("uses --as verbatim as an explicit session name", async () => {
    const author = await resolveAuthor({ as: "researcher", cwd: process.cwd() });
    expect(author).toEqual({ session: "researcher", name: "researcher" });
  });

  it("uses CLAUDE_SESSION_ID when set", async () => {
    process.env.CLAUDE_SESSION_ID = "abc-123";
    try {
      const author = await resolveAuthor({ cwd: process.cwd() });
      expect(author.session).toBe("claude-code:abc-123");
      expect(author.adapter).toBe("claude-code");
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
    }
  });

  it("falls back to anonymous user@host", async () => {
    const author = await resolveAuthor({ cwd: "/nonexistent/definitely-missing-xyz" });
    expect(author.anonymous).toBe(true);
    expect(author.session).toContain("@");
  });
});

describe("hashKey", () => {
  it("is a 16-char hex digest", () => {
    expect(hashKey("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashKey("x")).toBe(hashKey("x"));
  });
});
