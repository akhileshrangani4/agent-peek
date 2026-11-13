import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export interface GooseFixtureSession {
  id: string;
  name?: string;
  messages: string[];
}

/** A real Goose-shaped `sessions.db`: the columns the adapter reads, nothing more. */
export async function makeGooseDbHome(sessions: GooseFixtureSession[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "goose-db-"));
  const dir = join(home, ".local", "share", "goose", "sessions");
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "sessions.db"));
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, description TEXT,
        working_dir TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        role TEXT, content_json TEXT, created_timestamp INTEGER, timestamp TEXT);
    `);
    const insertSession = db.prepare(
      "INSERT INTO sessions (id, name, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    const insertMessage = db.prepare(
      "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)");
    for (const s of sessions) {
      insertSession.run(s.id, s.name ?? null, "/tmp/repo", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      s.messages.forEach((text, i) => {
        insertMessage.run(s.id, i % 2 === 0 ? "user" : "assistant",
          JSON.stringify([{ type: "text", text }]), 1770000000 + i);
      });
    }
  } finally {
    db.close();
  }
  return home;
}
