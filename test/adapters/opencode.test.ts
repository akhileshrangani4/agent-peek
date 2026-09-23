// test/adapters/opencode.test.ts
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import opencode from "../../src/adapters/opencode/index.js";
import { withEnv } from "../helpers/tmp-home.js";

const execFileAsync = promisify(execFile);

describe("opencode adapter", () => {
  it("scans and reads OpenCode V2 SQLite storage", async () => {
    const data = await mkdtemp(join(tmpdir(), "opencode-v2-"));
    const opencodeDir = join(data, "opencode");
    const db = join(opencodeDir, "opencode.db");
    await mkdir(opencodeDir, { recursive: true });
    await execFileAsync("sqlite3", [db, schema()]);

    await withEnv({ XDG_DATA_HOME: data }, async () => {
      const sessions = await opencode.scan();
      expect(sessions.map((session) => session.id)).toEqual(["opencode:ses_top", "opencode:ses_child"]);
      const top = sessions[0]!;
      expect(top.name).toBe("provider-retry");
      expect(top.cwd).toBe("/tmp/repo");
      expect(top.sourceType).toBe("database");
      expect(top.execution).toMatchObject({ state: "idle", outcome: "failed", sequence: 4 });
      expect(sessions[1]!.parentSessionId).toBe("opencode:ses_top");

      const result = await opencode.read(top);
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "system", "system"]);
      expect(result.messages[0]!.text).toBe("continue the task");
      expect(result.messages[1]!.text).toBe("working\nupstream failed");
      expect(result.messages[1]!.toolCalls?.[0]).toMatchObject({ name: "shell", status: "error" });
      expect(result.messages[2]!.text).toContain("HTTP 503");
      expect(result.messages[3]!.text).toBe("failed");

      const delta = await opencode.read(top, result.nextCursor);
      expect(delta.messages).toEqual([]);
    });
  });

  it("returns no sessions when V2 storage is absent", async () => {
    const data = await mkdtemp(join(tmpdir(), "opencode-empty-"));
    await withEnv({ XDG_DATA_HOME: data }, async () => {
      expect(await opencode.scan()).toEqual([]);
    });
  });
});

function schema(): string {
  return `
    CREATE TABLE session_v2 (
      id text PRIMARY KEY,
      parent_id text,
      title text,
      directory text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL,
      seq integer NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
    INSERT INTO session_v2 VALUES
      ('ses_top', NULL, 'Provider Retry', '/tmp/repo', 1770000000000, 1770000004000),
      ('ses_child', 'ses_top', 'Child', '/tmp/repo', 1770000000100, 1770000001100);
    INSERT INTO session_message VALUES
      ('msg_1', 'ses_top', 'user', 1, 1770000000000, '{"time":{"created":1770000000000},"text":"continue the task"}'),
      ('msg_2', 'ses_top', 'assistant', 2, 1770000001000, '{"time":{"created":1770000001000},"content":[{"type":"text","text":"working"},{"type":"tool","name":"shell","state":{"status":"error","error":"upstream failed"}}]}'),
      ('msg_3', 'ses_top', 'compaction', 3, 1770000002000, '{"time":{"created":1770000002000},"error":{"type":"provider.quota","message":"HTTP 503"}}'),
      ('msg_4', 'ses_top', 'idle', 4, 1770000004000, '{"time":{"created":1770000004000},"outcome":"failed"}'),
      ('msg_c1', 'ses_child', 'idle', 1, 1770000001100, '{"time":{"created":1770000001100},"outcome":"succeeded"}');
  `;
}
