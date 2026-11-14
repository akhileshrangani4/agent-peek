// test/app/feed.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PostNotFoundError, PostRejectedError } from "../../src/core/errors.js";
import { FeedService, parseEvidenceRefs, splitList } from "../../src/app/feed.js";
import { feedService } from "../../src/app/index.js";
import { projectAt } from "../../src/app/project.js";
import { fixedClock } from "../../src/app/time.js";
import { makeTmpHome } from "../helpers/tmp-home.js";

const NOW = "2026-11-13T12:00:00.000Z";

describe("feed argument rules", () => {
  it("splits comma lists and drops blanks", () => {
    expect(splitList(undefined)).toEqual([]);
    expect(splitList("")).toEqual([]);
    expect(splitList(" a, ,b ,")).toEqual(["a", "b"]);
  });

  it("reads evidence refs, taking only a trailing all-digit segment as a line", () => {
    expect(parseEvidenceRefs([
      "file:src/a.ts",
      "file:src/a.ts:12",
      "file:C:/repo/a.ts:3",
      "file:notes:v2",
      "commit:abc123",
      "session:claude-code:uuid",
    ])).toEqual([
      { kind: "file", path: "src/a.ts", line: undefined },
      { kind: "file", path: "src/a.ts", line: 12 },
      { kind: "file", path: "C:/repo/a.ts", line: 3 },
      { kind: "file", path: "notes:v2", line: undefined },
      { kind: "commit", ref: "abc123" },
      { kind: "session", ref: "claude-code:uuid" },
    ]);
  });

  it("rejects an evidence ref of an unknown kind", () => {
    expect(() => parseEvidenceRefs(["url:https://x"])).toThrow(PostRejectedError);
  });
});

describe("FeedService", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let project: ReturnType<typeof projectAt>;
  let feed: FeedService;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    const dir = join(home, "project");
    mkdirSync(dir);
    project = projectAt(dir);
    feed = new FeedService({ clock: fixedClock(NOW), home });
  });
  afterEach(async () => { await cleanup(); });

  const finding = { type: "finding" as const, title: "cache is per process", text: "The summary cache is an in-process Map.", paths: ["src/core/snapshot.ts"] };

  it("posts on the injected clock, as the named author", async () => {
    const post = await feed.post(project, finding, { as: "reviewer" });
    expect(post.lifecycle.createdAt).toBe(NOW);
    expect(post.author).toEqual({ session: "reviewer", name: "reviewer" });
    expect(post.body.title).toBe(finding.title);
  });

  it("reads back what it posted, scoped to the project", async () => {
    const post = await feed.post(project, finding, { as: "reviewer" });
    const read = await feed.read(project, { budget: 2000 });
    expect(read.items.map((item) => item.post.id)).toEqual([post.id]);
    expect(read.recovered).toBe(false);

    const other = join(home, "other");
    mkdirSync(other);
    expect((await feed.read(projectAt(other))).items).toEqual([]);
  });

  it("filters a read by type", async () => {
    await feed.post(project, finding, { as: "reviewer" });
    expect((await feed.read(project, { types: ["question"] })).items).toEqual([]);
  });

  it("expands a post and counts it in stats, without an engine", async () => {
    const post = await feed.post(project, finding, { as: "reviewer" });
    const standalone = feedService({ home });
    expect((await standalone.expand(project, post.id)).id).toBe(post.id);
    const stats = await standalone.stats(project);
    expect(stats.posts).toBe(1);
    expect(stats.byType).toEqual({ finding: 1 });
  });

  it("surfaces a missing post", async () => {
    await expect(feed.expand(project, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(PostNotFoundError);
  });
});
