// src/feed/index.ts
import { statSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import type { Engine } from "../core/engine.js";
import { PostNotFoundError } from "../core/errors.js";
import { deriveOverlapWarnings, deriveStatusPosts } from "./derive.js";
import { projectIdentity, resolveAuthor } from "./identity.js";
import { decodeFeedCursor, encodeFeedCursor, packFeed, type PackedItem, type RankContext } from "./rank.js";
import { validatePost, type FeedPost, type PostInput, type PostType } from "./schema.js";
import { FeedStore } from "./store.js";

export type { FeedPost, PostInput, PostType, PostAuthor, PostEvidence, PostOrigin, PostValidity } from "./schema.js";
export type { PackedItem, PackedFeed, RankContext } from "./rank.js";
export { validatePost, estimateTokens, DEFAULT_TTL_MS } from "./schema.js";
export { FeedStore, feedDbPath } from "./store.js";
export { projectIdentity, resolveAuthor } from "./identity.js";

export interface FeedReadResult {
  project: string;
  projectLabel: string;
  items: PackedItem[];
  tokensUsed: number;
  omitted: number;
  nextCursor: string;
  derivedErrors: string[];
  recovered: boolean;
}

export async function postToFeed(opts: {
  dir: string;
  input: Omit<PostInput, "project" | "author">;
  as?: string;
  home?: string;
  engine?: Engine;
}): Promise<FeedPost> {
  const identity = await projectIdentity(opts.dir);
  const author = await resolveAuthor({ as: opts.as, cwd: opts.dir, engine: opts.engine });
  const post = validatePost({ ...opts.input, project: identity.label, author });
  const store = new FeedStore({ projectId: identity.id, home: opts.home });
  try {
    for (const ref of [opts.input.supersedes, opts.input.replyTo]) {
      if (ref && !store.get(ref)) throw new PostNotFoundError(ref);
    }
    store.insert(post);
  } finally {
    store.close();
  }
  return post;
}

export async function readFeed(opts: {
  dir: string;
  budget?: number;
  contextPaths?: string[];
  since?: string;
  types?: PostType[];
  reader?: string;
  home?: string;
  engine?: Engine;
  includeDerived?: boolean;
}): Promise<FeedReadResult> {
  const identity = await projectIdentity(opts.dir);
  const cursor = decodeFeedCursor(opts.since);
  const now = new Date();
  const store = new FeedStore({ projectId: identity.id, home: opts.home });
  try {
    let stored = store.candidates({ types: opts.types, now });
    if (cursor.watermark) stored = stored.filter((p) => p.lifecycle.createdAt > cursor.watermark!);
    for (const post of stored) checkDrift(store, post, opts.dir);
    // Re-read validity after drift writes so packed output reflects it.
    stored = stored.map((p) => store.get(p.id) ?? p);

    const derivedErrors: string[] = [];
    let derived: FeedPost[] = [];
    if (opts.includeDerived !== false) {
      const overlap = await deriveOverlapWarnings(opts.dir, identity.label, now);
      derivedErrors.push(...overlap.errors);
      derived.push(...overlap.posts);
      if (opts.engine) {
        const status = await deriveStatusPosts(opts.engine, opts.dir, identity.label, now);
        derivedErrors.push(...status.errors);
        derived.push(...status.posts);
      }
      derived = derived.filter((p) => !cursor.seenDerived.includes(p.id));
      if (opts.types) derived = derived.filter((p) => opts.types!.includes(p.type));
    }

    const ctx: RankContext = { contextPaths: opts.contextPaths ?? [], readerSession: opts.reader, now };
    const budget = opts.budget ?? 600;
    const packed = packFeed([...stored, ...derived], budget, ctx);
    const watermark = stored.reduce((max, p) => (p.lifecycle.createdAt > max ? p.lifecycle.createdAt : max), cursor.watermark ?? "");
    const seenDerived = [...cursor.seenDerived, ...derived.map((p) => p.id)];
    store.logIngestion({ reader: opts.reader, tokens: packed.tokensUsed, postCount: packed.items.length, now });
    return {
      project: identity.id,
      projectLabel: identity.label,
      items: packed.items,
      tokensUsed: packed.tokensUsed,
      omitted: packed.omitted,
      nextCursor: encodeFeedCursor({ watermark, seenDerived }),
      derivedErrors,
      recovered: store.recovered,
    };
  } finally {
    store.close();
  }
}

function checkDrift(store: FeedStore, post: FeedPost, dir: string): void {
  if (post.lifecycle.validity !== "fresh" || post.scope.paths.length === 0) return;
  const createdMs = Date.parse(post.lifecycle.createdAt);
  const drifted: string[] = [];
  for (const path of post.scope.paths) {
    const abs = isAbsolute(path) ? path : join(resolve(dir), path);
    try {
      if (statSync(abs).mtimeMs > createdMs) drifted.push(path);
    } catch {
      drifted.push(path); // referenced file no longer exists
    }
  }
  if (drifted.length > 0) store.markDrifted(post.id, drifted);
}

export async function expandPost(opts: { dir: string; postId: string; home?: string }): Promise<FeedPost> {
  const identity = await projectIdentity(opts.dir);
  const store = new FeedStore({ projectId: identity.id, home: opts.home });
  try {
    const post = store.get(opts.postId);
    if (!post) throw new PostNotFoundError(opts.postId);
    return post;
  } finally {
    store.close();
  }
}

export async function feedStats(opts: { dir: string; home?: string }): Promise<{
  project: string; projectLabel: string; posts: number; byType: Record<string, number>; feedsServed: number; tokensServed: number;
}> {
  const identity = await projectIdentity(opts.dir);
  const store = new FeedStore({ projectId: identity.id, home: opts.home });
  try {
    return { project: identity.id, projectLabel: identity.label, ...store.stats() };
  } finally {
    store.close();
  }
}
