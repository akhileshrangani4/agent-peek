// src/feed/rank.ts
import { InvalidCursorError } from "../core/errors.js";
import { estimateTokens, type FeedPost, type PostType } from "./schema.js";

export interface RankContext {
  contextPaths: string[];
  readerSession?: string;
  now: Date;
}

const TYPE_WEIGHT: Record<PostType, number> = {
  warning: 5, handoff: 4, answer: 4, question: 3, intent: 3, finding: 2, status: 1,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HALF_LIFE_MS: Record<PostType, number> = {
  status: 30 * MINUTE, intent: 4 * HOUR, question: 3 * DAY, answer: 7 * DAY,
  finding: 7 * DAY, handoff: 2 * DAY, warning: Number.POSITIVE_INFINITY,
};

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function relevance(post: FeedPost, ctx: RankContext): number {
  if (ctx.contextPaths.length === 0) return 0.5;
  if (post.scope.paths.length === 0) return 0.3;
  let best = 0.2;
  const readerDirs = new Set(ctx.contextPaths.map(dirOf));
  for (const path of post.scope.paths) {
    if (ctx.contextPaths.includes(path)) { best = Math.max(best, 1); continue; }
    const dir = dirOf(path);
    if ([...readerDirs].some((d) => d === dir || d.startsWith(`${dir}/`) || dir.startsWith(`${d}/`))) {
      best = Math.max(best, 0.6);
    }
  }
  return best;
}

export function scorePost(post: FeedPost, ctx: RankContext): number {
  const { validity } = post.lifecycle;
  if (validity === "superseded" || validity === "expired") return 0;
  if (Date.parse(post.lifecycle.expiresAt) <= ctx.now.getTime()) return 0;
  const mentionBoost = ctx.readerSession && post.links.mentions.includes(ctx.readerSession) ? 2 : 1;
  const ageMs = Math.max(0, ctx.now.getTime() - Date.parse(post.lifecycle.createdAt));
  const halfLife = HALF_LIFE_MS[post.type];
  const freshness = Number.isFinite(halfLife) ? Math.pow(0.5, ageMs / halfLife) : 1;
  const validityFactor = validity === "drifted" ? 0.4 : 1;
  const anonymousFactor = post.author.anonymous ? 0.7 : 1;
  return TYPE_WEIGHT[post.type] * mentionBoost * relevance(post, ctx) * freshness * validityFactor * anonymousFactor;
}

export interface PackedItem { post: FeedPost; presentation: "full" | "title"; tokens: number }
export interface PackedFeed { items: PackedItem[]; tokensUsed: number; omitted: number }

const ITEM_OVERHEAD_TOKENS = 6;
const TITLE_ONLY_TOKENS = 15;

export function packFeed(posts: FeedPost[], budget: number, ctx: RankContext): PackedFeed {
  const scored = posts
    .map((post) => ({ post, score: scorePost(post, ctx) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const items: PackedItem[] = [];
  let tokensUsed = 0;
  let titlesOnly = false;
  let omitted = 0;
  for (const { post } of scored) {
    const fullCost = estimateTokens(`${post.body.title} ${post.body.text}`) + ITEM_OVERHEAD_TOKENS;
    if (!titlesOnly && tokensUsed + fullCost <= budget) {
      items.push({ post, presentation: "full", tokens: fullCost });
      tokensUsed += fullCost;
      continue;
    }
    titlesOnly = true;
    if (tokensUsed + TITLE_ONLY_TOKENS <= budget) {
      items.push({ post, presentation: "title", tokens: TITLE_ONLY_TOKENS });
      tokensUsed += TITLE_ONLY_TOKENS;
    } else {
      omitted += 1;
    }
  }
  return { items, tokensUsed, omitted };
}

const CURSOR_MAX_DERIVED = 64;

export function encodeFeedCursor(c: { watermark: string; seenDerived: string[] }): string {
  const seenDerived = c.seenDerived.slice(-CURSOR_MAX_DERIVED);
  return Buffer.from(JSON.stringify({ v: 1, w: c.watermark, d: seenDerived }), "utf8").toString("base64url");
}

export function decodeFeedCursor(cursor?: string): { watermark?: string; seenDerived: string[] } {
  if (!cursor) return { watermark: undefined, seenDerived: [] };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.v !== 1) throw new Error("bad version");
    return { watermark: typeof parsed.w === "string" ? parsed.w : undefined, seenDerived: Array.isArray(parsed.d) ? parsed.d : [] };
  } catch (error) {
    throw new InvalidCursorError(`feed cursor: ${(error as Error).message}`);
  }
}
