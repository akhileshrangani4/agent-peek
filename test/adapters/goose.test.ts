// test/adapters/goose.test.ts
import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import goose from "../../src/adapters/goose/index.js";
import { withEnv } from "../helpers/tmp-home.js";

describe("goose adapter", () => {
  it("reads legacy JSONL sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "goose-legacy-"));
    const dir = join(home, ".local", "share", "goose", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "20260101_120000.jsonl"),
      `{"id":"20260101_120000","working_dir":"/tmp/repo","description":"test"}\n`
      + `{"role":"user","created":1770000000,"content":[{"type":"text","text":"hello"}]}\n`
      + `{"role":"assistant","created":1770000001,"content":[{"type":"text","text":"hi"}]}\n`,
      "utf8");

    await withEnv({ HOME: home }, async () => {
      const sessions = await goose.scan();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe("goose:20260101_120000");
      expect(sessions[0]!.cwd).toBe("/tmp/repo");
      const r = await goose.read(sessions[0]!);
      expect(r.messages.map((m) => m.text)).toEqual(["hello", "hi"]);
    });
  });

  it("reads SQLite sessions through sqlite3 when available", async () => {
    const home = await mkdtemp(join(tmpdir(), "goose-db-"));
    const db = join(home, ".local", "share", "goose", "sessions", "sessions.db");
    await mkdir(join(db, ".."), { recursive: true });
    await writeFile(db, "", "utf8");
    await withFakeSqlite(async (binDir) => {
      await withEnv({ HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
      const sessions = await goose.scan();
      expect(sessions[0]!.id).toBe("goose:20260101_1");
      expect(sessions[0]!.name).toBe("db-session");
      expect(sessions[0]!.cwd).toBe("/tmp/repo");
        const r = await goose.read(sessions[0]!);
        expect(r.messages.map((m) => m.text)).toEqual(["question", "answer"]);
      });
    });
  });
});

async function withFakeSqlite<T>(fn: (binDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-fake-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const script = join(binDir, "sqlite3");
  await writeFile(script, `#!/usr/bin/env node
const sql = process.argv.slice(2).join(" ");
if (sql.includes("FROM sessions")) {
  process.stdout.write(JSON.stringify([
    { id: "20260101_1", name: "DB Session", working_dir: "/tmp/repo", updated_at: "2026-01-01T00:00:00Z" },
  ]));
} else if (sql.includes("FROM messages")) {
  process.stdout.write(JSON.stringify([
    { role: "user", content_json: JSON.stringify([{ type: "text", text: "question" }]), created_timestamp: 1770000000 },
    { role: "assistant", content_json: JSON.stringify([{ type: "text", text: "answer" }]), created_timestamp: 1770000001 },
  ]));
} else {
  process.stdout.write("[]");
}
`, "utf8");
  await chmod(script, 0o755);
  return fn(binDir);
}
