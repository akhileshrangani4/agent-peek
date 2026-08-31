import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";
import { buildUsageReport } from "../src/usage/report.js";
import { queryUsage } from "../src/usage/query.js";
import type { Invocation, Watermark } from "../src/usage/schema.js";
import type { UsageRow } from "../src/usage/query.js";

let home: string | undefined;
function makeStore(): UsageStore {
  home = mkdtempSync(join(tmpdir(), "peek-usage-report-"));
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
    adapter: "claude-code", agent: "claude-code", sessionId: "s1",
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

describe("skillsOnly filter", () => {
  it("counts a skill invoked by tool call and by slash command together", () => {
    // `tool: "Skill"` would drop the slash rows: a slash invocation stores the command
    // name in `tool`, which is how 14 skills on the source machine went missing.
    const store = makeStore();
    store.recordSource([
      inv({ tool: "Skill", skill: "review", sourceKind: "tool_call" }),
      inv({ tool: "review", skill: "review", sourceKind: "slash_command" }),
      inv({ tool: "Bash", skill: null }),
    ], wm());
    expect(queryUsage(store, { skillsOnly: true, groupBy: ["skill"] }))
      .toEqual([expect.objectContaining({ skill: "review", count: 2 })]);
    expect(queryUsage(store, { tool: "Skill", groupBy: ["skill"] })[0]?.count).toBe(1);
    store.close();
  });

  it("excludes invocations that name no skill", () => {
    const store = makeStore();
    store.recordSource([inv({ tool: "Bash", skill: null }), inv()], wm());
    const rows = queryUsage(store, { skillsOnly: true, groupBy: ["tool"] });
    expect(rows.map((r) => r.tool)).toEqual(["Skill"]);
    store.close();
  });
});

describe("buildUsageReport", () => {
  it("reports an empty index as empty rather than as zero usage", async () => {
    const store = makeStore();
    const report = await buildUsageReport(store, {}, { home });
    expect(report.empty).toBe(true);
    expect(report.rows).toEqual([]);
    expect(report.totalInvocations).toBe(0);
    store.close();
  });

  it("marks truncation so a top-N is never mistaken for the whole set", async () => {
    const store = makeStore();
    store.recordSource([inv({ skill: "a" }), inv({ skill: "b" }), inv({ skill: "c" })], wm());
    const limited = await buildUsageReport(store, { groupBy: ["skill"], limit: 2 }, { home });
    expect(limited.truncated).toBe(true);
    expect(limited.rows).toHaveLength(2);
    expect(limited.groupsReturned).toBe(2);
    const full = await buildUsageReport(store, { groupBy: ["skill"], limit: 10 }, { home });
    expect(full.truncated).toBe(false);
    store.close();
  });

  it("returns exactly N rows for --limit N when N rows qualify, after filtering", async () => {
    // Limiting in SQL and filtering afterwards trims the tail twice: a request for 8
    // came back with 5 plus a claim that more existed, which is the exact ambiguity
    // `truncated` exists to remove.
    const store = makeStore();
    const rows = Array.from({ length: 10 }, (_, i) => inv({ skill: `s${i}` }));
    store.recordSource(rows, wm());
    // Drop half the rows, as builtin resolution does.
    const keepRow = (row: UsageRow) => Number((row.skill ?? "s0").slice(1)) % 2 === 0;
    const report = await buildUsageReport(store, { groupBy: ["skill"], limit: 3 }, { home, keepRow });
    expect(report.rows).toHaveLength(3);
    expect(report.groupsReturned).toBe(3);
    expect(report.truncated).toBe(true);
    expect(report.rows.every((r) => keepRow(r))).toBe(true);
    store.close();
  });

  it("is not truncated once the filtered set is exhausted", async () => {
    const store = makeStore();
    store.recordSource(Array.from({ length: 4 }, (_, i) => inv({ skill: `s${i}` })), wm());
    const keepRow = (row: UsageRow) => row.skill === "s0" || row.skill === "s1";
    const report = await buildUsageReport(store, { groupBy: ["skill"], limit: 10 }, { home, keepRow });
    expect(report.rows).toHaveLength(2);
    expect(report.truncated).toBe(false);
    store.close();
  });

  it("reports a per-adapter window, because retention is per-agent", async () => {
    // Claude Code deletes at 30 days; Codex keeps everything. One global span would
    // claim a year of coverage for the agent whose history is actually capped.
    const store = makeStore();
    store.recordSource([
      inv({ adapter: "claude-code", timestamp: "2026-08-01T00:00:00.000Z" }),
      inv({ adapter: "claude-code", timestamp: "2026-08-31T00:00:00.000Z" }),
    ], wm());
    store.recordSource([
      inv({ sourcePath: "/t/b.jsonl", adapter: "codex", timestamp: "2025-09-22T00:00:00.000Z" }),
    ], wm({ sourcePath: "/t/b.jsonl", adapter: "codex" }));

    const report = await buildUsageReport(store, {}, { home });
    const byAdapter = Object.fromEntries(report.windows.map((w) => [w.adapter, w.days]));
    expect(byAdapter["claude-code"]).toBe(30);
    expect(byAdapter.codex).toBe(1);
    // The global window spans both and would overstate claude-code's coverage.
    expect(report.window.days).toBeGreaterThan(300);
    store.close();
  });

  it("counts a tombstoned source in the total but not as live", async () => {
    const store = makeStore();
    store.recordSource([inv()], wm());
    store.recordSource([inv({ sourcePath: "/t/b.jsonl" })], wm({ sourcePath: "/t/b.jsonl" }));
    store.markDeleted("/t/b.jsonl");
    const report = await buildUsageReport(store, {}, { home });
    expect(report.sources).toEqual({ live: 1, tombstoned: 1, total: 2 });
    expect(report.totalInvocations).toBe(2);
    store.close();
  });

  it("names agents whose usage cannot be observed, distinct from unused", async () => {
    const store = makeStore();
    store.recordSource([inv()], wm());
    const report = await buildUsageReport(store, {}, { home });
    // Only agents with a root present on this machine are reported; a mkdtemp home has
    // none, so the lists are empty rather than claiming blindness about absent agents.
    expect(Array.isArray(report.blindSpots)).toBe(true);
    expect(report.blindSpots.every((s) => s.reason === "no-adapter" || s.reason === "sees-nothing")).toBe(true);
    store.close();
  });

  it("passes filters through to the rows", async () => {
    const store = makeStore();
    store.recordSource([
      inv({ skill: "a", sidechain: true, attributionAgent: "general-purpose" }),
      inv({ skill: "b" }),
    ], wm());
    const report = await buildUsageReport(store, { sidechain: true, groupBy: ["skill"] }, { home });
    expect(report.rows.map((r) => r.skill)).toEqual(["a"]);
    store.close();
  });
});
