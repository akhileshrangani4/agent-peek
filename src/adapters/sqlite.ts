// src/adapters/sqlite.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function sqliteJson<T = Record<string, unknown>>(dbPath: string, sql: string): Promise<T[] | undefined> {
  try {
    // -readonly: never take a write lock or create WAL sidecars next to a live
    // database owned by another tool. .timeout: wait briefly instead of failing
    // immediately when the writer holds the lock.
    const { stdout } = await execFileAsync("sqlite3",
      ["-json", "-readonly", "-cmd", ".timeout 3000", dbPath, sql], {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.warn("[agent-peek] sqlite3 binary not found; install sqlite3 to read this database");
    }
    return undefined;
  }
}
