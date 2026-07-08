// src/feed/store.ts
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { FeedPost, PostType } from "./schema.js";

const nodeRequire = createRequire(import.meta.url);
// Lazy-load node:sqlite: requiring it emits Node's ExperimentalWarning on
// stderr, which must not happen for CLI commands that never touch the feed.
let cachedCtor: typeof DatabaseSync | undefined;
function databaseSyncCtor(): typeof DatabaseSync {
  cachedCtor ??= (nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  return cachedCtor;
}

export function feedDbPath(home: string | undefined, projectId: string): string {
  return join(home ?? homedir(), ".agent-peek", "feed", `${projectId}.db`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  origin TEXT NOT NULL,
  author_session TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  superseded_by TEXT,
  reply_to TEXT,
  validity TEXT NOT NULL DEFAULT 'fresh',
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_created ON posts (created_at DESC);
CREATE TABLE IF NOT EXISTS post_paths (
  post_id TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_paths_path ON post_paths (path);
CREATE TABLE IF NOT EXISTS ingestions (
  at TEXT NOT NULL,
  reader TEXT,
  tokens INTEGER NOT NULL,
  post_count INTEGER NOT NULL
);
`;

export class FeedStore {
  private db!: DatabaseSync;
  readonly path: string;
  recovered = false;

  constructor(opts: { projectId: string; home?: string }) {
    this.path = feedDbPath(opts.home, opts.projectId);
    mkdirSync(dirname(this.path), { recursive: true });
    this.open();
  }

  private open(): void {
    try {
      this.db = new (databaseSyncCtor())(this.path);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(SCHEMA);
    } catch {
      if (existsSync(this.path)) {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        this.recovered = true;
      }
      this.db = new (databaseSyncCtor())(this.path);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(SCHEMA);
    }
  }

  insert(post: FeedPost): void {
    const stmt = this.db.prepare(
      "INSERT INTO posts (id, type, origin, author_session, created_at, expires_at, superseded_by, reply_to, validity, doc) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    );
    stmt.run(
      post.id, post.type, post.origin, post.author.session,
      post.lifecycle.createdAt, post.lifecycle.expiresAt,
      post.links.replyTo ?? null, post.lifecycle.validity, JSON.stringify(post),
    );
    const pathStmt = this.db.prepare("INSERT INTO post_paths (post_id, path) VALUES (?, ?)");
    for (const path of post.scope.paths) pathStmt.run(post.id, path);
    if (post.links.supersedes) this.markSuperseded(post.links.supersedes, post.id);
  }

  get(id: string): FeedPost | undefined {
    const row = this.db.prepare("SELECT doc, validity FROM posts WHERE id = ?").get(id) as
      | { doc: string; validity: string }
      | undefined;
    if (!row) return undefined;
    return this.reviveRow(row.doc, row.validity);
  }

  candidates(opts: { types?: PostType[]; now?: Date } = {}): FeedPost[] {
    const now = (opts.now ?? new Date()).toISOString();
    let sql = "SELECT doc, validity FROM posts WHERE validity != 'superseded' AND validity != 'expired' AND expires_at > ?";
    const params: string[] = [now];
    if (opts.types && opts.types.length > 0) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(",")})`;
      params.push(...opts.types);
    }
    sql += " ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(...params) as { doc: string; validity: string }[];
    this.expireLazily(now);
    return rows.map((row) => this.reviveRow(row.doc, row.validity));
  }

  markDrifted(id: string, driftedPaths: string[]): void {
    const post = this.get(id);
    if (!post) return;
    const updated: FeedPost = {
      ...post,
      lifecycle: { ...post.lifecycle, validity: "drifted", driftedPaths },
    };
    this.db.prepare("UPDATE posts SET validity = 'drifted', doc = ? WHERE id = ?").run(JSON.stringify(updated), id);
  }

  private markSuperseded(oldId: string, newId: string): void {
    this.db.prepare("UPDATE posts SET validity = 'superseded', superseded_by = ? WHERE id = ?").run(newId, oldId);
  }

  private expireLazily(nowIso: string): void {
    this.db.prepare("UPDATE posts SET validity = 'expired' WHERE expires_at <= ? AND validity NOT IN ('expired','superseded')").run(nowIso);
  }

  logIngestion(entry: { reader?: string; tokens: number; postCount: number; now?: Date }): void {
    this.db.prepare("INSERT INTO ingestions (at, reader, tokens, post_count) VALUES (?, ?, ?, ?)")
      .run((entry.now ?? new Date()).toISOString(), entry.reader ?? null, entry.tokens, entry.postCount);
  }

  stats(): { posts: number; byType: Record<string, number>; feedsServed: number; tokensServed: number } {
    const typed = this.db.prepare("SELECT type, COUNT(*) AS n FROM posts GROUP BY type").all() as { type: string; n: number }[];
    const byType: Record<string, number> = {};
    let posts = 0;
    for (const row of typed) { byType[row.type] = row.n; posts += row.n; }
    const ing = this.db.prepare("SELECT COUNT(*) AS feeds, COALESCE(SUM(tokens), 0) AS tokens FROM ingestions").get() as { feeds: number; tokens: number };
    return { posts, byType, feedsServed: ing.feeds, tokensServed: ing.tokens };
  }

  private reviveRow(doc: string, validity: string): FeedPost {
    const post = JSON.parse(doc) as FeedPost;
    post.lifecycle.validity = validity as FeedPost["lifecycle"]["validity"];
    return post;
  }

  close(): void {
    this.db.close();
  }
}
