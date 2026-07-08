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
    // Drift-check every candidate (not just ones newer than the cursor) so
    // incremental readers still learn when an already-seen post's referenced
    // files change. The watermark filter below only affects what is RETURNED.
    const all = store.candidates({ types: opts.types, now });
    for (const post of all) checkDrift(store, post, opts.dir);
    // Re-read validity after drift writes so packed output reflects it.
    const refreshed = all.map((p) => store.get(p.id) ?? p);
    const refreshedById = new Map(refreshed.map((p) => [p.id, p]));
    const stored = refreshed.filter((p) => {
      if (cursor.watermark && p.lifecycle.createdAt <= cursor.watermark) return false;
      if (cursor.seenStored.includes(p.id)) return false;
      return true;
    });

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
    // Only advance the cursor over posts actually delivered (full or title
    // presentation). Budget-omitted posts must remain eligible on the next
    // read, otherwise they're permanently skipped once the watermark passes
    // their createdAt.
    //
    // packFeed orders by score, not time, so a single read can deliver a
    // NEWER post while budget-omitting an OLDER one. If the watermark simply
    // advanced to the max delivered createdAt, that older omitted post would
    // be silently skipped forever (its createdAt would fall below the new
    // watermark on the next incremental read). So when something stored gets
    // omitted, the watermark only advances up to just below the oldest
    // omission, and any newer stored post we DID deliver (because it scored
    // high enough) is tracked in `seenStored` so it isn't redelivered once
    // the watermark eventually catches up past it.
    const storedIds = new Set(stored.map((p) => p.id));
    const deliveredStored = packed.items.filter((item) => storedIds.has(item.post.id));
    const deliveredStoredIds = new Set(deliveredStored.map((item) => item.post.id));
    const deliveredDerivedIds = packed.items.filter((item) => !storedIds.has(item.post.id)).map((item) => item.post.id);
    const omittedStored = stored.filter((p) => !deliveredStoredIds.has(p.id));

    let watermark: string;
    if (omittedStored.length === 0) {
      watermark = deliveredStored.reduce(
        (max, item) => (item.post.lifecycle.createdAt > max ? item.post.lifecycle.createdAt : max),
        cursor.watermark ?? "",
      );
    } else {
      const oldestOmittedCreatedAt = omittedStored.reduce(
        (min, p) => (p.lifecycle.createdAt < min ? p.lifecycle.createdAt : min),
        omittedStored[0]!.lifecycle.createdAt,
      );
      watermark = deliveredStored.reduce((max, item) => {
        const createdAt = item.post.lifecycle.createdAt;
        return createdAt < oldestOmittedCreatedAt && createdAt > max ? createdAt : max;
      }, cursor.watermark ?? "");
    }

    // Carry forward any previously-tracked stored id whose post still sorts
    // above the (possibly advanced) watermark, plus anything delivered this
    // round that also sits above it. Ids whose post is gone (expired) are
    // dropped: scorePost already zeroes them out, so they pose no
    // redelivery risk.
    const seenStoredSet = new Set<string>();
    for (const id of cursor.seenStored) {
      const createdAt = refreshedById.get(id)?.lifecycle.createdAt;
      if (createdAt !== undefined && createdAt > watermark) seenStoredSet.add(id);
    }
    for (const item of deliveredStored) {
      if (item.post.lifecycle.createdAt > watermark) seenStoredSet.add(item.post.id);
    }
    const seenStored = [...seenStoredSet];
    const seenDerived = [...cursor.seenDerived, ...deliveredDerivedIds];
    store.logIngestion({ reader: opts.reader, tokens: packed.tokensUsed, postCount: packed.items.length, now });
    return {
      project: identity.id,
      projectLabel: identity.label,
      items: packed.items,
      tokensUsed: packed.tokensUsed,
      omitted: packed.omitted,
      nextCursor: encodeFeedCursor({ watermark, seenDerived, seenStored }),
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
