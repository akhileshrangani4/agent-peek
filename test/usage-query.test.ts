import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";
import { queryUsage, coverage } from "../src/usage/query.js";
import type { Invocation, Watermark } from "../src/usage/schema.js";

let home: string | undefined;
function makeStore(): UsageStore {
  home = mkdtempSync(join(tmpdir(), "peek-usage-query-"));
  return new UsageStore({ home });
}
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

let seq = 0;
function inv(overrides: Partial<Invocation> = {}): Invocation {
  seq += 1;
  return {
    sourcePath: "/t/a.jsonl", msgIndex: seq, callIndex: 0, sourceKind: "tool_call",
    adapter: "claude-code", agent: "claude", sessionId: "s1",
    timestamp: "2026-08-30T12:00:00.000Z", tool: "Skill", skill: "wayfinder",
    cwd: "/repo", status: "completed", sidechain: false, attributionAgent: null,
    nativeCallId: null, ...overrides,
  };
}

function wm(overrides: Partial<Watermark> = {}): Watermark {
  return {
    sourcePath: "/t/a.jsonl", adapter: "claude-code", sessionId: "s1", cursor: null,
    msgIndex: 0, size: 1, mtimeMs: 1, scannedAt: "2026-08-30T12:00:00.000Z",
    deleted: false, ...overrides,
  };
}

function seeded(rows: Invocation[]): UsageStore {
  const store = makeStore();
  store.recordSource(rows, wm());
  return store;
}

describe("queryUsage", () => {
  it("counts by tool, most used first", () => {
    const store = seeded([
      inv({ tool: "Bash", skill: null }), inv({ tool: "Bash", skill: null }), inv({ tool: "Skill" }),
    ]);
    expect(queryUsage(store).map((r) => [r.tool, r.count])).toEqual([["Bash", 2], ["Skill", 1]]);
    store.close();
  });

  it("groups by skill, which is the question this index exists to answer", () => {
    const store = seeded([
      inv({ skill: "wayfinder" }), inv({ skill: "wayfinder" }), inv({ skill: "grilling" }),
    ]);
    const rows = queryUsage(store, { tool: "Skill", groupBy: ["skill"] });
    expect(rows.map((r) => [r.skill, r.count])).toEqual([["wayfinder", 2], ["grilling", 1]]);
    store.close();
  });

  it("separates agent-initiated from user-initiated invocations", () => {
    const store = seeded([
      inv({ skill: "review" }),
      inv({ sourceKind: "slash_command", tool: "review", skill: "review" }),
      inv({ sourceKind: "slash_command", tool: "review", skill: "review" }),
    ]);
    const rows = queryUsage(store, { skill: "review", groupBy: ["source_kind"] });
    expect(rows.map((r) => [r.sourceKind, r.count]))
      .toEqual([["slash_command", 2], ["tool_call", 1]]);
    store.close();
  });

  it("reports first and last seen for each group", () => {
    const store = seeded([
      inv({ timestamp: "2026-08-01T00:00:00.000Z" }),
      inv({ timestamp: "2026-08-30T00:00:00.000Z" }),
    ]);
    const [row] = queryUsage(store);
    expect(row?.firstSeen).toBe("2026-08-01T00:00:00.000Z");
    expect(row?.lastSeen).toBe("2026-08-30T00:00:00.000Z");
    store.close();
  });

  it("buckets by UTC day by default", () => {
    const store = seeded([
      inv({ timestamp: "2026-08-30T23:00:00.000Z" }),
      inv({ timestamp: "2026-08-30T01:00:00.000Z" }),
    ]);
    expect(queryUsage(store, { groupBy: ["day"] }).map((r) => [r.day, r.count]))
      .toEqual([["2026-08-30", 2]]);
    store.close();
  });

  it("buckets by local day when given an offset", () => {
    // 21:00 PDT is already tomorrow in UTC; bucketing at write time would have frozen
    // whichever timezone the machine had at scan time.
    const store = seeded([inv({ timestamp: "2026-08-31T04:00:00.000Z" })]);
    expect(queryUsage(store, { groupBy: ["day"] })[0]?.day).toBe("2026-08-31");
    expect(queryUsage(store, { groupBy: ["day"], tzOffset: "-07:00" })[0]?.day).toBe("2026-08-30");
    store.close();
  });

  it("rejects a malformed timezone offset rather than building SQL from it", () => {
    const store = seeded([inv()]);
    expect(() => queryUsage(store, { groupBy: ["day"], tzOffset: "'; DROP TABLE invocations; --" }))
      .toThrow(/invalid tzOffset/);
    expect(store.allInvocations()).toHaveLength(1);
    store.close();
  });

  it("filters by time window, inclusive of since and exclusive of until", () => {
    const store = seeded([
      inv({ timestamp: "2026-08-01T00:00:00.000Z" }),
      inv({ timestamp: "2026-08-15T00:00:00.000Z" }),
      inv({ timestamp: "2026-08-30T00:00:00.000Z" }),
    ]);
    const rows = queryUsage(store, { since: "2026-08-15T00:00:00.000Z", until: "2026-08-30T00:00:00.000Z" });
    expect(rows[0]?.count).toBe(1);
    store.close();
  });

  it("separates a subagent's choice from the user's own", () => {
    const store = seeded([
      inv({ skill: "mattpocock-skills:research", sidechain: true, attributionAgent: "general-purpose" }),
      inv({ skill: "wayfinder" }),
    ]);
    const side = queryUsage(store, { sidechain: true, groupBy: ["skill"] });
    expect(side.map((r) => r.skill)).toEqual(["mattpocock-skills:research"]);
    const byAgent = queryUsage(store, { attributionAgent: "general-purpose", groupBy: ["skill"] });
    expect(byAgent).toHaveLength(1);
    store.close();
  });

  it("keeps adapter and agent as independent filters", () => {
    const store = makeStore();
    store.recordSource([
      inv({ adapter: "tmux", agent: null }),
      inv({ adapter: null, agent: "cursor" }),
    ], wm());
    expect(queryUsage(store, { adapter: "tmux" })[0]?.count).toBe(1);
    expect(queryUsage(store, { agent: "cursor" })[0]?.count).toBe(1);
    store.close();
  });

  it("groups by more than one dimension at once", () => {
    const store = seeded([
      inv({ skill: "a", agent: "claude" }), inv({ skill: "a", agent: "codex" }),
    ]);
    const rows = queryUsage(store, { groupBy: ["skill", "agent"] });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1)).toBe(true);
    store.close();
  });

  it("honours a limit", () => {
    const store = seeded([inv({ tool: "a" }), inv({ tool: "b" }), inv({ tool: "c" })]);
    expect(queryUsage(store, { limit: 2 })).toHaveLength(2);
    store.close();
  });

  it("rejects an unknown grouping", () => {
    const store = seeded([inv()]);
    expect(() => queryUsage(store, { groupBy: ["nope" as never] })).toThrow(/invalid groupBy/);
    store.close();
  });

  it("returns nothing for an empty index rather than failing", () => {
    const store = makeStore();
    expect(queryUsage(store)).toEqual([]);
    store.close();
  });
});

