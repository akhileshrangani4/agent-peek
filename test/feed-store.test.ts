import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeedStore, feedDbPath } from "../src/feed/store.js";
import { validatePost } from "../src/feed/schema.js";

let home: string;
function makeStore(): FeedStore {
  home = mkdtempSync(join(tmpdir(), "peek-feed-store-"));
  return new FeedStore({ projectId: "abc123", home });
}
afterEach(() => rmSync(home, { recursive: true, force: true }));

function post(overrides: Record<string, unknown> = {}) {
  return validatePost({
    type: "finding",
    title: "t",
    text: "body",
    project: "p",
    author: { session: "claude-code:1" },
    paths: ["src/a.ts"],
    ...overrides,
  } as never);
}

describe("FeedStore", () => {
  it("round-trips a post", () => {
    const store = makeStore();
    const p = post();
    store.insert(p);
    expect(store.get(p.id)).toEqual(p);
    store.close();
  });

  it("lists candidates newest-first, excluding expired", () => {
    const store = makeStore();
    const old = validatePost(
      { type: "status", title: "old", text: "x", project: "p", author: { session: "s" }, ttlMs: 1 },
      new Date(Date.now() - 60_000),
    );
    const fresh = post();
    store.insert(old);
    store.insert(fresh);
    const got = store.candidates();
    expect(got.map((p) => p.id)).toEqual([fresh.id]);
    store.close();
  });

  it("supersedes: inserting a post with links.supersedes hides the old one", () => {
    const store = makeStore();
    const a = post();
    store.insert(a);
    const b = post({ supersedes: a.id });
    store.insert(b);
    const ids = store.candidates().map((p) => p.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(store.get(a.id)?.lifecycle.validity).toBe("superseded");
    store.close();
  });

  it("filters candidates by type", () => {
    const store = makeStore();
    store.insert(post());
    store.insert(post({ type: "intent", paths: undefined }));
    expect(store.candidates({ types: ["intent"] })).toHaveLength(1);
    store.close();
  });

  it("markDrifted persists validity and paths", () => {
    const store = makeStore();
    const p = post();
    store.insert(p);
    store.markDrifted(p.id, ["src/a.ts"]);
    const got = store.get(p.id);
    expect(got?.lifecycle.validity).toBe("drifted");
    expect(got?.lifecycle.driftedPaths).toEqual(["src/a.ts"]);
    store.close();
  });

  it("logs ingestions and reports stats", () => {
    const store = makeStore();
    store.insert(post());
    store.logIngestion({ reader: "codex:1", tokens: 420, postCount: 3 });
    const stats = store.stats();
    expect(stats.posts).toBe(1);
    expect(stats.feedsServed).toBe(1);
    expect(stats.tokensServed).toBe(420);
    expect(stats.byType.finding).toBe(1);
    store.close();
  });

  it("recovers from a corrupt db file and reports it", () => {
    home = mkdtempSync(join(tmpdir(), "peek-feed-store-"));
    const path = feedDbPath(home, "abc123");
    mkdirSync(join(home, ".agent-peek", "feed"), { recursive: true });
    writeFileSync(path, "not a sqlite file");
    const store = new FeedStore({ projectId: "abc123", home });
    expect(store.recovered).toBe(true);
    store.insert(post());
    expect(store.candidates()).toHaveLength(1);
    store.close();
  });

  it("two stores on the same db can interleave writes (WAL)", () => {
    const store = makeStore();
    const other = new FeedStore({ projectId: "abc123", home });
    store.insert(post());
    other.insert(post());
    expect(store.candidates()).toHaveLength(2);
    other.close();
    store.close();
  });

  it("survives concurrent inserts and reads from multiple store instances", async () => {
    const store = makeStore();
    store.close();

    const stores = Array.from({ length: 6 }, () => new FeedStore({ projectId: "abc123", home }));
    const ops = stores.map((s, i) =>
      i % 2 === 0
        ? () => Promise.resolve(s.insert(post({ title: `concurrent-${i}` })))
        : () => Promise.resolve(s.candidates()),
    );

    await Promise.all(ops.map((op) => op()));

    for (const s of stores) s.close();

    const files = readdirSync(join(home, ".agent-peek", "feed"));
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(false);

    const verify = new FeedStore({ projectId: "abc123", home });
    const inserted = stores.length / 2;
    expect(verify.candidates()).toHaveLength(inserted);
    verify.close();
  });
});
