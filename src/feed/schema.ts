import { randomUUID } from "node:crypto";
import { PostRejectedError } from "../core/errors.js";

export type PostType = "finding" | "intent" | "warning" | "question" | "answer" | "handoff" | "status";
export type PostOrigin = "authored" | "derived";
export type PostValidity = "fresh" | "drifted" | "superseded" | "expired";

export const POST_TYPES: readonly PostType[] = ["finding", "intent", "warning", "question", "answer", "handoff", "status"];

export interface PostEvidence {
  kind: "file" | "commit" | "session";
  path?: string;
  line?: number;
  ref?: string;
  cursor?: string;
}

export interface PostAuthor {
  session: string;
  adapter?: string;
  name?: string;
  anonymous?: boolean;
}

export interface FeedPost {
  v: 1;
  id: string;
  type: PostType;
  origin: PostOrigin;
  author: PostAuthor;
  scope: { project: string; worktree?: string; branch?: string; paths: string[]; topics: string[] };
  body: { title: string; text: string; evidence: PostEvidence[] };
  links: { replyTo?: string; supersedes?: string; mentions: string[] };
  lifecycle: {
    createdAt: string;
    expiresAt: string;
    validity: PostValidity;
    driftedPaths: string[];
    confidence?: number;
  };
}

export interface PostInput {
  type: PostType;
  origin?: PostOrigin;
  title: string;
  text: string;
  project: string;
  author: PostAuthor;
  paths?: string[];
  topics?: string[];
  evidence?: PostEvidence[];
  replyTo?: string;
  supersedes?: string;
  mentions?: string[];
  ttlMs?: number;
  worktree?: string;
  branch?: string;
  confidence?: number;
}

export const TITLE_MAX_CHARS = 80;
export const AUTHORED_BODY_MAX_TOKENS = 150;
export const DERIVED_BODY_MAX_TOKENS = 40;
export const EVIDENCE_MAX = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_TTL_MS: Record<PostType, number> = {
  status: 10 * MINUTE,
  intent: 8 * HOUR,
  question: 7 * DAY,
  answer: 30 * DAY,
  warning: 14 * DAY,
  finding: 30 * DAY,
  handoff: 7 * DAY,
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function newPostId(now: Date = new Date()): string {
  const time = now.getTime().toString(36).padStart(9, "0");
  return `${time}-${randomUUID().slice(0, 8)}`;
}

export function validatePost(input: PostInput, now: Date = new Date()): FeedPost {
  const origin: PostOrigin = input.origin ?? "authored";
  if (!POST_TYPES.includes(input.type)) {
    throw new PostRejectedError(`unknown type "${input.type}". Use one of: ${POST_TYPES.join(", ")}.`);
  }
  const title = input.title.trim();
  if (title.length === 0) throw new PostRejectedError("title is required.");
  if (title.length > TITLE_MAX_CHARS) {
    throw new PostRejectedError(`title is ${title.length} chars; max is ${TITLE_MAX_CHARS}. Shorten it.`);
  }
  const text = input.text.trim();
  const maxTokens = origin === "derived" ? DERIVED_BODY_MAX_TOKENS : AUTHORED_BODY_MAX_TOKENS;
  const tokens = estimateTokens(text);
  if (tokens > maxTokens) {
    throw new PostRejectedError(`body is ~${tokens} tokens; max is ${maxTokens}. Shorten it; link evidence instead of inlining.`);
  }
  const paths = (input.paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if ((input.type === "finding" || input.type === "warning") && paths.length === 0) {
    throw new PostRejectedError(`type "${input.type}" requires --paths (used for ranking and drift detection). Pathless observations should use type "status".`);
  }
  const evidence = input.evidence ?? [];
  if (evidence.length > EVIDENCE_MAX) {
    throw new PostRejectedError(`${evidence.length} evidence entries; max is ${EVIDENCE_MAX}.`);
  }
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS[input.type];
  return {
    v: 1,
    id: newPostId(now),
    type: input.type,
    origin,
    author: input.author,
    scope: {
      project: input.project,
      worktree: input.worktree,
      branch: input.branch,
      paths,
      topics: (input.topics ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
    },
    body: { title, text, evidence },
    links: { replyTo: input.replyTo, supersedes: input.supersedes, mentions: input.mentions ?? [] },
    lifecycle: {
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      validity: "fresh",
      driftedPaths: [],
      confidence: input.confidence,
    },
  };
}
