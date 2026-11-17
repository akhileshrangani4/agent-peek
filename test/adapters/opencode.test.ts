// test/adapters/opencode.test.ts
//
// The opencode adapter over both stores: V2's opencode.db and pre-V2 filesystem storage.
// Letters refer to the acceptance list of the V2 adapter PR.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import opencode, { executionFromRow, mergeStores, opencodeDatabases } from "../../src/adapters/opencode/index.js";
import { TranscriptUnreadableError } from "../../src/core/errors.js";
import type { SessionEntry } from "../../src/core/types.js";
import { makeOpencodeHome, opencodeEnv, writeV2Database } from "../helpers/opencode-home.js";
import { withEnv } from "../helpers/tmp-home.js";

const byId = (sessions: SessionEntry[]) => new Map(sessions.map((s) => [s.id, s]));

describe("opencode adapter: legacy filesystem storage (a)", () => {
  it("lists legacy sessions under the 0.6.0 ids, adapter and source type", async () => {
    const home = await makeOpencodeHome({ legacy: true });
    await withEnv(opencodeEnv(home), async () => {
      const sessions = await opencode.scan();
      expect(sessions.map((s) => s.id).sort()).toEqual(["opencode:ses_legacy", "opencode:ses_shared"]);
      for (const s of sessions) {
        expect(s.adapter).toBe("opencode");
        expect(s.sourceType).toBe("directory");
        expect(s.execution).toBeUndefined();
      }
      const legacy = byId(sessions).get("opencode:ses_legacy")!;
      expect(legacy.transcriptPath).toBe(join(home.dir, "storage", "session", "proj-1", "ses_legacy.json"));
      const r = await opencode.read(legacy);
      expect(r.messages.map((m) => m.text)).toEqual(["fix auth", "reading auth.ts\nexport function login(){}"]);
      expect(r.messages[1]!.toolCalls?.[0]).toMatchObject({ name: "read", status: "completed" });
      expect((await opencode.read(legacy, r.nextCursor)).messages).toEqual([]);
    });
  });
});

describe("opencode adapter: V2 opencode.db (b)", () => {
  it("lists sessions, maps parents and reports execution for every outcome", async () => {
    const home = await makeOpencodeHome({ v2: true });
    await withEnv(opencodeEnv(home), async () => {
      const sessions = byId(await opencode.scan());
      expect([...sessions.keys()].sort()).toEqual([
        "opencode:ses_child", "opencode:ses_interrupted", "opencode:ses_running", "opencode:ses_shared", "opencode:ses_top",
      ]);
      const top = sessions.get("opencode:ses_top")!;
      expect(top).toMatchObject({
        adapter: "opencode", sourceType: "database", name: "provider-retry", cwd: "/tmp/repo",
        transcriptPath: join(home.dir, "opencode.db"),
      });
      expect(top.parentSessionId).toBeUndefined();
      expect(sessions.get("opencode:ses_child")!.parentSessionId).toBe("opencode:ses_top");

      expect(top.execution).toEqual({ state: "idle", outcome: "failed", at: "2026-02-02T02:40:04.000Z", sequence: 4 });
      expect(sessions.get("opencode:ses_child")!.execution).toMatchObject({ state: "idle", outcome: "succeeded", sequence: 1 });
      expect(sessions.get("opencode:ses_interrupted")!.execution).toMatchObject({ state: "idle", outcome: "interrupted", sequence: 2 });
      // A user message after the last idle marker: a new turn is running, and the
      // outcome still describes the previous turn (sequence 3 > the idle at sequence 2).
      expect(sessions.get("opencode:ses_running")!.execution).toMatchObject({ state: "running", outcome: "succeeded", sequence: 3 });
    });
  });

  it("reads messages, tool calls and system rows, and honours the cursor", async () => {
    const home = await makeOpencodeHome({ v2: true });
    await withEnv(opencodeEnv(home), async () => {
      const top = byId(await opencode.scan()).get("opencode:ses_top")!;
      const result = await opencode.read(top);
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "system"]);
      expect(result.messages[0]!.text).toBe("continue the task");
      expect(result.messages[1]!.text).toBe("working\nupstream failed");
      expect(result.messages[1]!.toolCalls?.[0]).toMatchObject({ name: "shell", status: "error" });
      expect(result.messages[2]!.text).toContain("HTTP 503");
      expect(result.messages[3]!.text).toBe("failed");
      expect((await opencode.read(top, result.nextCursor)).messages).toEqual([]);
    });
  });

  it("derives execution from a row with no idle marker or an unknown outcome", () => {
    const row = {
      id: "s", parent_id: null, title: null, directory: null, time_created: 1, time_updated: 2,
      last_sequence: 3, idle_seq: null, idle_data: null,
    };
    expect(executionFromRow(row, 2)).toEqual({ state: "running", outcome: undefined, at: undefined, sequence: 3 });
    const odd = { ...row, idle_seq: 3, idle_data: JSON.stringify({ outcome: "exploded" }) };
    expect(executionFromRow(odd, 2)).toMatchObject({ state: "idle", outcome: undefined, at: new Date(2).toISOString() });
  });
});

