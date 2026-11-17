// src/adapters/sqlite.ts
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
// Lazy-load node:sqlite as src/feed/store.ts and src/usage/store.ts do. A static import
// would emit Node's ExperimentalWarning for every command (adapters always load), and
// the bundler rewrites a static `node:sqlite` import to a bare `sqlite` package.
let cachedCtor: typeof DatabaseSync | undefined;
function databaseSyncCtor(): typeof DatabaseSync {
  cachedCtor ??= (nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  return cachedCtor;
}

/**
 * Run one query against a database another tool owns, through the built-in
 * `node:sqlite` driver: no `sqlite3` binary on PATH and no SQL built from strings.
 *
 * Read-only so peek never takes a write lock on a live database; the timeout waits
 * briefly when the owner holds the lock instead of failing at once. Errors propagate:
 * the caller decides whether an unreadable database is fatal (read) or skippable (scan).
 */
export function queryReadOnly<T>(dbPath: string, sql: string, params: SQLInputValue[] = []): T[] {
  const Database = databaseSyncCtor();
  const db = new Database(dbPath, { readOnly: true, timeout: 3000 });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