describe("coverage", () => {
  it("reports an empty index honestly", () => {
    const store = makeStore();
    expect(coverage(store)).toMatchObject({
      observedAdapters: [], tombstonedSources: 0, liveSources: 0, totalInvocations: 0,
    });
    store.close();
  });

  it("distinguishes a counted-then-deleted source from one never observed", () => {
    // This is the distinction ticket 06 needs: "never used" must not render the same
    // as "never able to observe".
    const store = makeStore();
    store.recordSource([inv()], wm());
    store.recordSource([inv({ sourcePath: "/t/b.jsonl" })], wm({ sourcePath: "/t/b.jsonl" }));
    store.markDeleted("/t/b.jsonl");

    const report = coverage(store);
    expect(report.tombstonedSources).toBe(1);
    expect(report.liveSources).toBe(1);
    expect(report.observedAdapters).toEqual(["claude-code"]);
    // Rows from the deleted source are still counted: the index outlives its sources.
    expect(report.totalInvocations).toBe(2);
    store.close();
  });

  it("reports the span of observed history", () => {
    const store = seeded([
      inv({ timestamp: "2026-07-01T00:00:00.000Z" }),
      inv({ timestamp: "2026-08-30T00:00:00.000Z" }),
    ]);
    const report = coverage(store);
    expect(report.earliest).toBe("2026-07-01T00:00:00.000Z");
    expect(report.latest).toBe("2026-08-30T00:00:00.000Z");
    store.close();
  });
});
