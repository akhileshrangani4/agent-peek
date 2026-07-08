import { describe, expect, it } from "vitest";
import { validatePost } from "../src/feed/schema.js";
import { scorePost, packFeed, encodeFeedCursor, decodeFeedCursor, type RankContext } from "../src/feed/rank.js";
import { InvalidCursorError } from "../src/core/errors.js";

const now = new Date("2026-07-07T12:00:00Z");
const ctx: RankContext = { contextPaths: ["src/payments/webhook.ts"], readerSession: "codex:9", now };

function make(over: Record<string, unknown> = {}) {
  return validatePost({
    type: "finding", title: "t", text: "some body text", project: "p",
    author: { session: "claude-code:1" }, paths: ["src/payments/webhook.ts"], ...over,
  } as never, now);
}

describe("scorePost", () => {
  it("ranks a warning on my file above an unrelated finding", () => {
    const warning = make({ type: "warning" });
    const unrelated = make({ paths: ["docs/readme.md"] });
    expect(scorePost(warning, ctx)).toBeGreaterThan(scorePost(unrelated, ctx));
  });

  it("boosts posts mentioning the reader", () => {
    const plain = make({ type: "handoff", paths: undefined });
    const mentioned = make({ type: "handoff", paths: undefined, mentions: ["codex:9"] });
    expect(scorePost(mentioned, ctx)).toBeGreaterThan(scorePost(plain, ctx));
  });

  it("subtree overlap scores between same-file and no-overlap", () => {
    const exact = scorePost(make(), ctx);
    const subtree = scorePost(make({ paths: ["src/payments/refunds.ts"] }), ctx);
    const none = scorePost(make({ paths: ["docs/x.md"] }), ctx);
    expect(exact).toBeGreaterThan(subtree);
    expect(subtree).toBeGreaterThan(none);
  });

  it("drifted posts score lower than fresh ones", () => {
    const fresh = make();
    const drifted = make();
    drifted.lifecycle.validity = "drifted";
    expect(scorePost(drifted, ctx)).toBeLessThan(scorePost(fresh, ctx));
  });

  it("excludes superseded and expired posts", () => {
    const gone = make();
    gone.lifecycle.validity = "superseded";
    expect(scorePost(gone, ctx)).toBe(0);
  });

  it("decays status posts hard with age, but not warnings", () => {
    const oldDate = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oldStatus = validatePost({ type: "status", title: "s", text: "x", project: "p", author: { session: "a" }, ttlMs: 24 * 60 * 60 * 1000 } as never, oldDate);
    const oldWarning = validatePost({ type: "warning", title: "w", text: "x", project: "p", author: { session: "a" }, paths: ["src/payments/webhook.ts"] } as never, oldDate);
    expect(scorePost(oldStatus, ctx)).toBeLessThan(0.1);
    expect(scorePost(oldWarning, ctx)).toBeGreaterThan(1);
  });
});

describe("packFeed", () => {
  it("fits full bodies then degrades to titles then omits, reporting counts", () => {
    const posts = Array.from({ length: 20 }, (_, i) => make({ title: `finding number ${i}`, text: "word ".repeat(100) }));
    const packed = packFeed(posts, 300, ctx);
    expect(packed.tokensUsed).toBeLessThanOrEqual(300);
    const full = packed.items.filter((i) => i.presentation === "full").length;
    const titles = packed.items.filter((i) => i.presentation === "title").length;
    expect(full).toBeGreaterThan(0);
    expect(titles).toBeGreaterThan(0);
    expect(full + titles + packed.omitted).toBe(20);
  });

  it("returns empty for zero candidates", () => {
    const packed = packFeed([], 600, ctx);
    expect(packed.items).toEqual([]);
    expect(packed.omitted).toBe(0);
  });
});

describe("feed cursor", () => {
  it("round-trips watermark and derived hashes", () => {
    const cursor = encodeFeedCursor({ watermark: "2026-07-07T00:00:00Z", seenDerived: ["a", "b"] });
    expect(decodeFeedCursor(cursor)).toEqual({ watermark: "2026-07-07T00:00:00Z", seenDerived: ["a", "b"] });
  });

  it("caps seenDerived at 64, evicting oldest first", () => {
    const seen = Array.from({ length: 100 }, (_, i) => `h${i}`);
    const decoded = decodeFeedCursor(encodeFeedCursor({ watermark: "w", seenDerived: seen }));
    expect(decoded.seenDerived).toHaveLength(64);
    expect(decoded.seenDerived[0]).toBe("h36");
  });

  it("returns empty state for undefined and throws on garbage", () => {
    expect(decodeFeedCursor(undefined)).toEqual({ watermark: undefined, seenDerived: [] });
    expect(() => decodeFeedCursor("!!not-base64!!")).toThrowError(InvalidCursorError);
  });
});
