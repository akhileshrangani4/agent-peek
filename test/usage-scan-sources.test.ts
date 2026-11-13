// D3.6: usage-scan watermarks must identify a session, not just a path on disk.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";
import { scanAdapter, sourceKey } from "../src/usage/scan.js";
import goose from "../src/adapters/goose/index.js";
import type { Adapter } from "../src/adapters/types.js";
import type { RawMessage, SessionEntry } from "../src/core/types.js";
import { encodeCursor } from "../src/core/cursor.js";
import { makeGooseDbHome } from "./helpers/goose-db.js";
import { withEnv } from "./helpers/tmp-home.js";

let dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const TS = "2026-08-30T12:00:00.000Z";

function sessionIds(store: UsageStore, adapter: string): string[] {
  return (store.handle()
    .prepare("SELECT session_id FROM watermarks WHERE adapter = ? AND deleted = 0 ORDER BY session_id")
    .all(adapter) as { session_id: string }[]).map((r) => r.session_id);
}

/**
 * Two sessions sharing one database file, each with one tool call. Stands in for any
 * database-backed adapter that does record tool calls, which Goose today does not.
 */
function sharedDbAdapter(dbPath: string): Adapter {
  const entry = (id: string): SessionEntry => ({
    id: `fake-db:${id}`, adapter: "fake-db", transcriptPath: dbPath, cwd: "/repo",
    lastSeen: TS, status: "idle", sourceType: "database",
  });
  const messages = (tool: string): RawMessage[] => [
    { role: "assistant", raw: {}, timestamp: TS, toolCalls: [{ name: tool, input: {}, status: "completed" }] },
  ];
  return {
    name: "fake-db",
    scan: async () => [entry("a"), entry("b")],
    read: async (e) => ({
      messages: messages(e.id === "fake-db:a" ? "Read" : "Edit"),
      nextCursor: encodeCursor({ adapter: "fake-db", byteOffset: 1, msgIndex: 1 }),
      eof: true,
    }),
  };
}

describe("usage scan: several sessions in one database (Goose)", () => {
  it("indexes both Goose sessions in one sessions.db", async () => {
    const gooseHome = await makeGooseDbHome([
      { id: "s-one", messages: ["first"] },
      { id: "s-two", messages: ["second"] },
    ]);
    dirs.push(gooseHome);
    const store = new UsageStore({ home: tmp("peek-goose-usage-") });
    await withEnv({ HOME: gooseHome }, async () => {
      const result = await scanAdapter(goose, store);
      expect(result.errors).toEqual([]);
      expect(result.sourcesScanned).toBe(2);
      expect(result.sourcesSkipped).toBe(0);
      expect(sessionIds(store, "goose")).toEqual(["s-one", "s-two"]);
    });
  });

  it("keeps invocations from every session sharing a database file", async () => {
    const db = join(tmp("peek-fake-db-"), "sessions.db");
    writeFileSync(db, "x");
    const store = new UsageStore({ home: tmp("peek-fake-usage-") });
    const result = await scanAdapter(sharedDbAdapter(db), store);
    expect(result.sourcesScanned).toBe(2);
    const rows = store.allInvocations();
    expect(rows.map((r) => [r.sessionId, r.tool]).sort()).toEqual([["a", "Read"], ["b", "Edit"]]);
  });

  it("skips every session of an unchanged database on the next scan", async () => {
    const db = join(tmp("peek-fake-db-"), "sessions.db");
    writeFileSync(db, "x");
    const store = new UsageStore({ home: tmp("peek-fake-usage-") });
    await scanAdapter(sharedDbAdapter(db), store);
    const again = await scanAdapter(sharedDbAdapter(db), store);
    expect(again.sourcesScanned).toBe(0);
    expect(again.sourcesSkipped).toBe(2);
    expect(store.allInvocations().length).toBe(2);
  });

  it("does not tombstone a 0.6 watermark keyed by the bare database path", async () => {
    const db = join(tmp("peek-fake-db-"), "sessions.db");
    writeFileSync(db, "x");
    const store = new UsageStore({ home: tmp("peek-fake-usage-") });
    // What 0.6 wrote for the first session it saw in a shared database.
    store.recordSource([], {
      sourcePath: db, adapter: "fake-db", sessionId: "a", cursor: null, msgIndex: 1,
      size: 1, mtimeMs: 0, scannedAt: TS, deleted: false,
    });
    const result = await scanAdapter(sharedDbAdapter(db), store);
    expect(result.sourcesTombstoned).toBe(0);
    expect(store.getWatermark(db)?.deleted).toBe(false);
  });

  it("keys database sources by session and file sources by path alone", () => {
    const base = { lastSeen: TS, status: "idle" as const };
    expect(sourceKey({ ...base, id: "goose:s1", adapter: "goose", transcriptPath: "/d/sessions.db", sourceType: "database" }))
      .toBe("/d/sessions.db#goose:s1");
    expect(sourceKey({ ...base, id: "claude-code:s1", adapter: "claude-code", transcriptPath: "/p/s1.jsonl", sourceType: "file" }))
      .toBe("/p/s1.jsonl");
  });
});
