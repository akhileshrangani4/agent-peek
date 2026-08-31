// src/usage/store.ts
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { BASE_SCHEMA, MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import type { Invocation, Watermark } from "./schema.js";

const CORRUPTION_PATTERN = /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i;

function isCorruptionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return CORRUPTION_PATTERN.test(message);
}

const nodeRequire = createRequire(import.meta.url);
// Lazy-load node:sqlite for the same reason src/feed/store.ts does: requiring it emits
// Node's ExperimentalWarning on stderr, which must not happen for commands that never
// touch the index.
let cachedCtor: typeof DatabaseSync | undefined;
function databaseSyncCtor(): typeof DatabaseSync {
  cachedCtor ??= (nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  return cachedCtor;
}

/** Machine-global, unlike the feed's per-project databases. */
export function usageDbPath(home?: string): string {
  return join(home ?? homedir(), ".agent-peek", "usage.db");
}

interface InvocationRow {
  source_path: string;
  msg_index: number;
  call_index: number;
  source_kind: string;
  adapter: string | null;
  agent: string | null;
  session_id: string | null;
  timestamp: string;
  tool: string;
  skill: string | null;
  cwd: string | null;
  status: string | null;
  sidechain: number;
  attribution_agent: string | null;
  native_call_id: string | null;
}

function toInvocation(row: InvocationRow): Invocation {
  return {
    sourcePath: row.source_path,
    msgIndex: row.msg_index,
    callIndex: row.call_index,
    sourceKind: row.source_kind as Invocation["sourceKind"],
    adapter: row.adapter,
    agent: row.agent,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    tool: row.tool,
    skill: row.skill,
    cwd: row.cwd,
    status: row.status,
    sidechain: row.sidechain === 1,
    attributionAgent: row.attribution_agent,
    nativeCallId: row.native_call_id,
  };
}

export class UsageStore {
  private db!: DatabaseSync;
  readonly path: string;
  recovered = false;

  constructor(opts: { home?: string; path?: string } = {}) {
    this.path = opts.path ?? usageDbPath(opts.home);
    mkdirSync(dirname(this.path), { recursive: true });
    this.open();
  }

  private open(): void {
    try {
      this.openDb();
    } catch (err) {
      // Rename-and-restart is reserved for genuine corruption. A version mismatch
      // never lands here: that path is forward migrations only.
      if (!isCorruptionError(err)) throw err;
      if (existsSync(this.path)) {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        this.recovered = true;
      }
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${this.path}${suffix}`;
        if (existsSync(sidecar)) {
          try { renameSync(sidecar, `${sidecar}.corrupt-${Date.now()}`); } catch { /* ignore */ }
        }
      }
      this.openDb();
    }
  }

  private openDb(): void {
    this.db = new (databaseSyncCtor())(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Concurrency is WAL plus this timeout, with no scan lock: a deterministic primary
    // key makes a concurrent double-scan wasted CPU, never wrong data.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(BASE_SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string } | undefined;
    const current = row ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) return; // written by a newer peek; leave it alone
    for (const migration of MIGRATIONS) {
      if (migration.to > current) this.db.exec(migration.sql);
    }
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /**
   * One source's rows and its watermark, atomically. The transaction is what stops a
   * crash from advancing a watermark past rows that were never written.
   *
   * `replace` is for a re-scan from 0 after a shrink: the primary key dedupes rows the
   * new read reproduces, but records past the new EOF would survive as orphans of a
   * file version that no longer exists, so the source's rows go first.
   */
  recordSource(invocations: Invocation[], watermark: Watermark, opts: { replace?: boolean } = {}): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (opts.replace) {
        this.db.prepare("DELETE FROM invocations WHERE source_path = ?").run(watermark.sourcePath);
      }
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO invocations
         (source_path, msg_index, call_index, source_kind, adapter, agent, session_id,
          timestamp, tool, skill, cwd, status, sidechain, attribution_agent, native_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const inv of invocations) {
        stmt.run(
          inv.sourcePath, inv.msgIndex, inv.callIndex, inv.sourceKind,
          inv.adapter, inv.agent, inv.sessionId, inv.timestamp, inv.tool, inv.skill,
          inv.cwd, inv.status, inv.sidechain ? 1 : 0, inv.attributionAgent, inv.nativeCallId,
        );
      }
      this.writeWatermark(watermark);
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  private writeWatermark(w: Watermark): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO watermarks
       (source_path, adapter, session_id, cursor, msg_index, size, mtime_ms, scanned_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      w.sourcePath, w.adapter, w.sessionId, w.cursor, w.msgIndex,
      w.size, w.mtimeMs, w.scannedAt, w.deleted ? 1 : 0,
    );
  }

  getWatermark(sourcePath: string): Watermark | undefined {
    const row = this.db.prepare("SELECT * FROM watermarks WHERE source_path = ?").get(sourcePath) as
      | Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      sourcePath: row.source_path as string,
      adapter: row.adapter as string,
      sessionId: (row.session_id as string | null) ?? null,
      cursor: (row.cursor as string | null) ?? null,
      msgIndex: row.msg_index as number,
      size: row.size as number,
      mtimeMs: row.mtime_ms as number,
      scannedAt: row.scanned_at as string,
      deleted: (row.deleted as number) === 1,
    };
  }

  /**
   * Mark a source whose transcript is gone. The row becomes a tombstone: it is what
   * distinguishes "counted, transcript since deleted" from "never observed".
   */
  markDeleted(sourcePath: string, now = new Date()): void {
    this.db.prepare("UPDATE watermarks SET deleted = 1, scanned_at = ? WHERE source_path = ?")
      .run(now.toISOString(), sourcePath);
  }

  /** Tombstoned sources: scanned once, transcript since deleted. */
  tombstones(): Watermark[] {
    const rows = this.db.prepare("SELECT source_path FROM watermarks WHERE deleted = 1").all() as
      { source_path: string }[];
    return rows.map((r) => this.getWatermark(r.source_path)!).filter(Boolean);
  }

  /** Adapters that have ever been scanned. Ticket 06 needs this for coverage. */
  observedAdapters(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT adapter FROM watermarks ORDER BY adapter").all() as
      { adapter: string }[];
    return rows.map((r) => r.adapter);
  }

  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM watermarks").get() as { n: number };
    return row.n === 0;
  }

  /** Escape hatch for the query layer. Not exported from the package. */
  handle(): DatabaseSync {
    return this.db;
  }

  allInvocations(): Invocation[] {
    const rows = this.db.prepare("SELECT * FROM invocations ORDER BY timestamp").all() as unknown as InvocationRow[];
    return rows.map(toInvocation);
  }

  close(): void {
    this.db.close();
  }
}
