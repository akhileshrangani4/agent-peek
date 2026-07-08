import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { postToFeed, readFeed, expandPost, feedStats } from "../src/feed/index.js";
import { PostNotFoundError, PostRejectedError } from "../src/core/errors.js";

const roots: string[] = [];
function tmpProject(): { dir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "peek-feed-orch-"));
  roots.push(root);
  const dir = join(root, "proj");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir, home: join(root, "home") };
}
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

const input = {
  type: "finding" as const,
  title: "Auth flows through middleware",
  text: "session.ts owns verification; do not add checks in handlers.",
  paths: ["src/session.ts"],
};

describe("postToFeed / readFeed round trip", () => {
  it("posts and reads back within budget", async () => {
    const { dir, home } = tmpProject();
    writeFileSync(join(dir, "src.keep"), "");
    const post = await postToFeed({ dir, home, input, as: "researcher" });
    expect(post.author.session).toBe("researcher");
    const feed = await readFeed({ dir, home, includeDerived: false });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.post.id).toBe(post.id);
    expect(feed.tokensUsed).toBeGreaterThan(0);
    expect(feed.nextCursor.length).toBeGreaterThan(0);
  });

  it("rejects over-budget posts", async () => {
    const { dir, home } = tmpProject();
    await expect(postToFeed({ dir, home, as: "x", input: { ...input, text: "word ".repeat(300) } })).rejects.toThrowError(PostRejectedError);
  });

  it("throws PostNotFoundError when supersedes target is missing", async () => {
    const { dir, home } = tmpProject();
    await expect(postToFeed({ dir, home, as: "x", input: { ...input, supersedes: "nope" } })).rejects.toThrowError(PostNotFoundError);
  });

  it("incremental read with cursor excludes already-seen stored posts", async () => {
    const { dir, home } = tmpProject();
    await postToFeed({ dir, home, input, as: "x" });
    const first = await readFeed({ dir, home, includeDerived: false });
    const second = await readFeed({ dir, home, includeDerived: false, since: first.nextCursor });
    expect(second.items).toHaveLength(0);
  });

  it("marks a post drifted when a referenced file changes after posting", async () => {
    const { dir, home } = tmpProject();
    mkdirSync(join(dir, "src"), { recursive: true });
    const target = join(dir, "src", "session.ts");
    writeFileSync(target, "old");
    await postToFeed({ dir, home, input, as: "x" });
    const future = new Date(Date.now() + 5_000);
    utimesSync(target, future, future);
    const feed = await readFeed({ dir, home, includeDerived: false });
    expect(feed.items[0]!.post.lifecycle.validity).toBe("drifted");
  });

  it("drift-checks already-seen posts on an incremental read even though the payload stays watermark-filtered", async () => {
    const { dir, home } = tmpProject();
    mkdirSync(join(dir, "src"), { recursive: true });
    const target = join(dir, "src", "session.ts");
    writeFileSync(target, "old");
    const post = await postToFeed({ dir, home, input, as: "x" });
    const first = await readFeed({ dir, home, includeDerived: false });
    const future = new Date(Date.now() + 5_000);
    utimesSync(target, future, future);
    const second = await readFeed({ dir, home, includeDerived: false, since: first.nextCursor });
    expect(second.items).toHaveLength(0);
    const expanded = await expandPost({ dir, home, postId: post.id });
    expect(expanded.lifecycle.validity).toBe("drifted");
  });

  it("expandPost returns the full post and throws for unknown ids", async () => {
    const { dir, home } = tmpProject();
    const post = await postToFeed({ dir, home, input, as: "x" });
    const expanded = await expandPost({ dir, home, postId: post.id });
    expect(expanded.body.text).toBe(post.body.text);
    await expect(expandPost({ dir, home, postId: "missing" })).rejects.toThrowError(PostNotFoundError);
  });

  it("feedStats counts posts and ingestions", async () => {
    const { dir, home } = tmpProject();
    await postToFeed({ dir, home, input, as: "x" });
    await readFeed({ dir, home, includeDerived: false });
    const stats = await feedStats({ dir, home });
    expect(stats.posts).toBe(1);
    expect(stats.feedsServed).toBe(1);
  });
});
