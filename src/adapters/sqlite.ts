// src/adapters/sqlite.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function sqliteJson<T = Record<string, unknown>>(dbPath: string, sql: string): Promise<T[] | undefined> {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return undefined;
  }
}

