import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore, usageDbPath } from "../src/usage/store.js";
import { SCHEMA_VERSION } from "../src/usage/schema.js";
import type { Invocation, Watermark } from "../src/usage/schema.js";

let home: string | undefined;
function makeStore(): UsageStore {
  home = mkdtempSync(join(tmpdir(), "peek-usage-store-"));
  return new UsageStore({ home });
}
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    sourcePath: "/t/a.jsonl",
    msgIndex: 3,
    callIndex: 0,
    sourceKind: "tool_call",
    adapter: "claude-code",
    agent: "claude",
    sessionId: "s1",
    timestamp: "2026-08-30T12:00:00.000Z",
    tool: "Skill",
    skill: "wayfinder",
    cwd: "/repo",
    status: "completed",
    sidechain: false,
    attributionAgent: null,
    nativeCallId: "toolu_1",
    ...overrides,
  };
}

function watermark(overrides: Partial<Watermark> = {}): Watermark {
  return {
    sourcePath: "/t/a.jsonl",
    adapter: "claude-code",
    sessionId: "s1",
    cursor: "cur",
    msgIndex: 4,
    size: 100,
    mtimeMs: 1,
    scannedAt: "2026-08-30T12:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

describe("UsageStore", () => {
  it("is machine-global, not per-project", () => {
    expect(usageDbPath("/h")).toBe(join("/h", ".agent-peek", "usage.db"));
  });

  it("stamps the schema version", () => {
    const store = makeStore();
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    store.close();
  });

  it("reports empty before any source is recorded", () => {
    const store = makeStore();
    expect(store.isEmpty()).toBe(true);
    store.recordSource([], watermark());
    expect(store.isEmpty()).toBe(false);
    store.close();
  });

  it("round-trips an invocation and its watermark", () => {
    const store = makeStore();
    const inv = invocation();
    store.recordSource([inv], watermark());
    expect(store.allInvocations()).toEqual([inv]);
    expect(store.getWatermark("/t/a.jsonl")).toEqual(watermark());
    store.close();
  });

  it("dedupes on re-scan: recording the same rows twice yields one row each", () => {
    const store = makeStore();
    const rows = [invocation(), invocation({ callIndex: 1, tool: "Bash", skill: null })];
    store.recordSource(rows, watermark());
    store.recordSource(rows, watermark());
    expect(store.allInvocations()).toHaveLength(2);
    store.close();
  });

  it("does not collide a tool call and a slash command at the same message index", () => {
    const store = makeStore();
    store.recordSource([
      invocation({ msgIndex: 7, callIndex: 0, sourceKind: "tool_call" }),
      invocation({ msgIndex: 7, callIndex: 0, sourceKind: "slash_command", tool: "wayfinder" }),
    ], watermark());
    // source_kind is in the primary key precisely so these stay two rows.
    expect(store.allInvocations()).toHaveLength(2);
    store.close();
  });

  it("keeps a watermark as a tombstone once its transcript is gone", () => {
    const store = makeStore();
    store.recordSource([invocation()], watermark());
    store.markDeleted("/t/a.jsonl");
    const w = store.getWatermark("/t/a.jsonl");
    expect(w?.deleted).toBe(true);
    expect(store.tombstones().map((t) => t.sourcePath)).toEqual(["/t/a.jsonl"]);
    // The rows survive: the index is the only remaining evidence of that session.
    expect(store.allInvocations()).toHaveLength(1);
    store.close();
  });

  it("lists adapters it has ever scanned", () => {
    const store = makeStore();
    store.recordSource([], watermark());
    store.recordSource([], watermark({ sourcePath: "/t/b.jsonl", adapter: "codex" }));
    expect(store.observedAdapters()).toEqual(["claude-code", "codex"]);
    store.close();
  });

  it("rolls back rows and watermark together when a write fails", () => {
    const store = makeStore();
    const bad = invocation({ timestamp: null as unknown as string });
    expect(() => store.recordSource([invocation(), bad], watermark())).toThrow();
    // Neither the good row nor the watermark may survive a failed source.
    expect(store.allInvocations()).toHaveLength(0);
    expect(store.getWatermark("/t/a.jsonl")).toBeUndefined();
    store.close();
  });

  it("recovers from a corrupt database by renaming it aside", () => {
    home = mkdtempSync(join(tmpdir(), "peek-usage-corrupt-"));
    const path = usageDbPath(home);
    mkdirSync(join(home, ".agent-peek"), { recursive: true });
    writeFileSync(path, "definitely not a database");
    const store = new UsageStore({ home });
    expect(store.recovered).toBe(true);
    expect(store.isEmpty()).toBe(true);
    store.close();
  });
});
