import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import goose from "../../src/adapters/goose/index.js";
import { withEnv } from "../helpers/tmp-home.js";
import { makeGooseDbHome } from "../helpers/goose-db.js";

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

  // D3.7: Goose used to shell out to the `sqlite3` CLI, so on a machine without that
  // binary every database session was invisible. PATH is stripped to an empty dir to
  // prove nothing is spawned.
  it("reads SQLite sessions with no sqlite3 binary on PATH", async () => {
    const home = await makeGooseDbHome([
      { id: "20260101_1", name: "DB Session", messages: ["question", "answer"] },
    ]);
    const emptyBin = await mkdtemp(join(tmpdir(), "goose-nobin-"));
    await withEnv({ HOME: home, PATH: emptyBin }, async () => {
      const sessions = await goose.scan();
      expect(sessions.map((s) => s.id)).toEqual(["goose:20260101_1"]);
      expect(sessions[0]!.name).toBe("db-session");
      expect(sessions[0]!.cwd).toBe("/tmp/repo");
      expect(sessions[0]!.sourceType).toBe("database");
      const r = await goose.read(sessions[0]!);
      expect(r.messages.map((m) => m.text)).toEqual(["question", "answer"]);
      expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });

  it("binds the session id as a parameter, so quotes cannot change the query", async () => {
    const home = await makeGooseDbHome([
      { id: "o'brien", messages: ["mine"] },
      { id: "other", messages: ["not mine"] },
    ]);
    await withEnv({ HOME: home }, async () => {
      const sessions = await goose.scan();
      const quoted = sessions.find((s) => s.id === "goose:o'brien")!;
      const r = await goose.read(quoted);
      expect(r.messages.map((m) => m.text)).toEqual(["mine"]);
    });
  });

  it("resumes from a cursor within one database session", async () => {
    const home = await makeGooseDbHome([{ id: "s1", messages: ["one", "two", "three"] }]);
    await withEnv({ HOME: home }, async () => {
      const [session] = await goose.scan();
      const first = await goose.read(session!);
      expect(first.messages.length).toBe(3);
      const again = await goose.read(session!, first.nextCursor);
      expect(again.messages).toEqual([]);
    });
  });

  it("warns and keeps legacy sessions when the database is not a Goose store", async () => {
    const home = await mkdtemp(join(tmpdir(), "goose-bad-db-"));
    const dir = join(home, ".local", "share", "goose", "sessions");
    await mkdir(dir, { recursive: true });
    new DatabaseSync(join(dir, "sessions.db")).close();
    await writeFile(join(dir, "legacy.jsonl"), `{"working_dir":"/tmp/repo"}\n`, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withEnv({ HOME: home }, async () => {
        const sessions = await goose.scan();
        expect(sessions.map((s) => s.id)).toEqual(["goose:legacy"]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot read Goose sessions"));
    } finally {
      warn.mockRestore();
    }
  });

  it("read throws TranscriptUnreadableError when the database cannot be queried", async () => {
    const home = await mkdtemp(join(tmpdir(), "goose-unreadable-"));
    const db = join(home, "sessions.db");
    new DatabaseSync(db).close();
    await expect(goose.read({
      id: "goose:x", adapter: "goose", transcriptPath: db, sourceType: "database",
      lastSeen: new Date().toISOString(), status: "ended",
    })).rejects.toThrow(/cannot query/);
  });
});