describe("opencode adapter: both stores (c)", () => {
  it("lists a session present in both stores exactly once, from V2", async () => {
    const home = await makeOpencodeHome({ v2: true, legacy: true });
    await withEnv(opencodeEnv(home), async () => {
      const sessions = await opencode.scan();
      const ids = sessions.map((s) => s.id);
      expect(ids.filter((id) => id === "opencode:ses_shared")).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("opencode:ses_legacy");

      const shared = byId(sessions).get("opencode:ses_shared")!;
      expect(shared).toMatchObject({ sourceType: "database", name: "migrated-session-v2" });
      expect((await opencode.read(shared)).messages[0]!.text).toBe("V2 copy of the shared session");
      // The legacy-only session still reads from filesystem storage.
      const legacy = byId(sessions).get("opencode:ses_legacy")!;
      expect((await opencode.read(legacy)).messages[0]!.text).toBe("fix auth");
    });
  });

  it("mergeStores keeps the first copy of an id, so V2 wins", () => {
    const entry = (id: string, sourceType: SessionEntry["sourceType"]): SessionEntry => ({
      id, adapter: "opencode", transcriptPath: "/x", sourceType, lastSeen: "2026-01-01T00:00:00.000Z", status: "ended",
    });
    const merged = mergeStores([entry("opencode:a", "database")], [entry("opencode:a", "directory"), entry("opencode:b", "directory")]);
    expect(merged.map((e) => [e.id, e.sourceType])).toEqual([["opencode:a", "database"], ["opencode:b", "directory"]]);
  });
});

describe("opencode adapter: no sqlite3 binary (d)", () => {
  it("scans and reads V2 with PATH stripped to an empty directory", async () => {
    const home = await makeOpencodeHome({ v2: true });
    const emptyBin = await mkdtemp(join(tmpdir(), "empty-bin-"));
    await withEnv(opencodeEnv(home, { PATH: emptyBin }), async () => {
      const top = byId(await opencode.scan()).get("opencode:ses_top")!;
      expect(top.execution?.outcome).toBe("failed");
      expect((await opencode.read(top)).messages).toHaveLength(4);
    });
  });
});

