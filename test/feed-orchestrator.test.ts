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

  it("resurfaces budget-omitted posts on the next read instead of skipping them forever", async () => {
    const { dir, home } = tmpProject();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "a");
    writeFileSync(join(dir, "src", "b.ts"), "b");

    // p1 and p2 are high-weight "warning" posts (fresh, non-decaying score);
    // p3 is a low-weight "status" post created LAST (chronologically newest)
    // but scores far lower, so it's processed last by the packer and gets
    // fully omitted under a tight budget despite being the newest candidate.
    await postToFeed({
      dir, home, as: "x",
      input: { type: "warning", title: "Warning one", text: "x".repeat(40), paths: ["src/a.ts"] },
    });
    await postToFeed({
      dir, home, as: "x",
      input: { type: "warning", title: "Warning two", text: "y".repeat(40), paths: ["src/b.ts"] },
    });
    await postToFeed({
      dir, home, as: "x",
      input: { type: "status", title: "Status short", text: "z".repeat(10) },
    });

    const first = await readFeed({ dir, home, includeDerived: false, budget: 38 });
    expect(first.items).toHaveLength(2);
    expect(first.items.map((i) => i.post.body.title)).toEqual(["Warning two", "Warning one"]);
    expect(first.omitted).toBe(1);

    const second = await readFeed({ dir, home, includeDerived: false, since: first.nextCursor, budget: 38 });
    expect(second.items.map((i) => i.post.body.title)).toContain("Status short");
  });

  it("resurfaces a budget-omitted OLDER post even when a NEWER post was delivered ahead of it by score", async () => {
    // packFeed orders by score, not time. Construct t1 < t2 < t3 (by createdAt)
    // where scoring delivers t3 (newest, warning on the reader's exact file)
    // and t1 (oldest, finding on the reader's exact file) ahead of t2 (finding
    // with non-overlapping paths), so the budget-limited pack omits t2 even
    // though it's chronologically in the middle. A single watermark that
    // simply advances to the max delivered createdAt (t3) would push past t2
    // forever. The fix must resurface t2 on the next read, and must NOT
    // redeliver t3 or t1 once it does.
    const { dir, home } = tmpProject();
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "a");
    writeFileSync(join(dir, "lib", "unrelated.ts"), "u");

    await postToFeed({
      dir, home, as: "x",
      input: { type: "finding", title: "Finding old", text: "x".repeat(40), paths: ["src/a.ts"] }, // t1
    });
    await postToFeed({
      dir, home, as: "x",
      input: { type: "finding", title: "Finding gap", text: "y".repeat(40), paths: ["lib/unrelated.ts"] }, // t2
    });
    await postToFeed({
      dir, home, as: "x",
      input: { type: "warning", title: "Warning new", text: "z".repeat(40), paths: ["src/a.ts"] }, // t3
    });

    const readOpts = { dir, home, includeDerived: false, budget: 38, contextPaths: ["src/a.ts"] };
    const first = await readFeed(readOpts);
    expect(first.items.map((i) => i.post.body.title)).toEqual(["Warning new", "Finding old"]);
    expect(first.omitted).toBe(1);

    const second = await readFeed({ ...readOpts, since: first.nextCursor });
    expect(second.items.map((i) => i.post.body.title)).toEqual(["Finding gap"]);

    const third = await readFeed({ ...readOpts, since: second.nextCursor });
    expect(third.items).toHaveLength(0);
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
