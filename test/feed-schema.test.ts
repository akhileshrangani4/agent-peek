import { describe, expect, it } from "vitest";
import { validatePost, estimateTokens, newPostId, DEFAULT_TTL_MS, type PostInput } from "../src/feed/schema.js";
import { PostRejectedError } from "../src/core/errors.js";

const base: PostInput = {
  type: "finding",
  title: "Webhook verification moved into middleware",
  text: "Dedup lives in verify.ts now; do not re-add the handler-level check.",
  project: "gh:example/repo",
  author: { session: "claude-code:abc", adapter: "claude-code" },
  paths: ["src/middleware/verify.ts"],
};

describe("estimateTokens", () => {
  it("is ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("newPostId", () => {
  it("sorts by creation time", () => {
    const a = newPostId(new Date("2026-01-01T00:00:00Z"));
    const b = newPostId(new Date("2026-06-01T00:00:00Z"));
    expect(a < b).toBe(true);
  });
});

describe("validatePost", () => {
  it("accepts a valid finding and fills lifecycle", () => {
    const now = new Date("2026-07-07T00:00:00Z");
    const post = validatePost(base, now);
    expect(post.v).toBe(1);
    expect(post.origin).toBe("authored");
    expect(post.lifecycle.validity).toBe("fresh");
    expect(post.lifecycle.createdAt).toBe(now.toISOString());
    expect(Date.parse(post.lifecycle.expiresAt)).toBe(now.getTime() + DEFAULT_TTL_MS.finding);
    expect(post.scope.paths).toEqual(["src/middleware/verify.ts"]);
  });

  it("rejects a finding without paths, hinting status", () => {
    expect(() => validatePost({ ...base, paths: [] })).toThrowError(PostRejectedError);
    expect(() => validatePost({ ...base, paths: undefined })).toThrowError(/paths/);
  });

  it("rejects a warning without paths", () => {
    expect(() => validatePost({ ...base, type: "warning", paths: [] })).toThrowError(PostRejectedError);
  });

  it("accepts a status without paths", () => {
    const post = validatePost({ ...base, type: "status", paths: undefined });
    expect(post.scope.paths).toEqual([]);
  });

  it("rejects title over 80 chars", () => {
    expect(() => validatePost({ ...base, title: "x".repeat(81) })).toThrowError(/title/);
  });

  it("rejects authored body over 150 tokens", () => {
    expect(() => validatePost({ ...base, text: "word ".repeat(200) })).toThrowError(/150/);
  });

  it("allows derived body up to 40 tokens only", () => {
    const text41 = "x".repeat(41 * 4);
    expect(() => validatePost({ ...base, origin: "derived", text: text41 })).toThrowError(/40/);
  });

  it("rejects more than 8 evidence entries", () => {
    const evidence = Array.from({ length: 9 }, () => ({ kind: "commit" as const, ref: "abc" }));
    expect(() => validatePost({ ...base, evidence })).toThrowError(/evidence/);
  });

  it("honors explicit ttlMs", () => {
    const now = new Date("2026-07-07T00:00:00Z");
    const post = validatePost({ ...base, ttlMs: 60_000 }, now);
    expect(Date.parse(post.lifecycle.expiresAt)).toBe(now.getTime() + 60_000);
  });
});