describe("opencode adapter: hostile session ids (e)", () => {
  it("reads a session id containing ' and ; and executes nothing", async () => {
    const home = await makeOpencodeHome();
    const dbPath = join(home.dir, "opencode.db");
    const hostile = "ses_q'uote; DROP TABLE session_message; --";
    await writeV2Database(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO session_v2 VALUES (?, NULL, 'Hostile', '/tmp/repo', 1770000040000, 1770000041000)").run(hostile);
    db.prepare("INSERT INTO session_message VALUES ('msg_h1', ?, 'user', 1, 1770000040000, ?)")
      .run(hostile, JSON.stringify({ text: "quoted id" }));
    db.close();
    const before = await digest(dbPath);

    await withEnv(opencodeEnv(home), async () => {
      const entry = byId(await opencode.scan()).get(`opencode:${hostile}`)!;
      expect(entry).toBeDefined();
      const r = await opencode.read(entry);
      expect(r.messages.map((m) => m.text)).toEqual(["quoted id"]);
    });

    expect(await digest(dbPath)).toBe(before);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(check.prepare("SELECT count(*) AS n FROM session_message").get()).toEqual({ n: 13 });
    check.close();
  });
});

describe("opencode adapter: database resolution (g)", () => {
  it("lists sessions from OPENCODE_DB when it points at a fixture", async () => {
    const home = await makeOpencodeHome();
    const elsewhere = await mkdtemp(join(tmpdir(), "opencode-db-"));
    const dbPath = join(elsewhere, "custom.db");
    await writeV2Database(dbPath);
    await withEnv(opencodeEnv(home, { OPENCODE_DB: dbPath }), async () => {
      expect(opencodeDatabases()).toEqual({ primary: dbPath, existing: [dbPath] });
      const sessions = await opencode.scan();
      expect(sessions).toHaveLength(5);
      expect(sessions.every((s) => s.transcriptPath === dbPath)).toBe(true);
      expect((await opencode.read(byId(sessions).get("opencode:ses_top")!)).messages).toHaveLength(4);
    });
  });

  it("resolves a relative OPENCODE_DB against the data dir, as OpenCode does", async () => {
    const home = await makeOpencodeHome();
    await writeV2Database(join(home.dir, "work.db"));
    await withEnv(opencodeEnv(home, { OPENCODE_DB: "work.db" }), async () => {
      expect(opencodeDatabases().primary).toBe(join(home.dir, "work.db"));
      expect(await opencode.scan()).toHaveLength(5);
    });
  });

  it("falls back to opencode.db when OPENCODE_DB is blank", async () => {
    const home = await makeOpencodeHome({ v2: true });
    await withEnv(opencodeEnv(home, { OPENCODE_DB: "   " }), async () => {
      expect(opencodeDatabases().primary).toBe(join(home.dir, "opencode.db"));
      expect(await opencode.scan()).toHaveLength(5);
    });
  });

  it("reads nothing from V2 when OPENCODE_DB is :memory:", async () => {
    const home = await makeOpencodeHome({ v2: true });
    await withEnv(opencodeEnv(home, { OPENCODE_DB: ":memory:" }), async () => {
      expect(opencodeDatabases()).toEqual({ primary: undefined, existing: [] });
      expect(await opencode.scan()).toEqual([]);
    });
  });

  it("reads channel databases beside opencode.db unless channel databases are disabled", async () => {
    const home = await makeOpencodeHome({ v2: true });
    const channel = join(home.dir, "opencode-local.db");
    // Same ids as the primary plus one of its own: the primary's copy wins.
    await writeV2Database(channel, `
      INSERT INTO session_v2 VALUES ('ses_channel', NULL, 'Channel Only', '/tmp/repo', 1770000050000, 1770000051000);
      UPDATE session_v2 SET title = 'From Channel' WHERE id = 'ses_top';
    `);
    // WAL side files are not databases.
    await writeFile(join(home.dir, "opencode-local.db-wal"), "");

    await withEnv(opencodeEnv(home), async () => {
      expect(opencodeDatabases().existing).toEqual([join(home.dir, "opencode.db"), channel]);
      const sessions = byId(await opencode.scan());
      expect(sessions.size).toBe(6);
      expect(sessions.get("opencode:ses_channel")!.transcriptPath).toBe(channel);
      expect(sessions.get("opencode:ses_top")!.name).toBe("provider-retry");
    });
    for (const disabled of ["1", "true"]) {
      await withEnv(opencodeEnv(home, { OPENCODE_DISABLE_CHANNEL_DB: disabled }), async () => {
        expect(opencodeDatabases().existing).toEqual([join(home.dir, "opencode.db")]);
      });
    }
  });

  it("lists channel databases alone when opencode.db is absent", async () => {
    const home = await makeOpencodeHome();
    await writeV2Database(join(home.dir, "opencode-beta.db"));
    await withEnv(opencodeEnv(home), async () => {
      expect(opencodeDatabases()).toEqual({ primary: join(home.dir, "opencode.db"), existing: [join(home.dir, "opencode-beta.db")] });
      expect(await opencode.scan()).toHaveLength(5);
    });
  });

  it("returns no sessions when OpenCode has no data dir at all", async () => {
    const data = await mkdtemp(join(tmpdir(), "opencode-none-"));
    await withEnv({ XDG_DATA_HOME: data, OPENCODE_DB: "", OPENCODE_DISABLE_CHANNEL_DB: "" }, async () => {
      expect(opencodeDatabases().existing).toEqual([]);
      expect(await opencode.scan()).toEqual([]);
    });
  });
});

describe("opencode adapter: unreadable database", () => {
  it("keeps legacy sessions listable and surfaces the scan failure as a warning", async () => {
    const home = await makeOpencodeHome({ legacy: true });
    await writeFile(join(home.dir, "opencode.db"), "not a database");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      await withEnv(opencodeEnv(home), async () => {
        expect((await opencode.scan()).map((s) => s.id).sort()).toEqual(["opencode:ses_legacy", "opencode:ses_shared"]);
      });
    } finally {
      console.warn = warn;
    }
    expect(warnings.join("\n")).toContain("cannot read OpenCode sessions");
  });

  it("throws TranscriptUnreadableError when a listed database disappears before read", async () => {
    const home = await makeOpencodeHome({ v2: true });
    await withEnv(opencodeEnv(home), async () => {
      const top = byId(await opencode.scan()).get("opencode:ses_top")!;
      await rm(join(home.dir, "opencode.db"));
      await mkdir(join(home.dir, "opencode.db"));
      await expect(opencode.read(top)).rejects.toBeInstanceOf(TranscriptUnreadableError);
    });
  });
});

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
